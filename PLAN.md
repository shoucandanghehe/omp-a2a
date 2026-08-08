# omp-a2a 匿名实时模型实施计划

## 目标

将现有“持久成员 + HTTP 轮询 Inbox”模型干净切换为：

> Project 是房间，WebSocket 连接是匿名 Agent，名字是临时句柄，消息是唯一持久记录。

## 冻结合同

1. Presence 当且仅当 WebSocket 存活。
2. 一个 Presence 只属于一个 Project；名字只在该 Project 的当前连接中唯一。
3. 断开后立即删除 Presence 并释放名字；同名重连是新的 Presence。
4. 不存在 `offline`、`stale` 或离线消息。
5. 点对点只解析当前在线名字；目标不存在立即失败。
6. 广播目标是消息接受瞬间的 Presence 快照，排除发送者，后来加入者不补收。
7. Message 一旦接受即不可变并进入 Project 历史；ACK 不删除消息。
8. 上下线通知是瞬时事件，不进入历史。
9. Hub 重启清空 Presence，但保留消息历史。
10. 当前无账号可信内网模型不提供私密历史访问控制；点对点是路由语义，不是保密语义。

## 最终接口

### 模型工具

- `a2a_peers`
- `a2a_message`
- `a2a_history`

`a2a_message` 使用强类型目标：

```ts
target:
  | { type: "agent"; name: string }
  | { type: "project" }
```

回复通过可选 `replyTo` 表达，不增加独立的 send/broadcast/reply 工具。

### 用户命令

- `/a2a hub`
- `/a2a project create|list|delete`
- `/a2a connect <project> --as <name>`
- `/a2a disconnect`
- `/a2a status`
- `/a2a peers`
- `/a2a history`
- `/a2a help`

删除用户数据面命令：`send`、`inbox`、`join`、`leave`。

用户就是当前可信内网部署的管理员；不新增 Operator 产品、Admin CLI、Unix Socket、额外控制端口或 `docker compose exec` 工作流。

## 实现步骤

1. 定义 `Presence`、Project 级 `Message`、历史查询和版本化 WebSocket 帧类型。
2. 新增 append-only `MessageStore`，使用 Project 级单调 sequence 和 `<project>:<sequence>` 引用。
3. 从旧 `message_ledger` 迁移普通消息；不迁移成员状态、cursor、ACK、receipt 或离线投递语义。
4. 新增内存 `PresenceRegistry`；连接建立即存在，连接关闭即删除。
5. 在现有 4173 HTTP Server 上挂载 `/v1/connect` WebSocket，不增加端口。
6. 通过 WebSocket 实现点对点、Project 广播、实时 delivery 和上下线通知。
7. 增加 cursor 化 `/v1/history` HTTP 查询；历史不自动注入。
8. 用单一 `A2aConnection` 替换 register/heartbeat/unregister 和 Inbox polling。
9. 将模型表面收敛为三个工具，将用户表面收敛为最终 Slash 命令。
10. 删除持久成员 Registry、InboxStore、每收件人 cursor、离线投递、旧 HTTP 消息路由和旧兼容 fallback。
11. 更新配置词汇：`agentId -> name`、`autoJoin -> autoConnect`；旧字段明确报迁移错误，不静默保留别名。
12. 更新测试、真实 Hub smoke、Docker smoke 和 README。

## 持久化迁移

新数据库使用 `messages.sqlite`，至少包含：

- `project_sequences`
- `messages`

迁移从旧 `inbox.sqlite` 的 `message_ledger` 读取普通消息，按 `(project, created_at, msg_id)` 确定 Project 序列，通过旧 `msg_id` 重建回复关系。pending 消息只迁为历史，不再投递。迁移必须在新数据库事务内完成，并校验消息数量和 `PRAGMA integrity_check`；失败时旧数据库保持不变。

## 验收

- 同名并发连接失败；关闭连接后立即从 peers 消失并产生下线通知。
- 同名重连获得新 Presence，且不继承旧投递。
- 点对点目标不存在立即失败。
- 广播只送达接受瞬间的当前 Presence 快照。
- Presence 通知不进入历史。
- 点对点、广播和回复进入统一 Project 时间线。
- Hub/容器重启后 Presence 清空、历史保留。
- 模型只能看到三个 A2A 工具；用户没有 send/inbox/join/leave 命令。
- Docker 仍只需 `docker compose up -d --build`，不增加日常管理步骤。

## 部署与回滚

新旧协议不混跑。部署前停止旧 Hub 写入并同时保存旧镜像与一致数据备份；先用备份副本验证迁移，再同时升级 Hub 与扩展。回滚必须同时恢复旧镜像和升级前数据。
