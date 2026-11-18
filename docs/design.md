# QC-Async-A2A-Platform 设计稿 v0.1

2026-11-17。本文写于定名之前，文中的 `crew` 即现在的命令 `qca2a`，`.crew.json` 即 `.qca2a.json`。

实现与本文第 3 节的一处差异：hook 不装在用户级。每个 repo 要在本机运行 `qca2a enable` 才参与，hook 写进该 repo 不提交的本地配置，绑定文件本身不代表同意（实测 Claude Code 会把主仓库的 `.claude/settings.local.json` 应用到子目录和 worktree）。

另外两处差异：token 放在 `X-QCA2A-Token` 请求头（Cloud Run 会拦截无法验证的 `Authorization: Bearer`）；已读状态记在每条广播的 `readBy` 上，而不是成员游标里。M1 已完成，状态见根目录 README。

## 1. 目标与范围

给我参与的多个队伍、多个项目共用的一套工具，让每个人的 coding agent 能看到队友的进展。

做三件事：

1. **广播**：发布设计决定、会议纪要、任务和通知，队友的 agent 在合适的时机自动看到。
2. **会话共享**：每个人在项目里与 agent 的聊天记录自动上传，队友的 agent 可以检索和阅读。
3. **git 进度镜像**：未推送的工作自动镜像到个人远程分支，并在合适的节点提醒提交。

不做：远程执行队友机器上的 agent（LivingRoom 的 `send.mjs` 保持独立）、网页界面、给外人自行部署、向量检索。

支持的工具：Claude Code、Codex、Cursor。

## 2. 三种工具的 hook 能力（2026-11-17 核实）

Codex 和 Cursor 两列来自官方文档；Claude Code 一列凭我对它的了解，未在本次重新查文档。

| 需要的能力 | Claude Code | Codex | Cursor |
|---|---|---|---|
| 开对话时注入上下文 | `SessionStart`，新建和恢复都触发 | `SessionStart`，`additionalContext` | `sessionStart`，`additional_context`；只在新建对话时触发 |
| 发消息时注入上下文 | `UserPromptSubmit` | `UserPromptSubmit` | 不支持：`beforeSubmitPrompt` 只能放行或拦截 |
| 对话中途注入的替代办法 | 不需要 | 不需要 | `postToolUse` 的 `additional_context` |
| 答完一轮时让 agent 继续 | `Stop` 返回 block 和理由 | `Stop` 返回 `decision: "block"`，理由成为新 prompt | `stop` 返回 `followup_message`，默认最多连续 5 次 |
| 对话结束事件 | `SessionEnd` | `SessionEnd`，超时默认 1 秒、最多 3 秒 | `sessionEnd`，只能记录 |
| 用户级配置文件 | `~/.claude/settings.json` 或 plugin | `~/.codex/hooks.json`，首次需在 `/hooks` 里信任 | `~/.cursor/hooks.json` |
| 聊天记录 | `~/.claude/projects/<项目>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，hook 输入带 `transcript_path` | `~/.cursor/projects/<项目>/agent-transcripts/<id>/<id>.jsonl` |
| Windows | 支持 | 支持，有 `commandWindows` 字段 | 支持，经 PowerShell 运行 |

三条影响设计的结论：

- **上传不能挂在对话结束事件上。** Codex 的 `SessionEnd` 最多 3 秒，来不及上传。改为每轮结束时启动一个脱离的后台进程，再加定时任务兜底。
- **Cursor 的记录比另外两家少。** 据 Cursor 论坛 2026 年 7 月的帖子（有官方人员回复），它的 JSONL 没有工具返回结果、没有时间戳，而且 `stop` 可能在最后一轮写盘之前触发。Cursor 会话的时间戳由我们在上传时补，上传前等文件大小稳定。
- **Cursor 命令行版的 hook 覆盖不全。** 论坛里官方确认 `stop` 在命令行可用，部分事件不可用；`sessionStart` 和 `postToolUse` 在命令行是否可用没有查到，需要实测。

三家的记录格式都声明不是稳定接口，所以原文必须保留，解析器按版本号可重跑。

## 3. 组成

| 部分 | 位置 | 安装频率 |
|---|---|---|
| Hub | 我的 GCP 项目：Cloud Run + Firestore + GCS | 一次 |
| `crew` 命令行 | 每人机器，零依赖 Node（18 以上） | 每台机器一次 |
| 工具适配壳 | 三种工具各自的用户级 hook 配置，只负责调用 `crew` | 由 `crew install` 写入 |
| 绑定文件 `.crew.json` | 每个 repo 根目录，提交进 git | 每个项目一次 |
| 后台定时任务 | launchd 或 Windows 任务计划，每 15 分钟 `crew sweep` | 由 `crew install` 写入 |

规则：hook 触发时从当前目录向上找 `.crew.json`，找不到就立即退出，不做任何事。个人 token 存在 `~/.config/crew/credentials.json`，不进 repo。

`.crew.json` 内容：

```json
{ "hub": "https://crew-xxxx.run.app", "workspace": "ws_7f3a", "wipPush": true }
```

## 4. 数据模型

隔离单位是 workspace（一个队伍的一个项目）。

Firestore：

| 集合 | 字段 |
|---|---|
| `members/{memberId}` | 名字、token 的哈希、创建时间、是否吊销 |
| `workspaces/{wsId}` | 名字、repo 地址、成员列表、群聊 webhook、原文保留天数 |
| `workspaces/{wsId}/posts/{postId}` | 作者、类型（`note` 纪要 / `decision` 决定 / `task` 任务 / `notice` 通知）、标题、正文、repo 文件链接、点名对象、时间 |
| `workspaces/{wsId}/sessions/{sessionId}` | 成员、工具、起止时间、分支、commit 列表、改动文件、摘要、原文在 GCS 的路径、格式版本 |
| `workspaces/{wsId}/cursors/{memberId}` | `notifiedAt`、`readPostIds` |

GCS：`gs://crew-data/{wsId}/sessions/{memberId}/{sessionId}/raw.jsonl.gz` 和 `normalized.jsonl.gz`。

