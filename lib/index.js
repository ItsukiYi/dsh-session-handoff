/**
 * dsh-session-handoff — 宿主插件：导出/导入 v4 原生会话，并即时登记到工作区。
 *
 * 与 bin/dsh-session-handoff.mjs 共用 .handoff.jsonl 格式：
 *   第 1 行 bundle 元信息；第 2 行会话物理 header；之后是原始事件行。
 *
 * 导入走 sessionPersistence 的公开 API（create + append + flush），
 * 再用 workspaceRegistry 的 attachSession 即时登记，所以不需要重启 DSH。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readConfig, writeConfig, gitAvailable, syncStatus, planPush, applyPush, planPull, applyPull, handoffDir, git, listWorkspaceSessions } from './sync-engine.mjs'

export const name = 'session-handoff'
// webServer：悬浮窗 HTTP 路由。connection 用 ctx.get 懒取（缺失时降级），不进 inject。
// 不用对象级 inject：它会推迟整个 apply()，而桌面壳的注入表在宿主启动时一次性收集，
// 晚了就永远进不去（whale-widget #152/#153 同款坑）。服务用 root.inject 局部等待。
// 无顶层 inject：apply() 立刻执行，先抢注桌面注入行（宿主启动时一次性收集注入表）。
// 依赖（tools/webServer）全部用 ctx.inject 局部等待 —— whale-widget #152 同款。


const BUNDLE_FORMAT = 'dsh-session-handoff'
const BUNDLE_VERSION = 1
const SESSION_FORMAT_VERSION = 4

function physicalHeader(header) {
  return { type: 'session', version: SESSION_FORMAT_VERSION, ...header }
}

function logicalHeader(line) {
  if (line === null || typeof line !== 'object') throw new Error('bundle header is not an object')
  if (line.type !== 'session') throw new Error('bundle header type is not "session"')
  if (line.version !== SESSION_FORMAT_VERSION) {
    throw new Error('bundle session format is v' + String(line.version) + ', this harness only reads v' + SESSION_FORMAT_VERSION)
  }
  // 逻辑 header 必须保留 version：V4 编码器把它当作 SessionHeader 的一部分校验。
  const { type: _type, ...header } = line
  if (!Number.isSafeInteger(header.version)) throw new Error('bundle header has no valid session format version')
  return header
}

function readBundle(file) {
  if (!existsSync(file)) throw new Error('bundle not found: ' + file)
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.length < 2) throw new Error('bundle is too short: ' + file)
  const meta = JSON.parse(lines[0])
  if (meta.format !== BUNDLE_FORMAT) throw new Error('not a dsh-session-handoff bundle: ' + file)
  if (meta.formatVersion !== BUNDLE_VERSION) throw new Error('unsupported bundle format version: ' + String(meta.formatVersion))
  if (meta.sessionFormat !== SESSION_FORMAT_VERSION) throw new Error('bundle session format mismatch')
  const header = logicalHeader(JSON.parse(lines[1]))
  const eventLines = []
  for (let i = 2; i < lines.length; i++) if (lines[i].length > 0) eventLines.push(lines[i])
  return { meta, header, eventLines }
}

function parseEvents(eventLines) {
  const events = []
  let expected = 0
  for (const [index, line] of eventLines.entries()) {
    let event
    try { event = JSON.parse(line) } catch { throw new Error('event line ' + (index + 1) + ' is not valid JSON') }
    if (!Number.isSafeInteger(event.seq)) throw new Error('event line ' + (index + 1) + ' has no integer seq')
    if (event.seq !== expected) throw new Error('event seq gap: expected ' + expected + ' at line ' + (index + 1) + ', got ' + event.seq)
    expected = event.seq + 1
    events.push(event)
  }
  return events
}

function baseDir(exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch {}
  return process.cwd()
}

function currentSessionId(exec) {
  try {
    const id = exec?.agent?.session?.id
    if (typeof id === 'string' && id.length > 0) return id
  } catch {}
  return undefined
}

async function exportSession(ctx, args, exec) {
  const sessionId = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : currentSessionId(exec)
  if (sessionId === undefined) throw new Error('session_export needs a sessionId (no owning agent session)')
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const header = handle.header
    if (header.isSeeded === true) {
      throw new Error('session "' + sessionId + '" is seeded (fork/inherited prefix); native export is not supported yet')
    }
    const { events } = await handle.read(0)
    const outDir = typeof args.outDir === 'string' && args.outDir.length > 0
      ? (isAbsolute(args.outDir) ? args.outDir : resolve(baseDir(exec), args.outDir))
      : join(header.cwd ?? baseDir(exec), '.dsh-handoff')
    mkdirSync(outDir, { recursive: true })
    const file = join(outDir, sessionId + '.handoff.jsonl')
    const meta = {
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_VERSION,
      sessionFormat: SESSION_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: { id: header.id, cwd: header.cwd ?? null, agentPreset: header.agentPreset ?? null },
    }
    const lines = [JSON.stringify(meta), JSON.stringify(physicalHeader(header)), ...events.map((event) => JSON.stringify(event))]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    return { file, sessionId, events: events.length }
  } finally {
    await handle.close()
  }
}

async function importSession(ctx, args, exec) {
  if (typeof args.file !== 'string' || args.file.length === 0) throw new Error('session_import needs a bundle file path')
  const file = isAbsolute(args.file) ? args.file : resolve(baseDir(exec), args.file)
  const { meta, header, eventLines } = readBundle(file)
  const events = parseEvents(eventLines)
  if (header.isSeeded === true) throw new Error('this bundle is a seeded (fork) session; importing it is not supported yet')
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('session_import needs a target cwd (the bundle header carries none)')
  const newId = 'session-' + randomUUID()
  const handle = await ctx.sessionPersistence.create({ ...header, id: newId, cwd })
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  const result = { file, sessionId: newId, cwd, events: events.length }
  const sourceId = meta?.source?.id
  if (typeof sourceId === 'string') result.sourceId = sourceId
  if (args.attach !== false) {
    try {
      let entity = await ctx.workspaceRegistry.resolveByPath(cwd)
      if (entity === undefined) entity = await ctx.workspaceRegistry.create(cwd)
      await entity.attachSession(newId)
      result.workspace = entity.path
    } catch (error) {
      result.workspaceError = error instanceof Error ? error.message : String(error)
    }
  }
  return result
}

async function unregisterSession(ctx, args) {
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) throw new Error('session_unregister needs a sessionId')
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined
  const entities = cwd === undefined
    ? ctx.workspaceRegistry.list()
    : [await ctx.workspaceRegistry.resolveByPath(cwd)].filter((entity) => entity !== undefined)
  for (const entity of entities) {
    const record = entity.sessionIds.includes ? entity.sessionIds : []
    if (!record.includes(args.sessionId)) continue
    await entity.detachSession(args.sessionId)
    return { sessionId: args.sessionId, workspace: entity.path, detached: true }
  }
  return { sessionId: args.sessionId, detached: false }
}

async function listSessions(ctx, args) {
  const entries = await ctx.sessionPersistence.list()
  const filter = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined
  const rows = []
  for (const entry of entries) {
    const header = entry?.header ?? entry
    if (header === undefined || header === null || typeof header !== 'object') continue
    if (typeof header.id !== 'string') continue
    if (filter !== undefined && header.cwd !== filter) continue
    const row = { sessionId: header.id }
    if (typeof header.cwd === 'string') row.cwd = header.cwd
    if (Number.isSafeInteger(header.createdAt)) row.createdAt = header.createdAt
    if (typeof header.agentPreset === 'string') row.agentPreset = header.agentPreset
    rows.push(row)
  }
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : 50
  return { total: rows.length, shown: Math.min(limit, rows.length), sessions: rows.slice(0, limit) }
}

const SESSION_ROW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    cwd: { type: 'string' },
    createdAt: { type: 'integer' },
    agentPreset: { type: 'string' },
  },
  required: ['sessionId'],
}

const exportTool = {
  name: 'session_export',
  description: 'Export a DSH session as a portable .handoff.jsonl file into the workspace (default <cwd>/.dsh-handoff). The file carries the raw native event stream, so it can be committed to git and imported on another machine with session_import. Session logs may contain tool output and secrets: warn the user before committing them.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', description: 'Session to export. Defaults to the current session.' },
      outDir: { type: 'string', description: 'Output directory. Defaults to <session cwd>/.dsh-handoff.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        sessionId: { type: 'string' },
        events: { type: 'integer' },
      },
      required: ['file', 'sessionId', 'events'],
    },
    render: (_args, value) => [{ type: 'text', text: 'Exported ' + value.events + ' events from ' + value.sessionId + ' to ' + value.file }],
  },
  execute: (args, exec) => exportSession(exec.ctx ?? undefined, args, exec),
}

const importTool = {
  name: 'session_import',
  description: 'Import a .handoff.jsonl bundle as a new native session (new id) and attach it to the matching workspace so it appears in the sidebar immediately. The target DSH must use the same session format (v4).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file: { type: 'string', description: 'Bundle file path (absolute, or relative to the current workspace).' },
      cwd: { type: 'string', description: 'Target workspace directory. Defaults to the cwd recorded in the bundle.' },
      attach: { type: 'boolean', description: 'Attach the imported session to its workspace. Defaults to true.' },
    },
    required: ['file'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        events: { type: 'integer' },
        sourceId: { type: 'string' },
        workspace: { type: 'string' },
        workspaceError: { type: 'string' },
      },
      required: ['file', 'sessionId', 'cwd', 'events'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: 'Imported ' + value.events + ' events as ' + value.sessionId + ' (cwd ' + value.cwd + ')'
        + (typeof value.workspace === 'string' ? '; attached to ' + value.workspace : '; workspace attach failed: ' + (value.workspaceError ?? 'attach skipped')),
    }],
  },
  execute: (args, exec) => importSession(exec.ctx ?? undefined, args, exec),
}

const listTool = {
  name: 'session_list',
  description: 'List stored DSH sessions with their ids and cwds, optionally filtered by workspace path. Useful before session_export.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cwd: { type: 'string', description: 'Only sessions whose recorded cwd equals this path.' },
      limit: { type: 'integer', description: 'Maximum rows to return. Defaults to 50.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'integer' },
        shown: { type: 'integer' },
        sessions: { type: 'array', items: SESSION_ROW },
      },
      required: ['total', 'shown', 'sessions'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.shown + '/' + value.total + ' sessions:\n' + value.sessions.map((s) => s.sessionId + '  ' + (s.cwd ?? '(no cwd)')).join('\n'),
    }],
  },
  execute: (args, exec) => listSessions(exec.ctx ?? undefined, args),
}

const unregisterTool = {
  name: 'session_unregister',
  description: 'Detach a session from its workspace so it stops appearing in the sidebar. The stored session file is left on disk: delete it yourself only after DSH is closed, because a running host may still hold the write lock.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', description: 'Session to detach.' },
      cwd: { type: 'string', description: 'Workspace to detach it from. Defaults to every workspace.' },
    },
    required: ['sessionId'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string' },
        workspace: { type: 'string' },
        detached: { type: 'boolean' },
      },
      required: ['sessionId', 'detached'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.detached
        ? 'Detached ' + value.sessionId + ' from ' + value.workspace
        : 'Session ' + value.sessionId + ' was not attached to any workspace',
    }],
  },
  execute: () => { throw new Error('unbound') },
}

// ---------------------------------------------------------------------------
// 悬浮窗 HTTP 路由（webServer）+ 桌面端脚本注入（webserver/index-inject）
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

// 信任栅栏：宿主 connection 服务可用就委托它；不可用则退化为自校验（只放行回环 Host）。
// 写请求（POST）必须来自本机，避免远端拿到 Web 会话就能改 git 远端配置。
function makeBarrier(ctx) {
  const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  const fence = () => {
    try {
      const conn = ctx.get ? ctx.get('connection') : ctx.connection
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch { return null }
  }
  const loopback = (hostname) => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  return function rejected(req, res) {
    const deny = (code) => { try { res.statusCode = code || 403; res.end() } catch {} ; return true }
    let host = ''
    try { host = new URL('http://' + String(req?.headers?.host ?? '')).hostname.toLowerCase() } catch { return deny(403) }
    const method = String(req?.method ?? 'GET').toUpperCase()
    const conn = fence()
    if (conn) {
      try {
        const code = conn.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) return deny(typeof code === 'number' ? code : 403)
      } catch { return deny(403) }
    } else if (!loopback(host)) {
      return deny(403)
    }
    if (WRITE.has(method) && !loopback(host)) return deny(403)
    return false
  }
}

function registerRoute(ctx, rejected, route) {
  const inner = route?.handler
  const wrapped = { ...route, handler: async (req, res) => { if (rejected(req, res)) return; return inner(req, res) } }
  return ctx.webServer.register(wrapped)
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk.toString('utf8') })
    req.on('end', () => { try { resolveBody(data.length > 0 ? JSON.parse(data) : {}) } catch (error) { rejectBody(error) } })
    req.on('error', rejectBody)
  })
}

async function resolveCwd(ctx, requested) {
  if (typeof requested === 'string' && requested.length > 0) return requested
  const saved = readConfig().workspace
  if (typeof saved === 'string' && saved.length > 0) return saved
  const entity = await ctx.workspaceRegistry.resolveByPath(process.cwd())
  if (entity !== undefined) return entity.path
  const all = ctx.workspaceRegistry.list()
  return all[0]?.path
}

async function registerSyncRoutes(ctx, rejected) {
  const disposers = []
  const base = '/dsh-session-handoff'
  const json = (res, payload) => { res.writeHead(200, JSON_HEADERS); res.end(JSON.stringify(payload)) }
  const fail = (res, error) => { res.writeHead(200, JSON_HEADERS); res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) })) }

  disposers.push(registerRoute(ctx, rejected, {
    kind: 'exact',
    path: base + '/widget.js',
    handler: (_req, res) => {
      const file = join(dirname(fileURLToPath(import.meta.url)), 'sync-widget.js')
      try {
        const bytes = readFileSync(file)
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(bytes)
      } catch (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('widget script unavailable: ' + String(error?.message ?? error))
      }
    },
  }))

  disposers.push(registerRoute(ctx, rejected, {
    kind: 'exact',
    path: base + '/widget-loaded',
    handler: (_req, res) => {
      try { appendFileSync(join(process.env.DSH_HOME ?? '', 'session-sync-debug.log'), '[widget-loaded] page executed widget.js at ' + new Date().toISOString() + '\n') } catch {}
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok')
    },
  }))

  disposers.push(registerRoute(ctx, rejected, {
    kind: 'exact',
    path: base + '/status.json',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const cwd = await resolveCwd(ctx, url.searchParams.get('cwd'))
        json(res, { ok: true, ...(await syncStatus(ctx.sessionPersistence, ctx.workspaceRegistry, cwd)) })
      } catch (error) { fail(res, error) }
    },
  }))

  disposers.push(registerRoute(ctx, rejected, {
    kind: 'exact',
    path: base + '/push',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const cwd = await resolveCwd(ctx, body.cwd)
        const plan = await planPush(ctx.sessionPersistence, cwd)
        const applied = await applyPush(ctx.sessionPersistence, cwd, plan)
        const gitResult = await git(['add', handoffDir(cwd)], cwd)
        if (gitResult.code !== 0) return json(res, { ok: false, stage: 'add', error: gitResult.stderr || gitResult.error, ...applied, plan })
        // 有变更才 commit；没有时不算失败。
        let committed = true
        let commitOut = ''
        if (applied.written.length > 0) {
          const commit = await git(['commit', '-m', 'session sync: push ' + applied.written.length + ' bundle(s)'], cwd)
          committed = commit.code === 0 || /nothing to commit/i.test(commit.stdout + commit.stderr)
          commitOut = commit.stdout || commit.stderr
          if (!committed) return json(res, { ok: false, stage: 'commit', error: commitOut, plan, ...applied })
        }
        // push：退出码 0 不代表真的推上去了（分支名不匹配时会静默 no-op），
        // 所以推送后比对本地 HEAD 和远端 HEAD。
        let pushOut = null
        let pushVerified = true
        if (committed) {
          const push = await git(['push'], cwd)
          pushOut = { code: push.code, stderr: push.stderr }
          if (push.code !== 0) {
            pushVerified = false
          } else {
            const local = await git(['rev-parse', 'HEAD'], cwd)
            const remoteRef = await git(['rev-parse', '@{u}'], cwd)
            pushVerified = local.code === 0 && remoteRef.code === 0 && local.stdout === remoteRef.stdout
            if (!pushVerified) pushOut.stderr = (pushOut.stderr || '') + ' (本地与远端 HEAD 不一致，push 可能未生效)'
          }
        }
        json(res, { ok: committed && pushVerified, plan, ...applied, commit: commitOut, push: pushOut })
      } catch (error) { fail(res, error) }
    },
  }))

  disposers.push(registerRoute(ctx, rejected, {
    kind: 'exact',
    path: base + '/pull',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const cwd = await resolveCwd(ctx, body.cwd)
        const fetched = await git(['pull', '--ff-only'], cwd)
        if (fetched.code !== 0) return json(res, { ok: false, stage: 'pull', error: fetched.stderr || fetched.error })
        const plan = await planPull(ctx.sessionPersistence, ctx.workspaceRegistry, cwd)
        const applied = await applyPull(ctx.sessionPersistence, ctx.workspaceRegistry, plan)
        json(res, { ok: true, plan, ...applied })
      } catch (error) { fail(res, error) }
    },
  }))

  disposers.push(registerRoute(ctx, rejected, {
    kind: 'exact',
    path: base + '/config.json',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return json(res, { ok: true, config: readConfig() })
        const body = await readBody(req)
        json(res, { ok: true, config: writeConfig(body) })
      } catch (error) { fail(res, error) }
    },
  }))

  return () => { for (const d of disposers) { try { d() } catch {} } }
}

export function apply(ctx) {
  const dbg = (msg) => { try { appendFileSync(join(process.env.DSH_HOME ?? '', 'session-sync-debug.log'), msg + ' at ' + new Date().toISOString() + '\n') } catch {} }
  dbg('[apply] entered, ctx.on=' + typeof ctx.on + ' ctx.inject=' + typeof ctx.inject)

  // ① 桌面端注入行：apply 第一件事，不依赖任何服务
  const scriptTag = '<script defer src="/dsh-session-handoff/widget.js"></script>'
  const rowDisposers = []
  const disposers = []
  ctx.effect?.(() => () => { for (const d of [...rowDisposers, ...disposers]) { try { d() } catch {} } })

  rowDisposers.push(ctx.on?.('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script-src' && row.src === '/dsh-session-handoff/widget.js') return
        if (row.kind === 'script' && typeof row.text === 'string'
          && row.text.includes('__dshSessionSyncLoaded')) return
      }
      // 内联整份 widget 源码：桌面壳 case "script" 用 textContent 注入后直接执行，
      // 不依赖 s.src 去拉外部文件（桌面 dsh-app:// 静态页解析不到 HTTP 相对路径，会静默 404）。
      const widgetSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sync-widget.js'), 'utf8')
        .replace(/<\/script/gi, '<\\/script')
      table.push({ kind: 'script', placement: 'body', text: widgetSrc })
    } catch {}
  }))

  // ② 工具：局部等 tools 服务
  ctx.inject?.(['tools'], (toolCtx) => {
    const bind = (tool, run) => ({ ...tool, execute: (args, exec) => run(toolCtx, args, exec) })
    toolCtx.tools.register(bind(exportTool, exportSession))
    toolCtx.tools.register(bind(importTool, importSession))
    toolCtx.tools.register(bind(listTool, listSessions))
    toolCtx.tools.register(bind(unregisterTool, unregisterSession))
  })

  // ③ 路由 + web 形态 tapIndex：局部等 webServer
  ctx.inject?.(['webServer'], (svcCtx) => {
    if (!svcCtx.webServer || typeof svcCtx.webServer.register !== 'function') return
    const rejected = makeBarrier(svcCtx)
    disposers.push(registerSyncRoutes(svcCtx, rejected))
    try {
      svcCtx.webServer.tapIndex?.((html) => {
        if (typeof html !== 'string' || html.includes('/dsh-session-handoff/widget.js')) return html
        return html.includes('</body>') ? html.replace('</body>', scriptTag + '</body>') : html + scriptTag
      })
    } catch {}
  })
}
