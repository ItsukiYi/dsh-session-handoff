/**
 * dsh-session-handoff — 同步引擎（纯逻辑，不碰 HTTP/UI）
 *
 * 同步模型：
 *   每个工作区 <cwd>/.dsh-handoff/<sessionId>.handoff.jsonl 是这台机器对该会话的镜像；
 *   git 把这些 bundle 推到远端，另一台机器 pull 后逐个 diff/导入。
 *
 * diff 规则（用户拍板）：
 *   - 本地事件 == 远端事件                 → same（无操作）
 *   - 共同前缀一致，一方更长              → 一方"包含"另一方，长的一方覆盖（快路径）
 *   - 共同前缀在某处分歧                  → fork（拉取时导入成新 id，永不覆盖）
 *
 * 会话事件从 sessionPersistence 读（内存 API，无需自己解 zstd）；
 * bundle 事件从 readBundle() 读（bundle 是明文 JSONL，不需要解压）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const BUNDLE_FORMAT = 'dsh-session-handoff'
export const BUNDLE_VERSION = 1
export const SESSION_FORMAT_VERSION = 4
export const HANDOFF_DIRNAME = '.dsh-handoff'

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

// 与 whale-widget 同款：直接写 ~/.dsh 下的小 JSON 文件，绕开 storages 服务。
function dshHome() {
  // 与 whale-widget 同款：DSH_HOME 宿主已设成 ...\\.dsh，不要再拼一层。
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return resolve(home)
  const fallback = process.env.USERPROFILE ?? process.env.HOME
  if (typeof fallback !== 'string' || fallback.length === 0) throw new Error('cannot resolve DSH home')
  return resolve(fallback, '.dsh')
}

/** 配置文件路径：~/.dsh/session-sync.json（DSH_HOME 优先）。 */
export function configPath() {
  return join(dshHome(), 'session-sync.json')
}

