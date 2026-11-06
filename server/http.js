// 极简 HTTP 辅助：统一信封、请求体解析、静态文件（带 ETag）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function ok(res, data = {}) {
  sendJson(res, 200, { ok: true, data, ts: Date.now() })
}

export function accepted(res, job) {
  sendJson(res, 202, { ok: true, data: { jobId: job.id, job: job.snapshot() }, ts: Date.now() })
}

export function fail(res, code, message, status = 400, detail = null) {
  sendJson(res, status, { ok: false, error: { code, message, detail }, ts: Date.now() })
}

export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let len = 0
    const chunks = []
    req.on('data', (c) => {
      len += c.length
      if (len > limit) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({ __raw: raw })
      }
    })
    req.on('error', reject)
  })
}

export function parseCookies(header = '') {
  const out = {}
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function serveStatic(req, res, rootDir, relPath) {
  const safe = path.normalize(relPath).replace(/^([/\\])+/, '')
  const full = path.join(rootDir, safe)
  if (!full.startsWith(path.resolve(rootDir))) {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'bad path' } })
    return
  }
  let st
  try {
    st = fs.statSync(full)
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
    return
  }
  if (!st.isFile()) {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
    return
  }
  const etag = 'W/"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const ext = path.extname(full).toLowerCase()
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    etag,
    'last-modified': new Date(st.mtimeMs).toUTCString(),
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate',
  }
  res.writeHead(200, headers)
  fs.createReadStream(full).pipe(res)
}

export function hashKey(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}
