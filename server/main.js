// 控制台入口：单实例 → 监听 127.0.0.1 随机端口 → 打开浏览器 → 关页即退。
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { DIR, FILE, ensureSkillDirs, dshBin } from '../lib/paths.js'
import * as runtime from '../lib/runtime.js'
import * as log from '../lib/log.js'
import * as dsh from '../lib/dsh.js'
import * as update from '../lib/update.js'
import { openBrowser } from '../lib/proc.js'
import { exists, sleep } from '../lib/util.js'
import { createRouter } from './router.js'
import * as httpUtil from './http.js'
import * as sse from './sse.js'
import * as session from './session.js'
import { registerRoutes } from './routes/index.js'

const APP = 'dsh-start-console'
const VERSION = '2.1.0'
const startedAt = Date.now()

const argv = process.argv.slice(2)
const NO_OPEN = argv.includes('--no-open')
const portArgIdx = argv.indexOf('--port')

function bootLog(m) {
  log.boot(m)
}

function probeConsole(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', timeout: 700 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          resolve(j && j.app === APP ? j : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

const KEY = randomBytes(16).toString('hex')
const router = createRouter()

let server = null
let shuttingDown = false

function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  bootLog('控制台退出：' + reason)
  log.info('控制台退出（' + reason + '），dsh web 不受影响')
  try {
    runtime.clear('console')
  } catch {}
  if (server) {
    try {
      server.close()
    } catch {}
  }
  // 给在途响应一点时间落地，再硬退出（SSE 连接会挂住 close）
  setTimeout(() => process.exit(0), 250)
}

