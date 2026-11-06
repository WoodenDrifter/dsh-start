// "关掉就全退"状态机。
//
// 判据优先级：
//   1. SSE 连接 —— 关闭标签页时 TCP 立刻 FIN，不受后台标签定时器节流影响，最可靠
//   2. pagehide 的 sendBeacon（bye）—— 关闭瞬间唯一保证送达的通道
//   3. 心跳 —— 只在 SSE 已断（比如浏览器崩溃）时兜底
//
// 两个不能退的时刻：
//   · 宽限期（8 秒）内 —— 吸收刷新 / 前进后退造成的瞬时全断
//   · 有长任务在跑（npm install、解压备份）—— 中途退出会留下半装状态
import * as jobs from './jobs.js'

// 时间参数允许用环境变量覆盖，便于自动化验证（默认值即产品行为）
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
const GRACE = num(process.env.DSH_START_GRACE_MS, 8000) // 最后一路信号消失后的宽限
const IDLE = num(process.env.DSH_START_IDLE_MS, 75000) // 心跳兜底：后台标签的定时器会被节流到 60 秒
const BOOT_DEADLINE = num(process.env.DSH_START_BOOT_MS, 120000) // 双击后浏览器一直没连上来 → 自己退，别留孤儿
const JOB_WAIT_MAX = 30 * 60 * 1000 // 等任务最多 30 分钟

const sessions = new Map()
let timer = null
let shuttingDown = false
let onShutdown = null
let bootTimer = null
let everHello = false
let waitingJobSince = 0

export function init({ shutdown }) {
  onShutdown = shutdown
  // 开发／自动化场景：没人 hello 也不要自杀
  if (process.env.DSH_START_NO_WATCHDOG === '1') return
  bootTimer = setTimeout(() => {
    if (!everHello) {
      shuttingDown = true
      onShutdown('boot-timeout')
    }
  }, BOOT_DEADLINE)
  bootTimer.unref?.()
}

function rec(sid) {
  if (!sessions.has(sid)) sessions.set(sid, { sid, lastSeen: 0, sse: 0 })
  return sessions.get(sid)
}

export function hello(sid) {
  everHello = true
  const s = rec(sid)
  s.lastSeen = Date.now()
  waitingJobSince = 0
  cancel()
  return { sessionId: sid, idleTimeout: IDLE, grace: GRACE }
}

export function heartbeat(sid) {
  const s = rec(sid)
  s.lastSeen = Date.now()
  waitingJobSince = 0
  cancel()
  return { alive: true }
}

export function bye(sid) {
  const s = rec(sid)
  s.lastSeen = 0
  s.sse = 0
  schedule()
}

export function sseOpen(sid) {
  everHello = true
  const s = rec(sid || 'sse')
  s.sse++
  s.lastSeen = Date.now()
  waitingJobSince = 0
  cancel()
}

export function sseClose(sid) {
  const s = rec(sid || 'sse')
  s.sse = Math.max(0, s.sse - 1)
  // 注意：这里刻意不刷新 lastSeen。
  // 否则"关闭标签页"时稍后到达的 SSE close 会把 bye 刚清掉的时间戳写回来，
  // 让进程多挂 75 秒（实测就是这样）。崩溃场景靠最后一次心跳计时即可。
  schedule()
}

function aliveCount(now) {
  let n = 0
  for (const s of sessions.values()) if (s.sse > 0 || (s.lastSeen > 0 && now - s.lastSeen < IDLE)) n++
  return n
}

function cancel() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function schedule(delay = GRACE) {
  cancel()
  if (shuttingDown) return
  timer = setTimeout(onTimer, delay)
  timer.unref?.()
}

function onTimer() {
  timer = null
  if (shuttingDown) return
  const now = Date.now()

  if (aliveCount(now) > 0) {
    // 还有活会话：如果只是没有 SSE（浏览器崩溃 / 后台标签），
    // 按最后一次心跳把空闲窗口等完再复查一次 —— 不重排的话进程会永远挂着。
    let hasSse = false
    let newest = 0
    for (const s of sessions.values()) {
      if (s.sse > 0) hasSse = true
      if (s.lastSeen > newest) newest = s.lastSeen
    }
    if (!hasSse && newest > 0) {
      schedule(Math.max(1000, newest + IDLE - now + 500))
    }
    return
  }

  // 没有活会话，但任务还在跑：等它做完再退，避免半装
  if (jobs.running()) {
    if (!waitingJobSince) waitingJobSince = now
    if (now - waitingJobSince < JOB_WAIT_MAX) {
      schedule(15000)
      return
    }
  }

  shuttingDown = true
  clearTimeout(bootTimer)
  if (onShutdown) onShutdown(jobs.running() ? 'job-timeout' : 'idle')
}

export function stats() {
  const now = Date.now()
  let open = 0
  for (const s of sessions.values()) if (s.sse > 0) open += s.sse
  return {
    sessions: sessions.size,
    sse: open,
    alive: aliveCount(now),
    job: jobs.running() ? jobs.running().kind : null,
    exitInMs: timer ? GRACE : null,
  }
}
