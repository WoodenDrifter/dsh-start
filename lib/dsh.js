// dsh web 服务：状态组装、启动、停止、重启、access URL 解析。
import fs from 'node:fs'
import path from 'node:path'
import * as settings from './settings.js'
import * as runtime from './runtime.js'
import { FILE, dshBin, dshPkgDir, dshVersionFromPkg, nodeExe, dshHome } from './paths.js'
import { classify, invalidate, pidAlive, probeDsh } from './netstat.js'
import { spawnDetached, killTree, waitPortOpen, waitPortClosed, run } from './proc.js'
import { tailLines, exists, sleep } from './util.js'
import * as log from './log.js'

// pid -> 启动时间(ms)。Windows 上取进程启动时间要起一次 powershell（~500ms），
// 所以只按 pid 缓存一次，且不阻塞 status：第一次拿不到就先返回 null。
const startedCache = new Map()
const startedPending = new Set()

function startTimeOf(pid) {
  if (!pid) return null
  if (startedCache.has(pid)) return startedCache.get(pid)
  if (!startedPending.has(pid)) {
    startedPending.add(pid)
    const ps = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    run(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], { timeout: 8000 }).then((r) => {
      const ticks = Number(String(r.stdout).trim())
      if (r.ok && ticks > 0) startedCache.set(pid, Math.round(ticks / 10000 - 11644473600000))
    })
  }
  return null
}

export function accessInfo() {
  const empty = { url: null, token: null, baseUrl: null }
  try {
    const st = fs.statSync(FILE.webOut)
    // 只读尾巴：这个文件会随服务运行无限增长
    const size = st.size
    const take = Math.min(size, 64 * 1024)
    const fd = fs.openSync(FILE.webOut, 'r')
    const buf = Buffer.alloc(take)
    fs.readSync(fd, buf, 0, take, size - take)
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    const all = [...text.matchAll(/dsh web:\s*(http\S+)/g)]
    if (!all.length) {
      // 尾部没有就往前多找一点（启动早期的 URL 可能被大量日志挤走）
      const full = tailLines(FILE.webOut, 4000, 4 << 20)
      const m = /dsh web:\s*(http\S+)/.exec(full)
      if (!m) return empty
      return splitUrl(m[1].trim())
    }
    return splitUrl(all[all.length - 1][1].trim())
  } catch {
    return empty
  }
}

function splitUrl(url) {
  const tm = /[?&]token=([^&\s]+)/.exec(url)
  const i = url.indexOf('/?') >= 0 ? url.indexOf('/?') : url.indexOf('?')
  return { url, token: tm ? tm[1] : null, baseUrl: i >= 0 ? url.slice(0, i) : url }
}

export function trustedHostArgs() {
  const out = []
  for (const h of settings.load().trustedHosts) {
    if (!h) continue
    out.push('--trusted-host', String(h).trim().toLowerCase())
  }
  return out
}

// 安装完整性：npm 装到一半被杀会留下「目录在、package.json 没了」的残骸，
// 这种情况 dsh 完全起不来，必须显式识别出来，不能只看 bin.js 是否存在。
export function installHealth() {
  const dir = dshPkgDir()
  const pkgFile = path.join(dir, 'package.json')
  const binFile = path.join(dir, 'lib', 'bin.js')
  const missing = []
  if (!exists(pkgFile)) missing.push('package.json')
  if (!exists(binFile)) missing.push('lib/bin.js')
  let version = null
  try {
    version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version || null
  } catch {
    if (!missing.includes('package.json')) missing.push('package.json（无法解析）')
  }
  return { ok: missing.length === 0, installed: exists(pkgFile) || exists(binFile), version, dir, missing }
}

export async function status() {
  const s = settings.load()
  const port = Number(s.port)
  const c = await classify(port)
  const rt = runtime.get()
  const web = rt.web || {}

  let startedAt = null
  if (c.running && c.pid) {
    if (web.pid === c.pid && web.startedAt) startedAt = web.startedAt
    else {
      const cached = startedCache.get(c.pid)
      if (cached) startedAt = cached
      else startTimeOf(c.pid)
    }
  }

  const access = c.running ? accessInfo() : { url: null, token: null, baseUrl: null }
  const owner = !c.running ? 'stopped' : c.owned ? 'ours' : c.adopted ? 'adopted' : 'foreign'
  const health = installHealth()

  return {
    installed: health.ok,
    broken: health.installed && !health.ok,
    missing: health.missing,
    version: dshVersionFromPkg(),
    running: c.running,
    owner,
    pid: c.pid,
    port,
    host: s.bindHost,
    startedAt,
    url: access.url,
    token: access.token,
    baseUrl: access.baseUrl,
    trustedHosts: s.trustedHosts,
    logPath: FILE.webOut,
    home: dshHome(),
  }
}

