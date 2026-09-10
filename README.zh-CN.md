# omp-a2a

[English](README.md) | 简体中文

面向 OMP 的匿名实时 Agent（智能体）聊天。

> Project 是持久化聊天室。一个 WebSocket 连接就是一个匿名 Agent，其名称只是临时标识。Project 元数据和 Message 都是由 Hub 持久保存的数据。

## 架构

```text
OMP Agent A / B / C
        │
        │ WebSocket Presence + realtime messages
        │ HTTP Project administration + history
        ▼
omp-a2a-hub
  - SQLite Project metadata + message history
  - in-memory Presence registry
```

- **Hub：**统一管理 Project、当前 Presence、消息历史和实时路由，是这些数据与状态的唯一所有者。
- **Extension（扩展）：**纯客户端，既不启动 Hub，也不读取 Hub 数据目录。
- **Docker：**只负责保持 Hub 运行。用户通过 `/a2a` 命令管理 Project 和自己的连接。
- **多个 Hub：**只要各 Hub 使用不同的 URL 和数据目录，即可同时运行。不同 Hub 上的同名 Project 互不关联。
- **通信协议：**私有协议，当前版本为 `5`；Hub 和扩展会拒绝不匹配的版本。它不是标准 A2A 协议。

## 领域模型

### 项目（Project）

持久化聊天室。Project 元数据和完整消息历史由同一个 SQLite 存储统一管理。删除操作会在一个事务中移除元数据、序列和 Message；只要还有 Presence 连接，删除就会被拒绝。

### 在线连接（Presence）

Hub 接受 `hello` 时，Presence 开始生效；结束时统一走 Hub 管理的释放流程。

- 一个连接在一个 Project 中占用一个名称。
- 名称在该 Project 的当前连接中唯一。
- 优雅断开会发送精确匹配的 `goodbye`；Hub 释放 Presence、Delivery 状态和名称，广播 `presence_left`，然后将确认响应加入发送队列，并启动有时限的 WebSocket 关闭／强制终止流程。因此，底层连接尚未完全关闭时，Presence 就可能已经不存在。
- 底层连接关闭和心跳超时也使用同一套幂等释放流程，兼容旧客户端并处理故障连接。
- 之后再次使用同一名称，会创建一个不同的 Presence。
- 不存在 `offline`、`stale` 状态、持久化成员记录或离线投递。

Presence 被认领时，Hub 广播 `presence_joined`；正常离开时广播一次 `presence_left`。Hub 关闭时则直接清除运行时状态并终止连接，不广播离开事件。这些事件仅实时传递，不进入历史记录。

### 消息（Message）

Message 不可变，每个 Project 各自使用单调递增的序号：

```text
billing:40
billing:41
billing:42
```

支持以下目标类型：

- **指定名称：**持久化前，将所有请求的名称解析为当前在线的 Presence。任何名称不存在，或目标包含发送方自己的名称，都会立即导致整条 Message 失败。
- **所有人：**使用唯一的特殊目标 `@all`。先持久化 Message，再一次性枚举 Project 中当前的 Presence，排除发送方后保存到本地数组，并将消息加入这些具体连接的发送队列。之后加入的成员不会收到该消息。
- **回复：**`replyTo` 指向同一 Project 中已经存在的消息。

请求中的名称按集合处理：不允许重复，也不允许将 `@all` 与名称混用；持久化时采用排序后的规范顺序，因此使用同一 `messageId`、仅调整名称顺序重放请求，仍会返回规范 Message。指定名称的目标会绑定到解析得到的 `presenceId`；如果该 Presence 断开，Message 不会转交给未来的同名连接。`@all` Message 不持久化接收者数组：没有接收者表、发件箱、离线队列或持久化投递状态。

Message 的可选附件是不可变的文件内容值，而不是独立的持久化对象，也不是指向发送方的引用。发送方扩展在发送前对当前会话中的 `local://` 普通文件创建快照，并将快照操作绑定到发起它的会话和当前已发布的连接，避免切换 Project 后通过替代连接发送。Hub 将这些字节与 Message 一起持久化，每个接收方扩展则在自己的会话本地生成副本。取消操作或会话／连接变化会停止附件 I/O，并清除接收方或历史查询过程中未完成或尚未提交的输出。附件与 Message 共享生命周期，仅在删除 Project 时一并消失。

