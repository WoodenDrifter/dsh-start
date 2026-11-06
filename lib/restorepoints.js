// 回退点：每次更新前落一条记录（旧版本号 + 数据备份名），可一键退回。
import fs from 'node:fs'
import path from 'node:path'
import { DIR } from './paths.js'
import { ensureDir, readJson, writeJsonAtomic, safeStat } from './util.js'

export function list() {
  let names = []
  try {
    names = fs.readdirSync(DIR.restorePoints)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!/\.json$/i.test(n) || n.endsWith('.tmp')) continue
    const full = path.join(DIR.restorePoints, n)
    const j = readJson(full, null)
    if (!j) continue
    const st = safeStat(full)
    out.push({
      id: j.id || n.replace(/\.json$/, ''),
      kind: j.kind || 'update',
      fromVersion: j.fromVersion || null,
      toVersion: j.toVersion || null,
      createdAt: j.createdAt || (st ? new Date(st.mtimeMs).toISOString() : null),
      status: j.status || 'unknown',
      backup: j.backup || null,
      message: j.message || null,
    })
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return out
}

export function get(id) {
  return list().find((r) => r.id === id) || null
}

export function create(entry) {
  ensureDir(DIR.restorePoints)
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const record = {
    id,
    kind: entry.kind || 'update',
    fromVersion: entry.fromVersion || null,
    toVersion: entry.toVersion || null,
    createdAt: new Date().toISOString(),
    status: entry.status || 'pending',
    backup: entry.backup || null,
    message: entry.message || null,
  }
  writeJsonAtomic(path.join(DIR.restorePoints, `${id}.json`), record)
  return record
}

export function update(id, patch) {
  const full = path.join(DIR.restorePoints, `${id}.json`)
  const cur = readJson(full, null)
  if (!cur) return null
  const next = { ...cur, ...patch }
  writeJsonAtomic(full, next)
  return next
}

export function remove(id, { withBackup = false } = {}) {
  if (!id || /[\\/]/.test(String(id))) throw new Error('非法的回退点 ID')
  const base = String(id).replace(/\.json$/i, '')
  const full = path.join(DIR.restorePoints, `${base}.json`)

  const rec = readJson(full, null)
  if (!rec) {
    // 记录已经不在了：不算失败，让调用方如实回一句「已不存在」即可
    return { deleted: false, reason: 'not-found', id: base, remaining: list().length }
  }

  hardDelete(full, '回退点')

  let backup = null
  if (withBackup && rec.backup) {
    const zip = path.join(DIR.backups, path.basename(String(rec.backup)))
    if (fs.existsSync(zip)) {
      try {
        hardDelete(zip, '备份')
        backup = { deleted: true, name: path.basename(zip) }
      } catch (e) {
        backup = { deleted: false, name: path.basename(zip), error: e.message }
      }
    } else {
      backup = { deleted: false, name: path.basename(String(rec.backup)), error: '备份文件不存在' }
    }
  }

  return { deleted: true, id: base, backup, remaining: list().length }
}

// 只读属性 / 被短暂占用时，先清属性再删；仍失败就抛带错误码的异常，别吞掉
function hardDelete(file, label) {
  try {
    fs.rmSync(file, { force: true })
    return
  } catch (e) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
      const err = new Error(`删除${label}失败：${e.code || e.message}`)
      err.code = 'DELETE_FAILED'
      throw err
    }
  }
  try {
    fs.chmodSync(file, 0o666)
    fs.rmSync(file, { force: true })
  } catch (e2) {
    const err = new Error(`删除${label}失败：${e2.code || e2.message}`)
    err.code = 'DELETE_FAILED'
    throw err
  }
}

// 清理「指向的备份已经不在了」的失效回退点，返回删掉了几条
export function pruneOrphans() {
  const removed = []
  for (const r of list()) {
    if (!r.backup) continue
    const zip = path.join(DIR.backups, path.basename(String(r.backup)))
    if (fs.existsSync(zip)) continue
    try {
      hardDelete(path.join(DIR.restorePoints, `${r.id}.json`), '回退点')
      removed.push({ id: r.id, backup: r.backup })
    } catch {}
  }
  return { removed: removed.length, items: removed, remaining: list().length }
}