export function readConfig() {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  mkdirSync(dshHome(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---------------------------------------------------------------------------
// bundle I/O（与 lib/index.js 保持一致的最小子集）
// ---------------------------------------------------------------------------

export function physicalHeader(header) {
  return { type: 'session', version: SESSION_FORMAT_VERSION, ...header }
}

export function readBundle(file) {
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.length < 2) return null
  let meta
  let header
  try {
    meta = JSON.parse(lines[0])
    header = JSON.parse(lines[1])
  } catch {
    return null
  }
  if (meta?.format !== BUNDLE_FORMAT) return null
  if (header?.type !== 'session' || header?.version !== SESSION_FORMAT_VERSION) return null
  const eventLines = []
  for (let i = 2; i < lines.length; i++) if (lines[i].length > 0) eventLines.push(lines[i])
  const events = []
  for (const line of eventLines) {
    try { events.push(JSON.parse(line)) } catch { return null }
  }
  return { meta, header, events }
}

export function writeBundle(file, header, events, source) {
  mkdirSync(join(file, '..'), { recursive: true })
  const meta = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_VERSION,
    sessionFormat: SESSION_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: source ?? { id: header.id, cwd: header.cwd ?? null, agentPreset: header.agentPreset ?? null },
  }
  const lines = [
    JSON.stringify(meta),
    JSON.stringify(physicalHeader(header)),
    ...events.map((event) => JSON.stringify(event)),
  ]
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// 本地会话读取（走 sessionPersistence，内存 API，避免手解 zstd 帧）
// ---------------------------------------------------------------------------

export async function readLocalSession(persistence, sessionId) {
  try {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const header = handle.header
      if (!header || header.isSeeded === true) return null
      const { events } = await handle.read(0)
      return { header, events }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function listWorkspaceSessions(persistence, workspaceRegistry, cwd) {
  let ids = null
  let entity
  if (workspaceRegistry && typeof workspaceRegistry.resolveByPath === 'function') {
    entity = await workspaceRegistry.resolveByPath(cwd)
    if (entity !== undefined) ids = Array.isArray(entity.sessionIds) ? entity.sessionIds : []
  }
  if (ids === null) {
    // registry 不可用（测试环境 / 极早期宿主）：退化为按 header.cwd 过滤所有已存会话。
    const all = await persistence.list()
    ids = []
    for (const entry of all) {
      const header = entry?.header ?? entry
      if (header && typeof header.id === 'string' && header.cwd === cwd) ids.push(header.id)
    }
  }
  const sessions = []
  for (const id of ids) {
    const record = await readLocalSession(persistence, id)
    if (record !== null) sessions.push({ id, ...record })
  }
  return { entity, sessions }
}

// ---------------------------------------------------------------------------
// diff：本地事件 vs 远端 bundle 事件
// ---------------------------------------------------------------------------

function eventKey(event) {
  // 事件里 seq 一定是本地的；比较时忽略 seq，只看其他字段，避免导入后再导出因为 seq 重排误判。
  if (event === null || typeof event !== 'object') return JSON.stringify(event)
  const { seq: _seq, ...rest } = event
  return JSON.stringify(rest)
}

export function diffEvents(localEvents, remoteEvents) {
  const n = Math.min(localEvents.length, remoteEvents.length)
  for (let i = 0; i < n; i++) {
    if (eventKey(localEvents[i]) !== eventKey(remoteEvents[i])) {
      return { relation: 'fork', firstDivergence: i }
    }
  }
  if (localEvents.length === remoteEvents.length) return { relation: 'same', common: n }
  if (localEvents.length > remoteEvents.length) return { relation: 'local-ahead', common: n }
  return { relation: 'remote-ahead', common: n }
}

// ---------------------------------------------------------------------------
// push：本地 → bundle → git → 远端
// ---------------------------------------------------------------------------

export function handoffDir(cwd) {
  return join(cwd, HANDOFF_DIRNAME)
}

export function listRemoteBundles(cwd) {
  const dir = handoffDir(cwd)
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.handoff.jsonl')) continue
    const file = join(dir, name)
    if (!statSync(file).isFile()) continue
    const bundle = readBundle(file)
    if (bundle === null) continue
    out.push({ file, name, id: bundle.header.id, bundle })
  }
  return out
}

export async function planPush(persistence, cwd) {
  const { sessions } = await listWorkspaceSessionsCached(persistence, cwd)
  const remote = new Map(listRemoteBundles(cwd).map((row) => [row.id, row]))
  const plan = { cwd, write: [], skip: [], forked: [], missing: 0 }
  for (const session of sessions) {
    const existing = remote.get(session.id)
    if (existing === undefined) {
      plan.write.push({ id: session.id, reason: 'new', events: session.events.length })
      continue
    }
    const verdict = diffEvents(session.events, existing.bundle.events)
    if (verdict.relation === 'same' || verdict.relation === 'remote-ahead') {
      plan.skip.push({ id: session.id, reason: verdict.relation, events: session.events.length })
      continue
    }
    if (verdict.relation === 'local-ahead') {
      plan.write.push({ id: session.id, reason: 'local-ahead', events: session.events.length, common: verdict.common })
      continue
    }
    // fork：本地版本照常推（保留本机真相），同时生成 fork bundle 供另一台机器拉取时导入成新会话
    plan.forked.push({ id: session.id, firstDivergence: verdict.firstDivergence, localEvents: session.events.length, remoteEvents: existing.bundle.events.length })
    plan.write.push({ id: session.id, reason: 'fork', events: session.events.length })
  }
  plan.missing = sessions.length
  return plan
}

// 进程内缓存，避免 plan + apply 阶段重复解压所有会话。
const sessionCache = new Map()
async function listWorkspaceSessionsCached(persistence, cwd) {
  const hit = sessionCache.get(cwd)
  if (hit) return hit
  const fresh = await listWorkspaceSessions(persistence, undefined, cwd)
  // 只缓存确定有内容的快照：空结果可能是宿主刚启动、projection 未就绪，
  // 缓存它会让同进程后续 push/pull 永远看不到会话。
  if (fresh.sessions.length > 0) sessionCache.set(cwd, fresh)
  return fresh
}
export function clearSessionCache() { sessionCache.clear() }

export async function applyPush(persistence, cwd, plan) {
  const { sessions } = await listWorkspaceSessionsCached(persistence, cwd)
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const dir = handoffDir(cwd)
  mkdirSync(dir, { recursive: true })
  const written = []
  const forkBundles = []
  for (const step of plan.write) {
    const session = byId.get(step.id)
    if (session === undefined) continue
    const file = join(dir, session.id + '.handoff.jsonl')
    writeBundle(file, session.header, session.events)
    written.push({ id: session.id, events: session.events.length })
    if (step.reason === 'fork') {
      const forkId = 'session-' + randomUUID()
      const forkFile = join(dir, forkId + '.handoff.jsonl')
      const forkHeader = { ...session.header, id: forkId }
      writeBundle(forkFile, forkHeader, session.events, { id: session.id, cwd: session.header.cwd ?? null, agentPreset: session.header.agentPreset ?? null })
      forkBundles.push({ forkId, sourceId: session.id, file: forkFile, events: session.events.length })
    }
  }
  clearSessionCache()
  return { written, forkBundles }
}

// ---------------------------------------------------------------------------
// pull：bundle → 本地会话 → attach
// ---------------------------------------------------------------------------

export async function planPull(persistence, workspaceRegistry, cwd) {
  const bundles = listRemoteBundles(cwd)
  const plan = { cwd, import: [], overwrite: [], skip: [], fork: [] }
  for (const row of bundles) {
    const local = await readLocalSession(persistence, row.id)
    if (local === null) {
      plan.import.push({ id: row.id, events: row.bundle.events.length, file: row.file })
      continue
    }
    const verdict = diffEvents(local.events, row.bundle.events)
    if (verdict.relation === 'same' || verdict.relation === 'local-ahead') {
      plan.skip.push({ id: row.id, reason: verdict.relation, events: row.bundle.events.length })
      continue
    }
    if (verdict.relation === 'remote-ahead') {
      plan.overwrite.push({ id: row.id, events: row.bundle.events.length, localEvents: local.events.length, common: verdict.common, file: row.file })
      continue
    }
    plan.fork.push({ id: row.id, firstDivergence: verdict.firstDivergence, localEvents: local.events.length, remoteEvents: row.bundle.events.length, file: row.file })
  }
  return plan
}

export async function applyPull(persistence, workspaceRegistry, plan) {
  const imported = []
  const forked = []
  const overwritten = []
  for (const step of plan.import) {
    const result = await importBundleAs(persistence, workspaceRegistry, step.file, step.id, plan.cwd)
    imported.push(result)
  }
  for (const step of plan.overwrite) {
    // 快路径：本地是远端的前缀 → 删掉本地文件，用同一个 id 重建，保持工作区不变。
    await replaceLocalSession(persistence, workspaceRegistry, step.id, step.file, plan.cwd)
    overwritten.push({ id: step.id, events: step.events, previous: step.localEvents })
  }
  for (const step of plan.fork) {
    // 真分叉：远端版本导入成新 id，本地不动。
    const result = await importBundleAs(persistence, workspaceRegistry, step.file, 'session-' + randomUUID(), plan.cwd)
    forked.push({ sourceId: step.id, ...result })
  }
  clearSessionCache()
  return { imported, overwritten, forked }
}

/** 导入换了新 id 时，把事件里的 delivery marker sessionId 一并重写，否则宿主校验报
 *  "delivery marker names the wrong Session"。只有带 data.sessionId 的事件需要改。 */
function remapSessionId(events, newId) {
  return events.map((event) => {
    if (event && typeof event === 'object' && event.data && typeof event.data === 'object'
      && 'sessionId' in event.data) {
      return { ...event, data: { ...event.data, sessionId: newId } }
    }
    return event
  })
}

async function importBundleAs(persistence, workspaceRegistry, file, newId, cwd) {
  const bundle = readBundle(file)
  if (bundle === null) throw new Error('unreadable bundle: ' + file)
  const header = { ...bundle.header, id: newId, cwd }
  delete header.type
  const handle = await persistence.create(header)
  try {
    if (bundle.events.length > 0) await handle.append(remapSessionId(bundle.events, newId))
    await handle.flush()
  } finally {
    await handle.close()
  }
  let workspace
  let workspaceError
  try {
    let entity = await workspaceRegistry.resolveByPath(cwd)
    if (entity === undefined) entity = await workspaceRegistry.create(cwd)
    await entity.attachSession(newId)
    workspace = entity.path
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error)
  }
  return { sessionId: newId, sourceId: bundle.header.id, events: bundle.events.length, workspace, workspaceError }
}

async function replaceLocalSession(persistence, workspaceRegistry, sessionId, file, cwd) {
  const bundle = readBundle(file)
  if (bundle === null) throw new Error('unreadable bundle: ' + file)
  // 先尝试删除旧会话文件（若宿主正在持有读句柄，删除可能失败，此时退化为"新 id fork"路径）。
  let removed = false
  try {
    const stat = await persistence.stat(sessionId)
    if (stat && typeof stat.path === 'string' && existsSync(stat.path)) {
      rmSync(stat.path, { force: true })
      removed = true
    }
  } catch { removed = false }
  if (!removed) {
    // 退路：保留旧文件，用新 id 导入（fork）。语义上等价于"拉下来一份完整副本"。
    return importBundleAs(persistence, workspaceRegistry, file, 'session-' + randomUUID(), cwd)
  }
  const header = { ...bundle.header, id: sessionId, cwd }
  delete header.type
  const handle = await persistence.create(header)
  try {
    if (bundle.events.length > 0) await handle.append(remapSessionId(bundle.events, newId))
    await handle.flush()
  } finally {
    await handle.close()
  }
  // 会话已在工作区登记过，无需重复 attach；但保险起见确保它在。
  try {
    const entity = await workspaceRegistry.resolveByPath(cwd)
    if (entity !== undefined && !entity.sessionIds.includes(sessionId)) await entity.attachSession(sessionId)
  } catch {}
  return { sessionId, events: bundle.events.length, replaced: true }
}

// ---------------------------------------------------------------------------
// git 操作（在工作区目录里执行；不依赖全局 git 配置）
// ---------------------------------------------------------------------------

export function git(args, cwd, timeoutMs = 120000) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timer = null
    const finish = (code, error) => {
      if (timer !== null) clearTimeout(timer)
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim(), error })
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(-1, 'git timed out after ' + timeoutMs + 'ms: git ' + args.join(' '))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => finish(-1, String(error?.message ?? error)))
    child.on('close', (code) => finish(code ?? -1))
  })
}

