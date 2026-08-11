# 现代 CI 决策记录（2026-08-11）

本文固定 `omp-a2a` 在 2026-08-11 采用的工具链和 CI 取舍。版本事实只引用一手来源；后续更新由 Dependabot PR 重新经过相同门禁。

## 稳定基线

| 组件 | 版本 | 依据 |
| --- | --- | --- |
| Bun | `1.3.14` | [Bun v1.3.14 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14)；官方文档说明 [canary 是未测试构建](https://bun.com/docs/installation#canary-builds)，不采用。 |
| Biome | `2.5.7` | [Biome CLI v2.5.7 release](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.5.7)。 |
| TypeScript | `7.0.2` | [TypeScript 7.0 stable 公告](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)称其可用于生产，并通过标准 `typescript` 包发布。项目只调用 `tsc`，不依赖 7.0 尚未提供的编译器 API。 |
| `actions/checkout` | `v7.0.1` | [官方 release](https://github.com/actions/checkout/releases/tag/v7.0.1)，工作流固定到 commit `3d3c42e5aac5ba805825da76410c181273ba90b1`。 |
| `oven-sh/setup-bun` | `v2.2.0` | [官方 release commit](https://github.com/oven-sh/setup-bun/commit/0c5077e51419868618aeaa5fe8019c62421857d6)，工作流固定到该完整 SHA。 |
| GitHub runner | `ubuntu-24.04` | [GitHub hosted runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#supported-runners-and-hardware-resources)；不使用 preview runner，也不让 `ubuntu-latest` 将来静默切换基线。 |

`packageManager` 固定本地与 Actions 使用的 Bun 版本；Dockerfile 同时固定相同 release 的 tag 和镜像 digest，使镜像在没有仓库脚本或环境变量时仍可独立、可复现地构建。两处版本由 Dependabot 更新并由 CI 检查，不引入为了“单文件版本源”而要求操作者预先导出 Compose 变量的额外协议。

## 三个独立门禁

### Source quality

`bun run verify` 顺序执行：

1. `biome ci --error-on-warnings .`：格式、lint、assist 和零 warning；[Biome `ci` 文档](https://biomejs.dev/reference/cli/#biome-ci)保证只检查、不写文件。
2. `tsc --noEmit`：严格检查 source、scripts、tests；[`noEmit`](https://www.typescriptlang.org/tsconfig/noEmit.html)只负责类型，不和 Bun bundler 争夺生成物所有权。
3. 两个 Bun entry-point build：Extension 将宿主提供的 `@oh-my-pi/*` 保持 external，Hub 生成独立 bundle。[Bun bundler 文档](https://bun.com/docs/bundler)不把 bundling 当类型检查替代品。
4. `bun test`、Registry smoke、真实同进程 HTTP/WebSocket Hub smoke。

CI 先执行 `bun install --frozen-lockfile`；[Bun install 文档](https://bun.com/docs/pm/cli/install#production-mode)规定 manifest 与 lockfile 不一致时失败，不在 CI 改锁文件。

### Production dependency audit

`bun run audit` 执行 `bun audit --prod --audit-level=high`。Hub 镜像实际交付 Express 和 ws，因此 high/critical 生产依赖漏洞属于发布边界；dev-only advisory 不阻断运行时交付。命令语义见 [Bun audit 文档](https://bun.com/docs/pm/cli/audit#filtering-options)。

### Container boundary

Docker job 执行：

1. [`docker compose --project-name omp-a2a-boundary-smoke config --quiet`](https://docs.docker.com/reference/cli/docker/compose/config/)；
2. [`docker compose --project-name omp-a2a-boundary-smoke up --build --wait --wait-timeout 90`](https://docs.docker.com/reference/cli/docker/compose/up/)；
3. `bun run smoke:docker`，穿过容器公开的 HTTP/WebSocket 边界并验证持久历史；
4. 失败时以同一 Compose project 输出容器日志；
5. 无条件 [`docker compose --project-name omp-a2a-boundary-smoke down --volumes --remove-orphans`](https://docs.docker.com/reference/cli/docker/compose/down/)。

Source、audit、container 三个 job 并行，避免容器边界被 source job 的排队时间遮蔽；每个 job 都有明确 timeout。

## GitHub Actions 安全合同

- 顶层 `permissions: contents: read`，符合 [最小权限原则](https://docs.github.com/en/actions/reference/security/secure-use#principle-of-least-privilege)。
- 外部 Action 使用完整 commit SHA；[GitHub secure-use 文档](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)指出这是唯一不可变引用。
- checkout 关闭 `persist-credentials`；工作流没有写仓库需求。
- concurrency 按 workflow/ref 分组并取消旧 run，避免过期提交继续占用 runner；见 [GitHub concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。
- Dependabot 使用官方 `bun`、`github-actions`、`docker` ecosystems 每周更新 lockfile、Action SHA 和基础镜像；Bun 文本锁文件支持见 [GitHub ecosystem 列表](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#bun)。

## 有意不采用

- 不加 Oxlint、ESLint、Prettier：Biome 是唯一 format/lint/assist owner，TypeScript 只拥有类型检查。
- 不加 OS/Bun matrix：当前部署合同只有 pinned Bun + Linux Docker，没有其他真实消费者。
- 不上传 build artifacts：当前没有发布或下载消费者，build 只证明两个入口可生成。
- 不加 dependency/BuildKit cache：当前 frozen install 和镜像构建都很短，没有数据证明缓存协议能回本。
- 不加 coverage gate：尚无可解释阈值或报告消费者；现有行为门禁直接覆盖 HTTP、WebSocket、SQLite 和容器边界。
- 不采用 beta、RC、nightly、canary 或 preview runner。
