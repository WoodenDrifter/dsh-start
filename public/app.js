// 外壳：导航、路由、状态轮询、SSE、以及"关页即退"的三件套（hello / heartbeat / bye）。
import { h, clear, toast } from './ui.js'
import { api, onJob } from './api.js'
import * as overview from './pages/overview.js'
import * as dsh from './pages/dsh.js'
import * as update from './pages/update.js'
import * as hosts from './pages/hosts.js'
import * as settings from './pages/settings.js'
import * as env from './pages/env.js'
import * as devices from './pages/devices.js'
import * as keys from './pages/keys.js'

const TABS = {
  overview: { label: '概览', icon: '▤', page: overview, group: 'main' },
  dsh: { label: 'dsh web', icon: '◈', page: dsh, group: 'service', dot: 'web' },
  update: { label: '更新与回退', icon: '⬆', page: update, group: 'version' },
  hosts: { label: '域名白名单', icon: '⚑', page: hosts, group: 'security' },
  devices: { label: '授权设备', icon: '▣', page: devices, group: 'security' },
  keys: { label: '密钥', icon: '⚿', page: keys, group: 'security' },
  settings: { label: '设置', icon: '⚙', page: settings, group: 'system' },
  env: { label: '环境体检', icon: '✚', page: env, group: 'system' },
}

const GROUPS = [
  { key: 'main', label: null },
  { key: 'service', label: '服务' },
  { key: 'version', label: '版本' },
  { key: 'security', label: '安全' },
  { key: 'system', label: '系统' },
]

const state = {
  status: null,
  page: null,
  pageEl: null,
  tabId: sessionStorage.getItem('dsh-tab') || crypto.randomUUID(),
  navDots: {},
}

sessionStorage.setItem('dsh-tab', state.tabId)

// ---------------------------------------------------------------- 导航
function buildSidebar() {
  const nav = document.getElementById('nav')
  clear(nav)
  for (const g of GROUPS) {
    const items = Object.entries(TABS).filter(([, t]) => t.group === g.key)
    if (!items.length) continue
    if (g.label) nav.appendChild(h('div', { class: 'nav-label' }, g.label))
    for (const [id, t] of items) {
      const dot = h('i', { class: 'dot' })
      const el = h(
        'button',
        { class: 'nav-item', dataset: { id }, onclick: () => location.hash = '#/' + id },
        h('span', { class: 'ico' }, t.icon),
        h('span', { class: 'grow ellipsis' }, t.label),
        t.dot ? dot : null
      )
      state.navDots[t.dot || id] = dot
      nav.appendChild(el)
    }
    if (g.key !== 'system') nav.appendChild(h('div', { class: 'nav-sep' }))
  }
}

function markActive() {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.dataset.id === state.page)
  }
}

function updateNavDots(status) {
  const web = state.navDots.web
  if (web) {
    web.className = 'dot ' + (status.web.running ? 'on' : '')
    web.title = status.web.running ? '运行中' : '未运行'
  }
}

// ---------------------------------------------------------------- 路由
function currentId() {
  const id = (location.hash || '').replace(/^#\/?/, '').split('?')[0]
  return TABS[id] ? id : 'overview'
}

async function route() {
  const id = currentId()
  state.page = id
  markActive()
  const view = document.getElementById('view')
  clear(view)
  const t = TABS[id]
  const ctx = {
    get status() {
      return state.status
    },
    refresh: () => pollStatus(true),
    open: (target) => api.post('/api/system/open', { target }).catch(() => {}),
  }
  state.pageEl = view
  try {
    const api2 = await t.page.render(view, ctx)
    state.pageApi = api2 || null
    if (state.status && api2 && api2.update) api2.update(state.status)
  } catch (e) {
    view.appendChild(h('div', { class: 'empty' }, '页面渲染失败：' + e.message))
  }
}

// ---------------------------------------------------------------- 状态
let polling = false
async function pollStatus(force = false) {
  if (polling) return
  polling = true
  try {
    const s = await api.get('/api/status', { quiet: !force })
    state.status = s
    updateNavDots(s)
    const foot = document.getElementById('foot')
    foot.textContent = `控制台 :${s.console.port} · 已运行 ${Math.floor((Date.now() - s.console.startedAt) / 1000)}s`
    if (state.pageApi && state.pageApi.update) state.pageApi.update(s)
    if (s.job) {
      const el = document.getElementById('jobbar')
      if (el) el.textContent = `${s.job.title} · ${s.job.percent}% · ${s.job.message || ''}`
    }
  } catch {
    const foot = document.getElementById('foot')
    if (foot) foot.textContent = '控制台连接中断'
  } finally {
    polling = false
  }
}

// ---------------------------------------------------------------- 会话保活
function startSession() {
  api.post('/api/system/hello', { tabId: state.tabId }).catch(() => {})

  const es = new EventSource('/api/events?sid=' + encodeURIComponent(state.tabId))
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse(ev.data)
      onJobEmit(job)
      if (job.status === 'done' || job.status === 'error') pollStatus(true)
    } catch {}
  })
  // EventSource 自带重连；连续失败也不会崩，状态轮询仍在跑

  setInterval(() => {
    if (document.visibilityState === 'visible') api.post('/api/system/heartbeat', { sessionId: state.tabId }, { quiet: true }).catch(() => {})
  }, 5000)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollStatus(true)
  })

  // 关闭标签页时唯一保证送达的通道
  window.addEventListener('pagehide', () => {
    try {
      const blob = new Blob([JSON.stringify({ sessionId: state.tabId })], { type: 'application/json' })
      navigator.sendBeacon('/api/system/bye', blob)
    } catch {}
    try {
      es.close()
    } catch {}
  })
  window.addEventListener('beforeunload', () => {
    try {
      navigator.sendBeacon('/api/system/bye', new Blob([JSON.stringify({ sessionId: state.tabId })], { type: 'application/json' }))
    } catch {}
  })
}

function onJobEmit(job) {
  if (state.pageApi && state.pageApi.job) state.pageApi.job(job)
}

// ---------------------------------------------------------------- 启动
function boot() {
  buildSidebar()
  document.getElementById('quit').addEventListener('click', async () => {
    const ok = window.confirm('退出控制台？\n\ndsh web 会继续运行，不受影响。')
    if (!ok) return
    try {
      await api.post('/api/system/quit')
    } catch {}
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;color:#b0b3b8;font:14px/1.8 \'Segoe UI\',sans-serif;text-align:center">' +
      '<div><div style="font-size:16px;color:#e6e6e8;margin-bottom:6px">控制台已退出</div>' +
      'dsh web 仍在后台运行。<br>需要时再双击桌面快捷方式即可。</div></div>'
  })
  startSession()
  window.addEventListener('hashchange', route)
  route()
  pollStatus(true)
  setInterval(() => pollStatus(), 2000)
}

boot()
toast('控制台已连接', 'ok')
