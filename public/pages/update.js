// 更新 / 版本切换 / 回退点
import { h, clear, badge, btn, kv, progress, toast, confirmModal, fmtTime } from '../ui.js'
import { api, waitJob } from '../api.js'

export function render(view, ctx) {
  view.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', null, '更新与回退'), h('div', { class: 'sub' }, '更新前会自动备份用户数据并落一条回退点'))))

  const verCard = h('div', { class: 'card' })
  const switchCard = h('div', { class: 'card' })
  const jobCard = h('div', { class: 'card hidden' })
  const rpCard = h('div', { class: 'card' })
  const jobBar = progress(0)
  const jobText = h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12px', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)' } }, '')
  const jobLines = h('pre', { class: 'log', style: { marginTop: '8px', maxHeight: '200px' } }, '')

  jobCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '进行中')))
  jobCard.appendChild(jobBar)
  jobCard.appendChild(jobText)
  jobCard.appendChild(jobLines)

  view.appendChild(h('div', { class: 'stack' }, verCard, switchCard, jobCard, rpCard))

  let checkInfo = null
  let versionList = null

  function showJob(job) {
    if (!job) {
      jobCard.classList.add('hidden')
      return
    }
    jobCard.classList.remove('hidden')
    jobBar.set(job.percent || 0)
    jobText.textContent = `${job.title} · ${job.message || ''}`
    if (job.lines) jobLines.textContent = job.lines.slice(-14).map((l) => l.text).join('\n')
  }

  async function runJob(startFn, title) {
    try {
      const { jobId, job } = await startFn()
      showJob(job || { title, percent: 0, message: '已开始' })
      const done = await waitJob(jobId, { onUpdate: showJob })
      toast(`${title}完成`, 'ok')
      await check(false)
      await loadVersions()
      await loadRestorePoints()
      setTimeout(() => showJob(null), 1500)
      return done
    } catch (e) {
      toast(e.message || '操作失败', 'err')
      setTimeout(() => showJob(null), 3000)
      return null
    }
  }

  async function check(force = true) {
    clear(verCard)
    verCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '版本'), h('div', { class: 'spacer' }), h('span', { class: 'dim', style: { fontSize: '11.5px' } }, '检查中…')))
    let r
    try {
      r = await api.get(`/api/update/check${force ? '?force=1' : ''}`, { quiet: true })
    } catch (e) {
      clear(verCard)
      verCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '版本')))
      verCard.appendChild(h('div', { class: 'empty' }, '检查失败：' + e.message))
      return
    }
    checkInfo = r
    clear(verCard)
    verCard.appendChild(
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-title' }, '版本'),
        r.broken ? badge('安装损坏', 'err') : r.needUpdate ? badge('有新版本', 'warn') : r.error ? badge('查询失败', 'err') : badge('已是最新', 'ok'),
        h('div', { class: 'spacer' }),
        btn('修复安装', async () => {
          const ok = await confirmModal(
            '重新安装 dsh',
            `把当前的 dsh 重新装一遍（不碰会话与数据）。\n如果 npm 装到一半被打断，这一步就是解药。`,
            { okText: '开始修复' }
          )
          if (!ok) return
          runJob(() => api.post('/api/update/repair', { version: r.installed || null }), '修复安装')
        }, { kind: 'ghost', size: 'sm' }),
        btn('检查更新', () => check(true), { kind: 'ghost', size: 'sm' })
      )
    )
    if (r.broken) {
      verCard.appendChild(
        h('div', { class: 'badge err', style: { marginTop: '10px', display: 'block', whiteSpace: 'normal' } }, `安装不完整：缺少 ${(r.missing || []).join('、') || '关键文件'}。点右上角「修复安装」重装即可，用户数据不受影响。`)
      )
    }
    verCard.appendChild(
      kv([
        ['已安装', r.installed || '未知'],
        ['registry 最新', r.latest || (r.error ? '查询失败' : '—')],
        ['数据源', r.source ? `${r.source}（${r.ms}ms）${r.viaProxy === false ? ' · 代理未生效，已直连' : ''}` : r.error || '—'],
      ])
    )
    if (r.proxyError) verCard.appendChild(h('div', { class: 'badge warn', style: { marginTop: '10px' } }, `代理没连上（${r.proxyError}），本次已自动直连`))
    if (r.error) verCard.appendChild(h('div', { class: 'badge err', style: { marginTop: '10px' } }, r.error + (r.detail ? '：' + r.detail : '')))
    if (r.needUpdate) {
      verCard.appendChild(
        h(
          'div',
          { class: 'row', style: { marginTop: '12px' } },
          btn(`更新到 ${r.latest}`, async () => {
            const ok = await confirmModal(
              '更新 dsh',
              `将执行：\n1. 备份用户数据\n2. 停止 dsh web\n3. npm install -g @deepseek-ai/dsh@${r.latest}\n4. 校验版本\n5. 重启服务\n\n期间不要在浏览器里操作 dsh web。`,
              { okText: '开始更新' }
            )
            if (!ok) return
            runJob(() => api.post('/api/update/install', { version: r.latest }), `更新到 ${r.latest}`)
          }, { kind: 'primary' })
        )
      )
    }
  }

  async function loadVersions() {
    clear(switchCard)
    switchCard.appendChild(h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, '切换版本'), h('div', { class: 'spacer' }), btn('获取版本', () => loadVersionsForce(), { kind: 'ghost', size: 'sm' })))
    if (!versionList) {
      switchCard.appendChild(h('div', { class: 'dim', style: { fontSize: '11.5px' } }, '点「获取版本」从 registry 拉取全部可安装版本。'))
      return
    }
    const sel = h(
      'select',
      { class: 'input', style: { width: '220px' } },
      ...versionList.versions.slice(0, 200).map((v) => h('option', { value: v, selected: v === versionList.installed }, v + (v === versionList.latest ? '（latest）' : '') + (v === versionList.installed ? '（当前）' : '')))
    )
    switchCard.appendChild(
      h(
        'div',
        { class: 'row' },
        sel,
        btn('安装所选版本', async () => {
          const v = sel.value
          if (v === versionList.installed) return toast('这就是当前版本', 'warn')
          const ok = await confirmModal('切换版本', `把 dsh 切换到 ${v}？\n\n会先备份数据、停服务、安装、校验、重启。`, { okText: '开始' })
          if (!ok) return
          runJob(() => api.post('/api/update/install', { version: v }), `切换到 ${v}`)
        }, { kind: 'primary', size: 'sm' }),
        h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `共 ${versionList.versions.length} 个版本 · 来源 ${versionList.source}`)
      )
    )
  }

  async function loadVersionsForce() {
    switchCard.querySelector('.card-head').lastChild.disabled = true
    try {
      versionList = await api.get('/api/update/versions', { quiet: true })
      await loadVersions()
    } catch (e) {
      toast('获取版本失败：' + e.message, 'err')
    }
  }

  async function loadRestorePoints() {
    let r
    try {
      r = await api.get('/api/restore-points', { quiet: true })
    } catch {
      return
    }
    clear(rpCard)
    rpCard.appendChild(
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-title' }, '回退点'),
        h('div', { class: 'spacer' }),
        h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `${r.items.length} 条`),
        btn('清理失效的', async () => {
          if (!(await confirmModal('清理失效回退点', '只清理「指向的数据备份已经不存在」的记录，正常回退点不受影响。', { okText: '清理' }))) return
          try {
            const x = await api.post('/api/restore-points/prune', {})
            toast(x.removed ? `已清理 ${x.removed} 条` : '没有失效的回退点', 'ok')
            await loadRestorePoints()
          } catch (e) {
            toast('清理失败：' + e.message, 'err')
          }
        }, { kind: 'ghost', size: 'sm' })
      )
    )
    if (!r.items.length) {
      rpCard.appendChild(h('div', { class: 'empty' }, '还没有回退点。每次更新前会自动记录。'))
      return
    }
    const list = h('div', { class: 'list' })
    for (const it of r.items) {
      list.appendChild(
        h(
          'div',
          { class: 'list-row' },
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'title' }, `${it.fromVersion || '?'} → ${it.toVersion || '?'}`),
            h('div', { class: 'meta' }, [fmtTime(it.createdAt), it.backup ? `数据备份 ${it.backup}` : '无数据备份', it.message].filter(Boolean).join('　·　'))
          ),
          it.status === 'success' ? badge('成功', 'ok') : it.status === 'failed' ? badge('失败', 'err') : it.status === 'rolled-back' ? badge('已回退', 'info') : badge(it.status, ''),
          btn('回退', async () => {
            const ok = await confirmModal(
              '回退版本',
              `把 dsh 退回到 ${it.fromVersion}。\n\n顺序是：先重装程序版本，再（可选）恢复数据。\n即使数据恢复有个别文件失败，程序版本也会回退成功。`,
              { okText: '回退', danger: true }
            )
            if (!ok) return
            runJob(() => api.post(`/api/restore-points/${encodeURIComponent(it.id)}/rollback`, { restoreData: Boolean(it.backup) }), '回退')
          }, { size: 'sm' }),
          btn('删除', async (ev) => {
            if (!(await confirmModal('删除回退点', `只删除这条记录，不动备份文件 ${it.backup || ''}。`, { okText: '删除', danger: true }))) return
            // 先把行拿掉，避免「点了没反应」的错觉；网络真失败再靠下面的 reload 纠正
            const row = ev && ev.target && ev.target.closest ? ev.target.closest('.list-row') : null
            const prevDisplay = row ? row.style.display : null
            if (row) row.style.display = 'none'
            try {
              const r = await api.del(`/api/restore-points/${encodeURIComponent(it.id)}`)
              if (r && r.deleted === false) toast('这条回退点已经不在了', 'ok')
              else toast(`已删除回退点${r && typeof r.remaining === 'number' ? `，还剩 ${r.remaining} 条` : ''}`, 'ok')
            } catch (e) {
              if (row && prevDisplay !== null) row.style.display = prevDisplay
              toast('删除失败：' + (e.message || '未知原因'), 'err')
            }
            await loadRestorePoints()
          }, { kind: 'ghost', size: 'sm' })
        )
      )
    }
    rpCard.appendChild(list)
  }

  check(false)
  loadVersions()
  loadRestorePoints()

  return {
    update(s) {
      if (s && s.job && /update|rollback/.test(s.job.kind || '')) showJob(s.job)
    },
    job: showJob,
  }
}
