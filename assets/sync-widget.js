/**
 * dsh-session-handoff — 悬浮窗前端
 *
 * 由宿主通过 tapIndex / webserver/index-inject 注入到 GUI 页面。
 * 挂载点：右下角小圆球，点击展开同步面板。
 * 与宿主通信：fetch('/dsh-session-handoff/{status,push,pull,config}')。
 */
;(function () {
  'use strict'
  // 诊断：确认本文件被页面加载执行
  if (window.__dshSessionSyncLoaded) return
  window.__dshSessionSyncLoaded = true

  const BASE = '/dsh-session-handoff'
  const STATE = {
    open: false,
    loading: false,
    updating: false,
    status: null,
    config: null,
    error: null,
    lastAction: null, // { kind: 'push'|'pull'|'update', ok, summary, at }
    sel: { push: null, pull: null, delete: null }, // Set<string> | null（null = 全部选中）
  }

  // ---------- 样式 ----------
  const CSS = `
  .dshss-root{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;color:#e6e6e6}
  .dshss-ball{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#4f8cff,#7c5cff);border:none;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease;padding:0}
  .dshss-ball:hover{transform:scale(1.06);box-shadow:0 6px 22px rgba(79,140,255,.5)}
  .dshss-ball.dshss-busy{animation:dshss-spin 1s linear infinite}
  @keyframes dshss-spin{to{transform:rotate(360deg)}}
  .dshss-panel{display:none;position:absolute;right:0;bottom:56px;width:340px;max-height:70vh;overflow:auto;background:#1e1f24;border:1px solid #33353d;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);padding:14px}
  .dshss-root.dshss-open .dshss-panel{display:block}
  .dshss-title{font-weight:600;font-size:14px;margin:0 0 10px;display:flex;justify-content:space-between;align-items:center}
  .dshss-title small{font-weight:400;color:#9aa0ab;font-size:11px}
  .dshss-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #2a2c33}
  .dshss-row:last-of-type{border-bottom:none}
  .dshss-label{color:#9aa0ab}
  .dshss-val{font-weight:500}
  .dshss-val.dshss-warn{color:#ffb74d}
  .dshss-val.dshss-ok{color:#66bb6a}
  .dshss-actions{display:flex;gap:8px;margin-top:12px}
  .dshss-btn{flex:1;padding:8px 10px;border:none;border-radius:8px;background:#4f8cff;color:#fff;font-weight:500;cursor:pointer;font-size:12px;transition:background .12s}
  .dshss-btn:hover{background:#6a9dff}
  .dshss-btn.dshss-secondary{background:#33353d}
  .dshss-btn.dshss-secondary:hover{background:#3f4149}
  .dshss-btn:disabled{opacity:.5;cursor:not-allowed}
  .dshss-msg{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;word-break:break-word}
  .dshss-msg.dshss-err{background:#3a2020;color:#ff8a80;border:1px solid #5c2e2e}
  .dshss-msg.dshss-info{background:#1f2c3a;color:#90caf9;border:1px solid #2e4460}
  .dshss-cfg{margin-top:10px;display:none}
  .dshss-root.dshss-cfg-open .dshss-cfg{display:block}
  .dshss-cfg input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #3a3c44;background:#26272c;color:#e6e6e6;font-size:12px;margin-top:4px}
  .dshss-cfg label{display:block;color:#9aa0ab;font-size:11px;margin-top:8px}
  .dshss-list{margin-top:8px;font-size:11px;color:#c5c9d1;max-height:140px;overflow:auto}
  .dshss-list div{padding:3px 0;border-bottom:1px solid #2a2c33}
  .dshss-list code{background:#26272c;padding:1px 5px;border-radius:4px;font-size:10px}

  .dshss-panel{width:400px;max-height:78vh}
  .dshss-title{display:flex;justify-content:space-between;align-items:center;gap:6px}
  .dshss-head-left{display:flex;align-items:center;gap:6px;min-width:0}
  .dshss-head-right{display:flex;gap:4px;flex:0 0 auto}
  .dshss-ver{font-weight:400;color:#8b93a1;font-size:10px;background:#26272c;border:1px solid #34363e;border-radius:5px;padding:1px 5px}
  .dshss-icon-btn{border:none;border-radius:7px;background:#33353d;color:#cfd4dc;cursor:pointer;font-size:12px;padding:3px 7px;line-height:1.4}
  .dshss-icon-btn:hover{background:#3f4149}
  .dshss-icon-btn:disabled{opacity:.45;cursor:not-allowed}
  .dshss-path{margin:0 0 8px}
  .dshss-path-row{display:flex;gap:6px;padding:3px 0;font-size:11px;line-height:1.45}
  .dshss-path-row .k{color:#8b93a1;flex:0 0 42px}
  .dshss-path-row .v{color:#dfe3ea;word-break:break-all;user-select:all;flex:1 1 auto}
  .dshss-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
  .dshss-cell{background:#26272c;border:1px solid #33353d;border-radius:9px;padding:7px 9px;text-align:center}
  .dshss-cell .n{font-size:17px;font-weight:600;line-height:1.2}
  .dshss-cell .t{font-size:10px;color:#8b93a1;margin-top:1px}
  .dshss-cell.dshss-warn{border-color:#6b5320;background:#332b18}
  .dshss-cell.dshss-warn .n{color:#ffb74d}
  .dshss-cell.dshss-ok .n{color:#66bb6a}
  .dshss-git{margin:2px 0 8px;font-size:10.5px;color:#9aa0ab;line-height:1.5;word-break:break-word}
  .dshss-sec{margin-top:10px;border-top:1px solid #2a2c33;padding-top:8px}
  .dshss-sec-head{display:flex;align-items:center;gap:6px;font-size:11px;color:#9aa0ab;margin-bottom:4px}
  .dshss-sec-head .ttl{flex:1 1 auto;font-weight:600;color:#c5c9d1}
  .dshss-sec-head label{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;font-size:10.5px;color:#8b93a1}
  .dshss-item{display:flex;align-items:flex-start;gap:6px;padding:4px 0;font-size:11px;line-height:1.4;border-bottom:1px solid #26272c}
  .dshss-item:last-child{border-bottom:none}
  .dshss-item input{margin:1px 0 0;flex:0 0 auto;cursor:pointer}
  .dshss-item .body{flex:1 1 auto;min-width:0}
  .dshss-item .name{color:#dfe3ea;word-break:break-word}
  .dshss-item .meta{color:#7f8794;font-size:10px;margin-top:1px;word-break:break-all}
  .dshss-tag{display:inline-block;font-size:9.5px;padding:0 4px;border-radius:4px;margin-left:4px;vertical-align:1px}
  .dshss-tag.new{background:#1f3a2a;color:#81c995}
  .dshss-tag.ahead{background:#1f2c3a;color:#90caf9}
  .dshss-tag.fork{background:#3a2a1f;color:#ffb74d}
  .dshss-tag.over{background:#2c2440;color:#c5a3ff}
  .dshss-msg.dshss-good{background:#1f3a2a;color:#81c995;border:1px solid #2e5c3a}
  .dshss-hint{color:#7f8794;font-size:10.5px;margin-top:2px}
  `

  // ---------- DOM ----------
  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // DOM 就绪保护：内联注入可能在 body 完整前执行
  const root = el('div', 'dshss-root')
  const panel = el('div', 'dshss-panel')
  const ball = el('button', 'dshss-ball', '⇅')
  ball.title = 'DSH 会话同步'
  ball.setAttribute('aria-label', 'DSH 会话同步')
  root.appendChild(panel)
  root.appendChild(ball)

  // DOM 就绪保护：内联注入可能在 body 完整前执行，只延迟挂载到 body
  const mountToBody = () => { document.body.appendChild(root) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountToBody, { once: true })
  else mountToBody()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  ball.addEventListener('click', () => {
    STATE.open = !STATE.open
    root.classList.toggle('dshss-open', STATE.open)
    if (STATE.open) { render(); refresh() }
  })

  // ---------- 数据 ----------
  async function api(path, body) {
    const res = await fetch(BASE + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const data = await res.json().catch(() => ({ ok: false, error: 'invalid JSON response' }))
    return data
  }

  async function refresh() {
    STATE.loading = true
    STATE.error = null
    render()
    try {
      const [status, config] = await Promise.all([api('/status.json'), api('/config.json')])
      STATE.status = status
      STATE.config = config?.config ?? {}
      if (status.ok === false) STATE.error = status.error
      syncSelection()
    } catch (error) {
      STATE.error = String(error?.message ?? error)
    } finally {
      STATE.loading = false
      render()
    }
  }

  function pushItems(st) { return Array.isArray(st?.push?.write) ? st.push.write : [] }

  function pullItems(st) {
    const p = st?.pull ?? {}
    const out = []
    for (const item of Array.isArray(p.import) ? p.import : []) out.push(Object.assign({}, item, { kind: 'import' }))
    for (const item of Array.isArray(p.overwrite) ? p.overwrite : []) out.push(Object.assign({}, item, { kind: 'overwrite' }))
    for (const item of Array.isArray(p.fork) ? p.fork : []) out.push(Object.assign({}, item, { kind: 'fork' }))
    return out
  }

  function deleteItems(st) { return Array.isArray(st?.deletions) ? st.deletions : [] }

  /** 状态刷新后校正选择集：保留仍存在的勾选，新出现的默认勾选。 */
  function syncSelection() {
    const st = STATE.status
    const groups = { push: pushItems(st).map((i) => i.id), pull: pullItems(st).map((i) => i.id), delete: deleteItems(st).map((i) => i.id) }
    const deleteDefault = new Set(deleteItems(st).filter((i) => !i.remoteOnly).map((i) => i.id))
    for (const key of ['push', 'pull', 'delete']) {
      const prev = STATE.sel[key]
      const ids = groups[key]
      if (prev === null || prev === undefined) { STATE.sel[key] = key === 'delete' ? new Set(deleteDefault) : new Set(ids); continue }
      const next = new Set()
      for (const id of ids) if (prev.has(id)) next.add(id)
      for (const id of ids) if (!prev.has(id)) next.add(id)
      STATE.sel[key] = next
    }
  }

  function selectedIds(key, items) {
    const sel = STATE.sel[key]
    if (!sel) return items.map((i) => i.id)
    return items.filter((i) => sel.has(i.id)).map((i) => i.id)
  }

  async function doPush() {
    const items = pushItems(STATE.status)
    const delItems = deleteItems(STATE.status)
    const ids = selectedIds('push', items)
    const deleteIds = selectedIds('delete', delItems)
    if (items.length > 0 && ids.length === 0 && deleteIds.length === 0) { STATE.error = '没有勾选要推送或删除的会话'; render(); return }
    STATE.loading = true
    STATE.error = null
    render()
    try {
      const payload = {}
      if (items.length > 0) payload.selected = ids
      if (deleteIds.length > 0) payload.deleteIds = deleteIds
      const result = await api('/push', payload)
      STATE.lastAction = { kind: 'push', ok: result.ok === true, summary: summarize(result), at: new Date() }
      if (result.ok === false) STATE.error = result.error ?? 'push failed'
    } catch (error) {
      STATE.error = String(error?.message ?? error)
    } finally {
      STATE.loading = false
      STATE.sel.push = null
      STATE.sel.delete = null
      render()
      refresh()
    }
  }

  async function doPull() {
    const items = pullItems(STATE.status)
    const ids = selectedIds('pull', items)
    if (items.length > 0 && ids.length === 0) { STATE.error = '没有勾选要拉取的会话'; render(); return }
    STATE.loading = true
    STATE.error = null
    render()
    try {
      const result = await api('/pull', items.length > 0 ? { selected: ids } : {})
      STATE.lastAction = { kind: 'pull', ok: result.ok === true, summary: summarize(result), at: new Date() }
      if (result.ok === false) STATE.error = result.error ?? 'pull failed'
    } catch (error) {
      STATE.error = String(error?.message ?? error)
    } finally {
      STATE.loading = false
      STATE.sel.pull = null
      render()
      refresh()
    }
  }

  async function doUpdate() {
    STATE.updating = true
    STATE.error = null
    render()
    try {
      const result = await api('/update', {})
      if (result.ok === false) {
        STATE.lastAction = { kind: 'update', ok: false, summary: String(result.error ?? '更新失败').slice(0, 160), at: new Date() }
      } else {
        const ver = result.changed
          ? (result.previousVersion && result.version ? result.previousVersion + ' → ' + result.version : '已更新')
          : '已是最新'
        STATE.lastAction = { kind: 'update', ok: true, summary: ver + (result.changed ? '（重启 DSH 生效）' : ''), at: new Date() }
      }
    } catch (error) {
      STATE.lastAction = { kind: 'update', ok: false, summary: String(error?.message ?? error).slice(0, 160), at: new Date() }
    } finally {
      STATE.updating = false
      render()
    }
  }

  async function saveConfig(patch) {
    try {
      const result = await api('/config.json', patch)
      STATE.config = result?.config ?? STATE.config
      render()
      refresh()
    } catch (error) {
      STATE.error = String(error?.message ?? error)
      render()
    }
  }

  function summarize(result) {
    const parts = []
    if (Array.isArray(result.written)) parts.push(result.written.length + ' 推送')
    if (Array.isArray(result.imported) && result.imported.length) parts.push(result.imported.length + ' 新导入')
    if (Array.isArray(result.overwritten) && result.overwritten.length) parts.push(result.overwritten.length + ' 覆盖')
    if (Array.isArray(result.forked) && result.forked.length) parts.push(result.forked.length + ' 分叉')
    if (Array.isArray(result.forkBundles) && result.forkBundles.length) parts.push(result.forkBundles.length + ' fork bundle')
    if (result.deleted && Array.isArray(result.deleted.removed) && result.deleted.removed.length) parts.push(result.deleted.removed.length + ' 删除')
    if (result.ok === false && result.error) return String(result.error).slice(0, 160)
    return parts.length > 0 ? parts.join('，') : '无变化'
  }

  function pad2(n) { return String(n).padStart(2, '0') }

  function fmtTime(ms) {
    if (!ms) return ''
    const d = new Date(Number(ms))
    if (isNaN(d.getTime())) return ''
    return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function fmtClock(date) {
    if (!(date instanceof Date)) return ''
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
  }

  function shortId(id) { return String(id ?? '').replace(/^session-/, '').slice(0, 8) }

  function itemName(item) {
    const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : null
    return title !== null ? title : '会话 ' + shortId(item.id)
  }

  function render() {
    ball.classList.toggle('dshss-busy', STATE.loading || STATE.updating)
    ball.textContent = (STATE.loading || STATE.updating) ? '◌' : '⇅'
    panel.textContent = ''

    const st = STATE.status

    const title = el('div', 'dshss-title')
    const left = el('div', 'dshss-head-left')
    left.appendChild(el('span', null, '会话同步'))
    if (st?.version) left.appendChild(el('span', 'dshss-ver', 'v' + st.version))
    title.appendChild(left)
    const right = el('div', 'dshss-head-right')
    const updBtn = el('button', 'dshss-icon-btn', STATE.updating ? '…' : '⟳ 更新')
    updBtn.title = 'git pull 插件自身仓库（快进）；有更新需重启 DSH'
    updBtn.disabled = STATE.loading || STATE.updating
    updBtn.onclick = doUpdate
    const cfgBtn = el('button', 'dshss-icon-btn', '⚙')
    cfgBtn.title = '配置'
    cfgBtn.onclick = () => { root.classList.toggle('dshss-cfg-open'); renderConfig() }
    right.appendChild(updBtn)
    right.appendChild(cfgBtn)
    title.appendChild(right)
    panel.appendChild(title)

    if (STATE.error) panel.appendChild(el('div', 'dshss-msg dshss-err', STATE.error))
    if (!st) {
      panel.appendChild(el('div', 'dshss-msg dshss-info', STATE.loading ? '加载中…' : '点击刷新获取状态'))
      if (root.classList.contains('dshss-cfg-open')) renderConfig()
      return
    }
    if (st.ok === false) {
      panel.appendChild(el('div', 'dshss-msg dshss-err', '状态获取失败：' + (st.error ?? 'unknown')))
      if (root.classList.contains('dshss-cfg-open')) renderConfig()
      return
    }

    const paths = el('div', 'dshss-path')
    const addPath = (k, v, muted) => {
      const row = el('div', 'dshss-path-row')
      row.appendChild(el('span', 'k', k))
      const val = el('span', 'v', v)
      if (muted) val.style.color = '#8b93a1'
      row.appendChild(val)
      paths.appendChild(row)
    }
    addPath('工作区', String(st.cwd ?? '(未设置)'))
    addPath('远端', st.remote ? String(st.remote) : '(未配置)', !st.remote)
    panel.appendChild(paths)

    const grid = el('div', 'dshss-grid')
    const addCell = (n, t, tone) => {
      const cell = el('div', 'dshss-cell' + (tone ? ' dshss-' + tone : ''))
      cell.appendChild(el('div', 'n', String(n ?? 0)))
      cell.appendChild(el('div', 't', t))
      grid.appendChild(cell)
    }
    addCell(st.localSessions, '本地会话')
    addCell(st.remoteBundles, '远端 bundle')
    addCell(st.toPush, '待推送', (st.toPush ?? 0) > 0 ? 'warn' : 'ok')
    addCell(st.toPull, '待拉取', (st.toPull ?? 0) > 0 ? 'warn' : 'ok')
    if ((st.toDelete ?? 0) > 0) addCell(st.toDelete, '待删除', 'warn')
    panel.appendChild(grid)

    const bd = st.localBreakdown
    if (bd && (bd.archived > 0 || bd.deleted > 0 || bd.empty > 0)) {
      const bits = []
      if (bd.archived > 0) bits.push('已归档 ' + bd.archived)
      if (bd.deleted > 0) bits.push('远端已删 ' + bd.deleted)
      if (bd.empty > 0) bits.push('空会话 ' + bd.empty)
      panel.appendChild(el('div', 'dshss-hint', '不计入本地会话：' + bits.join(' · ')))
    }

    const repo = st.repo ?? {}
    if (repo.head) {
      const bits = ['HEAD ' + repo.head]
      if (repo.branch) bits.push('@' + repo.branch)
      const time = fmtTime(repo.headTime)
      if (time) bits.push('· ' + time)
      if (repo.headAuthor) bits.push('· ' + repo.headAuthor)
      const gitLine = el('div', 'dshss-git', bits.join(' '))
      if (repo.headSubject) gitLine.title = repo.headSubject
      panel.appendChild(gitLine)
    }

    renderList('push', '待推送', pushItems(st), (item) => {
      const reason = item.reason
      const tagClass = reason === 'fork' ? 'fork' : reason === 'new' ? 'new' : 'ahead'
      const delta = typeof item.newEvents === 'number' ? item.newEvents : null
      const tagText = reason === 'fork' ? '分叉' : reason === 'new' ? '新' : (delta !== null ? '本地 +' + delta : '本地更新')
      const meta = shortId(item.id) + ' · ' + item.events + ' 事件' + (item.duplicate ? ' · ⚠ 疑似重复副本' : '')
      return { tagClass: tagClass, tagText: tagText, meta: meta }
    })

    renderList('pull', '待拉取', pullItems(st), (item) => {
      const kind = item.kind
      const tagClass = kind === 'fork' ? 'fork' : kind === 'overwrite' ? 'over' : 'new'
      const tagText = kind === 'fork' ? '分叉' : kind === 'overwrite' ? '覆盖' : '新导入'
      let meta = shortId(item.id) + ' · ' + item.events + ' 事件'
      if (kind === 'overwrite') meta = shortId(item.id) + ' · ' + item.localEvents + '→' + item.events
      if (kind === 'fork') meta = shortId(item.id) + ' · 本地' + item.localEvents + '/远端' + item.remoteEvents
      return { tagClass: tagClass, tagText: tagText, meta: meta }
    })

    renderList('delete', '待删除', deleteItems(st), (item) => {
      const tagText = item.remoteOnly ? '仅远端' : item.archived ? '已归档' : '本地已删'
      const tail = item.remoteOnly ? '本机无此会话，勾选后移除远端副本' : '推送时移除远端副本'
      return { tagClass: 'fork', tagText: tagText, meta: shortId(item.id) + ' · 远端 ' + item.events + ' 事件 · ' + tail }
    })

    const emptyList = Array.isArray(st.push?.empty) ? st.push.empty : []
    if (emptyList.length > 0) {
      const hint = el('div', 'dshss-hint', '空会话不计入推送：' + emptyList.length + ' 个（无对话内容）')
      panel.appendChild(hint)
    }

    const pushAll = pushItems(st)
    const pullAll = pullItems(st)
    const pushIds = selectedIds('push', pushAll)
    const pullIds = selectedIds('pull', pullAll)
    const actions = el('div', 'dshss-actions')
    const delAll = deleteItems(st)
    const delIds = selectedIds('delete', delAll)
    const pushParts = []
    if (pushIds.length > 0) pushParts.push(pushIds.length + ' 推')
    if (delIds.length > 0) pushParts.push(delIds.length + ' 删')
    const pushLabel = '↑ 推送' + (pushParts.length > 0 ? ' (' + pushParts.join(' / ') + ')' : '')
    const pushBtn = el('button', 'dshss-btn', pushLabel)
    pushBtn.disabled = STATE.loading || STATE.updating || (pushAll.length > 0 && pushIds.length === 0 && delIds.length === 0)
    pushBtn.onclick = doPush
    const pullLabel = '↓ 拉取' + (pullAll.length > 1 || pullIds.length !== pullAll.length ? ' (' + pullIds.length + ')' : '')
    const pullBtn = el('button', 'dshss-btn dshss-secondary', pullLabel)
    pullBtn.disabled = STATE.loading || STATE.updating || (pullAll.length > 0 && pullIds.length === 0)
    pullBtn.onclick = doPull
    actions.appendChild(pushBtn)
    actions.appendChild(pullBtn)
    panel.appendChild(actions)

    if (STATE.lastAction) {
      const la = STATE.lastAction
      const kindText = la.kind === 'push' ? '推送' : la.kind === 'pull' ? '拉取' : '更新'
      const tone = la.ok ? (la.kind === 'update' ? 'dshss-good' : 'dshss-info') : 'dshss-err'
      const when = fmtClock(la.at)
      panel.appendChild(el('div', 'dshss-msg ' + tone,
        kindText + ' · ' + (la.ok ? '完成' : '失败') + ' · ' + la.summary + (when ? ' · ' + when : '')))
    }

    if (root.classList.contains('dshss-cfg-open')) renderConfig()
  }

  function renderList(key, titleText, items, decorate) {
    if (items.length === 0) return
    const sel = STATE.sel[key] ?? new Set(items.map((i) => i.id))
    const sec = el('div', 'dshss-sec')
    const head = el('div', 'dshss-sec-head')
    head.appendChild(el('span', 'ttl', titleText + ' · ' + sel.size + '/' + items.length))
    const allLabel = el('label')
    const allBox = document.createElement('input')
    allBox.type = 'checkbox'
    allBox.checked = sel.size === items.length
    allBox.indeterminate = sel.size > 0 && sel.size < items.length
    allBox.onchange = () => {
      STATE.sel[key] = allBox.checked ? new Set(items.map((i) => i.id)) : new Set()
      render()
    }
    allLabel.appendChild(allBox)
    allLabel.appendChild(document.createTextNode('全选'))
    head.appendChild(allLabel)
    sec.appendChild(head)

    for (const item of items) {
      const row = el('div', 'dshss-item')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = sel.has(item.id)
      box.onchange = () => {
        const next = new Set(STATE.sel[key] ?? items.map((i) => i.id))
        if (box.checked) next.add(item.id)
        else next.delete(item.id)
        STATE.sel[key] = next
        render()
      }
      row.appendChild(box)
      const body = el('div', 'body')
      const nameLine = el('div', 'name')
      nameLine.appendChild(el('span', null, itemName(item)))
      const decorated = decorate(item)
      nameLine.appendChild(el('span', 'dshss-tag ' + decorated.tagClass, decorated.tagText))
      body.appendChild(nameLine)
      body.appendChild(el('div', 'meta', decorated.meta))
      row.appendChild(body)
      sec.appendChild(row)
    }
    panel.appendChild(sec)
  }

  function renderConfig() {
    const cfg = STATE.config ?? {}
    let remoteInput = panel.querySelector('.dshss-cfg-remote')
    if (!remoteInput) {
      const box = el('div', 'dshss-cfg')
      box.appendChild(el('label', null, 'Git 远端（git remote get-url origin 的值）'))
      remoteInput = el('input', 'dshss-cfg-remote')
      remoteInput.placeholder = 'https://github.com/user/repo.git'
      box.appendChild(remoteInput)
      box.appendChild(el('label', null, '工作区路径（留空 = 用当前 cwd）'))
      const wsInput = el('input', 'dshss-cfg-workspace')
      wsInput.placeholder = 'D:\\CyberAlbum'
      box.appendChild(wsInput)
      const saveBtn = el('button', 'dshss-btn', '保存配置')
      saveBtn.style.marginTop = '10px'
      saveBtn.style.width = '100%'
      saveBtn.onclick = () => {
        const patch = {}
        if (remoteInput.value.trim()) patch.remote = remoteInput.value.trim()
        if (wsInput.value.trim()) patch.workspace = wsInput.value.trim()
        saveConfig(patch)
      }
      box.appendChild(saveBtn)
      if (STATE.status?.configPath) box.appendChild(el('div', 'dshss-hint', '配置文件：' + STATE.status.configPath))
      panel.appendChild(box)
      remoteInput._ws = wsInput
    }
    remoteInput.value = cfg.remote ?? ''
    if (remoteInput._ws) remoteInput._ws.value = cfg.workspace ?? ''
  }

  render()
})()