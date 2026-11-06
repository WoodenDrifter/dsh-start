// 全部 API 路由。约定：返回 data 即 200；返回 {__job} 即 202；返回 {__fail} 即错误信封。
import * as settings from '../../lib/settings.js'
import * as dsh from '../../lib/dsh.js'
import * as env from '../../lib/env.js'
import * as registry from '../../lib/registry.js'
import * as update from '../../lib/update.js'
import * as rp from '../../lib/restorepoints.js'
import * as runtime from '../../lib/runtime.js'
import * as jobs from '../jobs.js'
import * as session from '../session.js'
import * as sse from '../sse.js'
import { openExternal } from '../../lib/proc.js'
import { dshVersionFromPkg, DIR, FILE, dshHome, npmPrefix, dshPkgDir, nodeExe, dshBin } from '../../lib/paths.js'
import { readJson, tailLines, normalizeHost, compareVersion, exists, fmtBytes } from '../../lib/util.js'
import * as log from '../../lib/log.js'

const fail = (code, message, status = 400, detail = null) => ({ __fail: true, code, message, status, detail })
const jobOut = (job) => ({ __job: job })

function startJob(kind, title, fn, depsExtra = {}) {
  try {
    const job = jobs.start(kind, title, fn)
    Object.assign(job, depsExtra)
    return jobOut(job)
  } catch (e) {
    if (e.code === 'JOB_RUNNING') return fail('JOB_RUNNING', e.message, 409, e.job)
    return fail('JOB_FAILED', e.message, 500)
  }
}

