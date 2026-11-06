// 长任务：阶段 + 百分比 + 日志。同一时刻只允许一个（与旧版一致），
// 避免两次 npm install 撞在一起把 dsh 装坏。
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DIR } from '../lib/paths.js'
import { ensureDir } from '../lib/util.js'
import * as sse from './sse.js'

const jobs = new Map()
const MAX_JOBS = 30

class Job {
  constructor(kind, title) {
    this.id = randomBytes(5).toString('hex')
    this.kind = kind
    this.title = title
    this.status = 'running'
    this.stage = 'init'
    this.percent = 0
    this.message = '准备中…'
    this.startedAt = Date.now()
    this.endedAt = null
    this.error = null
    this.result = null
    this.lines = []
    this.file = path.join(DIR.jobs, `${this.id}.log`)
    ensureDir(DIR.jobs)
    this.snapshot = this.snapshot.bind(this)
  }

  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      status: this.status,
      stage: this.stage,
      percent: this.percent,
      message: this.message,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error,
      result: this.result,
      lines: this.lines.slice(-120),
    }
  }

  emit() {
    sse.broadcast('job', this.snapshot())
  }

  progress(p) {
    if (typeof p === 'string') p = { message: p }
    if (p.stage !== undefined) this.stage = p.stage
    if (p.percent !== undefined) this.percent = Math.max(0, Math.min(100, Math.round(p.percent)))
    if (p.message !== undefined) {
      this.message = p.message
      this.line(p.message)
    }
    this.emit()
  }

  line(text) {
    const item = { t: Date.now(), text: String(text) }
    this.lines.push(item)
    if (this.lines.length > 400) this.lines.shift()
    try {
      fs.appendFileSync(this.file, `[${new Date(item.t).toISOString()}] ${item.text}\n`, 'utf8')
    } catch {}
  }

  finish(status, { error = null, result = null, message = null } = {}) {
    this.status = status
    this.endedAt = Date.now()
    this.error = error
    this.result = result
    if (status === 'done') this.percent = 100
    if (message) this.message = message
    this.emit()
  }
}

export function running() {
  for (const j of jobs.values()) if (j.status === 'running') return j
  return null
}

export function list() {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((j) => j.snapshot())
}

export function get(id) {
  const j = jobs.get(id)
  return j ? j.snapshot() : null
}

export function start(kind, title, fn) {
  const busy = running()
  if (busy) {
    const e = new Error('已有任务在进行中：' + busy.title)
    e.code = 'JOB_RUNNING'
    e.job = busy.snapshot()
    throw e
  }
  const job = new Job(kind, title)
  jobs.set(job.id, job)
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest) jobs.delete(oldest.id)
  }
  job.emit()

  // 任务体异步跑，异常统一收敛成 job.status = 'error'
  Promise.resolve()
    .then(() => fn(job))
    .then((result) => {
      if (job.status === 'running') job.finish('done', { result })
    })
    .catch((e) => {
      job.line('✗ ' + (e && e.message ? e.message : String(e)))
      job.finish('error', { error: e && e.message ? e.message : String(e), result: e && e.detail ? { detail: e.detail } : null })
    })

  return job
}
