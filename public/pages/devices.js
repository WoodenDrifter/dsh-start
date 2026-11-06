// 授权设备（只读）
import { h, clear, badge, btn, fmtTime } from '../ui.js'
import { api } from '../api.js'

export function render(view, ctx) {
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, '授权设备'), h('div', { class: 'sub' }, '来自 config/devices.json 的设备库（本版只读）')))
  head.appendChild(h('div', { class: 'actions' }, btn('刷新', load, { kind: 'ghost', size: 'sm' }), btn('打开配置目录', () => ctx.open('config'), { kind: 'ghost', size: 'sm' })))
  const card = h('div', { class: 'card' })
  view.appendChild(head)
  view.appendChild(card)

  async function load() {
    clear(card)
    card.appendChild(h('div', { class: 'empty' }, '读取中…'))
    let r
    try {
      r = await api.get('/api/devices', { quiet: true })
    } catch (e) {
      clear(card)
      card.appendChild(h('div', { class: 'empty' }, '读取失败：' + e.message))
      return
    }
    clear(card)
    card.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '已授权设备'), h('div', { class: 'spacer' }), h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `${r.items.length} 台`)))
    if (!r.items.length) {
      card.appendChild(h('div', { class: 'empty' }, '还没有设备记录。'))
      return
    }
    const list = h('div', { class: 'list' })
    for (const d of r.items) {
      list.appendChild(
        h(
          'div',
          { class: 'list-row' },
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'title' }, d.name),
            h(
              'div',
              { class: 'meta' },
              [
                d.authorized ? `来源 ${d.authorized}` : null,
                d.createdAt ? `创建 ${fmtTime(d.createdAt)}` : null,
                d.expiresAt ? `到期 ${fmtTime(d.expiresAt)}` : null,
                d.id ? `ID ${d.id}` : null,
              ]
                .filter(Boolean)
                .join('　·　')
            )
          ),
          d.expired ? badge('已过期', 'err') : d.remainDays !== null ? badge(`剩 ${d.remainDays} 天`, d.remainDays < 15 ? 'warn' : 'ok') : badge('无到期时间', '')
        )
      )
    }
    card.appendChild(list)
    card.appendChild(h('div', { class: 'dim', style: { fontSize: '11px', marginTop: '10px' } }, '设备续期/撤销沿用旧版逻辑（dsh web 的登录态）。本版暂不提供写操作，避免误操作把当前设备的令牌换掉。'))
  }

  load()
  return { update() {} }
}
