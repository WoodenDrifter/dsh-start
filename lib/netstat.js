// 监听表快照（1s TTL）+ 端口归属判定。绝不在热路径上起进程去"查命令行"。
import { execFile } from 'node:child_process'
import http from 'node:http'
import { FILE } from './paths.js'
import { readJson } from './util.js'

let snapshot = null
let snapshotAt = 0
let inflight = null

const NETSTAT = process.env.WINDIR ? `${process.env.WINDIR}\\System32\\netstat.exe` : 'netstat.exe'

function parse(text) {
  const map = new Map() // port -> [{pid, addr}]
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const port = Number(m[2])
    const pid = Number(m[3])
    if (!port || !pid) continue
    if (!map.has(port)) map.set(port, [])
    const arr = map.get(port)
    if (!arr.some((x) => x.pid === pid)) arr.push({ pid, addr: m[1] })
  }
  return map
}

export function invalidate() {
  snapshotAt = 0
}

export function listeners() {
  const now = Date.now()
  if (snapshot && now - snapshotAt < 1000) return Promise.resolve(snapshot)
  if (inflight) return inflight
  inflight = new Promise((resolve) => {
    execFile(NETSTAT, ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000, maxBuffer: 8 << 20 }, (err, stdout) => {
      inflight = null
      if (err && !stdout) {
        resolve(snapshot || new Map())
        return
      }
      snapshot = parse(stdout || '')
      snapshotAt = Date.now()
      resolve(snapshot)
    })
  })
  return inflight
}

export async function pidOfPort(port) {
  const map = await listeners()
  const arr = map.get(Number(port)) || []
  return arr.length ? arr[0].pid : null
}

export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// dsh web 的零成本指纹：未授权访问根路径返回 401 且正文含固定英文串。
// 命中即可确信"端口上跑的是 dsh"，与是谁拉起的无关。
export function probeDsh(port, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => {
          body += d
          if (body.length > 8192) req.destroy()
        })
        res.on('end', () => {
          const isDsh = /dsh web authentication required/i.test(body) || (res.statusCode === 401 && /dsh/i.test(body))
          resolve({ ok: true, status: res.statusCode, isDsh })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, isDsh: false })
    })
    req.on('error', () => resolve({ ok: false, status: 0, isDsh: false }))
    req.end()
  })
}

export async function classify(port) {
  const map = await listeners()
  const arr = map.get(Number(port)) || []
  if (!arr.length) return { running: false, pid: null, owned: false, adopted: false, isDsh: false }
  const pid = arr[0].pid
  const rt = readJson(FILE.runtime, {}) || {}
  const owned = Boolean(rt.web && rt.web.pid && rt.web.pid === pid)
  const probe = await probeDsh(Number(port))
  return { running: true, pid, owned, adopted: !owned && probe.isDsh, isDsh: probe.isDsh }
}