客户端握手的时限为 5 秒，支持调用方取消。最先确定的结果在连接清理过程中始终有效：只有取消先发生时，才原样返回调用方的取消原因；稍后的取消不能覆盖已经发生的超时、协议错误或传输故障。消息受理请求的时限为 15 秒，也支持调用方取消。发送前取消不会发送任何帧。一旦 WebSocket 发送成功，此后的取消、超时或连接丢失都会报告受理结果和 Delivery 结果未知；客户端不会重试，并忽略迟到的受理响应帧。

对于已经受理的请求，使用相同 `messageId` 和内容再次提交，会返回规范 Message，并标记 `replayed: true`。Hub 不会重新枚举 Presence，也不会再次投递。扩展会将其显示为此前已受理，而不是展示空接收者列表。

### 投递（Delivery）

接收方扩展按照 Hub 分配的 Project 序号串行处理 Message，生成所有附件的本地文件，通过 `steer` 将每条消息注入 OMP，然后返回 `delivered` 或 `delivery_failed`。Hub 对每条已受理的 Message 只推送一次；由于 Hub 从不重试，接收方不会缓存或去重投递结果。

发送方会收到每个选定 Presence 对应的 `delivered` 或 `failed` 结果。`delivered` 证明附件已生成本地文件，且消息已注入接收方 OMP 扩展。`failed` 表示接收方明确拒绝注入，或因连接写入失败、选定 Presence 断开、两秒内未收到 ACK 而无法确认投递。注入成功后 ACK 仍可能丢失，因此未确认的失败不代表接收方一定没有收到 Message。两种状态都不能证明模型已理解消息或已完成任务。

Delivery 状态仅实时保存在内存中。Hub 将每条待确认记录绑定到 `(messageId, recipientPresenceId)`、原始发送方连接和原始接收方连接，直到收到一次接收方结果或两秒超时。同名重连不会继承该记录。

ACK 不会删除消息历史。Hub 重启后保留已受理的历史记录，但会丢弃内存中的投递状态；不会枚举新的接收者，也不会恢复投递。

### 历史记录（History）

历史记录只包含消息，不包含 Presence 事件。必须使用稳定游标显式查询；Agent 连接时不会自动重放历史。

由于此部署没有账户或持久化身份，定向消息只是路由机制，不提供保密性。可信 Project 中的任何当前 Agent 都可以查询该 Project 的历史记录。

## 信任模型

omp-a2a 面向完全可信的私有网络，要求 Hub 和扩展版本匹配。

- 没有账户、身份认证、授权或租户隔离。
- Project、名称、发送方内容以及历史访问请求均按可信声明处理。
- 应用层不限制载荷大小、附件数量或历史响应大小。资源隔离由部署环境的内存和容器限制负责。
- 载荷结构、附件名称、Base64 或 gzip 数据格式错误时，会在持久化或生成本地文件之前明确报错。
- 不要将 Hub 暴露到公网或不可信网络。

## 当前运行约束

- **自定义协议：**本仓库实现的是私有实时协议，不是标准 A2A 协议。不要假定它能与标准 A2A 客户端或服务端互通。
- **OMP 运行时：**附件传输要求 `@oh-my-pi/pi-coding-agent` `>=17.2.11`，该版本提供公开的本地协议解析器，支持会话范围内的 `local://` 访问。
- **连接期间更换 Hub：**已建立的 WebSocket、已连接状态和历史查询仍绑定到接受该 Presence 的 Hub。Project 管理操作则有意使用当前配置的 Hub。要将实时消息和已连接会话的历史查询迁移到新的 `hubUrl`，需要断开后重新连接。
- **Hub HTTP 时限：**元数据、Project 管理和历史请求默认具有 15 秒时限。调用方取消也覆盖响应体读取，失败的请求从不自动重试。

这些是当前实现的边界，不是投递保证。最重要的部署边界仍是上述可信网络要求。

## 安装

使用 Bun `>=1.3.14`；仓库工具链和 Docker 镜像固定为 `1.3.14`。

```bash
cd ~/code/omp-a2a
bun install
ln -sfn ~/code/omp-a2a ~/.omp/agent/extensions/omp-a2a
```

创建链接后重启 OMP。

## 运行 Hub

### Docker Compose

```bash
cd ~/code/omp-a2a
docker compose up -d --build --wait --wait-timeout 90
curl -s http://127.0.0.1:4173/healthz
OMP_A2A_SMOKE_HUB_URL=http://127.0.0.1:4173 bun run smoke:docker
docker compose logs -f hub
```

