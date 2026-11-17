#!/usr/bin/env node
/**
 * dsh-session-handoff — 把 DSH (0.2.2-rc.3) 的 v4 原生会话搬进/搬出工作区。
 *
 * 存储事实（来自 0.2.2-rc.3 的 dsh-session-persistence-jsonl）:
 *   <root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd
 *   - 文件是若干个独立可解码的 zstd 帧拼接
 *   - 第 1 帧: 恰好一行 header JSON + "\n"
 *   - 后续帧: 事件行（每行一个 JSON）+ "\n"
 *   - 读取时后端校验: 物理路径必须等于 generationLogPath(root, header.cwd, header.id)
 *   - 版本必须等于 4
 *
 * 命令:
 *   list                         列出本机会话
 *   export <sessionId>           导出为可提交 git 的 .handoff.jsonl
 *   import <bundle>              导入为新会话（默认新 id；--cwd 指定目标工作区）
 *   verify <bundle>              校验 bundle 结构
 *   doctor                       用真实会话交叉验证路径/编码规则
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const SESSION_FORMAT_VERSION = 4
const ZSTD_MAGIC = 4247762216
const BUNDLE_FORMAT = 'dsh-session-handoff'
const BUNDLE_VERSION = 1
const LOG_RE = /^session\.v(\d+)\.jsonl\.zstd$/

function defaultRoot() {
  const home = process.env.DSH_HOME
  return home ? join(home, 'sessions') : join(homedir(), '.dsh', 'sessions')
}

/** storages/workspace.json，工作区归属所在的持久文件。 */
function workspaceFile() {
  const home = process.env.DSH_HOME
  return join(home ?? join(homedir(), '.dsh'), 'storages', 'workspace.json')
}

function canonicalPath(path) {
  try { return realpathSync(path) } catch { return path }
}

/**
 * 把会话登记到对应工作区的 sessionIds。
 * 工作区归属记录在 storages/workspace.json，宿主启动时读入内存；
 * 外部改动需要重启 DSH 才生效。
 */
function registerSession(cwd, sessionId, { dryRun = false } = {}) {
  const file = workspaceFile()
  if (!existsSync(file)) throw new Error('workspace registry not found: ' + file)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const workspaces = data?.tables?.workspaces
  if (workspaces === undefined) throw new Error('workspace registry has no workspaces table: ' + file)
  const target = canonicalPath(cwd)
  let match
  for (const [id, record] of Object.entries(workspaces)) {
    if (canonicalPath(record.path).toLowerCase() === target.toLowerCase()) { match = { id, record }; break }
  }
  if (match === undefined) {
    console.warn('warning: no workspace is registered for ' + target)
    console.warn('         open that directory in DSH once, then run: register ' + sessionId + ' --cwd "' + target + '"')
    return false
  }
  if (match.record.sessionIds.includes(sessionId)) {
    console.log('workspace already contains ' + sessionId)
    return true
  }
  const next = {
    ...match.record,
    sessionIds: [sessionId, ...match.record.sessionIds],
    updatedAt: new Date().toISOString(),
  }
  workspaces[match.id] = next
  if (dryRun) {
    console.log('would register ' + sessionId + ' in workspace ' + match.id + ' (' + match.record.path + ')')
    return true
  }
  copyFileSync(file, file + '.bak-' + Date.now())
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log('registered in workspace: ' + match.record.path + ' (' + match.id + ')')
  console.log('note: workspace state is read at DSH startup — fully quit and reopen DSH for it to appear.')
  return true
}

