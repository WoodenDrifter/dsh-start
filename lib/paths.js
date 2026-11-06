// 全部关键路径的唯一来源。任何模块都不要自己拼 path。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ensureDir, exists, safeStat } from './util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

export const DIR = {
  root: ROOT,
  server: path.join(ROOT, 'server'),
  public: path.join(ROOT, 'public'),
  config: path.join(ROOT, 'config'),
  logs: path.join(ROOT, 'logs'),
  jobs: path.join(ROOT, 'logs', 'jobs'),
  backups: path.join(ROOT, 'backups'),
  restorePoints: path.join(ROOT, 'restore-points'),
  legacy: path.join(ROOT, 'legacy'),
  tools: path.join(ROOT, 'tools'),
}

export const FILE = {
  settings: path.join(DIR.config, 'settings.json'),
  runtime: path.join(DIR.config, 'runtime.json'),
  devices: path.join(DIR.config, 'devices.json'),
  appLog: path.join(DIR.logs, 'app.log'),
  bootLog: path.join(DIR.logs, 'boot.log'),
  webOut: path.join(DIR.logs, 'web.out.log'),
  webErr: path.join(DIR.logs, 'web.err.log'),
  icon: path.join(ROOT, 'app.ico'),
  launcher: path.join(ROOT, 'DSH-start.exe'),
}

export function ensureSkillDirs() {
  for (const d of [DIR.config, DIR.logs, DIR.jobs, DIR.backups, DIR.restorePoints]) ensureDir(d)
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function userHome() {
  return os.homedir()
}

// npm 全局前缀：Windows 默认 %APPDATA%\npm，允许用 NPM_CONFIG_PREFIX 覆盖
export function npmPrefix() {
  return process.env.NPM_CONFIG_PREFIX || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
}

export function dshPkgDir() {
  return path.join(npmPrefix(), 'node_modules', '@deepseek-ai', 'dsh')
}

export function dshBin() {
  if (process.env.DSH_START_DSH_BIN && exists(process.env.DSH_START_DSH_BIN)) return process.env.DSH_START_DSH_BIN
  return path.join(dshPkgDir(), 'lib', 'bin.js')
}

export function dshVersionFromPkg() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dshPkgDir(), 'package.json'), 'utf8'))
    return pkg.version || null
  } catch {
    return null
  }
}

export function nodeExe() {
  if (process.env.DSH_START_NODE && exists(process.env.DSH_START_NODE)) return process.env.DSH_START_NODE
  return process.execPath
}

export function npmCli() {
  const dir = path.dirname(nodeExe())
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of candidates) if (exists(c)) return c
  return null
}

export function systemTar() {
  return path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
}

export function settingsMtime() {
  const st = safeStat(FILE.settings)
  return st ? st.mtimeMs : 0
}