async function main() {
  ensureSkillDirs()
  bootLog(`控制台启动 v${VERSION} pid=${process.pid}`)

  // ---- 安装完整性自检：上次更新被打断（npm 半装）会留下「目录在、package.json 没了」，
  // 这种情况 dsh 根本起不来，必须在界面上明确提示 + 提供修复入口。
  const health = dsh.installHealth()
  if (!health.ok) {
    const j = update.pendingJournal()
    const hint = health.installed ? `缺少 ${health.missing.join('、')}` : '未安装'
    log.warn(`dsh 安装不完整（${hint}）${j ? `，上次安装目标是 ${j.version}` : ''}；可在「更新与回退」页点「修复安装」`)
    bootLog(`dsh 安装不完整：${hint}`)
  }

  // ---- 单实例：已经在跑就直接把浏览器指过去
  const rt = runtime.get()
  const prevPort = rt.console && rt.console.port
  if (prevPort && prevPort !== Number(argv[portArgIdx + 1])) {
    const alive = await probeConsole(prevPort)
    if (alive) {
      const url = `http://127.0.0.1:${prevPort}/?k=${rt.console.key || ''}`
      log.info(`控制台已在运行（端口 ${prevPort}），直接打开界面`)
      if (!NO_OPEN) openBrowser(url)
      return
    }
  }

  session.init({ shutdown })

  const server_ = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)
    req.query = Object.fromEntries(url.searchParams.entries())

    try {
      // ---------------- 系统级路径
      if (pathname === '/api/ping') {
        httpUtil.sendJson(res, 200, { app: APP, version: VERSION, port: server.address().port })
        return
      }

      const cookies = httpUtil.parseCookies(req.headers.cookie)
      const hasKey = cookies.dsx === KEY

      if (pathname === '/' || pathname === '/index.html') {
        if (req.query.k === KEY) {
          res.writeHead(302, {
            location: '/',
            'set-cookie': `dsx=${KEY}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
          })
          res.end()
          return
        }
        if (!hasKey) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><meta charset="utf-8"><title>DSH 控制台</title>` +
              `<body style="background:#14161a;color:#e6e8eb;font:15px/1.7 'Segoe UI',sans-serif;padding:48px">` +
              `<h2 style="font-weight:600">需要从桌面快捷方式打开</h2>` +
              `<p style="color:#9aa4b2">这个页面带了访问校验，直接输入地址打不开。请双击桌面的 <b>DSH-start</b> 图标。</p></body>`
          )
          return
        }
        httpUtil.serveStatic(req, res, DIR.public, 'index.html')
        return
      }

      if (pathname.startsWith('/api/')) {
        if (!hasKey) {
          httpUtil.fail(res, 'NEED_KEY', '缺少访问凭据，请从桌面快捷方式重新打开', 403)
          return
        }
        if (req.method !== 'GET') {
          const origin = req.headers.origin
          const selfOrigin = `http://127.0.0.1:${server.address().port}`
          if (origin && origin !== selfOrigin && origin !== `http://localhost:${server.address().port}`) {
            httpUtil.fail(res, 'BAD_ORIGIN', '跨站请求被拒绝', 403)
            return
          }
        }

        if (pathname === '/api/events') {
          const sid = req.query.sid || 'sse'
          session.sseOpen(sid)
          const conn = sse.attach(req, res)
          res.on('close', () => {
            session.sseClose(sid)
            conn.close()
          })
          return
        }

        const route = router.match(req.method, pathname)
        if (!route) {
          httpUtil.fail(res, 'NO_ROUTE', '未知接口：' + pathname, 404)
          return
        }
        const body = req.method === 'GET' ? null : await httpUtil.readBody(req)
        const out = await route.handler({ req, res, params: route.params, query: req.query, body, key: KEY, shutdown })
        if (out === undefined || out === null) {
          if (!res.headersSent) httpUtil.ok(res, {})
          return
        }
        if (out.__raw) {
          httpUtil.sendJson(res, out.status || 200, out.__raw)
          return
        }
        if (out.__job) {
          httpUtil.accepted(res, out.__job)
          return
        }
        if (out.__fail) {
          httpUtil.fail(res, out.code, out.message, out.status || 400, out.detail || null)
          return
        }
        httpUtil.ok(res, out)
        return
      }

      // ---------------- 静态资源
      if (pathname === '/favicon.ico') {
        httpUtil.serveStatic(req, res, DIR.root, 'app.ico')
        return
      }
      httpUtil.serveStatic(req, res, DIR.public, pathname)
    } catch (e) {
      log.error('请求处理异常 ' + req.method + ' ' + pathname + '：' + (e && e.stack ? e.stack : e))
      if (!res.headersSent) httpUtil.fail(res, 'INTERNAL', e && e.message ? e.message : '内部错误', 500)
      else res.end()
    }
  })

  server = server_

  const wantPort = portArgIdx >= 0 ? Number(argv[portArgIdx + 1]) : 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(wantPort, '127.0.0.1', resolve)
  })

  const port = server.address().port
  runtime.patch({ console: { pid: process.pid, port, key: KEY, startedAt, version: VERSION } })
  bootLog(`已监听 127.0.0.1:${port}`)

  // 双击后 120 秒内浏览器没连上来就自己退，绝不留孤儿进程
  const url = `http://127.0.0.1:${port}/?k=${KEY}`
  if (!NO_OPEN) {
    log.info('控制台就绪，正在打开浏览器：' + `http://127.0.0.1:${port}/`)
    openBrowser(url)
  } else {
    log.info(`控制台就绪（未自动打开浏览器）：${url}`)
  }

  process.on('SIGINT', () => shutdown('signal'))
  process.on('SIGTERM', () => shutdown('signal'))
  process.on('uncaughtException', (e) => log.error('未捕获异常：' + (e.stack || e.message)))
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝：' + (e && e.stack ? e.stack : e)))
}

registerRoutes(router, {
  version: VERSION,
  startedAt,
  key: KEY,
  get port() {
    return server ? server.address().port : 0
  },
  shutdown,
})

main().catch((e) => {
  log.error('启动失败：' + (e && e.stack ? e.stack : e))
  bootLog('启动失败：' + (e && e.message ? e.message : e))
  process.exit(1)
})
