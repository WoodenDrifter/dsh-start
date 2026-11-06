// 更新 / 版本切换 / 回退：五个阶段，每阶段都往 job 里推进度。
// 失败时尽量把版本装回去，并把回退点标成 failed，避免留下半装状态。
import * as registry from './registry.js'
import * as npm from './npm.js'
import * as dsh from './dsh.js'
import * as settings from './settings.js'
import * as backup from './backup.js'
import * as rp from './restorepoints.js'
import { dshVersionFromPkg, DIR } from './paths.js'
import { compareVersion, sleep, readJson, writeJsonAtomic } from './util.js'
import * as log from './log.js'
import fs from 'node:fs'
import path from 'node:path'

// 安装日志：npm 开跑前落盘，成功后清掉。控制台若被强杀，下次启动能据此发现半装并自动修复。
const JOURNAL = path.join(DIR.config, 'install-journal.json')

export function pendingJournal() {
  return readJson(JOURNAL, null)
}

function journalWrite(rec) {
  try {
    writeJsonAtomic(JOURNAL, { ...rec, startedAt: new Date().toISOString() })
  } catch {}
}

function journalClear() {
  try {
    fs.rmSync(JOURNAL, { force: true })
  } catch {}
}

// 装一个版本，并校验真的装好了（不是「目录还在但 package.json 没了」）
async function installVersion(job, version, action = 'install') {
  journalWrite({ version, action })
  const s = settings.load()
  if (s.proxy) job && job.line && job.line(`使用代理 ${s.proxy}`)
  await npm.installGlobal(`@deepseek-ai/dsh@${version}`, {
    onLine: (line) => job && job.line && job.line(line.slice(0, 200)),
    proxy: s.proxy || null,
    registry: s.registry || null,
  })
  const h = dsh.installHealth()
  if (!h.ok) {
    const e = new Error(`npm 执行完了但安装不完整，缺少 ${h.missing.join('、')}`)
    e.code = 'INSTALL_INCOMPLETE'
    throw e
  }
  if (version && h.version && compareVersion(h.version, version) !== 0) {
    const e = new Error(`安装后版本不符：期望 ${version}，实际 ${h.version}`)
    e.code = 'VERSION_MISMATCH'
    throw e
  }
  journalClear()
  return h.version
}

// 修复：把指定版本（或安装日志里的版本）重新装一遍，不碰用户数据。
export async function repair(job, version) {
  const j = pendingJournal()
  let fallback = null
  if (!version && !(j && j.version) && !dshVersionFromPkg()) {
    // 包已经坏到读不出版本号时，用最近一条回退点记录的「旧版本」兜底
    const rps = rp.list()
    fallback = rps.map((x) => x.toVersion || x.fromVersion).find(Boolean) || null
  }
  const target = String(version || (j && j.version) || dshVersionFromPkg() || fallback || '')
    .replace(/^v/, '')
    .trim()
  if (!target) throw new Error('没法判断该装回哪个版本。请到「切换版本」里选一个版本号再修复。')
  const before = dsh.installHealth()
  job.progress({
    stage: 'repair',
    percent: 10,
    message: `正在重新安装 ${target}…（当前：${before.ok ? '完整' : '损坏，缺 ' + before.missing.join('、')}）`,
  })

  const wasRunning = (await dsh.status()).running
  if (wasRunning) await dsh.stop((x) => job.progress({ ...x, percent: 20, message: '停止 dsh web…' }))

  try {
    await installVersion(job, target, 'repair')
  } catch (e) {
    job.line('修复失败：' + e.message)
    if (e.detail) job.line(String(e.detail).slice(-600))
    throw e
  }

  const after = dsh.installHealth()
  job.progress({ stage: 'verify', percent: 80, message: `已重装 ${after.version || target}` })
  let started = false
  if (wasRunning) {
    const st = await dsh.start((x) => job.progress({ ...x, percent: 85 + Math.round((x.percent || 0) * 0.12) }))
    started = Boolean(st.ok)
  }
  job.progress({ stage: 'done', percent: 100, message: `修复完成：${after.version || target}` })
  log.info(`dsh 安装修复完成：${after.version || target}`)
  return { version: after.version || target, restarted: started }
}