export function registerRoutes(router, deps) {
  // ---------------------------------------------------------------- 状态
  router.get('/api/status', async () => {
    const web = await dsh.status()
    const s = settings.load()
    const job = jobs.running()
    const inst = dshVersionFromPkg()
    const latestCache = registry.peekLatest()
    return {
      console: { pid: process.pid, port: deps.port, startedAt: deps.startedAt, version: deps.version, uptime: Date.now() - deps.startedAt },
      web,
      settings: { port: s.port, bindHost: s.bindHost, registry: s.registry, proxy: s.proxy, trustedHosts: s.trustedHosts },
      versions: { installed: inst, latest: latestCache ? latestCache.value.version : null, source: latestCache ? latestCache.value.source : null, checkedAt: latestCache ? latestCache.at : null },
      job: job ? job.snapshot() : null,
      session: session.stats(),
    }
  })

  router.get('/api/system/env', async () => await env.check())

  router.post('/api/system/hello', async ({ body }) => {
    const sid = (body && body.tabId) || 'tab'
    session.hello(sid)
    return { sessionId: sid, consolePort: deps.port, version: deps.version }
  })

  router.post('/api/system/heartbeat', async ({ body }) => {
    session.heartbeat((body && body.sessionId) || 'tab')
    return { alive: true }
  })

  router.post('/api/system/bye', async ({ body }) => {
    const sid = (body && body.sessionId) || (body && body.__raw) || 'tab'
    session.bye(String(sid).trim() || 'tab')
    return { bye: true }
  })

  router.post('/api/system/quit', async ({ res }) => {
    setTimeout(() => deps.shutdown('manual'), 200)
    return { exiting: true }
  })

  router.post('/api/system/open', async ({ body }) => {
    const target = String((body && body.target) || '')
    const map = {
      root: DIR.root,
      backups: DIR.backups,
      logs: DIR.logs,
      config: DIR.config,
      'dsh-home': dshHome(),
      'npm-global': npmPrefix(),
    }
    if (target === 'url' && body && body.url) {
      openExternal(String(body.url))
      return { opened: true, target: body.url }
    }
    const p = map[target]
    if (!p) return fail('BAD_TARGET', '未知开关：' + target)
    openExternal(p)
    return { opened: true, target: p }
  })

  // ---------------------------------------------------------------- dsh web
  router.post('/api/web/start', async () => {
    if (jobs.running()) return fail('JOB_RUNNING', '已有任务在进行中', 409)
    const job = jobs.start('web-start', '启动 dsh web', async (j) => {
      const r = await dsh.start((x) => j.progress(x))
      if (!r.ok) {
        const e = new Error(r.message || '启动失败')
        e.detail = r.detail
        throw e
      }
      j.progress({ stage: 'done', percent: 100, message: r.alreadyRunning ? '服务已在运行' : '已启动' })
      return r
    })
    return jobOut(job)
  })

  router.post('/api/web/stop', async () => {
    const r = await dsh.stop()
    if (!r.ok) return fail(r.code || 'STOP_FAILED', r.message, 400)
    return r
  })

  router.post('/api/web/restart', async () => {
    if (jobs.running()) return fail('JOB_RUNNING', '已有任务在进行中', 409)
    const job = jobs.start('web-restart', '重启 dsh web', async (j) => {
      const r = await dsh.restart((x) => j.progress(x))
      if (!r.ok) throw new Error(r.message || '重启失败')
      j.progress({ stage: 'done', percent: 100, message: '已重启' })
      return r
    })
    return jobOut(job)
  })

  router.get('/api/web/logs', async ({ query }) => {
    const lines = Math.min(Math.max(Number(query.lines) || 200, 20), 2000)
    const r = dsh.logs(query.stream === 'err' ? 'err' : 'out', lines)
    return { ...r, lines }
  })

  router.get('/api/web/access', async () => {
    const st = await dsh.status()
    return { url: st.url, token: st.token, baseUrl: st.baseUrl, running: st.running }
  })

  router.post('/api/web/verify', async () => await dsh.verify())

  // ---------------------------------------------------------------- 域名白名单
  router.get('/api/hosts', async () => {
    const s = settings.load()
    const st = await dsh.status()
    return {
      items: s.trustedHosts.map((h) => ({ host: h, active: st.running })),
      restartRequired: false,
      note: '改动后需要重启 dsh web 才会传给服务（--trusted-host）',
    }
  })

  router.post('/api/hosts', async ({ body }) => {
    const raw = body && body.value
    const host = normalizeHost(raw)
    if (!host) return fail('BAD_HOST', '网址格式不正确，例：example.com 或 https://a.example.com:8443')
    const s = settings.load()
    if (s.trustedHosts.map((x) => x.toLowerCase()).includes(host)) {
      return { host, added: false, message: '已存在', restartRequired: false }
    }
    settings.patch({ trustedHosts: [...s.trustedHosts, host] })
    log.info('已添加受信任域名：' + host)
    return { host, added: true, restartRequired: true, message: '已添加，重启 dsh web 后生效' }
  })

  router.del('/api/hosts/:host', async ({ params }) => {
    const target = String(params.host || '').toLowerCase()
    const s = settings.load()
    const next = s.trustedHosts.filter((x) => x.toLowerCase() !== target)
    if (next.length === s.trustedHosts.length) return fail('NOT_FOUND', '列表里没有这个域名')
    settings.patch({ trustedHosts: next })
    log.info('已移除受信任域名：' + target)
    return { removed: true, restartRequired: true, message: '已移除，重启 dsh web 后生效' }
  })

  // ---------------------------------------------------------------- 密钥
  // dsh web 的访问 token 与设备密钥一览。token 由 dsh web 启动时生成，写在它的 stdout 里。
  router.get('/api/keys', async () => {
    const st = await dsh.status()
    const db = readJson(FILE.devices, { devices: [] }) || { devices: [] }
    const now = Date.now() / 1000
    const devices = (db.devices || []).map((d) => {
      const exp = Number(d.expiresAt) || 0
      return {
        id: d.id || null,
        name: d.name || '(未命名)',
        createdAt: d.createdAt ? d.createdAt * 1000 : null,
        expiresAt: exp ? exp * 1000 : null,
        expired: exp ? exp < now : false,
        remainDays: exp ? Math.max(0, Math.round((exp - now) / 86400)) : null,
      }
    })
    return {
      running: st.running,
      token: st.token,
      tokenMasked: st.token ? st.token.slice(0, 4) + '…' + st.token.slice(-4) : null,
      url: st.url,
      baseUrl: st.baseUrl,
      devices,
    }
  })

  // ---------------------------------------------------------------- 设置
  router.get('/api/settings', async () => ({ settings: settings.publicView(), paths: { dshHome: dshHome(), npmPrefix: npmPrefix(), dshPkg: dshPkgDir(), node: nodeExe(), dshBin: dshBin() } }))

  router.put('/api/settings', async ({ body }) => {
    const cur = settings.load()
    const next = {}
    let restartRequired = false
    if (body && body.port !== undefined) {
      const p = Number(body.port)
      if (!Number.isInteger(p) || p < 1024 || p > 65535) return fail('BAD_PORT', '端口需在 1024–65535 之间')
      if (p !== cur.port) restartRequired = true
      next.port = p
    }
    if (body && body.bindHost !== undefined) {
      const h = String(body.bindHost).trim()
      if (!/^(\d+\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|::1)$/.test(h)) return fail('BAD_HOST', '绑定地址只接受 IP 或 localhost')
      if (h !== cur.bindHost) restartRequired = true
      next.bindHost = h
    }
    if (body && body.proxy !== undefined) next.proxy = String(body.proxy).trim()
    if (body && body.registry !== undefined) next.registry = String(body.registry).trim() || 'auto'
    settings.patch(next)
    return { settings: settings.publicView(), restartRequired, message: restartRequired ? '已保存，重启 dsh web 后生效' : '已保存' }
  })

  router.post('/api/settings/test-proxy', async ({ body }) => await registry.testProxy(body && body.proxy))
  router.post('/api/settings/test-registry', async ({ body }) => await registry.testRegistry(body && body.registry))

  // ---------------------------------------------------------------- 更新
  router.get('/api/update/check', async ({ query }) => await update.check({ force: query.force === '1' }))
  router.get('/api/update/versions', async ({ query }) => await update.versions({ force: query.force === '1' }))

  router.post('/api/update/install', async ({ body }) => {
    const version = body && body.version
    return startJob('update', '更新到 ' + version, async (j) => await update.install(j, version))
  })

  router.post('/api/update/repair', async ({ body }) => {
    const version = (body && body.version) || null
    const j = update.pendingJournal()
    const label = version || (j && j.version) || '当前版本'
    return startJob('repair', '重新安装 ' + label, async (job) => await update.repair(job, version))
  })

  router.get('/api/update/journal', async () => ({ journal: update.pendingJournal() }))

  router.get('/api/restore-points', async () => ({ items: rp.list() }))

  router.post('/api/restore-points/:id/rollback', async ({ params, body }) => {
    return startJob('rollback', '回退到旧版本', async (j) => await update.rollback(j, params.id, { restoreData: Boolean(body && body.restoreData) }))
  })

  router.del('/api/restore-points/:id', async ({ params, body }) => rp.remove(params.id, { withBackup: Boolean(body && body.withBackup) }))

  router.post('/api/restore-points/prune', async () => rp.pruneOrphans())

  // ---------------------------------------------------------------- 任务
  router.get('/api/jobs', async () => ({ items: jobs.list() }))
  router.get('/api/jobs/:id', async ({ params }) => {
    const j = jobs.get(params.id)
    if (!j) return fail('NOT_FOUND', '任务不存在', 404)
    return j
  })

  // ---------------------------------------------------------------- 设备（只读）
  router.get('/api/devices', async () => {
    const db = readJson(FILE.devices, { devices: [] }) || { devices: [] }
    const now = Date.now() / 1000
    const items = (db.devices || []).map((d) => {
      const exp = Number(d.expiresAt) || 0
      const days = exp ? Math.max(0, Math.round((exp - now) / 86400)) : null
      return {
        id: d.id || null,
        name: d.name || '(未命名)',
        authorized: d.authorized || null,
        createdAt: d.createdAt ? d.createdAt * 1000 : null,
        expiresAt: exp ? exp * 1000 : null,
        remainDays: days,
        expired: exp ? exp < now : false,
      }
    })
    const store = readJson(FILE.devices, {}) || {}
    return { items, storeVersion: store.version || null }
  })

  router.get('/api/logs', async ({ query }) => {
    const which = String(query.which || 'app')
    const map = { app: FILE.appLog, boot: FILE.bootLog, web: FILE.webOut, webErr: FILE.webErr }
    const f = map[which]
    if (!f) return fail('BAD_LOG', '未知日志：' + which)
    const lines = Math.min(Math.max(Number(query.lines) || 200, 20), 2000)
    return { text: tailLines(f, lines), path: f }
  })
}