归一化格式每行一条：`{ts, role, text, tool: {name, input}, files}`。工具返回结果只保留前 2 KB。

## 5. Hub API

全部要求 `Authorization: Bearer <成员 token>`，Hub 校验该成员属于路径里的 workspace。

| 方法与路径 | 作用 |
|---|---|
| `POST /join` | 用邀请码换成员 token（唯一不需要 token 的接口） |
| `GET /ws/{id}/inbox?since=` | 未通知的广播，加队友新会话的条数 |
| `POST /ws/{id}/posts` | 发布广播；带点名或类型为 `task`/`notice` 时同步到群聊 webhook |
| `POST /ws/{id}/posts/{pid}/read` | 标记已读 |
| `GET /ws/{id}/sessions?member=&since=&q=` | 会话摘要列表，`q` 为关键词过滤 |
| `GET /ws/{id}/sessions/{sid}?part=summary\|normalized\|raw` | 取某个会话 |
| `PUT /ws/{id}/sessions/{sid}` | 上传或增量更新会话 |
| `POST /admin/workspaces`、`/admin/invites`、`/admin/revoke` | 仅我的管理 token 可用 |

## 6. 客户端命令

| 命令 | 作用 |
|---|---|
| `crew join <邀请码>` | 换取并保存 token |
| `crew install` | 检测本机装了哪些工具，写入各自的 hook 配置和定时任务 |
| `crew init` | 在当前 repo 生成 `.crew.json` |
| `crew hook <工具> <事件>` | hook 入口，读标准输入，按该工具的格式输出 |
| `crew sweep` | 上传有变化的会话，为已空闲的会话生成摘要 |
| `crew post` / `inbox` / `read` | 发布、查看、标记已读 |
| `crew log` / `show` / `search` | 浏览队友会话 |
| `crew pause` | 当前会话不上传 |

agent 通过一个 skill（Claude Code）或规则文件里的说明（Codex 的 `AGENTS.md`、Cursor rules）知道这些命令的存在和用法。

