// 密钥：dsh web 的访问 token 与已授权设备密钥一览
import { h, clear, badge, btn, kv, copyText, fmtTime } from '../ui.js'
import { api } from '../api.js'

export function render(view, ctx) {
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', null, h('h1', null, '密钥'), h('div', { class: 'sub' }, 'dsh web 的访问令牌，以及本机已授权的设备密钥（只读）')),
    h('div', { class: 'actions' }, btn('刷新', load, { kind: 'ghost', size: 'sm' }))
  )
  view.appendChild(head)

  const tokenCard = h('div', { class: 'card' })
  const deviceCard = h('div', { class: 'card' })
  view.appendChild(h('div', { class: 'stack' }, tokenCard, deviceCard))

  let revealed = false
  let data = null

  function renderToken() {
    clear(tokenCard)
    const d = data || {}
    tokenCard.appendChild(
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-title' }, 'dsh web 访问密钥'),
        d.token ? badge('可用', 'ok') : d.running ? badge('尚未拿到', 'warn') : badge('服务未运行', ''),
        h('div', { class: 'spacer' }),
        btn(revealed ? '隐藏' : '显示', () => {
          revealed = !revealed
          renderToken()
        }, { kind: 'ghost', size: 'sm' })
      )
    )

    if (!d.running) {
      tokenCard.appendChild(h('div', { class: 'empty' }, 'dsh web 没有在运行，启动后才会生成本次会话的 token。'))
      return
    }
    if (!d.token) {
      tokenCard.appendChild(h('div', { class: 'empty' }, '服务已启动，但日志里还没出现带 token 的地址，稍后刷新一次。'))
      return
    }

    const shown = revealed ? d.token : d.tokenMasked || '••••••••'
    tokenCard.appendChild(
      kv([
        ['token', h('span', { class: 'mono' }, shown)],
        ['基础地址', h('span', { class: 'mono' }, d.baseUrl || '—')],
        ['完整地址', h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, revealed ? d.url : String(d.baseUrl || '') + '/?token=••••')],
      ])
    )

    tokenCard.appendChild(
      h(
        'div',
        { class: 'row', style: { marginTop: '12px' } },
        btn('复制密钥', () => copyText(d.token, '密钥已复制'), { size: 'sm' }),
        btn('复制访问地址', () => copyText(d.url, '地址已复制（含 token）'), { kind: 'ghost', size: 'sm' }),
        btn('在浏览器打开', () => api.post('/api/system/open', { target: 'url', url: d.url }).catch(() => {}), { kind: 'ghost', size: 'sm' })
      )
    )
    tokenCard.appendChild(
      h(
        'div',
        { class: 'dim', style: { fontSize: '11.5px', marginTop: '10px', lineHeight: '1.8' } },
        'token 是 dsh web 每次启动时随机生成的，写进它的日志里；重启服务后旧 token 立即失效，需要重新复制。'
      )
    )
  }

  function renderDevices() {
    clear(deviceCard)
    const items = (data && data.devices) || []
    deviceCard.appendChild(
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '设备密钥'), h('div', { class: 'spacer' }), h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `${items.length} 台`))
    )
    if (!items.length) {
      deviceCard.appendChild(h('div', { class: 'empty' }, '还没有设备记录。设备在本机浏览器里完成一次授权后才会出现。'))
      return
    }
    const list = h('div', { class: 'list' })
    for (const it of items) {
      list.appendChild(
        h(
          'div',
          { class: 'list-row' },
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'title' }, it.name),
            h(
              'div',
              { class: 'meta' },
              [it.id ? `ID ${it.id}` : null, it.createdAt ? `创建 ${fmtTime(it.createdAt)}` : null, it.expiresAt ? `到期 ${fmtTime(it.expiresAt)}` : null]
                .filter(Boolean)
                .join('　·　')
            )
          ),
          it.expired ? badge('已过期', 'err') : it.remainDays !== null ? badge(`剩 ${it.remainDays} 天`, it.remainDays < 15 ? 'warn' : 'ok') : badge('无到期时间', '')
        )
      )
    }
    deviceCard.appendChild(list)
    deviceCard.appendChild(
      h('div', { class: 'dim', style: { fontSize: '11px', marginTop: '10px' } }, '设备密钥由 dsh web 自己维护，控制台只读取展示；要撤销某台设备，请到「授权设备」页按它的 ID 处理或清理 dsh 数据目录。')
    )
  }

  async function load() {
    try {
      data = await api.get('/api/keys', { quiet: true })
    } catch (e) {
      clear(tokenCard)
      tokenCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'dsh web 访问密钥')))
      tokenCard.appendChild(h('div', { class: 'empty' }, '读取失败：' + e.message))
      return
    }
    renderToken()
    renderDevices()
  }

  load()
  let lastRunning = null
  return {
    update(s) {
      // 只在「运行 / 未运行」发生变化时重新取，避免每次心跳都读一遍日志
      const running = s && s.web ? Boolean(s.web.running) : null
      if (running === lastRunning) return
      lastRunning = running
      load()
    },
  }
}