/** 与后端完全一致的 id 路径编码。 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** 与后端完全一致的 project 目录名（cwd -> 目录）。 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (((readable.replace(/^-+/, '')) || 'root').slice(0, 251)) + '--'
}

function sessionDir(root, cwd, id) {
  return join(root, cwd === undefined ? '_no-cwd' : projectKey(cwd), encodeSegment(id))
}

function logPath(root, cwd, id) {
  return join(sessionDir(root, cwd, id), 'session.v' + SESSION_FORMAT_VERSION + '.jsonl.zstd')
}

/** 扫描 zstd 帧边界；遇到不完整尾帧时返回其起点（与后端一致）。 */
function scanFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('reserved zstd frame-header bit at byte ' + (offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved zstd block type at byte ' + (offset - 3))
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 解码完整帧为 JSONL 明文；忽略 torn 尾帧。 */
function decodeLogText(buffer) {
  const { frames, tornStart } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less session log')
  const chunks = []
  for (const f of frames) chunks.push(zstdDecompressSync(buffer.subarray(f.start, f.end)))
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    frames: frames.length,
    torn: tornStart !== undefined,
  }
}

function readHeaderFromFile(path) {
  const buffer = readFileSync(path)
  const { frames } = scanFrames(buffer, 1)
  if (frames.length === 0) throw new Error('no complete frame in ' + path)
  const first = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  if (!first.endsWith('\n') || first.indexOf('\n') !== first.length - 1) {
    throw new Error('first frame is not exactly one header line: ' + path)
  }
  return JSON.parse(first)
}

/** 列出所有会话（读取每个 session 目录中版本最高的规范日志）。 */
function listSessions(root) {
  if (!existsSync(root)) return []
  const out = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(projectPath, session.name)
      let best
      for (const entry of readdirSync(dir)) {
        const m = LOG_RE.exec(entry)
        if (!m) continue
        const version = Number(m[1])
        if (best === undefined || version > best.version) best = { version, file: join(dir, entry) }
      }
      if (best === undefined) continue
      let header
      try { header = readHeaderFromFile(best.file) } catch (error) {
        out.push({ id: session.name, dir, file: best.file, version: best.version, error: String(error.message || error) })
        continue
      }
      const st = statSync(best.file)
      out.push({
        id: header.id,
        cwd: header.cwd,
        version: header.version,
        agentPreset: header.agentPreset,
        isSeeded: header.isSeeded,
        file: best.file,
        dir,
        bytes: st.size,
        updatedAt: st.mtime,
      })
    }
  }
  return out.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
}

function findSession(root, id) {
  for (const session of listSessions(root)) {
    if (session.id === id) return session
  }
  return undefined
}

function splitLogText(text) {
  const lines = text.split('\n')
  const headerLine = lines[0]
  const events = []
  for (let i = 1; i < lines.length; i++) if (lines[i].length > 0) events.push(lines[i])
  return { headerLine, header: JSON.parse(headerLine), events }
}

function cmdList(root) {
  const sessions = listSessions(root)
  if (sessions.length === 0) { console.log('no sessions under ' + root); return }
  console.log('root: ' + root)
  for (const s of sessions) {
    const stamp = s.updatedAt ? s.updatedAt.toISOString().replace('T', ' ').slice(0, 19) : '?'
    const size = s.bytes === undefined ? '' : (s.bytes / 1024).toFixed(0) + 'KB'
    console.log([stamp, s.id, s.error ? 'CORRUPT: ' + s.error : (s.cwd ?? '(no cwd)'), 'v' + s.version, size].join('  '))
  }
}

function cmdExport(root, id, outDir) {
  const session = findSession(root, id)
  if (session === undefined) throw new Error('session not found: ' + id)
  if (session.error) throw new Error('source session is unreadable: ' + session.error)
  const { text, frames, torn } = decodeLogText(readFileSync(session.file))
  const { headerLine, header, events } = splitLogText(text)
  if (header.type !== 'session' || header.version !== SESSION_FORMAT_VERSION) {
    throw new Error('unsupported session header: ' + JSON.stringify({ type: header.type, version: header.version }))
  }
  if (header.isSeeded === true) {
    console.warn('warning: source session is seeded (fork/inherited prefix); imported copy may not replay exactly.')
  }
  if (torn) console.warn('warning: source log had a torn final frame; that tail was ignored.')
  const target = outDir ?? join(header.cwd ?? process.cwd(), '.dsh-handoff')
  mkdirSync(target, { recursive: true })
  const file = join(target, id + '.handoff.jsonl')
  const meta = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_VERSION,
    sessionFormat: SESSION_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { id: header.id, cwd: header.cwd ?? null, agentPreset: header.agentPreset ?? null },
  }
  const lines = [JSON.stringify(meta), headerLine, ...events]
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  console.log('exported: ' + file)
  console.log('events: ' + events.length + '  frames decoded: ' + frames)
  if (events.length === 0) console.log('note: this session has no events yet.')
}