export async function check({ force = false } = {}) {
  const s = settings.load()
  const installed = dshVersionFromPkg()
  const health = dsh.installHealth()
  try {
    const latest = await registry.latest({ force, registry: s.registry, proxy: s.proxy })
    return {
      installed,
      broken: health.installed && !health.ok,
      missing: health.missing,
      latest: latest.version,
      source: latest.source,
      ms: latest.ms,
      viaProxy: latest.viaProxy,
      proxyError: latest.proxyError,
      needUpdate: Boolean(installed && latest.version && compareVersion(latest.version, installed) > 0),
      checkedAt: Date.now(),
    }
  } catch (e) {
    return {
      installed,
      broken: health.installed && !health.ok,
      missing: health.missing,
      latest: null,
      error: e.message,
      code: e.code || 'REGISTRY_FAILED',
      detail: e.detail || null,
      checkedAt: Date.now(),
    }
  }
}

export async function versions({ force = false } = {}) {
  const s = settings.load()
  const v = await registry.versions({ force, registry: s.registry, proxy: s.proxy })
  return {
    installed: dshVersionFromPkg(),
    versions: v.versions,
    stable: v.stable,
    latest: v.latest,
    next: v.next,
    source: v.source,
  }
}

export async function install(job, targetVersion) {
  const version = String(targetVersion || '').trim().replace(/^v/, '')
  if (!version) throw new Error('未指定目标版本')

  const health = dsh.installHealth()
  const from = health.version || dshVersionFromPkg()
  if (health.ok && from && compareVersion(version, from) === 0) {
    job.progress({ stage: 'skip', percent: 100, message: `当前已是 ${version}` })
    return { alreadyInstalled: true, version }
  }
  if (!health.ok && health.installed) {
    job.line(`检测到当前安装不完整（缺 ${health.missing.join('、')}），本次会覆盖安装。`)
  }

  // 阶段 1：预检 + 数据备份 + 落回退点
  job.progress({ stage: 'precheck', percent: 4, message: `准备更新 ${from || '?'} → ${version}` })
  const s = settings.load()
  const all = await registry.versions({ registry: s.registry, proxy: s.proxy })
  if (!all.versions.includes(version)) {
    const e = new Error(`registry 上不存在版本 ${version}`)
    e.code = 'VERSION_NOT_FOUND'
    throw e
  }

  const record = rp.create({ kind: 'update', fromVersion: from, toVersion: version, status: 'pending' })
  job.line(`回退点：${record.id}`)

  let dataBackup = null
  try {
    job.progress({ stage: 'backup', percent: 8, message: '备份用户数据…' })
    const sub = {
      progress: (x) => {
        if (x.percent !== undefined) job.progress({ ...x, percent: 8 + Math.round((x.percent || 0) * 0.12) })
      },
    }
    const b = await backup.create(sub, 'pre-update')
    dataBackup = b.name
    rp.update(record.id, { backup: dataBackup })
    job.progress({ stage: 'backup', percent: 20, message: `数据已备份：${b.name}` })
  } catch (e) {
    job.line('备份失败，继续更新（不阻断）：' + e.message)
  }

  // 阶段 2：停服务（不先停会把 npm 装的包锁住）
  const wasRunning = (await dsh.status()).running
  if (wasRunning) {
    job.progress({ stage: 'stop', percent: 24, message: '停止 dsh web…' })
    const st = await dsh.stop((x) => job.progress({ ...x, percent: 24 + Math.round((x.percent || 0) * 0.04) }))
    if (!st.ok) {
      rp.update(record.id, { status: 'failed', message: '停服失败：' + st.message })
      throw new Error('无法停止 dsh web，已中止更新：' + st.message)
    }
  }

  // 阶段 3：安装
  job.progress({ stage: 'install', percent: 30, message: `npm install -g @deepseek-ai/dsh@${version}…` })
  try {
    await installVersion(job, version, 'update')
    job.line(`npm 安装完成：${version}`)
  } catch (e) {
    job.line('安装失败：' + e.message)
    if (e.detail) job.line(String(e.detail).slice(-800))
    // 回滚：把原来的版本装回去
    if (from) {
      job.progress({ stage: 'rollback', percent: 70, message: `安装失败，正在还原 ${from}…` })
      try {
        await installVersion(job, from, 'revert')
        rp.update(record.id, { status: 'failed', message: '安装失败，已还原原版本' })
        job.line(`已还原 ${from}`)
      } catch (e2) {
        rp.update(record.id, { status: 'failed', message: '安装失败且还原失败：' + e2.message })
        job.line('还原也失败了：' + e2.message)
        job.line(`可以稍后在「更新」页点「修复安装」，或手动执行：npm i -g @deepseek-ai/dsh@${from}`)
      }
    }
    const err = new Error('安装失败：' + e.message)
    err.detail = e.detail || null
    throw err
  }

  // 阶段 4：校验
  job.progress({ stage: 'verify', percent: 82, message: '校验安装结果…' })
  const installed = dshVersionFromPkg()
  if (!installed || compareVersion(installed, version) !== 0) {
    rp.update(record.id, { status: 'failed', message: `校验不符：期望 ${version}，实际 ${installed}` })
    throw new Error(`安装后版本不符：期望 ${version}，实际 ${installed}`)
  }
  job.line(`版本校验通过：${installed}`)

  // 阶段 5：重启
  registry.invalidate()
  let started = false
  if (wasRunning) {
    job.progress({ stage: 'start', percent: 88, message: '重启 dsh web…' })
    await sleep(400)
    const st = await dsh.start((x) => job.progress({ ...x, percent: 88 + Math.round((x.percent || 0) * 0.1) }))
    started = Boolean(st.ok)
    if (!st.ok) job.line('重启失败：' + st.message)
  }

  rp.update(record.id, { status: 'success', message: started || !wasRunning ? '更新完成' : '更新完成但未启动' })
  log.info(`dsh 更新完成：${from} → ${version}`)
  job.progress({ stage: 'done', percent: 100, message: `已更新到 ${version}` })
  return { from, to: version, backup: dataBackup, restorePoint: record.id, restarted: started }
}