export async function verify() {
  const s = settings.load()
  const c = await classify(Number(s.port))
  const probe = c.running ? await probeDsh(Number(s.port)) : { ok: false }
  return { ...c, http: probe, owner: !c.running ? 'stopped' : c.owned ? 'ours' : c.adopted ? 'adopted' : 'foreign' }
}

export async function start(onProgress = () => {}) {
  const s = settings.load()
  const port = Number(s.port)
  const rt = runtime.get()
  const web = rt.web || {}

  if ((await classify(port)).running) {
    const acc = accessInfo()
    const c = await classify(port)
    runtime.patch({ web: { pid: c.pid, port, host: s.bindHost, startedAt: web.pid === c.pid ? web.startedAt : Date.now() } })
    return { ok: true, alreadyRunning: true, pid: c.pid, url: acc.url, message: '服务已在运行' }
  }

  const node = nodeExe()
  const bin = dshBin()
  if (!exists(bin)) {
    return { ok: false, code: 'NO_DSH', message: '未找到 dsh 主程序：' + bin }
  }

  // 每次启动都清空日志：access URL 必须来自本次输出，不能拿到上一次的旧 token
  for (const f of [FILE.webOut, FILE.webErr]) {
    try {
      fs.rmSync(f, { force: true })
    } catch {}
  }

  onProgress({ stage: 'spawn', percent: 10, message: '正在拉起 dsh web…' })
  const args = [bin, '--profile', 'web', '--no-open', '--host', s.bindHost, '--port', String(port), ...trustedHostArgs()]
  const hosts = s.trustedHosts.length ? `（受信任域名：${s.trustedHosts.join(', ')}）` : ''
  log.info(`启动 dsh web：${node} ${args.join(' ')}`)

  let pid = null
  try {
    const r = spawnDetached(node, args, { out: FILE.webOut, err: FILE.webErr })
    pid = r.pid
  } catch (e) {
    return { ok: false, code: 'SPAWN_FAILED', message: '启动进程失败：' + e.message }
  }

  const startedAt = Date.now()
  runtime.patch({ web: { pid, port, host: s.bindHost, startedAt, bin } })
  invalidate()

  const deadline = Date.now() + 90000
  let url = null
  let tick = 0
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      const err = tailLines(FILE.webErr, 20, 64 * 1024)
      return { ok: false, code: 'EXITED', message: 'dsh web 启动后立即退出', detail: err, pid }
    }
    invalidate()
    const c = await classify(port)
    if (c.running) {
      const acc = accessInfo()
      if (acc.url) {
        url = acc.url
        break
      }
    }
    await new Promise((r) => setTimeout(r, 350))
    tick++
    if (tick % 6 === 0) onProgress({ stage: 'wait', percent: Math.min(85, 10 + tick), message: '等待服务就绪…' })
  }

  if (!url) {
    return { ok: false, code: 'TIMEOUT', message: '等待服务就绪超时（90 秒）', pid, detail: tailLines(FILE.webErr, 20, 64 * 1024) }
  }

  onProgress({ stage: 'ready', percent: 100, message: '服务已就绪' })
  log.info(`dsh web 已就绪 PID ${pid}${hosts}`)
  return { ok: true, pid, url, message: '已启动' }
}

export async function stop(onProgress = () => {}) {
  const s = settings.load()
  const port = Number(s.port)
  const c = await classify(port)
  if (!c.running) {
    runtime.clear('web')
    return { ok: true, message: '服务未在运行', stopped: false }
  }
  if (!c.isDsh) {
    return { ok: false, code: 'FOREIGN', message: `端口 ${port} 被其它程序占用（PID ${c.pid}），不敢动它` }
  }
  onProgress({ stage: 'stop', percent: 20, message: '正在停止 dsh web…' })
  const pid = c.pid
  const r = await killTree(pid)
  const closed = await waitPortClosed(port, 8000)
  invalidate()
  if (!closed) {
    return { ok: false, code: 'EPERM', message: '进程未能退出（可能权限不足或被安全软件拦截）', pid }
  }
  runtime.clear('web')
  startedCache.delete(pid)
  log.info(`已停止 dsh web（PID ${pid}${r.forced ? '，强制结束' : ''}）`)
  onProgress({ stage: 'done', percent: 100, message: '已停止' })
  return { ok: true, stopped: true, pid, message: '已停止' }
}

export async function restart(onProgress = () => {}) {
  const s = await stop(onProgress)
  if (!s.ok) return s
  await sleep(600)
  return await start(onProgress)
}

export function logs(stream = 'out', lines = 200) {
  const f = stream === 'err' ? FILE.webErr : FILE.webOut
  return { text: tailLines(f, lines), path: f }
}