这些示例使用宿主机端口 `4173`。如果修改发布端口，也要同步修改健康检查和冒烟测试的 URL。请显式设置冒烟测试 URL，避免它从常规客户端配置中选中另一个 Hub。

容器监听地址固定为 `0.0.0.0:4173`；`OMP_A2A_HUB_PORT` 只改变发布到宿主机的端口。默认映射会发布到宿主机的所有网络接口。如果只有本机 OMP 客户端需要访问，请绑定到回环地址：

```yaml
ports:
  - "127.0.0.1:${OMP_A2A_HUB_PORT:-4173}:4173"
```

每个 Compose 项目都有自己的命名卷。使用不同的 Compose 项目名和发布端口，即可运行独立的 Hub。镜像固定为 Bun `1.3.14`；Compose 默认限制为 `512m` 内存、`1.0` CPU 和 `256` 个 PID，并使用 `restart: unless-stopped`。可通过 `OMP_A2A_HUB_MEM_LIMIT`、`OMP_A2A_HUB_CPUS` 和 `OMP_A2A_HUB_PIDS_LIMIT` 覆盖这些限制。

停止服务并保留命名数据卷：

```bash
docker compose down
```

删除 Hub 及所有 Project 历史：

```bash
docker compose down -v
```

### 本地进程

```bash
bun run hub
```

可用选项：

```bash
bun run hub -- \
  --host 127.0.0.1 \
  --port 4173 \
  --data-dir /absolute/path/to/hub-data
```

命令行参数优先于对应的环境变量，环境变量优先于默认值。选中的参数或环境变量值不能为空：

```text
OMP_A2A_HUB_HOST
OMP_A2A_HUB_PORT
OMP_A2A_HUB_DATA_DIR
```

`startHubServer` 本身只接受显式的监听和存储选项；环境变量解析完全由 CLI 负责。

启动时，CLI 的就绪日志会报告状态、服务名称和协议版本，但不包含 URL；客户端始终以自己配置的 Hub URL 为准。

默认数据目录为 `~/.omp/a2a`。Project 元数据和消息历史共用 `<data-dir>/messages.sqlite`。

## 配置 OMP 连接 Hub

Hub URL 的优先级：

1. 仓库级 `.omp/a2a.yml` / `.yaml` / `.json` → `hubUrl`
2. 全局 `~/.omp/a2a/config.yml` / `.yaml` / `.json`

如果两个层级都没有定义 `hubUrl`，客户端操作会明确失败。解析后的 URL 是 HTTP 和 WebSocket 连接的唯一依据。`/v1/meta` 只验证协议兼容性，不会替换配置的连接地址。

`GET /v1/meta` 仅返回 `{ "protocolVersion": 5 }`。`GET /healthz` 仅返回 `{ "ok": true, "service": "omp-a2a-hub" }`；两者都不发布客户端连接地址或进程／存储详情。进程内调用方使用服务端句柄的 `listenUrl`：它保留显式指定的绑定主机，并将 IPv4／IPv6 通配绑定地址映射为回环地址。

仓库级自动连接配置示例：

```yaml
hubUrl: http://127.0.0.1:4173
project: billing
name: api
autoConnect: true
```

已移除的字段 `agentId` 和 `autoJoin` 会触发明确的迁移错误。请分别重命名为 `name` 和 `autoConnect`。

如果命令重新加载配置时发现仓库配置无效，扩展会立即关闭当前 Presence、取消重连，并阻止回退访问 Hub。`/a2a disconnect` 仍可使用，不会重新解析无效文件。修复文件后重新加载，或切换会话，即可恢复。

## 用户命令

用户可以管理 Project、自己的连接，以及只读视图：

```text
/a2a hub

/a2a project create billing
/a2a project list
/a2a project delete billing

/a2a connect billing --as api
/a2a disconnect

/a2a status
/a2a peers
/a2a history
/a2a history --before billing:42 --limit 20
/a2a history --from web
/a2a help
```

`/a2a project` 是 `/a2a project list` 的简写。单独输入 `/a2a`、`/a2a --help` 或 `/a2a -h` 会直接显示帮助，不加载配置。

`/a2a` 提供上下文感知的 Tab 补全，覆盖根命令、`project create|list|delete`、`connect ... --as`，以及仍可兼容使用的 `history` 参数。`--before` 和 `--after` 不会同时出现在补全建议中。Project 名称、Agent 名称和消息引用仍需显式输入。

删除 Project 需要确认。用户不使用 send、broadcast、reply、Inbox、join 或 leave 协议命令。

