// 环境体检
import { h, clear, badge, btn } from '../ui.js'
import { api } from '../api.js'

export function render(view, ctx) {
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, '环境体检'), h('div', { class: 'sub' }, '跑一遍就知道服务为什么起不来')))
  const listCard = h('div', { class: 'card' })
  const summary = h('div', { class: 'row', style: { marginBottom: '4px' } })
  view.appendChild(head)
  view.appendChild(h('div', { class: 'stack' }, summary, listCard))
  head.appendChild(h('div', { class: 'actions' }, btn('重新体检', load, { kind: 'ghost', size: 'sm' })))

  async function load() {
    clear(listCard)
    listCard.appendChild(h('div', { class: 'empty' }, '检查中…'))
    let r
    try {
      r = await api.get('/api/system/env', { quiet: true })
    } catch (e) {
      clear(listCard)
      listCard.appendChild(h('div', { class: 'empty' }, '体检失败：' + e.message))
      return
    }
    clear(summary)
    summary.appendChild(badge(`${r.stats.ok} 项正常`, 'ok'))
    if (r.stats.warn) summary.appendChild(badge(`${r.stats.warn} 项提醒`, 'warn'))
    if (r.stats.err) summary.appendChild(badge(`${r.stats.err} 项异常`, 'err'))

    clear(listCard)
    const list = h('div', { class: 'list' })
    for (const it of r.items) {
      const kind = it.level === 'ok' ? 'ok' : it.level === 'warn' ? 'warn' : it.level === 'err' ? 'err' : ''
      list.appendChild(
        h(
          'div',
          { class: 'list-row' },
          h('span', { class: 'badge ' + kind, style: { minWidth: '54px', justifyContent: 'center' } }, it.level === 'ok' ? '正常' : it.level === 'warn' ? '提醒' : it.level === 'err' ? '异常' : '信息'),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'title' }, it.name),
            h('div', { class: 'meta mono', style: { wordBreak: 'break-all' } }, it.detail || ''),
            it.hint ? h('div', { class: 'dim', style: { fontSize: '11px', marginTop: '2px' } }, '→ ' + it.hint) : null
          )
        )
      )
    }
    listCard.appendChild(list)
  }

  load()
  return { update() {} }
}