export async function gitAvailable() {
  const result = await git(['--version'], process.cwd(), 5000)
  return result.code === 0 ? { ok: true, version: result.stdout } : { ok: false, error: result.error ?? result.stderr }
}

export async function gitRepoStatus(cwd) {
  if (!existsSync(join(cwd, '.git'))) return { repo: false }
  const head = await git(['rev-parse', '--short', 'HEAD'], cwd, 10000)
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 10000)
  const remote = await git(['remote', 'get-url', 'origin'], cwd, 10000)
  const dirty = await git(['status', '--porcelain', HANDOFF_DIRNAME], cwd, 10000)
  return {
    repo: true,
    head: head.code === 0 ? head.stdout : null,
    branch: branch.code === 0 ? branch.stdout : null,
    remote: remote.code === 0 ? remote.stdout : null,
    handoffDirty: dirty.code === 0 ? dirty.stdout.length > 0 : null,
  }
}

// ---------------------------------------------------------------------------
// 状态汇总（悬浮窗首屏用）
// ---------------------------------------------------------------------------

export async function syncStatus(persistence, workspaceRegistry, cwd) {
  // 面板要反映当前真实状态：本地会话可能被删除/新增，清掉进程内缓存再统计。
  clearSessionCache()
  const [push, pull, repo] = await Promise.all([
    planPush(persistence, cwd),
    planPull(persistence, workspaceRegistry, cwd),
    gitRepoStatus(cwd),
  ])
  return {
    cwd,
    remote: readConfig().remote ?? null,
    localSessions: push.missing,
    remoteBundles: listRemoteBundles(cwd).length,
    toPush: push.write.length,
    toPull: pull.import.length + pull.overwrite.length + pull.fork.length,
    push: { write: push.write, skip: push.skip, forked: push.forked },
    pull: { import: pull.import, overwrite: pull.overwrite, skip: pull.skip, fork: pull.fork },
    repo,
    configPath: configPath(),
  }
}