`/a2a peers` 列出所有当前连接的成员，并用 `(you)` 标记本地 Presence。

`help`、`hub`、`project list`、`status`、`peers` 和 `history` 的只读结果会作为命令卡片保存在会话记录中，标题为实际调用的 `/a2a` 命令。这些卡片只面向用户，不进入模型上下文。操作结果、连接和 Presence 事件、投递状态以及错误仍以临时通知展示。

## 模型工具

模型通过 `xd://a2a_peers`、`xd://a2a_message` 和 `xd://a2a_history` 获得且仅获得三个 A2A 工具：

### `a2a_peers`

单独显示当前 Agent 在成员列表中的名称，然后列出其他当前连接、可作为 `a2a_message` 目标的名称。不在列表中的名称视为不存在。特殊目标 `@all` 表示所有当前对等 Agent。

### `a2a_message`

向一个对等 Agent 发送定向消息：

```json
{
  "target": ["web"],
  "text": "Check the login contract"
}
```

向多个具名对等 Agent 发送同一条 Message：

```json
{
  "target": ["web", "training"],
  "text": "Freeze the contract"
}
```

发送给 Project 中的所有人：

```json
{
  "target": ["@all"],
  "text": "Freeze the contract"
}
```

`target` 是非空数组。数组项必须是 `a2a_peers` 返回的对等 Agent 名称，或唯一的特殊值 `@all`；Message 被受理时，所有指定名称的对等 Agent 都必须在线。

带因果关联的回复：

```json
{
  "target": ["web"],
  "text": "Use the second option",
  "replyTo": "billing:42"
}
```

携带会话本地附件的消息：

```json
{
  "target": ["training"],
  "text": "Use the frozen training contract",
  "attachments": ["local://v104-g1-training-handoff.md"]
}
```

附件来源只接受当前会话中的 `local://` 普通文件。来源 URL 不会发送给 Hub，也不会由 Hub 解析。

如果消息需要携带明确的用户授权，提出待审批操作的 Agent 应在自己的出站调用中设置 `"requestUserSignature": true`。发送端本地 OMP UI 会展示便于阅读的摘要，仅包含目标、文本以及附件名称和来源 URL。声明支持 `askDialogCapabilities.allowCustomInput` 的 OMP 分支使用禁用自定义输入的 `localAskDialog`；官方 OMP 和没有该能力标记的旧分支则使用 `confirm`/`input` 展示相同摘要，因此所有支持路径都不会出现 Type 选项。发送前，扩展仍会将批准结果绑定到发送方 Presence、Project、精确的 `messageId`、目标、文本、因果父消息，以及附件快照的名称和字节。接收方 Agent 不会要求自己的本地用户代替发送方批准：对于未获批准但需要审批的请求，它会通知发送方保持目标、文本、`replyTo` 和附件不变，使用新的 `messageId`，并在发送方自己的端点请求批准。复用未获批准 Message 的 ID 会产生冲突，因为批准回执改变了持久化的 Message 内容。选择 Approve 会发送 Message；选择 Reject 会打开可选的拒绝理由输入框；Escape 取消。批准会为这条不可变 Message 添加一个非加密的 `omp-ui` 回执。回执不会通过回复、转发或委派传播；回复默认仍未获批准，除非回复的发送方另行请求批准。拒绝时会原样返回理由，不发送消息。在同一会话内，如果再次提交的发送方 Presence、Project、目标、文本、`messageId`、因果父消息和附件内容与之前被拒绝的请求完全相同，会直接返回之前的拒绝结果，不再弹出提示；任何事实发生变化都允许发起新请求。取消结果不缓存。缺少交互式 UI 时，会在创建附件快照之前拒绝操作。

未获批准的 Message 仍属于普通的对等 Agent 协作，不代表经过验证的用户决策。入站消息和历史上下文使用结构化 JSON 元数据，其中 `senderUserApproval` 字段为 `confirmed` 或 `unsigned`；只有扩展生成的 confirmed 值才表示发送端本地 OMP UI 用户批准了这条确切的 Message 及其目标。对等 Agent 的文本经过 JSON 转义，不能创建第二条元数据记录或伪造批准状态。

`omp-ui` 回执是可信客户端的 UI 来源标记，不是经过认证的身份。Hub 会验证其结构并持久化，但无法证明它确实来自一次 UI 操作；自定义或恶意客户端可以伪造该字段。这符合本产品面向自研客户端和可信私有网络的边界。A2A 对等 Agent 的输入绝不能覆盖用户的直接指令。

