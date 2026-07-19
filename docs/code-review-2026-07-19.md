# omp-a2a 全项目审查报告

> 审查日期：2026-07-19
> 固定快照：`ad6d8aa206fe96282e5f22390a3831308eeba1c8`
> 审查范围：该快照中的全部 tracked 文件
> 结论：当前快照不应作为可部署版本

本报告保留固定快照的历史审查事实；文中的源码和 README 行号均指向该快照。

## 后续处理

后续架构决定改为完全自定义 Mesh，并完成针对九项问题的重构：

| 原 finding | 后续状态 |
| --- | --- |
| F-01 | 已处理：Project create/list/join 全部通过 Hub API |
| F-02 | 已处理：在线状态只由 heartbeat lease 推导 |
| F-03 | 已处理：在线同名 `agentId` 直接拒绝 |
| F-04 | 已撤回：标准 A2A 互操作不再属于项目合同，SDK 门面已删除 |
| F-05 | 已替代：32 KiB 起使用 gzip wire payload，解压后上限为 4 MiB |
| F-06 | 已处理：Inbox 改为无条数 cap 的 SQLite 持久队列和显式 ack |
| F-07 | 已处理：多个 Hub 通过独立 `dataDir` 完全隔离，同目录并发启动被拒绝 |
| F-08 | 已处理：leave 立即停止本地租约，远端失败明确报告 cleanup pending |
| F-09 | 已处理：Slash 与 Tool 共用同一 `A2aOperations` 模块 |

下文继续保留原始发现，便于追溯为什么发生这些改动。

## 审查依据

仓库当时没有独立 PRD 或关联 issue。本次审查使用以下当时合同：

- `README.md:20-21`：Hub 独立运行；OMP extension 是 pure client；Hub 不可达时 fail closed。
- `README.md:23-27`：Hub 只用于完全可信的内网；调用方声明的 `project/from` 直接视为事实，成员表只用于发现和路由收件人。
- `README.md:82-87`：Hub URL 按 repo config、环境变量、global config、默认值的顺序解析。
- `README.md:107-118`：公开命令面包括 project、join、list、send、inbox、status、leave。
- `README.md:120-124`：`bun run smoke` 是公开验证命令。
- Project Registry 是项目与成员状态的唯一权威来源。
- 数据面使用官方 `@a2a-js/sdk` 0.3 管理消息、任务和生命周期，不维护平行的私有消息语义。
- 发件人的 `project/from` 是可信声明；未知或离线收件人、自发自收和注册时的 `agentId` 冲突仍 fail closed。
- Hub 是全局唯一的 standalone 进程；v1 不提供离线持久队列。
- 超过 32 KiB 的正文没有 blob 时必须拒绝，发送失败或消息丢失不得报告成功。

工程标准同时要求：错误必须显式、状态转换应幂等、问题在首次成为事实的边界修复，不以 fallback 或重复状态掩盖失败。

## 严重度

| 级别 | 含义 |
| --- | --- |
| P1 | 阻断核心功能、破坏隔离或导致不可接受的数据丢失；部署前必须修复 |
| P2 | 违反明确合同或错误状态语义，但不直接造成整体失效 |
| P3 | 已出现行为分叉风险的维护性问题 |

## 双轴结论

- **Standards：5 项**——4 项硬违规，1 项 Fowler Duplicated Code 判断性提示。
- **Spec：7 项**——standalone Docker、`agentId` 冲突、标准 A2A 数据面和 fail-closed 合同均未满足。

两个轴存在重叠。下文按根因去重，共记录 9 项唯一问题。

## 问题总览

| ID | 级别 | 问题 | 直接后果 |
| --- | --- | --- | --- |
| F-01 | P1 | Docker 部署中的 Registry 分裂 | 推荐部署路径无法 create/list/join |
| F-02 | P1 | 跨 PID namespace 探活 | 容器内成员立即 stale，无法收发 |
| F-03 | P1 | `agentId` 冲突默认强制覆盖 | 省略 force 即可顶替在线成员 |
| F-04 | P1 | OMP 实际绕过标准 A2A 数据面 | SDK 生命周期与真实消息路径脱节 |
| F-05 | P2 | 未执行 32 KiB 正文限制 | 大正文绕过 blob/handoff 边界 |
| F-06 | P1 | Inbox 满时静默丢消息 | 发送方收到成功，但消息已丢失 |
| F-07 | P1 | 未强制全局唯一 Hub | Registry 共享而 Inbox 分裂 |
| F-08 | P2 | 注销失败仍报告离开成功 | 本地与 Hub 成员状态不一致 |
| F-09 | P3 | slash command 与 tool 重复实现 | 默认参数已经发生行为分叉 |