function readBundle(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const meta = JSON.parse(lines[0])
  if (meta.format !== BUNDLE_FORMAT) throw new Error('not a dsh-session-handoff bundle: ' + file)
  if (meta.formatVersion !== BUNDLE_VERSION) throw new Error('unsupported bundle format version: ' + meta.formatVersion)
  if (meta.sessionFormat !== SESSION_FORMAT_VERSION) {
    throw new Error('bundle session format v' + meta.sessionFormat + ' != this harness v' + SESSION_FORMAT_VERSION)
  }
  const header = JSON.parse(lines[1])
  const events = []
  for (let i = 2; i < lines.length; i++) if (lines[i].length > 0) events.push(lines[i])
  return { meta, header, events }
}

function checkEvents(events) {
  let expected = null
  for (const [index, line] of events.entries()) {
    let event
    try { event = JSON.parse(line) } catch { throw new Error('event line ' + (index + 2) + ' is not JSON') }
    if (typeof event.seq !== 'number') throw new Error('event line ' + (index + 2) + ' has no numeric seq')
    if (expected !== null && event.seq !== expected) {
      throw new Error('event seq gap at line ' + (index + 2) + ': expected ' + expected + ', got ' + event.seq)
    }
    expected = event.seq + 1
  }
}

function writeSession(root, header, events, { force = false } = {}) {
  const path = logPath(root, header.cwd, header.id)
  if (existsSync(path) && !force) throw new Error('target session already exists: ' + path)
  mkdirSync(sessionDir(root, header.cwd, header.id), { recursive: true })
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))
  const bodyFrame = events.length === 0 ? Buffer.alloc(0)
    : zstdCompressSync(Buffer.from(events.join('\n') + '\n', 'utf8'))
  writeFileSync(path, Buffer.concat([headerFrame, bodyFrame]))
  return path
}

function cmdImport(root, file, options) {
  const { meta, header, events } = readBundle(file)
  checkEvents(events)
  const newId = options.id ?? 'session-' + randomUUID()
  if (!/^[A-Za-z0-9._-]+$/.test(newId)) throw new Error('invalid session id: ' + newId)
  const cwd = options.cwd ?? header.cwd
  const newHeader = { ...header, id: newId, ...(cwd === undefined ? {} : { cwd }) }
  delete newHeader.id
  newHeader.id = newId
  if (cwd === undefined) delete newHeader.cwd
  if (options.dryRun) {
    console.log('would write: ' + logPath(root, cwd, newId))
    console.log('events: ' + events.length)
    return
  }
  const path = writeSession(root, newHeader, events, { force: options.force })
  console.log('imported: ' + path)
  console.log('id: ' + newId)
  console.log('cwd: ' + (cwd ?? '(none)'))
  console.log('events: ' + events.length)
  console.log('source: ' + (meta.source?.id ?? '?') + ' @ ' + (meta.exportedAt ?? '?'))
  if (options.register !== false && cwd !== undefined) registerSession(cwd, newId)
  console.log('')
  console.log('下一步: 工作区归属只在 DSH 启动时读取——完全退出并重新打开 DSH 后，会话才会出现在该工作区。')
}

function cmdRegister(sessionId, cwd) {
  if (cwd === undefined) throw new Error('register requires --cwd')
  registerSession(cwd, sessionId)
}

