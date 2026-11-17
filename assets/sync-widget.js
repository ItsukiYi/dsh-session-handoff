/**
 * dsh-session-handoff — 悬浮窗前端
 *
 * 由宿主通过 tapIndex / webserver/index-inject 注入到 GUI 页面。
 * 挂载点：右下角小圆球，点击展开同步面板。
 * 与宿主通信：fetch('/dsh-session-handoff/{status,push,pull,config}')。
 */
;(function () {
  'use strict'
  if (window.__dshSessionSyncLoaded) return
  window.__dshSessionSyncLoaded = true

  const BASE = '/dsh-session-handoff'
  const STATE = {
    open: false,
    loading: false,
    status: null,
    config: null,
    error: null,
    lastAction: null, // { kind: 'push'|'pull', ok, summary, at }
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
  `

  // ---------- DOM ----------
  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const root = el('div', 'dshss-root')
  const panel = el('div', 'dshss-panel')
  const ball = el('button', 'dshss-ball', '⇅')
  ball.title = 'DSH 会话同步'
  ball.setAttribute('aria-label', 'DSH 会话同步')
  root.appendChild(panel)
  root.appendChild(ball)
  document.body.appendChild(root)

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
    } catch (error) {
      STATE.error = String(error?.message ?? error)
    } finally {
      STATE.loading = false
      render()
    }
  }

  async function doPush() {
    STATE.loading = true
    STATE.error = null
    render()
    try {
      const result = await api('/push', {})
      STATE.lastAction = { kind: 'push', ok: result.ok === true, summary: summarize(result), at: new Date() }
      if (result.ok === false) STATE.error = result.error ?? 'push failed'
    } catch (error) {
      STATE.error = String(error?.message ?? error)
    } finally {
      STATE.loading = false
      render()
      refresh()
    }
  }

  async function doPull() {
    STATE.loading = true
    STATE.error = null
    render()
    try {
      const result = await api('/pull', {})
      STATE.lastAction = { kind: 'pull', ok: result.ok === true, summary: summarize(result), at: new Date() }
      if (result.ok === false) STATE.error = result.error ?? 'pull failed'
    } catch (error) {
      STATE.error = String(error?.message ?? error)
    } finally {
      STATE.loading = false
      render()
      refresh()
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
    return parts.length > 0 ? parts.join('，') : '无变化'
  }

  // ---------- 渲染 ----------
  function render() {
    ball.classList.toggle('dshss-busy', STATE.loading)
    ball.textContent = STATE.loading ? '◌' : '⇅'
    panel.textContent = ''

    const title = el('div', 'dshss-title')
    title.appendChild(el('span', null, '会话同步'))
    const cfgToggle = el('button', 'dshss-btn dshss-secondary', '⚙')
    cfgToggle.style.flex = '0 0 auto'
    cfgToggle.style.padding = '3px 8px'
    cfgToggle.onclick = () => { root.classList.toggle('dshss-cfg-open'); renderConfig() }
    title.appendChild(cfgToggle)
    panel.appendChild(title)

    const st = STATE.status
    if (STATE.error) {
      const err = el('div', 'dshss-msg dshss-err', STATE.error)
      panel.appendChild(err)
    }
    if (!st) {
      panel.appendChild(el('div', 'dshss-msg dshss-info', STATE.loading ? '加载中…' : '点击刷新获取状态'))
      return
    }
    if (st.ok === false) {
      panel.appendChild(el('div', 'dshss-msg dshss-err', '状态获取失败：' + (st.error ?? 'unknown')))
      return
    }

    const rows = el('div')
    rows.appendChild(makeRow('工作区', shorten(st.cwd)))
    rows.appendChild(makeRow('远端', st.remote ? shorten(st.remote) : '(未配置)', !st.remote))
    rows.appendChild(makeRow('本地会话', String(st.localSessions ?? 0)))
    rows.appendChild(makeRow('远端 bundle', String(st.remoteBundles ?? 0)))
    rows.appendChild(makeRow('待推送', String(st.toPush ?? 0), (st.toPush ?? 0) > 0))
    rows.appendChild(makeRow('待拉取', String(st.toPull ?? 0), (st.toPull ?? 0) > 0))
    if (st.repo && st.repo.head) rows.appendChild(makeRow('git HEAD', st.repo.head + (st.repo.branch ? ' @' + st.repo.branch : '')))
    panel.appendChild(rows)

    if (Array.isArray(st.push?.write) && st.push.write.length > 0) {
      const list = el('div', 'dshss-list')
      list.appendChild(el('div', null, '待推送：'))
      for (const item of st.push.write) {
        list.appendChild(el('div', null, item.id.slice(0, 18) + '… ' + (item.reason === 'fork' ? '⚠分叉' : '+' + item.events)))
      }
      panel.appendChild(list)
    }
    if (Array.isArray(st.pull?.overwrite) && st.pull.overwrite.length > 0) {
      const list = el('div', 'dshss-list')
      list.appendChild(el('div', null, '待覆盖（远端更新）：'))
      for (const item of st.pull.overwrite) {
        list.appendChild(el('div', null, item.id.slice(0, 18) + '… ' + item.localEvents + '→' + item.events))
      }
      panel.appendChild(list)
    }
    if (Array.isArray(st.pull?.fork) && st.pull.fork.length > 0) {
      const list = el('div', 'dshss-list')
      list.appendChild(el('div', null, '⚠ 分叉（将导入为新会话）：'))
      for (const item of st.pull.fork) {
        list.appendChild(el('div', null, item.id.slice(0, 18) + '… 本地' + item.localEvents + '/远端' + item.remoteEvents))
      }
      panel.appendChild(list)
    }

    const actions = el('div', 'dshss-actions')
    const pushBtn = el('button', 'dshss-btn', '↑ 推送')
    pushBtn.disabled = STATE.loading
    pushBtn.onclick = doPush
    const pullBtn = el('button', 'dshss-btn dshss-secondary', '↓ 拉取')
    pullBtn.disabled = STATE.loading
    pullBtn.onclick = doPull
    actions.appendChild(pushBtn)
    actions.appendChild(pullBtn)
    panel.appendChild(actions)

    if (STATE.lastAction) {
      const msg = el('div', 'dshss-msg ' + (STATE.lastAction.ok ? 'dshss-info' : 'dshss-err'),
        (STATE.lastAction.kind === 'push' ? '推送' : '拉取') + ' · ' + (STATE.lastAction.ok ? '完成' : '失败') + ' · ' + STATE.lastAction.summary)
      panel.appendChild(msg)
    }

    if (root.classList.contains('dshss-cfg-open')) renderConfig()
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
      panel.appendChild(box)
      remoteInput._ws = wsInput
    }
    remoteInput.value = cfg.remote ?? ''
    if (remoteInput._ws) remoteInput._ws.value = cfg.workspace ?? ''
  }

  function makeRow(label, value, warn) {
    const row = el('div', 'dshss-row')
    row.appendChild(el('span', 'dshss-label', label))
    const val = el('span', 'dshss-val' + (warn ? ' dshss-warn' : ''), value)
    val.title = value
    row.appendChild(val)
    return row
  }

  function shorten(text) {
    const s = String(text ?? '')
    return s.length > 32 ? s.slice(0, 30) + '…' : s
  }

  render()
})()
