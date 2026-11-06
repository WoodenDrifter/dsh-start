// 域名白名单：对应 dsh web 的 --trusted-host
import { h, clear, badge, btn, toast, confirmModal } from '../ui.js'
import { api } from '../api.js'

export function render(view, ctx) {
  view.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, '域名白名单'), h('div', { class: 'sub' }, '经隧道（如 cloudflared）用公网域名访问 dsh web 时，必须把域名告诉它，否则页面能开但接口全 401'))
    )
  )

  const listCard = h('div', { class: 'card' })
  const input = h('input', { class: 'input wide', placeholder: 'example.com 或 https://a.example.com:8443' })

  async function add() {
    const v = input.value.trim()
    if (!v) return toast('先填一个域名', 'warn')
    try {
      const r = await api.post('/api/hosts', { value: v })
      toast(r.message || '已添加', r.added ? 'ok' : 'warn')
      input.value = ''
      render2()
    } catch {}
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add()
  })

  view.appendChild(
    h(
      'div',
      { class: 'stack' },
      listCard,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '添加域名')), h('div', { class: 'row' }, input, btn('添加', add, { kind: 'primary' })))
    )
  )

  async function render2() {
    let data
    try {
      data = await api.get('/api/hosts', { quiet: true })
    } catch {
      return
    }
    clear(listCard)
    listCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'dsh web 受信任域名'), h('div', { class: 'spacer' }), h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `${data.items.length} 项`)))

    if (!data.items.length) {
      listCard.appendChild(h('div', { class: 'empty' }, '还没有配置。从隧道域名访问 dsh web 时再加。'))
      return
    }

    const list = h('div', { class: 'list' })
    for (const it of data.items) {
      list.appendChild(
        h(
          'div',
          { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title mono' }, it.host)),
          ctx.status && ctx.status.web.running ? badge('已生效', 'ok') : badge('重启后生效', 'warn'),
          btn('移除', async () => {
            if (!(await confirmModal('移除域名', `确定从白名单移除 ${it.host}？`, { okText: '移除', danger: true }))) return
            try {
              const r = await api.del(`/api/hosts/${encodeURIComponent(it.host)}`)
              toast(r.message || '已移除', 'ok')
              render2()
            } catch {}
          }, { kind: 'ghost', size: 'sm' })
        )
      )
    }
    listCard.appendChild(list)
    listCard.appendChild(h('div', { class: 'dim', style: { fontSize: '11px', marginTop: '10px' } }, '改动只在重启 dsh web 后才会作为 --trusted-host 传给服务。'))
  }

  render2()
  return {
    update() {},
  }
}
