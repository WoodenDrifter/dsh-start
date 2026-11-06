// 应用日志：logs/app.log，2MB 轮转保留 1 份；控制台同时输出到 stdout 便于调试。
import fs from 'node:fs'
import { FILE, DIR } from './paths.js'
import { ensureDir } from './util.js'

const MAX = 2 * 1024 * 1024
let lastRotateCheck = 0

function rotateIfNeeded() {
  const now = Date.now()
  if (now - lastRotateCheck < 5000) return
  lastRotateCheck = now
  try {
    const st = fs.statSync(FILE.appLog)
    if (st.size > MAX) fs.renameSync(FILE.appLog, FILE.appLog + '.1')
  } catch {}
}

function line(level, msg) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `[${ts}] [${String(level).padEnd(5)}] ${msg}`
}

export function log(msg, level = 'info') {
  const l = line(level, msg)
  try {
    ensureDir(DIR.logs)
    rotateIfNeeded()
    fs.appendFileSync(FILE.appLog, l + '\n', 'utf8')
  } catch {}
  if (process.env.DSH_START_QUIET !== '1') {
    const out = level === 'error' ? process.stderr : process.stdout
    try {
      out.write(l + '\n')
    } catch {}
  }
}

export const info = (m) => log(m, 'info')
export const warn = (m) => log(m, 'warn')
export const error = (m) => log(m, 'error')

export function boot(msg) {
  try {
    ensureDir(DIR.logs)
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    fs.appendFileSync(FILE.bootLog, `[${ts}] ${msg}\n`, 'utf8')
  } catch {}
}
