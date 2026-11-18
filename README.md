# dsh-session-handoff

把 DSH（0.2.2-rc.3，会话格式 v4）的**原生会话**通过 git 在机器之间搬运：导出一段会话的事件流到工作区，提交、推送，另一台机器拉取后导入成新的原生会话，打开后可以继续对话、继续调用工具。

两种形态共用同一份 `.handoff.jsonl` 格式：

- **插件**（推荐）：注册 `session_list` / `session_export` / `session_import` / `session_unregister` 四个工具，
  导入时通过宿主 API 直接 `attachSession`，**不需要重启 DSH**；
- **CLI**（无插件时可用）：直接读写会话文件与 `storages/workspace.json`，改完要重启 DSH。

## 一键安装（推荐）

### 方式 0a：一条命令（需要能访问 GitHub）

在另一台电脑的 PowerShell 里执行：

```powershell
irm https://raw.githubusercontent.com/ItsukiYi/dsh-session-handoff/main/install.ps1 | iex
```

脚本会自动：找 DSH 数据目录和 `dsh.cmd` → 下载插件到 `%LOCALAPPDATA%\dsh-plugins\dsh-session-handoff` → 用 CLI 方式装进 desktop profile → 写进 `dsh.profile.bundles`。

完成后**完全退出 DSH**（含托盘/后台进程）再启动。

### 方式 0b：拷文件夹双击装（不依赖 GitHub，最稳）

1. 把整个 `dsh-session-handoff` 文件夹拷到那台电脑（如 `D:\dsh-plugins\dsh-session-handoff`）
2. 双击 `install.cmd`（会自动用所在目录安装）
3. 完全退出 DSH 再启动

> 若找不到 DSH 或数据目录，手动指定：
> ```powershell
> powershell -ExecutionPolicy Bypass -File install.ps1 -DshCmd "D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd" -DshHome "C:\Users\你\.dsh"
> ```

> **为什么不用 DSH 插件页（GUI）装？** 插件页靠"安装前后 dependencies 差异"判断装了哪个包，差异不为 1 时直接报"无法从依赖变更中确定安装了哪一个包"。上面的脚本用 CLI（直接转发 pnpm）绕开这套检测。

---

## 在其他电脑上安装

三种方式，按有没有 GitHub 选。

### 方式 A：从 GitHub 安装（推荐，可多机复用）

本机先把插件做成独立仓库并推送（只推插件目录，不含你的项目代码）：

```powershell
cd D:\CyberAlbum\dsh-session-handoff
git init
git add -A
git commit -m "dsh-session-handoff v0.2.0"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-session-handoff.git
git push -u origin main
```

另一台电脑：

```powershell
# 需要本机有 git
& 'D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add github:<你的用户名>/dsh-session-handoff
# 完全退出并重启 DSH
```

DSH 会把 profile 的 `package.json` 依赖和 `dsh.profile.bundles` 一起写好。
私有仓库需要在机器上先配好 git 凭据。

### 方式 B：拷贝目录（没有 GitHub 时最简单）

把整个 `dsh-session-handoff` 文件夹拷到另一台电脑（U 盘/网盘），放在固定位置，例如 `D:\dsh-plugins\dsh-session-handoff`，然后：

```powershell
& 'D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:D:\dsh-plugins\dsh-session-handoff
# 完全退出并重启 DSH
```

> `link:` 指向的是**那台电脑上的路径**，不是本机路径。目录之后不能删或移动，否则插件失效。

### 方式 C：打包 tgz

```powershell
cd D:\CyberAlbum\dsh-session-handoff
npm pack   # 产出 dsh-session-handoff-0.2.0.tgz（14 KB）
```

把 tgz 拷到另一台电脑，然后：

```powershell
& ...\dsh.cmd plugin --profile desktop add file:D:\path\dsh-session-handoff-0.2.0.tgz
```

### 本机安装（开发时）

```powershell
& 'D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:D:\CyberAlbum\dsh-session-handoff
```

启用后对话里直接说“列出可用会话 / 把当前会话导出 / 导入这个 handoff 文件”即可。

插件提供四个工具：

