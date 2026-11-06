// 最小可用的 zip 读写（零依赖）。
//
// 读：只信中央目录的 csize/usize（local header 里可能是 0，带 data descriptor），
//     支持 store/deflate，非 ASCII 名按 UTF-8 → GBK 回退解码，带 zip-slip 防护。
// 写：逐文件 deflateRaw 之后回填 crc/size（不用 data descriptor，兼容性最好），
//     先写 .part 再 rename，避免半截文件污染备份列表。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { withinDir, decodeBytes } from './util.js'

// ---------------------------------------------------------------- crc32
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf, prev = 0) {
  let c = prev ^ -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8')
  const s = decodeBytes(buf)
  return s
}

// ---------------------------------------------------------------- 读
export function readEntries(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 22) throw new Error('不是有效的 zip（文件太小）')

    // EOCD 在最尾部，注释最长 65535，从后往前扫
    const scanLen = Math.min(size, 65557)
    const tail = Buffer.alloc(scanLen)
    fs.readSync(fd, tail, 0, scanLen, size - scanLen)
    let eocd = -1
    for (let i = scanLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('找不到 zip 中央目录（文件可能损坏）')

    const total = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 大备份，请用 7-Zip 手动解压')
    }

    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOffset)

    const out = []
    let p = 0
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) break
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      const csize = cd.readUInt32LE(p + 20)
      const usize = cd.readUInt32LE(p + 24)
      const nlen = cd.readUInt16LE(p + 28)
      const elen = cd.readUInt16LE(p + 30)
      const clen = cd.readUInt16LE(p + 32)
      const offset = cd.readUInt32LE(p + 42)
      const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), flags)
      out.push({ name: name.replace(/\\/g, '/'), flags, method, crc, csize, usize, offset })
      p += 46 + nlen + elen + clen
    }
    return out
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

function entryDataOffset(fd, entry) {
  const lh = Buffer.alloc(30)
  fs.readSync(fd, lh, 0, 30, entry.offset)
  if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error('文件头损坏：' + entry.name)
  const nlen = lh.readUInt16LE(26)
  const elen = lh.readUInt16LE(28)
  return entry.offset + 30 + nlen + elen
}

