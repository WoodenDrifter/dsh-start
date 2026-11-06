// 备份：自动探测 ~/.dsh 里哪些是用户数据、哪些是可重建内容。
//
// 判定顺序（与旧版一致）：
//   1. 名字命中纯缓存名单            → 排除
//   2. 目录内含 node_modules         → 可重建，排除
//   3. 目录内含 package.json + 锁文件 → 可重建，排除
//   4. 其余                          → 用户数据，纳入
// profiles / dsh-runtimes 是重量级可重建目录，直接排除（实测 743MB）。
import fs from 'node:fs'
import path from 'node:path'
import { DIR, dshHome, FILE } from './paths.js'
import { ensureDir, exists, fmtBytes, fileTag, safeStat, tailLines } from './util.js'
import * as zip from './zip.js'
import * as settings from './settings.js'
import * as dsh from './dsh.js'
import { dshVersionFromPkg } from './paths.js'
import * as log from './log.js'
import os from 'node:os'

// node_modules / 缓存 / 日志不备份；bash-ipc 是 dsh-ops 插件的 IPC 暂存目录
// （本机实测 412MB，全是可丢弃的临时数据，不排除会让每次备份都变几百 MB）。
const HARD_EXCLUDE = new Set([
  'profiles',
  'dsh-runtimes',
  'node_modules',
  '.pnpm-store',
  '.git',
  'logs',
  'cache',
  'caches',
  '.cache',
  'tmp',
  'dist',
  'bash-ipc',
])
const ALWAYS_REBUILD = new Set(['profiles', 'dsh-runtimes'])

function walk(dir, onFile = null) {
  const stats = { files: 0, bytes: 0, skipped: 0 }
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      stats.skipped++
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isSymbolicLink()) {
        stats.skipped++
        continue
      }
      if (e.isDirectory()) {
        if (HARD_EXCLUDE.has(e.name.toLowerCase())) {
          stats.skipped++
          continue
        }
        stack.push(full)
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full)
          stats.bytes += st.size
          stats.files++
          if (onFile) onFile(full, st)
        } catch {
          stats.skipped++
        }
      }
    }
  }
  return stats
}

function classifyTop(item) {
  const lower = item.toLowerCase()
  if (ALWAYS_REBUILD.has(lower)) return { include: false, kind: '可重建', reason: '运行时/依赖树，可重新安装生成' }
  if (HARD_EXCLUDE.has(lower)) return { include: false, kind: '缓存', reason: '纯缓存或日志' }
  return { include: true, kind: '用户数据', reason: '会话 / 配置 / 插件等不可重建内容' }
}

function hasChildDir(dir, name) {
  try {
    return fs.existsSync(path.join(dir, name))
  } catch {
    return false
  }
}

export function plan() {
  const home = dshHome()
  const items = []
  let totalBytes = 0
  let totalFiles = 0

  let tops = []
  try {
    tops = fs.readdirSync(home, { withFileTypes: true })
  } catch (e) {
    return { error: '无法读取 dsh 数据目录：' + home, items: [], included: [], excluded: [], totalMB: 0, totalFiles: 0 }
  }

  for (const ent of tops) {
    const full = path.join(home, ent.name)
    const base = classifyTop(ent.name)
    let include = base.include
    let kind = base.kind
    let reason = base.reason
    let stats = { files: 0, bytes: 0, skipped: 0 }

    if (ent.isDirectory() && include) {
      if (hasChildDir(full, 'node_modules')) {
        include = false
        kind = '可重建'
        reason = '含 node_modules'
      } else if (
        hasChildDir(full, 'package.json') &&
        (fs.existsSync(path.join(full, 'pnpm-lock.yaml')) || fs.existsSync(path.join(full, 'package-lock.json')) || fs.existsSync(path.join(full, 'yarn.lock')))
      ) {
        include = false
        kind = '可重建'
        reason = '含 package.json 与锁文件'
      }
    }

    if (include) {
      if (ent.isDirectory()) {
        stats = walk(full)
      } else {
        const st = safeStat(full)
        if (st) stats = { files: 1, bytes: st.size, skipped: 0 }
      }
      totalBytes += stats.bytes
      totalFiles += stats.files
    }

    items.push({
      name: ent.name,
      kind,
      reason,
      include,
      files: stats.files,
      sizeMB: +(stats.bytes / 1048576).toFixed(2),
      isDir: ent.isDirectory(),
    })
  }

  items.sort((a, b) => Number(b.include) - Number(a.include) || b.sizeMB - a.sizeMB)
  return {
    home,
    items,
    included: items.filter((i) => i.include),
    excluded: items.filter((i) => !i.include),
    totalMB: +(totalBytes / 1048576).toFixed(2),
    totalFiles,
    summary: `纳入 ${items.filter((i) => i.include).length} 项 / ${(totalBytes / 1048576).toFixed(1)} MB，排除 ${items.filter((i) => !i.include).length} 项`,
  }
}

