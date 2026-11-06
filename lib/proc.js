// Windows 进程操作：脱离控制台的 spawn、端口等待、树杀、开浏览器、单次命令采集。
import fs from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { sleep } from './util.js'
import { listeners, invalidate, pidAlive } from './netstat.js'

const TASKKILL = process.env.WINDIR ? `${process.env.WINDIR}\\System32\\taskkill.exe` : 'taskkill.exe'
const RUNDLL = process.env.WINDIR ? `${process.env.WINDIR}\\System32\\rundll32.exe` : 'rundll32.exe'

// stdout/stderr 必须是文件 fd：接管道时父进程一退出就 EPIPE，会把 dsh 一起弄死
export function spawnDetached(exe, args, { out, err, env, cwd } = {}) {
  const stdio = ['ignore', 'ignore', 'ignore']
  let fdOut = null
  let fdErr = null
  if (out) {
    fdOut = fs.openSync(out, 'a')
    stdio[1] = fdOut
  }
  if (err) {
    fdErr = fs.openSync(err, 'a')
    stdio[2] = fdErr
  }
  const child = spawn(exe, args, {
    cwd: cwd || process.env.USERPROFILE,
    detached: true,
    windowsHide: true,
    stdio,
    env: { ...process.env, ...(env || {}) },
  })
  child.unref()
  // 父进程立刻关掉自己的 fd 副本，避免占着文件句柄
  if (fdOut !== null) try { fs.closeSync(fdOut) } catch {}
  if (fdErr !== null) try { fs.closeSync(fdErr) } catch {}
  return { pid: child.pid, child }
}

export function run(exe, args, { timeout = 30000, cwd, env, maxBuffer = 4 << 20 } = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout, cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        error: err ? err.message : null,
        stdout: stdout ? stdout.toString('utf8') : '',
        stderr: stderr ? stderr.toString('utf8') : '',
      })
    })
  })
}

// 只查监听表：Windows 上连一个未监听的本机端口不会立刻 RST，会白等满超时
export async function portOpen(port) {
  invalidate()
  const map = await listeners()
  return (map.get(Number(port)) || []).length > 0
}

export async function waitPortOpen(port, ms = 20000, step = 250) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    invalidate()
    const map = await listeners()
    if ((map.get(Number(port)) || []).length) return true
    await sleep(step)
  }
  return false
}

export async function waitPortClosed(port, ms = 8000, step = 250) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    invalidate()
    const map = await listeners()
    if (!(map.get(Number(port)) || []).length) return true
    await sleep(step)
  }
  return false
}

export async function killTree(pid) {
  if (!pid) return { ok: true, forced: false }
  try {
    process.kill(pid)
  } catch {}
  await sleep(150)
  if (!pidAlive(pid)) return { ok: true, forced: false }
  const r = await run(TASKKILL, ['/PID', String(pid), '/T', '/F'], { timeout: 8000 })
  await sleep(250)
  return { ok: pidAlive(pid) === false, forced: r.ok, error: r.ok ? null : r.stderr || r.error }
}

export function openExternal(target) {
  const args = /^https?:/i.test(target)
    ? ['url.dll,FileProtocolHandler', target]
    : ['url.dll,FileProtocolHandler', target]
  try {
    const c = spawn(RUNDLL, args, { detached: true, stdio: 'ignore', windowsHide: true })
    c.unref()
    return true
  } catch {
    return false
  }
}

export function openBrowser(url) {
  return openExternal(url)
}

export async function taskName(pid) {
  const r = await run('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { timeout: 5000 })
  const m = /^"([^"]+)"/.exec(r.stdout.trim())
  return m ? m[1] : null
}
