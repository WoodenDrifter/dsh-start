// settings.json 读写：保留旧版本的键（window 等）原样不动，只合并已知键。
import fs from 'node:fs'
import { FILE, DIR } from './paths.js'
import { readJson, writeJsonAtomic, ensureDir, exists } from './util.js'

export const DEFAULTS = {
  port: 3080,
  bindHost: '127.0.0.1',
  proxy: '',
  registry: 'auto',
  onClose: 'closeUi',
  trustedHosts: [],
  cookieDays: 90,
  renewDays: 30,
}

// 已知键之外的（window 等）保留下来，避免把旧配置写丢
let cache = null
let cacheMtime = 0

export function load() {
  let st = null
  try {
    st = fs.statSync(FILE.settings)
  } catch {}
  const mtime = st ? st.mtimeMs : 0
  if (cache && mtime === cacheMtime) return cache

  const raw = readJson(FILE.settings, null)
  if (raw === null && exists(FILE.settings)) {
    // 文件存在但解析失败：改名留档，别反复踩同一个坑
    try {
      fs.renameSync(FILE.settings, FILE.settings + '.bad')
    } catch {}
  }
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  merged.port = Number(merged.port) || DEFAULTS.port
  merged.bindHost = String(merged.bindHost || DEFAULTS.bindHost)
  merged.trustedHosts = Array.isArray(merged.trustedHosts) ? merged.trustedHosts.filter(Boolean).map(String) : []
  cache = merged
  cacheMtime = mtime
  return merged
}

export function patch(values) {
  ensureDir(DIR.config)
  const current = load()
  const next = { ...current, ...values }
  writeJsonAtomic(FILE.settings, next)
  cache = null
  cacheMtime = 0
  return load()
}

export function publicView() {
  const s = load()
  return {
    port: s.port,
    bindHost: s.bindHost,
    proxy: s.proxy,
    registry: s.registry,
    trustedHosts: s.trustedHosts,
    cookieDays: s.cookieDays,
    renewDays: s.renewDays,
  }
}
