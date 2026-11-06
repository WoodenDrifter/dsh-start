// dsh web：启停、地址、日志
import { h, clear, cardWith, badge, btn, kv, copyText, duration, logBox, progress, toast, confirmModal } from '../ui.js'
import { api, waitJob } from '../api.js'

export function render(view, ctx) {
  view.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'dsh web'), h('div', { class: 'sub' }, '本机 DeepSeek Harness Web 服务'))))

  const statusCard = h('div', { class: 'card' })
  const jobCard = h('div', { class: 'card hidden' })
  const logCard = h('div', { class: 'card' })

  let logStream = 'out'
  const pre = logBox('', true)
  const jobBar = progress(0)
  const jobText = h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12px' } }, '')

  async function loadLogs() {
    try {
      const r = await api.get(`/api/web/logs?stream=${logStream}&lines=300`, { quiet: true })
      pre.set(r.text)
    } catch {}
  }

  const outBtn = btn('stdout', () => switchStream('out'), { size: 'sm', kind: 'primary' })
  const errBtn = btn('stderr', () => switchStream('err'), { size: 'sm', kind: 'ghost' })
  function switchStream(s) {
    logStream = s
    outBtn.className = `btn sm ${s === 'out' ? 'primary' : 'ghost'}`
    errBtn.className = `btn sm ${s === 'err' ? 'primary' : 'ghost'}`
    loadLogs()
  }

  logCard.appendChild(
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'card-title' }, '服务日志'),
      h('div', { class: 'spacer' }),
      outBtn,
      errBtn,
      btn('刷新', loadLogs, { kind: 'ghost', size: 'sm' }),
      btn('打开目录', () => ctx.open('logs'), { kind: 'ghost', size: 'sm' })
    )
  )
  logCard.appendChild(pre)

  jobCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '进行中'), h('div', { class: 'spacer' }), h('span', { class: 'badge info', id: 'jobpct' }, '0%')))
  jobCard.appendChild(jobBar)
  jobCard.appendChild(jobText)

  view.appendChild(h('div', { class: 'stack' }, statusCard, jobCard, logCard))

  function showJob(job) {
    if (!job) {
      jobCard.classList.add('hidden')
      return
    }
    jobCard.classList.remove('hidden')
    jobBar.set(job.percent || 0)
    const pct = jobCard.querySelector('#jobpct')
    if (pct) pct.textContent = (job.percent || 0) + '%'
    jobText.textContent = `${job.title} · ${job.message || ''}`
    if (job.lines && job.lines.length) jobText.textContent += '\n' + job.lines.slice(-3).map((l) => l.text).join('\n')
    jobText.style.whiteSpace = 'pre-wrap'
    jobText.style.fontFamily = 'var(--mono)'
  }

  async function runJob(startFn, title) {
    try {
      const { jobId, job } = await startFn()
      showJob(job || { title, percent: 0, message: '已开始' })
      const done = await waitJob(jobId, { onUpdate: showJob })
      toast(`${title}完成`, 'ok')
      ctx.refresh()
      await loadLogs()
      setTimeout(() => showJob(null), 1500)
      return done
    } catch (e) {
      toast(e.message || '操作失败', 'err')
      ctx.refresh()
      return null
    }
  }

  function renderStatus(s) {
    const w = s.web
    clear(statusCard)
    const stateBadge = !w.running
      ? badge('未运行', '')
      : w.owner === 'ours'
        ? badge('运行中', 'ok')
        : w.owner === 'adopted'
          ? badge('运行中（非本控制台启动）', 'ok')
          : badge('端口被其它程序占用', 'err')

    statusCard.appendChild(
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-title' }, '状态'),
        stateBadge,
        h('div', { class: 'spacer' }),
        w.running
          ? btn('重启', async () => {
              if (!(await confirmModal('重启 dsh web', '会中断当前打开的网页会话（浏览器里的对话不会丢）。确定重启？', { okText: '重启' }))) return
              runJob(() => api.post('/api/web/restart'), '重启')
            }, { size: 'sm' })
          : null,
        w.running
          ? btn('停止', async () => {
              if (!(await confirmModal('停止 dsh web', '停止后浏览器里的 dsh web 就打不开了。', { okText: '停止', danger: true }))) return
              try {
                await api.post('/api/web/stop')
                toast('已停止', 'ok')
                ctx.refresh()
              } catch (e) {}
            }, { kind: 'danger', size: 'sm' })
          : btn('启动', () => runJob(() => api.post('/api/web/start'), '启动'), { kind: 'primary', size: 'sm' })
      )
    )

    statusCard.appendChild(
      kv([
        ['端口', `${w.port}　·　${w.host}`],
        ['PID', w.running ? String(w.pid) : '—'],
        ['已运行', w.startedAt ? duration(Date.now() - w.startedAt) : w.running ? '未知（非本控制台启动）' : '—'],
        ['版本', w.version || '未安装'],
        ['数据目录', h('span', { class: 'mono' }, w.home)],
      ])
    )

    if (w.url) {
      statusCard.appendChild(
        h(
          'div',
          { style: { marginTop: '12px' } },
          h('div', { class: 'dim', style: { fontSize: '11px', marginBottom: '4px' } }, '带 token 的访问地址'),
          h('div', { class: 'row' }, h('span', { class: 'mono', style: { color: '#a8b8ff', wordBreak: 'break-all', flex: '1' } }, w.url), btn('复制', () => copyText(w.url), { size: 'sm' }))
        )
      )
    }

    if (w.running && w.owner === 'foreign') {
      statusCard.appendChild(h('div', { class: 'badge err', style: { marginTop: '10px' } }, '端口上的进程不是 dsh，控制台不会去动它。请先释放端口。'))
    }
  }

  const pageApi = {
    update(s) {
      if (!s) return
      renderStatus(s)
      if (s.job && /web/.test(s.job.kind || '')) showJob(s.job)
    },
    job: showJob,
  }

  if (ctx.status) renderStatus(ctx.status)
  loadLogs()
  return pageApi
}