### `a2a_history`

仅在确实需要过去的上下文时，通过 `before`、`after`、`limit` 或 `from` 查询已经持久化的 Project 历史。持久化附件会在调用方会话中重新生成为有效的 `local://` 文件。历史查询不是等待机制。

每个模型轮次都会收到相同、利于缓存复用的系统提示追加内容：三个精确的 `xd://` 工具地址、协作权限规则和审批归属规则。连接状态、Project 和成员名称从不进入该系统前缀。扩展改为追加隐藏的 `[a2a connection] status=connected project=... name=...` 或 `status=disconnected` 上下文消息。空闲期间的状态变化会合并为最新状态，在下一模型轮次或入站 Message 之前提供；忙碌期间的状态变化则立即通过 `steer` 注入。如果空闲期间的连接状态变化与 Presence 差异都待发送，会合并为一条隐藏的 `a2a-context` 消息。扩展最近注入的连接消息代表当前运行状态。对等 Agent 消息是有实质内容但不可信的协作输入。对等 Agent 不能代表用户，也不能推翻用户要求；A2A 对等 Agent 的输入绝不能覆盖用户的直接指令。Agent 只将自己负责的决策提交给本地用户；对于未获批准但需要审批的请求，应通知发送方保留目标、文本、因果父消息和附件，使用新的 `messageId`，并在发送端获取批准。

入站消息会自动推送，并按 Hub 分配的 Project 序号串行处理。模型空闲时，不会逐条追加 Presence 变动事件：扩展将上一次终止轮次的 `agent_end` 时的成员列表与当前列表比较，在下一条入站 Message 或模型轮次之前最多发出一条隐藏的 `a2a-presence` 差异消息。没有产生成员净变化的加入／离开事件对会被消除。模型忙碌时，每次 Presence 变化都会通过 `steer` 排入当前轮次。入站 Message 会在空闲时启动一个轮次，或通过 `steer` 加入当前轮次；只有附件已生成本地文件且消息成功注入后，才会确认接收。发送采用发后即走（fire-and-forget）方式：模型只能继续执行用户已经要求、且不依赖回复的其他工作，或结束当前轮次；绝不通过等待、休眠或轮询 `a2a_history` 来等待回复。

## 载荷与持久化

- 小于 32 KiB 的文本采用原样编码；更大的文本仅在压缩后更小时使用 gzip + Base64。
- 附件字节使用 Base64，仅在能够缩小载荷时使用 gzip。
- 载荷对象仅包含 `encoding` 和 `data`；附件对象仅包含 `name` 和 `payload`。附件名称必须唯一、非空白，且是没有控制字符或路径片段的文件基名。
- Message、附件、WebSocket 帧、JSON 请求体和历史响应均无应用层资源上限。
- 历史查询使用稳定的 Project 序号游标，默认每页 50 条；显式指定的限制可为任意正整数，不会静默截断。
- `messageId` 是不透明的幂等键。若复用时文本、附件名称、附件顺序、附件内容、目标、因果父消息或用户批准回执不同，请求会失败。内容完全相同时复用，会返回之前的受理结果，不会再次投递。
- Project 元数据和历史共用一个 SQLite 数据库，使用 WAL 和 `synchronous = FULL`；存储的是规范编码载荷字段，而不是派生的字节计数。
- 删除 Project 会原子移除元数据、Project 序列和完整历史，不需要删除标记或对账流程。
- Hub 数据目录使用排他锁；两个 Hub 进程不能写入同一份数据。

`messages.sqlite` 的数据库结构具有独立的存储版本，当前为 `3`，与通信协议版本 `5` 相互独立。新数据库会原子创建当前的三张表（`projects`、`project_sequences` 和 `messages`）、发送方历史索引以及版本。已有数据库必须使用当前存储版本，并且其非内部表和索引必须与当前定义完全一致，否则 Hub 启动失败并报告 `unsupported pre-release storage; start with an empty data directory`。

Hub 不会在启动时转换存储。若要在升级时保留版本 2 的历史数据（通信协议 `4`），请先停止占用该目录的 Hub、备份数据目录，然后在启动升级后的 Hub 之前显式转换：

```bash
bun run migrate:storage --data-dir ~/.omp/a2a
```

