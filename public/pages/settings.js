// 设置：端口、绑定地址、更新代理、npm registry
import { h, badge, btn, kv, toast } from '../ui.js'
import { api } from '../api.js'

export function render(view, ctx) {
  view.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', null, '设置'), h('div', { class: 'sub' }, '改端口与绑定地址需要重启 dsh web 才生效'))))

  const s = (ctx.status && ctx.status.settings) || {}
  const portInput = h('input', { class: 'input narrow', value: s.port || 3080 })
  const hostInput = h('input', { class: 'input', style: { width: '180px' }, value: s.bindHost || '127.0.0.1' })
  const proxyInput = h('input', { class: 'input wide', value: s.proxy || '' })
  const regSelect = h(
    'select',
    { class: 'input', style: { width: '180px' } },
    ...[
      ['auto', 'auto（多源竞速）'],
      ['npmmirror', 'npmmirror'],
      ['npmjs', 'npm 官方源'],
    ].map(([v, label]) => h('option', { value: v, selected: (s.registry || 'auto') === v }, label))
  )

  const proxyResult = h('div', { class: 'dim', style: { fontSize: '11.5px', marginTop: '6px' } }, '')
  const regResult = h('div', { class: 'dim', style: { fontSize: '11.5px', marginTop: '6px' } }, '')
  const saveHint = h('div', { class: 'dim', style: { fontSize: '11.5px', marginTop: '8px' } }, '')

  async function testProxy() {
    proxyResult.textContent = '测试中…'
    try {
      const r = await api.post('/api/settings/test-proxy', { proxy: proxyInput.value.trim() }, { quiet: true })
      proxyResult.textContent = `${r.ok ? '✓' : '✗'} ${r.message}${r.ms ? `（${r.ms}ms）` : ''}`
      proxyResult.style.color = r.ok ? 'var(--ok)' : 'var(--err)'
    } catch (e) {
      proxyResult.textContent = '✗ ' + e.message
      proxyResult.style.color = 'var(--err)'
    }
  }

  async function testRegistry() {
    regResult.textContent = '测试中…'
    try {
      const r = await api.post('/api/settings/test-registry', { registry: regSelect.value }, { quiet: true })
      regResult.textContent = `${r.ok ? '✓' : '✗'} ${r.message}${r.ms ? `（${r.ms}ms）` : ''}`
      regResult.style.color = r.ok ? 'var(--ok)' : 'var(--err)'
    } catch (e) {
      regResult.textContent = '✗ ' + e.message
      regResult.style.color = 'var(--err)'
    }
  }

  async function save() {
    try {
      const r = await api.put('/api/settings', {
        port: Number(portInput.value),
        bindHost: hostInput.value.trim(),
        proxy: proxyInput.value.trim(),
        registry: regSelect.value,
      })
      toast(r.message || '已保存', 'ok')
      saveHint.textContent = r.restartRequired ? '已保存 — 需要重启 dsh web 才生效' : ''
      saveHint.style.color = 'var(--warn)'
      ctx.refresh()
    } catch {}
  }

  const form = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '服务')),
    h(
      'div',
      { class: 'list' },
      row('监听端口', portInput, '1024–65535，改完重启 dsh web 生效'),
      row('绑定地址', hostInput, '只在本机用就保持 127.0.0.1；0.0.0.0 会暴露到局域网'),
      h(
        'div',
        { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, '更新代理'), h('div', { class: 'meta' }, '查询版本与 npm 安装时走这个代理，留空表示直连')),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' } }, h('div', { class: 'row' }, proxyInput, btn('测试', testProxy, { kind: 'ghost', size: 'sm' })), proxyResult)
      ),
      h(
        'div',
        { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, 'npm registry'), h('div', { class: 'meta' }, 'auto = npmmirror 与官方源竞速，取最快')),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' } }, h('div', { class: 'row' }, regSelect, btn('测试', testRegistry, { kind: 'ghost', size: 'sm' })), regResult)
      )
    ),
    saveHint,
    h('div', { class: 'row', style: { marginTop: '12px' } }, btn('保存设置', save, { kind: 'primary' }), btn('刷新', () => ctx.refresh(), { kind: 'ghost' }))
  )

  const pathsCard = h('div', { class: 'card' })
  const p = (ctx.status && ctx.status.settings) || {}
  view.appendChild(
    h(
      'div',
      { class: 'stack' },
      form,
      pathsCard,
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '目录')),
        h(
          'div',
          { class: 'row' },
          btn('打开控制台目录', () => ctx.open('root'), { kind: 'ghost', size: 'sm' }),
          btn('打开配置目录', () => ctx.open('config'), { kind: 'ghost', size: 'sm' }),
          btn('打开日志目录', () => ctx.open('logs'), { kind: 'ghost', size: 'sm' }),
          btn('打开 dsh 数据目录', () => ctx.open('dsh-home'), { kind: 'ghost', size: 'sm' }),
          btn('打开 npm 全局目录', () => ctx.open('npm-global'), { kind: 'ghost', size: 'sm' })
        )
      )
    )
  )

  api
    .get('/api/settings', { quiet: true })
    .then((d) => {
      pathsCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '路径')))
      pathsCard.appendChild(
        kv([
          ['dsh 数据', h('span', { class: 'mono' }, d.paths.dshHome)],
          ['dsh 主程序', h('span', { class: 'mono' }, d.paths.dshBin)],
          ['npm 全局', h('span', { class: 'mono' }, d.paths.npmPrefix)],
          ['node', h('span', { class: 'mono' }, d.paths.node)],
        ])
      )
    })
    .catch(() => {})

  function row(label, control, hint) {
    return h(
      'div',
      { class: 'list-row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, label), hint ? h('div', { class: 'meta' }, hint) : null),
      h('div', { class: 'row' }, control)
    )
  }

  return { update() {} }
}
