// 统一 API 客户端：信封解包、错误 toast、任务订阅。
import { toast } from './ui.js'

export class ApiError extends Error {
  constructor(code, message, detail, status) {
    super(message)
    this.code = code
    this.detail = detail
    this.status = status
  }
}

async function call(method, path, body, { quiet = false } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    })
  } catch (e) {
    if (!quiet) toast('无法连接控制台服务（可能已退出）', 'err')
    throw new ApiError('NETWORK', '无法连接控制台服务', null, 0)
  }
  let j = null
  try {
    j = await res.json()
  } catch {
    if (!quiet) toast(`服务返回异常（HTTP ${res.status}）`, 'err')
    throw new ApiError('BAD_JSON', '服务返回异常', null, res.status)
  }
  if (!j || j.ok !== true) {
    const err = (j && j.error) || {}
    if (err.code === 'NEED_KEY') {
      if (!quiet) toast('访问凭据失效，请从桌面快捷方式重新打开', 'err')
    } else if (!quiet) {
      toast(err.message || `请求失败（HTTP ${res.status}）`, 'err')
    }
    throw new ApiError(err.code || 'FAILED', err.message || '请求失败', err.detail, res.status)
  }
  return j.data
}

export const api = {
  get: (p, o) => call('GET', p, null, o),
  post: (p, b, o) => call('POST', p, b || {}, o),
  put: (p, b, o) => call('PUT', p, b || {}, o),
  patch: (p, b, o) => call('PATCH', p, b || {}, o),
  del: (p, o) => call('DELETE', p, null, o),
}

// 任务进度：优先走 SSE，断线后降级为轮询
const listeners = new Set()
export function onJob(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function emitJob(job) {
  for (const fn of listeners) {
    try {
      fn(job)
    } catch {}
  }
}

export async function waitJob(jobId, { onUpdate = () => {} } = {}) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < 31 * 60 * 1000) {
    let j = null
    try {
      j = await api.get(`/api/jobs/${jobId}`, { quiet: true })
    } catch {}
    if (j) {
      last = j
      onUpdate(j)
      if (j.status === 'done') return j
      if (j.status === 'error') {
        const err = new ApiError('JOB_ERROR', j.error || '任务失败', j.result && j.result.detail)
        throw err
      }
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new ApiError('TIMEOUT', '任务超时未完成', last)
}
