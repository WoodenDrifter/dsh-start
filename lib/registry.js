// registry 查询：多源竞速 + 走 CONNECT 代理隧道（不依赖 undici，本机没装）。
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import { URL } from 'node:url'
import { compareVersion } from './util.js'

const PKG = '@deepseek-ai/dsh'
const ENCODED = encodeURIComponent(PKG)

export const SOURCES = [
  { id: 'npmmirror', label: 'npmmirror', base: 'https://registry.npmmirror.com' },
  { id: 'npmjs', label: 'npm 官方源', base: 'https://registry.npmjs.org' },
]

let latestCache = null // { value, at }
let versionsCache = null // { value, at }

export function parseProxy(proxy) {
  if (!proxy) return null
  try {
    const u = new URL(String(proxy).trim())
    if (!/^https?:$/.test(u.protocol)) return null
    return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null }
  } catch {
    return null
  }
}

// 通过 HTTP 代理建立到目标的隧道，返回隧道 socket（明文 TCP，需要再套 TLS）
function connectVia(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${host}:${port}`, 'proxy-connection': 'keep-alive' }
    if (proxy.auth) headers['proxy-authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64')
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`, headers })
    req.setTimeout(8000, () => req.destroy(new Error('代理连接超时')))
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error('代理拒绝连接：HTTP ' + res.statusCode))
        return
      }
      socket.setTimeout(0)
      socket.setNoDelay(true)
      resolve(socket)
    })
    req.on('error', reject)
    req.end()
  })
}

// 建一个一次性 agent：它的 createConnection 直接拿隧道 socket 做 TLS 握手。
// 注意：不能写 https.connect（Node 没有这个函数），必须用 tls.connect。
function tunnelAgent(rawSocket, servername) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = (opts, cb) => {
    const s = tls.connect({ socket: rawSocket, servername, ALPNProtocols: ['http/1.1'] })
    s.once('secureConnect', () => cb(null, s))
    s.once('error', (e) => cb(e))
    return s
  }
  return agent
}