export function readEntryBuffer(file, entry) {
  const fd = fs.openSync(file, 'r')
  try {
    const start = entryDataOffset(fd, entry)
    const buf = Buffer.alloc(entry.csize)
    if (entry.csize) fs.readSync(fd, buf, 0, entry.csize, start)
    if (entry.method === 0) return buf
    if (entry.method === 8) return zlib.inflateRawSync(buf)
    throw new Error(`不支持的压缩方式 ${entry.method}（${entry.name}），请用 7-Zip 打开`)
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

export function readText(file, name) {
  const entries = readEntries(file)
  const hit = entries.find((e) => e.name === name)
  if (!hit) return null
  return readEntryBuffer(file, hit).toString('utf8')
}

// Windows 上「只读」属性的文件不能直接 open 写入，会抛 EPERM/EACCES；
// 被别的进程占着时也会失败。这里按三级降级：直接写 → 清只读再写 → 改名让位再写。
function writeFileForce(target, data) {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY'])
  try {
    fs.writeFileSync(target, data)
    return
  } catch (e) {
    if (!transient.has(e.code)) throw e
  }
  try {
    fs.chmodSync(target, 0o666)
  } catch {}
  try {
    fs.writeFileSync(target, data)
    return
  } catch (e) {
    if (!transient.has(e.code)) throw e
  }
  // 最后手段：把旧文件挪开（Windows 允许改名已打开的文件），再写新的
  const bak = `${target}.dsh-old-${Date.now()}`
  let moved = false
  try {
    fs.renameSync(target, bak)
    moved = true
  } catch {}
  try {
    fs.writeFileSync(target, data)
  } finally {
    if (moved) {
      try {
        fs.chmodSync(bak, 0o666)
      } catch {}
      try {
        fs.unlinkSync(bak)
      } catch {}
    }
  }
}

// 解压到目录；onSkip(name) 返回 true 表示跳过；onError(name, err) 用于收集失败项（返回后继续）
export function extract(file, destDir, { onEntry = null, onError = null } = {}) {
  const entries = readEntries(file)
  let written = 0
  let skipped = 0
  const failed = []
  for (const e of entries) {
    const parts = e.name.split('/').filter(Boolean)
    if (!parts.length) continue
    if (parts.some((p) => p === '..') || /^[a-zA-Z]:/.test(e.name) || e.name.startsWith('/')) {
      skipped++
      continue
    }
    const target = path.join(destDir, ...parts)
    if (!withinDir(destDir, target)) {
      skipped++
      continue
    }
    if (e.name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    if (onEntry && onEntry(e.name) === true) {
      skipped++
      continue
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      writeFileForce(target, e.usize === 0 ? Buffer.alloc(0) : readEntryBuffer(file, e))
      written++
    } catch (err) {
      failed.push({ name: e.name, code: err.code || 'ERR', message: err.message })
      if (onError) onError(e.name, err)
    }
  }
  return { written, skipped, failed, total: entries.length }
}

// ---------------------------------------------------------------- 写
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

// files: [{ name, absPath }] 或 [{ name, data }]
export async function write(file, files, { onProgress = null, level = 6 } = {}) {
  let totalBytes = 0
  for (const f of files) totalBytes += f.data ? f.data.length : (fs.statSync(f.absPath).size || 0)
  if (!totalBytes) totalBytes = 1

  let doneBytes = 0
  const tmp = file + '.part'
  const fd = fs.openSync(tmp, 'w')
  const central = []
  const { time, date } = dosTime(new Date())

  try {
    for (const f of files) {
      const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8')
      const flags = /[^\x00-\x7F]/.test(f.name) ? 0x800 : 0
      const offset = fs.fstatSync(fd).size

      const loc = Buffer.alloc(30)
      loc.writeUInt32LE(SIG_LOCAL, 0)
      loc.writeUInt16LE(20, 4)
      loc.writeUInt16LE(flags, 6)
      loc.writeUInt16LE(8, 8) // deflate
      loc.writeUInt16LE(time, 10)
      loc.writeUInt16LE(date, 12)
      // crc / csize / usize 先写 0，压缩完再按绝对偏移回填
      loc.writeUInt16LE(nameBuf.length, 26)
      loc.writeUInt16LE(0, 28)
      fs.writeSync(fd, loc)
      fs.writeSync(fd, nameBuf)

      const payload = f.data || fs.readFileSync(f.absPath)
      const comp = zlib.deflateRawSync(payload, { level })
      fs.writeSync(fd, comp)

      const crc = crc32(payload, 0)
      const patch = Buffer.alloc(12)
      patch.writeUInt32LE(crc >>> 0, 0)
      patch.writeUInt32LE(comp.length, 4)
      patch.writeUInt32LE(payload.length, 8)
      fs.writeSync(fd, patch, 0, 12, offset + 14)

      central.push({ nameBuf, flags, crc, csize: comp.length, usize: payload.length, offset, time, date })

      doneBytes += payload.length
      if (onProgress) onProgress(Math.min(doneBytes, totalBytes), totalBytes, f.name)
    }

    const cdStart = fs.fstatSync(fd).size
    for (const c of central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(SIG_CENTRAL, 0)
      h.writeUInt16LE(20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(c.flags, 8)
      h.writeUInt16LE(8, 10)
      h.writeUInt16LE(c.time, 12)
      h.writeUInt16LE(c.date, 14)
      h.writeUInt32LE(c.crc >>> 0, 16)
      h.writeUInt32LE(c.csize, 20)
      h.writeUInt32LE(c.usize, 24)
      h.writeUInt16LE(c.nameBuf.length, 28)
      h.writeUInt16LE(0, 30)
      h.writeUInt16LE(0, 32)
      h.writeUInt16LE(0, 34)
      h.writeUInt16LE(0, 36)
      h.writeUInt32LE(0, 38)
      h.writeUInt32LE(c.offset, 42)
      fs.writeSync(fd, h)
      fs.writeSync(fd, c.nameBuf)
    }
    const cdSize = fs.fstatSync(fd).size - cdStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    fs.writeSync(fd, eocd)
  } finally {
    fs.closeSync(fd)
  }

  fs.renameSync(tmp, file)
  return { size: fs.statSync(file).size, entries: central.length }
}
