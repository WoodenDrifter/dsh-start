// 极简 DOM 构建工具 + 通用组件。没有框架，改一行刷新即生效。
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k === 'html') el.innerHTML = v
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, v)
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

export function card(title, ...body) {
  const head = title ? h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title)) : null
  return h('div', { class: 'card' }, head, ...body)
}

export function cardWith(title, actions, ...body) {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title), h('div', { class: 'spacer' }), ...(actions || [])),
    ...body
  )
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, kind ? h('i', { class: 'dot' }) : null, text)
}

export function btn(text, onClick, { kind = '', size = '', disabled = false, title = '' } = {}) {
  return h('button', { class: `btn ${kind} ${size}`.trim(), onclick: onClick, disabled, title }, text)
}

export function kv(pairs) {
  const box = h('div', { class: 'kv' })
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue
    box.appendChild(h('div', { class: 'k' }, k))
    box.appendChild(h('div', { class: 'v' }, v))
  }
  return box
}

export function progress(value = 0) {
  const bar = h('i', { style: { width: Math.max(0, Math.min(100, value)) + '%' } })
  const wrap = h('div', { class: 'progress' }, bar)
  wrap.set = (v) => {
    bar.style.width = Math.max(0, Math.min(100, v)) + '%'
  }
  return wrap
}

export function logBox(text = '', tall = false) {
  const pre = h('pre', { class: `log ${tall ? 'tall' : ''}` }, text || '（暂无内容）')
  pre.set = (t) => {
    pre.textContent = t || '（暂无内容）'
  }
  pre.append = (t) => {
    if (pre.textContent === '（暂无内容）') pre.textContent = ''
    pre.textContent += (pre.textContent ? '\n' : '') + t
    pre.scrollTop = pre.scrollHeight
  }
  return pre
}

export function toast(message, kind = '') {
  const box = document.getElementById('toasts')
  const el = h('div', { class: `toast ${kind}` }, message)
  box.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .2s'
    setTimeout(() => el.remove(), 220)
  }, kind === 'err' ? 6000 : 3200)
}

export function confirmModal(title, message, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => {
      mask.remove()
      resolve(v)
    }
    const mask = h(
      'div',
      { class: 'modal-mask' },
      h(
        'div',
        { class: 'modal' },
        h('h3', null, title),
        h('p', null, message),
        h(
          'div',
          { class: 'foot' },
          btn('取消', () => close(false), { kind: 'ghost' }),
          btn(okText, () => close(true), { kind: danger ? 'danger' : 'primary' })
        )
      )
    )
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(false)
    })
    document.body.appendChild(mask)
  })
}

export function copyText(text, okMessage = '已复制') {
  navigator.clipboard.writeText(text).then(
    () => toast(okMessage, 'ok'),
    () => toast('复制失败，请手动选中复制', 'err')
  )
}

export function ago(ms) {
  if (!ms) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export function duration(ms) {
  if (!ms || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h_ = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return `${d} 天 ${h_} 小时`
  if (h_) return `${h_} 小时 ${m} 分`
  if (m) return `${m} 分 ${sec} 秒`
  return `${sec} 秒`
}

export function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
