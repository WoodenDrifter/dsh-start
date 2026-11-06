// 通用小工具：延时、原子写、JSON、字节格式化、版本比较、编码回退。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const IS_WIN = process.platform === 'win32'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

export function safeStat(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

export function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function fmtBytes(n) {
  if (!n && n !== 0) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i]
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${sec} 秒`
  return `${sec} 秒`
}

// "1.2.10-rc.2" 之类，返回 -1/0/1；无法解析时按字符串比较
export function compareVersion(a, b) {
  const parse = (v) => {
    const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    if (!m) return null
    return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || '' }
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return String(a) === String(b) ? 0 : String(a) > String(b) ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1 // 正式版 > 预发布
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

export function shortPath(p, max = 46) {
  if (!p) return ''
  const s = String(p)
  if (s.length <= max) return s
  return s.slice(0, 12) + '…' + s.slice(-(max - 13))
}

// 按行尾读文件，避免把几百 MB 的日志整块读进内存
export function tailLines(file, lines = 200, maxBytes = 512 * 1024) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const text = decodeBytes(buf)
    const arr = text.split(/\r?\n/)
    if (start > 0) arr.shift()
    return arr.slice(-lines).join('\n')
  } catch {
    return ''
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

// Windows 上大量程序输出 GBK；严格 UTF-8 解不出来就退回 GBK
const GBK = (() => {
  try {
    return new TextDecoder('gbk')
  } catch {
    return null
  }
})()

export function decodeBytes(buf) {
  if (typeof buf === 'string') return buf
  const b = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return GBK ? GBK.decode(b) : b.toString('utf8')
  }
}

export function homedir() {
  return os.homedir()
}

export function uniqBy(arr, keyFn) {
  const seen = new Set()
  const out = []
  for (const it of arr) {
    const k = keyFn(it)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it)
  }
  return out
}

export function normalizeHost(raw) {
  let t = String(raw || '').trim().toLowerCase()
  if (!t) return null
  if (/^\w+:\/\//.test(t)) t = t.split('://').slice(1).join('://')
  t = t.split(/[/?#]/)[0].trim().replace(/\.+$/, '')
  if (/\s/.test(t)) return null
  if (!/^[a-z0-9._:\-[\]]+$/.test(t)) return null
  const hn = t.split(':')[0]
  if (hn === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hn)) return t
  return hn.includes('.') ? t : null
}

export function fileTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function withinDir(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  return c === p || c.startsWith(p + path.sep)
}