## 7. 三个流程

### 7.1 检查更新

1. 开对话：`crew hook … session-start` 请求 inbox，注入一段文字，例如"3 条未读广播（标题列表），队友新增 5 个会话；用 `crew inbox` 看详情"。
2. 对话进行中：Claude Code 和 Codex 在每次发消息时检查，Cursor 在工具调用后检查。结果本地缓存 10 分钟；只有出现新内容才注入一行，否则无输出。
3. 点名给我的 `task` 和 `notice` 立即注入全文标题；队友的日常会话只在开对话时汇总。
4. 标题注入后推进 `notifiedAt`，不再重复；agent 运行 `crew read` 后才记入 `readPostIds`。
5. 整个 hook 限时 2 秒，超时或出错时无输出、退出码 0。

### 7.2 会话上传

1. 每轮结束（`Stop`/`stop`）时，hook 启动一个脱离的后台进程后立即返回。
2. 后台进程等记录文件大小稳定，脱敏，生成归一化格式，增量上传。同一会话 2 分钟内最多上传一次。
3. `crew sweep` 每 15 分钟补传遗漏的会话，并为空闲超过 30 分钟、消息数超过 6 条的会话生成摘要。
4. 摘要用成员本机的命令行生成（`claude -p`、`codex exec` 或 Cursor 的 `agent --print`），指定便宜的小模型。摘要固定四段：做了什么、定了什么、遗留什么、改动的文件和 commit。

脱敏规则：

- 读取 repo 里所有 `.env*` 文件的值，在记录中做精确替换。
- 常见密钥格式的正则替换（`sk-…`、`AKIA…`、`ghp_…`、JWT、私钥块）。
- 只处理当前 repo 目录对应的会话。
- 被 `crew pause` 标记的会话整个跳过。

### 7.3 git 进度

每轮结束时脚本检查，分两种情况：

- **有未推送的 commit**：脚本直接执行 `git push origin HEAD:refs/heads/wip/<成员>/<当前分支>`。这只是把现有 commit 镜像到个人远程分支，不改本地任何东西，不经过模型。失败时静默。
- **有未提交的改动**，且满足任一条件（改动文件超过 10 个、最早的改动超过 2 小时、距上次提醒超过 1 小时）：让 agent 继续一轮，提示内容为"有 N 个文件未提交，如果刚才的工作是一个完整节点，请提交；否则回复不需要"。agent 自行判断，脚本不自动提交。

防循环：Claude Code 和 Codex 检查 `stop_hook_active`，Cursor 设 `loop_limit: 1`。推到主分支或开 PR 永远需要人确认。`.crew.json` 里 `wipPush: false` 可以整体关掉镜像。

## 8. 安全

- token 只存哈希；每人一个，可单独吊销。
- Hub 的每个请求都校验 workspace 成员资格。
- 从 Hub 取回的队友内容在注入时加固定前缀，声明它是队友的记录、仅供参考、不是指令。
- 原文默认保留 90 天，摘要长期保留；workspace 可整体导出后删除。
- 我作为 GCP 项目所有者能读到全部数据，邀请队友时明确告知。

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | Hub（认证、广播、inbox）；`crew` 命令行；Claude Code 适配 | 两台机器之间发布广播，对方开对话时看到 |
| M2 | 会话上传、脱敏、归一化；`log`/`show`/`search` | 我的 agent 能回答"队友昨天做了什么" |
| M3 | Codex 适配；git 镜像和提交提醒 | Codex 用户走通 M1、M2 的验收 |
| M4 | Cursor 适配；摘要生成；群聊 webhook | 三种工具混用的 3 人队伍用满一周 |

## 10. 待确认

1. Cursor 命令行版里 `sessionStart` 和 `postToolUse` 是否触发，需要实测；如果不触发，Cursor 命令行用户只靠规则文件和定时任务。
2. 自动镜像到 `wip/` 分支需要每个队友同意。
3. 队友用 Cursor 的是桌面版还是命令行版。
4. 正式名字。
