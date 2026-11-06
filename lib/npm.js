// npm 调用：走 node + npm-cli.js（不依赖 .cmd，避免 shell 与编码问题）。
import { spawn } from 'node:child_process'
import { npmCli, nodeExe, npmPrefix } from './paths.js'
import { exists } from './util.js'

export const ALLOW_SCRIPTS = '@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs'

let npmVersionCache = null

export function runNpmStream(args, { onLine = null, timeout = 10 * 60 * 1000, env = {} } = {}) {
  const cli = npmCli()
  if (!cli) return Promise.reject(new Error('找不到 npm-cli.js，无法执行 npm 操作'))
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe(), [cli, ...args], {
      cwd: process.env.USERPROFILE,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_prefix: npmPrefix(), ...env },
    })
    let buf = ''
    let errBuf = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill()
      } catch {}
    }, timeout)

    const handle = (chunk, isErr) => {
      const text = chunk.toString('utf8')
      if (isErr) errBuf += text
      buf += text
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() || ''
      for (const line of parts) {
        const t = line.trimEnd()
        if (t && onLine) onLine(t, isErr)
      }
    }

    child.stdout.on('data', (c) => handle(c, false))
    child.stderr.on('data', (c) => handle(c, true))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buf && onLine) onLine(buf.trimEnd(), false)
      if (killed) reject(new Error('npm 执行超时'))
      else if (code !== 0) {
        const e = new Error(`npm 退出码 ${code}`)
        e.detail = (errBuf || '').slice(-2000)
        reject(e)
      } else resolve({ code })
    })
  })
}

export async function npmVersion() {
  if (npmVersionCache) return npmVersionCache
  const cli = npmCli()
  if (!cli) return null
  const v = await new Promise((resolve) => {
    const c = spawn(nodeExe(), [cli, '-v'], { windowsHide: true })
    let out = ''
    c.stdout.on('data', (d) => (out += d.toString()))
    c.on('close', () => resolve(out.trim() || null))
    c.on('error', () => resolve(null))
  })
  npmVersionCache = v
  return v
}

async function supportsAllowScripts() {
  const v = await npmVersion()
  if (!v) return false
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 11 || (major === 11 && minor >= 19)
}

export async function installGlobal(spec, { onLine = null, proxy = null, registry = null } = {}) {
  const base = ['install', '-g', spec, '--no-audit', '--no-fund', '--loglevel=http']
  // 控制台里配的代理/源要真的传给 npm，否则「测试代理通过」和「实际安装」走的是两条路
  const extra = []
  // npm 只认 http(s) 代理；socks5 传过去会让它直接报错，这里过滤掉
  const px = proxy && /^https?:\/\//i.test(String(proxy).trim()) ? String(proxy).trim() : null
  if (px) extra.push(`--proxy=${px}`, `--https-proxy=${px}`)
  if (registry && registry !== 'auto') extra.push(`--registry=${registry}`)
  const args = [...base, ...extra]
  const env = {}
  if (px) {
    env.npm_config_proxy = px
    env.npm_config_https_proxy = px
  }
  if (await supportsAllowScripts()) {
    try {
      return await runNpmStream([...args, `--allow-scripts=${ALLOW_SCRIPTS}`], { onLine, env })
    } catch (e) {
      // 参数不被接受时退回不带参数的版本，而不是把整个更新流程判死
      if (/allow-scripts|unknown|invalid/i.test(e.message + (e.detail || ''))) {
        if (onLine) onLine('（当前 npm 不接受 --allow-scripts，改为普通安装）')
      } else {
        throw e
      }
    }
  }
  return await runNpmStream(args, { onLine, env })
}

export function prefixWritableHint() {
  return exists(npmPrefix()) ? null : `npm 全局前缀不存在：${npmPrefix()}`
}