## 详细发现

### F-01：Docker 部署中的 Registry 分裂

**证据**

- extension 直接访问宿主文件系统上的 Registry：`src/extension.ts:245,315,333,473,486`。
- Hub 注册时从自己的 Registry 查询 Project：`src/hub/server.ts:282`。
- Compose 将 Hub 的 `HOME` 设为 `/data`，并把 Registry 放入独立 named volume：`docker-compose.yml:15-18`。

**已观察行为**

使用两个不同 HOME 分别模拟宿主 extension 和容器 Hub 后：extension 能看到本地创建的 Project，Hub 的 Project 列表为空，join 返回 `unknown project`。

**合同影响**

`README.md:40-63` 推荐的 Docker Compose 路径无法完成公开的 project create/join 流程。Project Registry 同时存在两个 owner。

**修复验收条件**

Project create、list、join 必须访问 Hub 持有的同一份权威 Registry；使用独立宿主 HOME 和容器 HOME 的端到端场景必须通过。

### F-02：跨 PID namespace 探活

**证据**

- `src/registry.ts:52-68` 使用 `process.kill(member.pid, 0)` 判断成员进程是否存活。
- 客户端把宿主 OMP PID 发给 Hub：`src/extension.ts:178-187`。
- 当前 Hub smoke 使用同一进程和同一 PID：`scripts/smoke-hub.ts:30,37`。

**已观察行为**

模拟 Hub 无法看到宿主 PID 后，两个 register 请求均成功，但在线成员列表为空；send 返回 `sender ... not online`。

**合同影响**

PID 不是跨 namespace 的成员身份或 lease。推荐容器部署下 heartbeat 尚未生效，成员已先被派生为 stale。

**修复验收条件**

在线状态必须由 Hub 可观察的注册/heartbeat lease 决定，不能依赖宿主 PID 可见性；真实容器边界 smoke 必须覆盖该路径。

### F-03：`agentId` 冲突默认强制覆盖

**证据**

- Hub register 将缺省 `force` 解释为 `true`：`src/hub/server.ts:286-298`。
- extension 的共享 join 路径也将缺省 `force` 解释为 `true`：`src/extension.ts:161-187`。
- Registry 本身只有在 `force` 为 false 时才拒绝在线冲突：`src/registry.ts:177-185`。

**已观察行为**

注册请求省略 `force` 后，在线的 `victim` 成员记录被从 `/victim` 覆盖为 `/attacker`。

**合同影响**

“冲突默认失败、显式 force 才替换”的合同被反转；可信客户端的配置错误或重连也可能覆盖错误成员。

**修复验收条件**

省略 `force` 必须拒绝在线冲突；显式 force 继续作为可信调用方主动替换成员的入口。

### F-04：OMP 实际绕过标准 A2A 数据面

**证据**

- extension 的命令和 tool 都调用 `HubClient.send`：`src/extension.ts:399-412,556-570`。
- `HubClient.send` 和 `inbox` 使用私有 `/v1/send`、`/v1/inbox`：`src/hub/client.ts:174-186`。
- Hub 使用自建 `InboxStore` 和 `HubEnvelope` 管理真实收发；Agent Card 和 JSON-RPC 是旁挂入口：`src/hub/server.ts:60-168,223-226,415-421`。

**合同影响**

官方 SDK 的 task、message、result 和 lifecycle 并非 OMP 的实际数据面。系统同时维护两套发送语义、路由状态和错误模型。

**修复验收条件**

OMP 的实际 send/task/result 路径必须经过标准 A2A 0.3 handler；不得保留承担同一职责的私有消息生命周期。

### F-05：未执行 32 KiB 正文限制

**证据**

- Express 接受最大 4 MB JSON：`src/hub/server.ts:228-229`。
- `/v1/send` 只检查字段存在和成员状态，没有正文大小检查：`src/hub/server.ts:358-393`。

**已观察行为**

32,769 字节的正文被接受并返回成功。

**合同影响**

大 diff、schema 和日志可以绕过 blob/handoff 边界，增加内存、日志和请求处理风险。

**修复验收条件**