| 工具 | 作用 |
|---|---|
| `session_list` | 列出已存储会话（可按 cwd 过滤） |
| `session_export` | 导出会话为 `.handoff.jsonl`（默认写到 `<cwd>/.dsh-handoff`） |
| `session_import` | 导入为**新 id** 的原生会话，并即时 `attachSession` 到工作区（**免重启**） |
| `session_unregister` | 把会话从工作区摘除（文件保留；文件需在 DSH 关闭后自行删除） |

## 日常用法（直接对 Agent 说）

不需要记命令，用自然语言即可，Agent 会调用上面的工具：

| 你想做的事 | 直接这样说 |
|---|---|
| 看有哪些会话 | 「列出这个工作区的会话」 |
| 把当前对话打包 | 「把这个会话导出成 handoff」 |
| 导出别人的会话 | 「把 session-xxxx 导出」 |
| 从 git 里拿回来 | 「导入 .dsh-handoff/session-xxxx.handoff.jsonl」 |
| 换到另一个目录 | 「导入 xxx.handoff.jsonl 到 D:\OtherProject」 |
| 清理 | 「把 session-xxxx 从工作区摘除」 |

### 跨机器完整流程

```powershell
# ── 机器 A ──
# 1. 对话里说「把这个会话导出成 handoff」→ 生成 <cwd>\.dsh-handoff\session-<id>.handoff.jsonl
cd D:\CyberAlbum
git add .dsh-handoff/session-<id>.handoff.jsonl
git commit -m "handoff: <一句话描述>"
git push

# ── 机器 B ──
git pull
# 2. 对话里说「导入 .dsh-handoff/session-<id>.handoff.jsonl --cwd D:\Work\Project」
#    会话立即出现在侧栏，打开即可继续对话
```

导入的是**新 id**，源会话不受影响；两台机器各自继续互不干扰。

### 什么时候用 CLI

- 想在 DSH 之外批量搬运、或在没有插件时抢救会话；
- 想检查一个 bundle 是否完整：`node bin/dsh-session-handoff.mjs verify <file>`；
- 想核对存储路径规则是否变了：`node bin/dsh-session-handoff.mjs doctor`。

卸载：

```powershell
& 'D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-session-handoff
```

插件实现要点：导出用 `sessionPersistence.open(id,'read')` 的 `handle.read()`；导入用
`create(header)` → `append(events)` → `flush()` → `close()`，再用
`workspaceRegistry.resolveByPath(cwd) ?? create(cwd)` 拿到实体并 `attachSession(newId)`。

## 它怎么工作

DSH 的会话是事件溯源的 JSONL 日志，存储位置（0.2.2-rc.3）：

```
~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd
```

- 文件由多个独立可解码的 zstd 帧拼接而成；
- 第 1 帧恰好是 **一行 header JSON + 换行**；
- 后面的帧是事件行（每行一个 JSON）；
- 后端打开会话时会校验「物理路径 == 由 header.cwd + header.id 推导出的路径」，版本必须为 4，事件 seq 必须从 0 连续。

本工具只做两件事：

1. **export**：把会话解压成可读的 `.handoff.jsonl`（第 1 行是本工具的元信息，第 2 行是会话 header，之后是原始事件行）；
2. **import**：生成新的 session id、按目标 cwd 算出正确目录、写入「header 帧 + 事件帧」，其余交给后端。

因为事件行是**原样搬运**，导入的会话就是原生会话，不是"摘要"或"转发"。

## 要求

- 两台机器的 DSH 会话格式版本相同（都显示 `v4`）。版本不同会被拒绝。
- 运行时只要 Node.js ≥ 22.15（内置 zstd）。Windows 上本仓库已验证 Node 26。
- 会话日志包含工具输出、文件内容和命令结果，**可能含密钥**。提交到公共仓库前请自行审查。

## 用法

默认 sessions root 是 `%DSH_HOME%/sessions` 或 `~/.dsh/sessions`，可用 `--root` 覆盖。

