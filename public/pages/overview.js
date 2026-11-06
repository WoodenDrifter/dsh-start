// 概览：一屏看清两个服务的状态 + 最常用动作
import { h, clear, cardWith, badge, btn, kv, copyText, duration, fmtTime, toast } from '../ui.js'
import { api, waitJob } from '../api.js'

export function render(view, ctx) {
  const wrap = h('div', { class: 'stack' })
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', null, h('h1', null, '概览'), h('div', { class: 'sub' }, '本机 dsh web 的运行状态与常用操作')),
    h('div', { class: 'actions' }, btn('刷新', () => ctx.refresh(), { kind: 'ghost', size: 'sm' }))
  )
  view.appendChild(head)

  const webCard = h('div', { class: 'card' })
  const consoleCard = h('div', { class: 'card' })

  wrap.appendChild(webCard)
  wrap.appendChild(consoleCard)
  view.appendChild(wrap)

  function renderWeb(s) {
    const w = s.web
    clear(webCard)
    const stateBadge = !w.running
      ? badge('未运行', '')
      : w.owner === 'ours'
        ? badge('运行中', 'ok')
        : w.owner === 'adopted'
          ? badge('运行中（外部启动）', 'ok')
          : badge('端口被占用', 'err')
    webCard.appendChild(
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-title' }, 'dsh web'),
        stateBadge,
        h('div', { class: 'spacer' }),
        btn('打开', () => openWeb(w), { kind: 'ghost', size: 'sm', disabled: !w.running || !w.url })
      )
    )
    webCard.appendChild(
      kv([
        ['端口', `${w.port}　·　${w.host}`],
        ['PID', w.running ? String(w.pid) : '—'],
        ['已运行', w.startedAt ? duration(Date.now() - w.startedAt) : w.running ? '未知' : '—'],
        ['版本', w.version || '未安装'],
        ['访问地址', w.url ? h('span', { class: 'mono' }, w.url) : w.running ? '（日志里还没出现地址）' : '—'],
      ])
    )
    if (w.url) {
      webCard.appendChild(
        h(
          'div',
          { class: 'row', style: { marginTop: '10px' } },
          btn('复制访问地址', () => copyText(w.url, '已复制，粘到浏览器即可（带 token）'), { size: 'sm' }),
          btn('复制基础地址', () => copyText(w.baseUrl), { kind: 'ghost', size: 'sm' })
        )
      )
    }
  }

  function renderConsole(s) {
    clear(consoleCard)
    consoleCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '控制台')))
    consoleCard.appendChild(
      kv([
        ['版本', s.console.version],
        ['端口', String(s.console.port)],
        ['PID', String(s.console.pid)],
        ['启动于', fmtTime(s.console.startedAt)],
        ['说明', '关掉这个页面，控制台会自己退出；dsh web 继续运行。'],
      ])
    )
    consoleCard.appendChild(
      h(
        'div',
        { class: 'row', style: { marginTop: '12px' } },
        btn('环境体检', () => (location.hash = '#/env'), { kind: 'ghost', size: 'sm' }),
        btn('打开日志目录', () => ctx.open('logs'), { kind: 'ghost', size: 'sm' }),
        btn('打开数据目录', () => ctx.open('dsh-home'), { kind: 'ghost', size: 'sm' })
      )
    )
  }

  function openWeb(w) {
    if (!w.url) return toast('还没有拿到带 token 的地址', 'warn')
    api.post('/api/system/open', { target: 'url', url: w.url }).catch(() => {})
  }

  const api2 = {
    update(s) {
      if (!s) return
      renderWeb(s)
      renderConsole(s)
    },
  }
  if (ctx.status) api2.update(ctx.status)
  return api2
}
