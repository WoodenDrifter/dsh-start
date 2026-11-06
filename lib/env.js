// 环境体检：跑一次就能看出"为什么服务起不来"。
import fs from 'node:fs'
import path from 'node:path'
import { DIR, FILE, dshBin, dshPkgDir, dshVersionFromPkg, nodeExe, npmPrefix, npmCli, dshHome } from './paths.js'
import { exists, fmtBytes, safeStat } from './util.js'
import { run } from './proc.js'
import { pidOfPort, classify } from './netstat.js'
import { installHealth } from './dsh.js'
import * as settings from './settings.js'

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, '.wtest')
    fs.writeFileSync(p, 'x')
    fs.rmSync(p, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, code: e.code || 'ERR', message: e.message }
  }
}

export async function check() {
  const s = settings.load()
  const items = []

  const nodeVer = await run(nodeExe(), ['-v'], { timeout: 8000 })
  items.push({
    name: 'Node.js',
    level: nodeVer.ok ? 'ok' : 'err',
    detail: nodeVer.ok ? `${nodeVer.stdout.trim()} · ${nodeExe()}` : `未找到可执行的 node（期望 ${nodeExe()}）`,
    hint: nodeVer.ok ? null : '安装 Node.js 20+，或确认 PATH 中有 node.exe',
  })

  // dsh 磁盘版本：区分「没装」「装了但残缺」「正常」
  const bin = dshBin()
  const health = installHealth()
  if (!health.installed) {
    items.push({
      name: 'dsh 主程序',
      level: 'err',
      detail: `未安装（期望目录 ${dshPkgDir()}）`,
      hint: '在「更新与回退」页点「修复安装」，或执行 npm i -g @deepseek-ai/dsh',
    })
  } else if (!health.ok) {
    items.push({
      name: 'dsh 主程序',
      level: 'err',
      detail: `安装不完整：缺少 ${health.missing.join('、')} · ${dshPkgDir()}`,
      hint: '在「更新与回退」页点「修复安装」（不碰数据），或 npm i -g @deepseek-ai/dsh@<版本>',
    })
  } else {
    items.push({
      name: 'dsh 主程序',
      level: 'ok',
      detail: `v${health.version || '?'} · ${health.dir}`,
      hint: null,
    })
  }

  // 运行中的那个进程，跟磁盘上的版本对不对得上
  const port = Number(s.port)
  const occ = await classify(port)
  const runningVer = occ.running ? dshVersionFromPkg() : null
  items.push({
    name: 'dsh 运行中',
    level: occ.running ? 'ok' : 'info',
    detail: occ.running
      ? `PID ${occ.pid} · 端口 ${port}${occ.owned === false ? '（非本控制台启动，已接管）' : ''}`
      : '未运行',
    hint: occ.running && health.ok && runningVer ? null : occ.running ? null : '需要时在概览页点「启动 dsh web」',
  })

  const npm = npmCli()
  let npmVer = null
  if (npm) {
    try {
      npmVer = JSON.parse(fs.readFileSync(path.join(path.dirname(npm), '..', 'package.json'), 'utf8')).version || null
    } catch {}
  }
  items.push({
    name: 'npm',
    level: npm ? 'ok' : 'warn',
    detail: npm ? `${npmVer ? 'v' + npmVer + ' · ' : ''}${npm}` : '未找到 npm-cli.js',
    hint: npm ? null : '更新与版本切换不可用；请确认 Node 安装完整',
  })

  const py = await run('python', ['--version'], { timeout: 8000 })
  items.push({
    name: 'Python（可选）',
    level: py.ok ? 'ok' : 'info',
    detail: py.ok ? (py.stdout || py.stderr).trim() : '未安装，不影响本控制台',
    hint: null,
  })

  for (const [label, dir] of [
    ['配置目录', DIR.config],
    ['日志目录', DIR.logs],
    ['备份目录', DIR.backups],
  ]) {
    const w = writable(dir)
    items.push({
      name: label + '可写',
      level: w.ok ? 'ok' : 'err',
      detail: w.ok ? dir : `${dir} — ${w.code} ${w.message}`,
      hint: w.ok ? null : '把整个 DSH-start 目录授权给当前用户，或移动到非 Program Files 位置',
    })
  }

  const homeW = writable(dshHome())
  items.push({
    name: 'dsh 数据目录可写',
    level: homeW.ok ? 'ok' : 'err',
    detail: homeW.ok ? dshHome() : `${dshHome()} — ${homeW.code}`,
    hint: homeW.ok ? null : '检查 ~/.dsh 权限，或用 DSH_HOME 指向别的目录',
  })

  const occupant = await pidOfPort(port)
  items.push({
    name: `端口 ${port}`,
    level: occupant ? 'info' : 'ok',
    detail: occupant ? `被 PID ${occupant} 占用（若为 dsh 即属正常）` : '空闲',
    hint: null,
  })

  const npmW = writable(npmPrefix())
  items.push({
    name: 'npm 全局前缀可写',
    level: npmW.ok ? 'ok' : 'warn',
    detail: npmPrefix(),
    hint: npmW.ok ? null : '更新 dsh 时可能需要管理员权限',
  })

  const st = safeStat(FILE.appLog)
  items.push({
    name: '应用日志',
    level: 'info',
    detail: st ? `${FILE.appLog}（${fmtBytes(st.size)}）` : '尚未生成',
    hint: null,
  })

  const stats = { ok: items.filter((i) => i.level === 'ok').length, warn: items.filter((i) => i.level === 'warn').length, err: items.filter((i) => i.level === 'err').length }
  return { items, stats }
}