function cmdVerify(file) {
  const { meta, header, events } = readBundle(file)
  if (header.type !== 'session') throw new Error('header type is not "session"')
  if (header.version !== SESSION_FORMAT_VERSION) throw new Error('header version mismatch: ' + header.version)
  for (const key of ['id', 'createdAt', 'isSeeded', 'delegationDepth']) {
    if (!Object.hasOwn(header, key)) throw new Error('header missing required key: ' + key)
  }
  checkEvents(events)
  console.log('bundle OK')
  console.log('format: ' + meta.format + ' v' + meta.formatVersion + ', session format v' + meta.sessionFormat)
  console.log('source: ' + (meta.source?.id ?? '?') + '  cwd: ' + (meta.source?.cwd ?? '(none)'))
  console.log('events: ' + events.length + (events.length ? '  seq ' + JSON.parse(events[0]).seq + '..' + JSON.parse(events.at(-1)).seq : ''))
}

function cmdDoctor(root) {
  const sessions = listSessions(root)
  let bad = 0
  for (const s of sessions) {
    if (s.error) { console.log('FAIL (unreadable): ' + s.id + ' ' + s.error); bad++; continue }
    const expectedProject = projectKey(s.cwd)
    const expectedSession = encodeSegment(s.id)
    const actualProject = basename(join(s.dir, '..'))
    const actualSession = basename(s.dir)
    if (expectedProject !== actualProject || expectedSession !== actualSession) {
      console.log('FAIL (path rule): ' + s.id + ' expected ' + expectedProject + '/' + expectedSession)
      bad++
    }
  }
  console.log('doctor: ' + sessions.length + ' sessions checked, ' + bad + ' mismatches')
  if (bad > 0) process.exitCode = 1
}

function usage() {
  console.log(`dsh-session-handoff — DSH v4 会话原生搬运

用法:
  node bin/dsh-session-handoff.mjs list                [--root <sessions root>]
  node bin/dsh-session-handoff.mjs export <sessionId>  [--root <root>] [--out <dir>]
  node bin/dsh-session-handoff.mjs import <bundle>     [--root <root>] [--cwd <dir>] [--id <id>] [--force] [--dry-run]
  node bin/dsh-session-handoff.mjs verify <bundle>
  node bin/dsh-session-handoff.mjs register <sessionId> --cwd <dir>
  node bin/dsh-session-handoff.mjs doctor              [--root <root>]

默认 sessions root: %DSH_HOME%/sessions 或 ~/.dsh/sessions
`)
}

function parse(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') flags.root = argv[++i]
    else if (a === '--out') flags.out = argv[++i]
    else if (a === '--cwd') flags.cwd = argv[++i]
    else if (a === '--id') flags.id = argv[++i]
    else if (a === '--force') flags.force = true
    else if (a === '--no-register') flags.register = false
    else if (a === '--dry-run') flags.dryRun = true
    else if (a === '-h' || a === '--help') flags.help = true
    else if (a.startsWith('--')) throw new Error('unknown flag: ' + a)
    else positional.push(a)
  }
  return { positional, flags }
}

function main() {
  const { positional, flags } = parse(process.argv.slice(2))
  if (flags.help || positional.length === 0) { usage(); return }
  const root = flags.root ?? defaultRoot()
  const [command, arg] = positional
  switch (command) {
    case 'list': return cmdList(root)
    case 'doctor': return cmdDoctor(root)
    case 'export':
      if (!arg) throw new Error('export requires a session id')
      return cmdExport(root, arg, flags.out)
    case 'import':
      if (!arg) throw new Error('import requires a bundle file')
      return cmdImport(root, arg, flags)
    case 'verify':
      if (!arg) throw new Error('verify requires a bundle file')
      return cmdVerify(arg)
    case 'register':
      if (!arg) throw new Error('register requires a session id')
      return cmdRegister(arg, flags.cwd)
    default: throw new Error('unknown command: ' + command)
  }
}

try {
  main()
} catch (error) {
  console.error('error: ' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
}
