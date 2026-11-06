// config/runtime.json：控制台/服务进程的记录。它是辅助证据，不是唯一真相。
import { FILE } from './paths.js'
import { readJson, writeJsonAtomic, ensureDir } from './util.js'
import { DIR } from './paths.js'

export function get() {
  return readJson(FILE.runtime, {}) || {}
}

export function patch(values) {
  ensureDir(DIR.config)
  const cur = get()
  const next = { ...cur }
  for (const [k, v] of Object.entries(values)) {
    next[k] = v === null ? undefined : { ...(cur[k] || {}), ...v }
    if (next[k] === undefined) delete next[k]
  }
  try {
    writeJsonAtomic(FILE.runtime, next)
  } catch {}
  return next
}

export function clear(key) {
  const cur = get()
  if (!(key in cur)) return cur
  delete cur[key]
  try {
    writeJsonAtomic(FILE.runtime, cur)
  } catch {}
  return cur
}