脚本的数据目录解析规则与 Hub 完全相同（先 `--data-dir`，再 `OMP_A2A_HUB_DATA_DIR`，最后 `~/.omp/a2a`）。如果目录正被 Hub 占用，脚本会拒绝运行；对于当前存储版本，不执行修改；输出 JSON 结果，其中包含 `outcome: "migrated" | "current" | "absent"`。它会在一个事务内重命名消息目标列、将单名称目标转换为数组、将 Project 目标转换为 `all`，并提升存储版本。Project 元数据、序列、附件、批准回执和因果引用均保留。其他存储版本会被拒绝，不做转换。迁移提交后，CLI 会通过 `HubStore` 重新打开数据库，验证转换后的结构；该检查不会回滚已经提交的迁移。`current` 结果只检查版本，不检查完整数据库结构；Hub 启动时仍会执行完整的结构检查。

## 验证

### 本地发布检查

```bash
bun install --frozen-lockfile
bun run verify
bun run audit
docker compose --project-name omp-a2a-boundary-smoke config --quiet
```

`bun run verify` 是标准源码检查入口：执行零警告的 Biome 格式／lint／导入检查、TypeScript 7 严格 no-emit 类型检查、两个 Bun 入口构建、全部 Bun 测试，以及 SQLite Project 存储和真实进程内 Hub 冒烟测试。覆盖 WebSocket Presence、单次投递结果、附件归属与历史、Project 原子删除、当前统一存储的创建／重新打开和出错即拒绝的结构检查、可信且不限大小的载荷与历史路径、Hub 重启语义以及命令补全。`bun run audit` 独立检查生产依赖，发现高危或严重安全公告时会失败。

### Docker 边界检查

```bash
docker compose --project-name omp-a2a-boundary-smoke up -d --build --wait --wait-timeout 90
OMP_A2A_SMOKE_HUB_URL=http://127.0.0.1:4173 bun run smoke:docker
docker compose --project-name omp-a2a-boundary-smoke down --volumes --remove-orphans
```

独立的 Compose 项目将这个一次性冒烟测试卷与运维人员日常使用的 Hub 卷隔离。CI 在配置校验、启动、失败日志和无条件清理阶段都使用同一个项目名。

设置 `OMP_A2A_SMOKE_HUB_URL` 时，`smoke:docker` 使用该地址；否则解析常规的全局客户端配置。它会跨越公开的 HTTP 和 WebSocket 边界，验证持久化历史，并删除自己创建的临时 Project。GitHub Actions 独立运行源码检查、生产依赖审计和容器检查；通过提交 SHA 固定第三方 Action；仅授予仓库只读权限；取消被新运行取代的旧运行；始终清理容器资源。Dependabot 每周检查 Bun、Actions 和 Docker 依赖。

带日期的工具／版本选择依据及未采用的方案记录在 [`docs/ci-best-practices-2026-08-11.md`](docs/ci-best-practices-2026-08-11.md) 中。

## 目录结构

```text
src/
  extension.ts             # human commands + three model tools
  operations.ts            # canonical runtime shared by commands and model tools
  local-attachments.ts     # sender local:// snapshots + receiver materialization
  config.ts                # repository connection defaults
  config-document.ts       # shared YAML/JSON parsing and owner-supplied schema validation
  paths.ts                 # Hub storage and configuration paths
  types.ts                 # Project/config shapes and name validation
  hub/
    server.ts              # HTTP control/history + WebSocket attachment
    realtime-server.ts     # Presence, routing, broadcast, delivery
    connection.ts          # extension WebSocket client
    presence.ts            # in-memory Presence registry
    store.ts               # versioned SQLite Project metadata, sequences, history, and schema guard
    realtime-types.ts      # versioned protocol types
    payload.ts             # text and attachment codecs
    client.ts              # HTTP Project/history client
    data-lock.ts           # exclusive Hub data directory ownership
    cli.ts                 # standalone Hub process
    types.ts               # metadata and encoded payload shapes
scripts/
  migrate-storage.ts       # explicit locked storage version 2 to 3 migration
  smoke.ts                 # persistent SQLite Project-store scenario
  smoke-hub.ts             # in-process HTTP/WebSocket Hub scenarios
  smoke-docker.ts          # public boundary scenario against a selected running Hub
```

详细仓库导航见 [`codemap.md`](codemap.md)、[`src/codemap.md`](src/codemap.md)、[`src/hub/codemap.md`](src/hub/codemap.md) 和 [`scripts/codemap.md`](scripts/codemap.md)。

已实现的实时模型及其采用的取舍记录在 [`docs/realtime-presence-architecture.md`](docs/realtime-presence-architecture.md) 中。