function requestOnce(urlStr, { proxy, timeout = 8000, accept = 'application/json' } = {}) {
  return new Promise(async (resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch {
      reject(new Error('bad url'))
      return
    }
    const headers = { accept, 'user-agent': 'dsh-start-console/2.0' }
    const p = proxy ? parseProxy(proxy) : null
    try {
      let agent = undefined
      if (p) {
        if (u.protocol !== 'https:') throw new Error('只支持 https 目标走代理')
        const raw = await connectVia(p, u.hostname, Number(u.port) || 443)
        agent = tunnelAgent(raw, u.hostname)
      }
      const req = https.request(
        { host: u.hostname, port: Number(u.port) || 443, path: u.pathname + (u.search || ''), method: 'GET', headers, ...(agent ? { agent } : {}) },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            requestOnce(new URL(res.headers.location, u).toString(), { proxy, timeout }).then(resolve, reject)
            return
          }
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`))
              return
            }
            try {
              resolve(JSON.parse(text))
            } catch {
              reject(new Error('返回内容不是 JSON'))
            }
          })
        }
      )
      req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
      req.on('error', reject)
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

async function race(pathname, opts) {
  const started = Date.now()
  const attempts = SOURCES.map(async (s) => {
    const data = await requestOnce(s.base + pathname, opts)
    return { data, source: s.id, label: s.label }
  })
  // 先成功者胜；全失败时抛出第一个错误
  try {
    const winner = await Promise.any(attempts)
    return { ...winner, ms: Date.now() - started }
  } catch (e) {
    // Promise.any 只给 AggregateError，这里补一条可读原因
    const errs = (e.errors || []).map((x) => x.message).filter(Boolean)
    const err = new Error(errs.length ? errs[0] : '所有源都失败')
    err.code = 'REGISTRY_FAILED'
    err.detail = errs.join('；')
    throw err
  }
}

// 代理没开（最常见：Clash 没启动）时不要让"检查更新"永远失败，
// 自动退回直连并在结果里标明，用户才知道代理其实没生效。
async function withProxyFallback(proxy, fn) {
  const p = proxy ? parseProxy(proxy) : null
  if (!p) return await fn(null)
  try {
    const r = await fn(proxy)
    return { ...r, viaProxy: true }
  } catch (e) {
    const r = await fn(null)
    return { ...r, viaProxy: false, proxyError: e.message }
  }
}

export async function latest({ force = false, registry = 'auto', proxy = null } = {}) {
  if (!force && latestCache && Date.now() - latestCache.at < 10 * 60 * 1000) return latestCache.value
  const opts = { proxy }
  let result
  const doIt = async (px) => {
    const o = { proxy: px }
    if (registry && registry !== 'auto') {
      const src = SOURCES.find((s) => s.id === registry) || SOURCES[0]
      const started = Date.now()
      const data = await requestOnce(`${src.base}/${ENCODED}/latest`, o)
      return { data, source: src.id, label: src.label, ms: Date.now() - started }
    }
    return await race(`/${ENCODED}/latest`, o)
  }
  result = await withProxyFallback(proxy, doIt)
  const value = {
    version: result.data && result.data.version ? result.data.version : null,
    source: result.label,
    ms: result.ms,
    viaProxy: result.viaProxy !== false,
    proxyError: result.proxyError || null,
    at: Date.now(),
  }
  if (!value.version) {
    const e = new Error('registry 返回里没有 version 字段')
    e.code = 'REGISTRY_BAD'
    throw e
  }
  latestCache = { value, at: Date.now() }
  return value
}

export async function versions({ force = false, registry = 'auto', proxy = null } = {}) {
  if (!force && versionsCache && Date.now() - versionsCache.at < 30 * 60 * 1000) return versionsCache.value
  const opts = { timeout: 15000, accept: 'application/vnd.npm.install-v1+json' }
  const doIt = async (px) => {
    const o = { ...opts, proxy: px }
    if (registry && registry !== 'auto') {
      const src = SOURCES.find((s) => s.id === registry) || SOURCES[0]
      return { data: await requestOnce(`${src.base}/${ENCODED}`, o), source: src.id, label: src.label }
    }
    return await race(`/${ENCODED}`, o)
  }
  const result = await withProxyFallback(proxy, doIt)
  const all = Object.keys((result.data && result.data.versions) || {})
  const stable = all.filter((v) => !v.includes('-'))
  const tagged = (result.data && result.data['dist-tags']) || {}
  const value = {
    versions: all.sort((a, b) => compareVersion(b, a)),
    stable: stable.sort((a, b) => compareVersion(b, a)),
    latest: tagged.latest || null,
    next: tagged.next || null,
    source: result.label,
    viaProxy: result.viaProxy !== false,
    proxyError: result.proxyError || null,
    at: Date.now(),
  }
  versionsCache = { value, at: Date.now() }
  return value
}

export function invalidate() {
  latestCache = null
  versionsCache = null
}

// 只读缓存，用于 /api/status 里展示"上次查到的版本"，不触发网络请求
export function peekLatest() {
  return latestCache
}

export async function testProxy(proxy) {
  const p = parseProxy(proxy)
  if (!p) return { ok: false, message: '代理地址格式不对，应形如 http://127.0.0.1:7890' }
  const started = Date.now()
  try {
    const data = await requestOnce(`https://registry.npmmirror.com/${ENCODED}/latest`, { proxy, timeout: 8000 })
    return { ok: true, host: p.host, port: p.port, ms: Date.now() - started, version: data.version || null, message: '代理可用' }
  } catch (e) {
    return { ok: false, host: p.host, port: p.port, ms: Date.now() - started, message: '代理不通：' + e.message }
  }
}

export async function testRegistry(registry) {
  const src = registry && registry !== 'auto' ? SOURCES.find((s) => s.id === registry) || SOURCES[0] : null
  const started = Date.now()
  if (src) {
    try {
      const data = await requestOnce(`${src.base}/${ENCODED}/latest`, { timeout: 8000 })
      return { ok: true, url: src.base, ms: Date.now() - started, version: data.version || null, message: `${src.label} 可用` }
    } catch (e) {
      return { ok: false, url: src.base, ms: Date.now() - started, message: e.message }
    }
  }
  try {
    const r = await race(`/${ENCODED}/latest`, { timeout: 8000 })
    return { ok: true, url: r.label, ms: r.ms, version: r.data.version || null, message: `${r.label} 响应最快` }
  } catch (e) {
    return { ok: false, url: 'auto', ms: Date.now() - started, message: e.message }
  }
}