没有 blob/file part 的正文超过 32 KiB 时必须明确拒绝；边界值 32 KiB 应被自动化覆盖。

### F-06：Inbox 满时静默丢消息

**证据**

`InboxStore.push` 在队列超过 200 条时直接 `shift()`，但调用方始终返回成功：`src/hub/server.ts:60-69,384-393`。

**已观察行为**

连续发送 201 条消息均得到成功响应，收件人只得到 200 条，最早的 `m0` 已丢失。

**合同影响**

发送成功不再表示 Hub 接受并保留了消息，违反显式失败合同。该行为也不是合同允许的离线持久队列。

**修复验收条件**

队列无法接受消息时必须在发送响应中明确失败，或先建立具有一致成功语义的持久交付机制；不得静默淘汰已确认消息。

### F-07：未强制全局唯一 Hub

**证据**

`startHubServer` 直接监听目标端口，随后覆盖 `hub.json` 和 `hub.pid`；启动前不检查已有 Hub，也没有所有权锁：`src/hub/server.ts:424-440`。

**已观察行为**

同一 HOME 下两个不同端口的 Hub 可以同时启动。二者共享 Registry 文件，但各自持有独立内存 Inbox；消息只在接收请求的 Hub 中可见。

**合同影响**

“全局唯一 Hub”只是约定，不是状态不变量。metadata 最后写入者与实际消息所在进程可能不同。

**修复验收条件**

同一 Registry owner 下第二个 Hub 必须复用现有 endpoint 或明确启动失败；停止非 owner 进程不得删除 owner 的 runtime metadata。

### F-08：注销失败仍报告离开成功

**证据**

- `doLeave` 吞掉 unregister 异常，随后无条件清空 membership：`src/extension.ts:192-204`。
- slash command 和 tool 均把返回值渲染为成功：`src/extension.ts:377-384,529-534`。

**合同影响**

Hub 不可达或拒绝注销时，本地显示已离开，Hub 仍保留原成员；错误、未知状态和成功状态无法区分。

**修复验收条件**

注销失败必须向调用方返回错误，并保留足以重试或展示未知状态的本地事实；重复 leave 应保持幂等。

### F-09：slash command 与 tool 重复实现

**证据**

- slash command 分支位于 `src/extension.ts:275-436`。
- tool 分支位于 `src/extension.ts:438-599`。
- slash join 显式计算缺省 false：`src/extension.ts:365-371`；tool join 将 `undefined` 传入默认 true 的 `doJoin`：`src/extension.ts:505-515`。

**判断**

这是 Fowler Duplicated Code 判断性提示，不是独立的风格硬违规。但行为分叉已经发生，因此重复结构不再只是审美问题。

**修复验收条件**

命令与 tool 应共享同一组规范操作及默认值；两种入口对相同输入必须产生相同状态转换和错误。

## 验证结果

### 现有验证

`bun run smoke` 通过：

- Slice 0 Registry create/join/list/isolation/heartbeat/leave 通过。
- in-process Hub 的双成员 send/inbox 和 Agent Card 通过。
- 未知目标拒绝通过。

该结果只覆盖同 HOME、同 PID、同进程边界，不能证明 Docker、容量或多 Hub 不变量。

### 定向复现

| 场景 | 结果 |
| --- | --- |
| extension HOME 与 Hub HOME 分离 | Hub 返回 `unknown project` |
| Hub 无法观察客户端 PID | register 成功，但成员 stale，send 被拒绝 |
| 发送 32,769 字节正文 | Hub 接受 |
| 连续发送 201 条消息 | 201 次均成功，只保留后 200 条 |
| 同 HOME 启动两个不同端口 Hub | 两者均启动，Inbox 分裂 |
| 注册同名在线成员且省略 force | 原成员记录被覆盖 |

根据明确的 trust-on-claim 合同，无认证 REST、未注册 A2A 发件人以及 Compose 发布到内网接口均不计为缺陷；这些行为只有在部署越过 `README.md:23-27` 的信任边界时才构成风险。

这些定向复现尚未进入仓库自动化测试。仓库也没有可用的 TypeScript LSP 配置，因此本报告未把语言服务诊断作为正确性证据。

## 发布判定

在 F-01、F-02、F-03、F-04、F-06 和 F-07 关闭前，不应把当前快照视为可部署的 standalone A2A Hub。`bun run smoke` 通过只能证明当前的同进程 happy path，不能覆盖实际失效边界。