```powershell
# 列出本机会话（id / cwd / 版本 / 大小）
node bin/dsh-session-handoff.mjs list

# 导出当前工作区某个会话到 <cwd>\.dsh-handoff\<id>.handoff.jsonl
node bin/dsh-session-handoff.mjs export session-cf74d9c0-ca6a-4e4f-a79e-d377f1dee6ff

# 指定输出目录
node bin/dsh-session-handoff.mjs export <sessionId> --out .\handoff

# 检查一个 bundle 是否完整
node bin/dsh-session-handoff.mjs verify .\.dsh-handoff\session-xxxx.handoff.jsonl

# 在另一台机器导入（新 id；cwd 指向目标机器上的工作区路径）
# 导入会自动把会话登记进该 cwd 对应的工作区
node bin/dsh-session-handoff.mjs import .\.dsh-handoff\session-xxxx.handoff.jsonl --cwd D:\Work\Project

# 只登记某个已存在的会话（不导入）
node bin/dsh-session-handoff.mjs register <sessionId> --cwd D:\Work\Project

# 只预览目标路径，不写盘
node bin/dsh-session-handoff.mjs import <bundle> --cwd D:\Work\Project --dry-run

# 自检：用本机真实会话交叉验证路径编码规则
node bin/dsh-session-handoff.mjs doctor
```

**导入后必须完全退出并重新打开 DSH**。DSH 的工作区归属不是扫描目录得到的，而是记录在
`~/.dsh/storages/workspace.json` 的每个工作区记录的 `sessionIds` 里，宿主在启动时读入内存；
所以只刷新页面不会看到新会话。导入命令会自动写入这条登记（可用 `--no-register` 关闭）。

如果目标 cwd 还不是 DSH 里的工作区，先在 DSH 里打开该目录一次，再执行
`register <sessionId> --cwd <目录>`。

> 注意：DSH 运行期间会持有 workspace.json 的内存副本，之后任何工作区操作都可能把它写回。
> 因此建议的顺序是：**先退出 DSH，再执行导入/register，最后启动 DSH**。
> 每次写 workspace.json 前工具都会在同目录留一份 `workspace.json.bak-<时间戳>`。

## 典型的 git 工作流

```powershell
# 机器 A：导出并提交
node bin/dsh-session-handoff.mjs export session-<id>
git add .dsh-handoff/session-<id>.handoff.jsonl
git commit -m "session: handoff <id>"
git push

# 机器 B：拉取并导入
git pull
node bin/dsh-session-handoff.mjs import .\.dsh-handoff\session-<id>.handoff.jsonl --cwd D:\Work\Project
```

## 已知限制

- **不做合并**。在 B 上导入后继续对话产生的新事件只存在 B 上；要再带回 A，就再导出一次。两边同时继续同一个会话会产生分叉，本工具不尝试合并。
- **绝对路径保留原样**。事件里记录的工具调用路径还是 A 上的路径；如果两台机器目录不同，历史里的路径不会自动改写。
- **fork / 子会话**：被 fork 的会话 header 为 `isSeeded: true`，导入不保证逐字节等价；子 agent 的会话是独立 session，默认不随父会话一起导出。
- **版本绑定**：目标 DSH 必须能读 v4；将来格式升级后需要先跑官方迁移。
- 大会话会让 git 仓库变大；当前 bundle 是未压缩 JSONL（便于 diff），后续可加 zstd 选项。

## 验证记录（开发机，2026-11-16）

- `doctor`：39 个真实会话，路径编码规则 0 处不符。
- 往返：导出 31 事件（14 帧）→ 导入新 root → `doctor` 通过 → 新会话可再次导出。
- 事件行不含 session id 引用，原样搬迁不需要改写事件内容。
- 根因记录：工作区会话列表来自 `storages/workspace.json` 的 `sessionIds`，不是目录扫描；
  仅写 session 文件不会出现在 UI，必须登记且重启宿主（插件形态用 attachSession 免重启）。
- 插件工具 schema 已用宿主真实的 `assertSupportedJsonSchema` 校验通过。
- 插件端到端：`session_export` 导出 31 事件 → `session_import` 生成新 id 并返回
  `workspace: D:\CyberAlbum` → `storages/workspace.json` 立即新增该 id（**未重启宿主**）
  → 再次用 CLI 导出该校验会话，31 条事件完整。
- 在真实运行时（Electron-as-node + app.asar 内 persistence 插件）单独验证过
  `create → append → flush → close → open → read`：31 条事件读回逐字节一致。