export async function rollback(job, id, { restoreData = false } = {}) {
  const record = rp.get(id)
  if (!record) throw new Error('回退点不存在：' + id)
  const target = record.fromVersion
  if (!target) throw new Error('该回退点没有记录旧版本号')

  job.progress({ stage: 'precheck', percent: 5, message: `回退到 ${target}…` })
  const s = settings.load()

  // 版本检查只是「确认 registry 上还有这个版本」，连不上 registry 不该挡住回退：
  // npm 自己会拉到精确版本，失败再报错也不迟。
  try {
    const all = await registry.versions({ registry: s.registry, proxy: s.proxy })
    if (!all.versions.includes(target)) {
      job.line(`注意：registry 列表里没有 ${target}，仍会尝试按精确版本安装。`)
    }
  } catch (e) {
    job.line(`跳过 registry 预检（${e.message}），直接按精确版本安装。`)
  }

  const wasRunning = (await dsh.status()).running
  if (wasRunning) {
    job.progress({ stage: 'stop', percent: 15, message: '停止 dsh web…' })
    await dsh.stop((x) => job.progress({ ...x, percent: 15 + Math.round((x.percent || 0) * 0.05) }))
  }

  // 先恢复程序版本，再恢复数据。顺序很重要：
  // 数据恢复可能因为个别文件被占用/只读而失败，绝不能因此让版本停在损坏状态。
  job.progress({ stage: 'install', percent: 25, message: `安装 ${target}…` })
  try {
    await installVersion(job, target, 'rollback')
  } catch (e) {
    rp.update(id, { status: 'failed', message: '回退安装失败：' + e.message })
    throw e
  }

  registry.invalidate()
  job.progress({ stage: 'verify', percent: 60, message: `已安装 ${target}，校验通过` })

  let dataResult = null
  let dataError = null
  if (restoreData && record.backup) {
    job.progress({ stage: 'restore', percent: 65, message: `恢复数据备份 ${record.backup}…` })
    try {
      dataResult = await backup.restore(job, record.backup, { restartWeb: false, safetyBackup: true })
      if (dataResult.failed) {
        job.line(`数据已恢复，但有 ${dataResult.failed} 个文件没能写回（多为被占用或只读）。`)
      }
    } catch (e) {
      dataError = e.message
      job.line('数据恢复失败，但程序版本已回退成功：' + e.message)
    }
  }

  let started = false
  if (wasRunning) {
    job.progress({ stage: 'start', percent: 88, message: '重启 dsh web…' })
    const st = await dsh.start((x) => job.progress({ ...x, percent: 88 + Math.round((x.percent || 0) * 0.1) }))
    started = Boolean(st.ok)
    if (!st.ok) job.line('重启失败：' + st.message)
  }

  const warn = dataError ? `；数据未恢复（${dataError}）` : dataResult && dataResult.failed ? `；${dataResult.failed} 个文件未能写回` : ''
  rp.update(id, { status: 'rolled-back', message: `已回退到 ${target}${warn}` })
  job.progress({ stage: 'done', percent: 100, message: `已回退到 ${target}${warn}` })
  return { to: target, restarted: started, restoreData: Boolean(restoreData), dataError, dataFailed: dataResult ? dataResult.failed || 0 : 0 }
}