const manifestCache = new Map()

export function manifestOf(file) {
  const st = safeStat(file)
  if (!st) return null
  const key = `${path.basename(file)}|${st.mtimeMs}`
  if (manifestCache.has(key)) return manifestCache.get(key)
  let m = null
  try {
    const text = zip.readText(file, 'manifest.json')
    if (text) m = JSON.parse(text)
  } catch {}
  manifestCache.set(key, m)
  return m
}

export function list() {
  const out = []
  let names = []
  try {
    names = fs.readdirSync(DIR.backups)
  } catch {
    return out
  }
  for (const n of names) {
    if (!/\.zip$/i.test(n)) continue
    const full = path.join(DIR.backups, n)
    const st = safeStat(full)
    if (!st) continue
    const m = manifestOf(full)
    out.push({
      name: n,
      path: full,
      sizeMB: +(st.size / 1048576).toFixed(2),
      sizeText: fmtBytes(st.size),
      mtime: st.mtimeMs,
      kind: m ? 'backup' : 'legacy',
      manifest: m
        ? {
            dshVersion: m.dshVersion || null,
            files: m.files || null,
            createdAt: m.createdAt || null,
            included: Array.isArray(m.included) ? m.included.map((x) => x.name) : null,
          }
        : null,
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

export function backupPath(name) {
  const base = path.basename(String(name || ''))
  if (!/\.zip$/i.test(base)) throw new Error('文件名不合法')
  const full = path.join(DIR.backups, base)
  if (!exists(full)) throw new Error('备份不存在：' + base)
  return full
}

export async function create(job, prefix = 'manual') {
  ensureDir(DIR.backups)
  job.progress({ stage: 'scan', percent: 4, message: '扫描备份范围…' })
  const p = plan()
  if (!p.totalFiles) throw new Error('没有可备份的文件')

  const home = dshHome()
  const files = []
  const stats = { files: 0, bytes: 0, skipped: 0 }
  for (const item of p.included) {
    const full = path.join(home, item.name)
    const st = safeStat(full)
    if (!st) continue
    if (st.isDirectory()) {
      walk(full, (f, s) => files.push({ name: path.relative(home, f).replace(/\\/g, '/'), absPath: f }), stats)
    } else {
      files.push({ name: item.name, absPath: full })
    }
  }
  if (!files.length) throw new Error('没有可备份的文件')

  const ver = dshVersionFromPkg() || 'unknown'
  const name = `${prefix}-${ver}-${fileTag()}.zip`
  const dest = path.join(DIR.backups, name)
  const totalBytes = files.reduce((n, f) => n + (safeStat(f.absPath)?.size || 0), 0)

  job.progress({ stage: 'pack', percent: 8, message: `待打包 ${files.length} 个文件 / ${fmtBytes(totalBytes)}` })

  const manifest = {
    appVersion: '2.0.0',
    formatVersion: 2,
    createdAt: new Date().toISOString(),
    dshVersion: dshVersionFromPkg(),
    files: files.length,
    autoDetect: true,
    included: p.included.map((i) => ({ name: i.name, kind: i.kind, reason: i.reason, sizeMB: i.sizeMB, files: i.files })),
    excluded: p.excluded.map((i) => ({ name: i.name, kind: i.kind, reason: i.reason, sizeMB: i.sizeMB })),
    host: os.hostname(),
    user: process.env.USERNAME || null,
  }

  files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })

  const result = await zip.write(dest, files, {
    onProgress: (done, total, current) => {
      const pct = 8 + Math.round((done / total) * 88)
      job.progress({ stage: 'pack', percent: pct, message: `打包中 ${pct}%（${path.basename(current || '')}）` })
    },
  })

  log.info(`备份完成：${name}（${fmtBytes(result.size)}，${files.length} 个条目）`)
  job.progress({ stage: 'done', percent: 100, message: `备份完成：${name}` })
  return { name, path: dest, sizeMB: +(result.size / 1048576).toFixed(2), files: files.length, dshVersion: dshVersionFromPkg() }
}

// 恢复前自动再备份一次当前状态，避免误操作无法挽回
export async function restore(job, name, { restartWeb = true, safetyBackup = true } = {}) {
  const file = backupPath(name)
  const m = manifestOf(file)
  const home = dshHome()

  job.progress({ stage: 'precheck', percent: 3, message: '检查备份内容…' })
  const entries = zip.readEntries(file)
  if (!entries.length) throw new Error('备份里没有条目')

  let safety = null
  if (safetyBackup) {
    job.progress({ stage: 'safety', percent: 6, message: '先备份当前状态…' })
    const sub = {
      progress: (x) => {
        if (x.percent !== undefined) job.progress({ ...x, percent: 6 + Math.round((x.percent || 0) * 0.1) })
      },
    }
    safety = await create(sub, 'pre-restore')
    job.progress({ stage: 'safety', percent: 16, message: `已备份当前状态：${safety.name}` })
  }

  const wasRunning = (await dsh.status()).running
  if (wasRunning) {
    job.progress({ stage: 'stop', percent: 18, message: '正在停止 dsh web…' })
    await dsh.stop((x) => job.progress({ ...x, percent: 18 + Math.round((x.percent || 0) * 0.05) }))
  }

  job.progress({ stage: 'extract', percent: 25, message: `解压 ${entries.length} 个条目到 ${home}…` })
  ensureDir(home)
  const failedSample = []
  const r = zip.extract(file, home, {
    onEntry: (n) => n === 'manifest.json',
    onError: (n, e) => {
      if (failedSample.length < 20) failedSample.push(`${n}（${e.code || e.message}）`)
    },
  })

  job.progress({
    stage: 'extract',
    percent: 80,
    message: r.failed && r.failed.length ? `已写入 ${r.written} 个文件，${r.failed.length} 个失败（跳过 ${r.skipped}）` : `已写入 ${r.written} 个文件（跳过 ${r.skipped}）`,
  })
  if (r.failed && r.failed.length) {
    job.line(`有 ${r.failed.length} 个文件没能写入，例如：`)
    for (const x of failedSample) job.line('  ' + x)
    job.line('这些文件通常是被运行中的 dsh web 占用或带只读属性；其余文件已正常恢复。')
  }

  let restarted = false
  if (restartWeb && wasRunning) {
    job.progress({ stage: 'start', percent: 85, message: '正在重启 dsh web…' })
    const s = await dsh.start((x) => job.progress({ ...x, percent: 85 + Math.round((x.percent || 0) * 0.14) }))
    restarted = Boolean(s.ok)
  }

  log.info(`已从备份恢复：${name}（${r.written} 个文件${r.failed && r.failed.length ? `，${r.failed.length} 个失败` : ''}）`)
  job.progress({ stage: 'done', percent: 100, message: r.failed && r.failed.length ? `恢复完成，但有 ${r.failed.length} 个文件失败` : '恢复完成' })
  return {
    name,
    written: r.written,
    skipped: r.skipped,
    failed: (r.failed || []).length,
    failedSample,
    safetyBackup: safety ? safety.name : null,
    restarted,
    dshVersion: m ? m.dshVersion : null,
  }
}

export function remove(name) {
  const file = backupPath(name)
  const st = safeStat(file)
  fs.rmSync(file, { force: true })
  manifestCache.clear()
  log.info(`已删除备份：${name}`)
  return { freedMB: st ? +(st.size / 1048576).toFixed(2) : 0 }
}
