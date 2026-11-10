# Implementation

交互依据见 [设计说明](./ideal/CLI-INTERFACES.md)，实现和本地验证证据见
[实现验证](./Verification.md)。本阶段不发布 npm、不变更协议、版本或部署契约。

## Steps

### I-S01: 提取共享执行能力

`src/cli-core.ts` 共用配置、HTTP/离线历史、服务发现、提交、等待和认证编排。
`src/cli.ts` 保留 Human 入口、`run` 兼容入口和内部 `_auto-serve`；
`src/cli-ai.ts` 固定 AI 契约，不通过子进程调用 Human 命令。自动服务仍由既有
`local-service.ts` 启动 `cli.js _auto-serve`。

### I-S02: 接入双入口交互契约

同一包增加 `acplus-ai` bin，保留 exports map、files
allowlist 和既有 Human 参数。AI 使用 17 个平铺命令、全量小写 UUID、命名参数和默认 JSON；
`session-send`/`turn-start` 必须显式传入 `--turn UUID`。
`session-send`/`agent-login` 默认仅提交，只有显式 `--wait-ms 100..86400000`
才等待；删除必须 `--yes`，文件及配置输入拒绝
`-`，TTY 不改变这些规则。错误与资源内诊断只引用 AI 命令，不改写模型回复或事件 payload。

### I-S03: 完善测试和使用文档

README 和 `docs/CLI.md`
分别说明两个入口；Human 顶层按用途分区，AI 顶层帮助完整列出命令、选项、输出、退出和恢复约束，并保留聚焦帮助。新增单元及实际构建入口测试；入口检查同时校验两条 bin、版本、shebang、帮助及 AI 帮助 UTF-8 体积。执行针对性测试和现有质量检查，不改写只读理想契约。

## Acceptance criteria

### I-AC01: 共享业务与兼容行为保持一致

通过本地、远程及双入口交替操作测试，证明业务结果一致，原有脚本兼容路径仍受保护。

### I-AC02: AI 契约可独立验证

通过 TTY 与非 TTY 测试证明无输入等待，并验证 JSON、退出码、恢复语义及完整帮助覆盖和体积。

### I-AC03: 双入口构建和质量检查通过

通过 `pnpm check`
和构建产物双 bin 检查证明两个入口可用；文档分别说明 Human 与 Agent 使用方式。

本地实现证据覆盖测试、类型、构建和包形状；协调者已修复准备阶段文档排版，重新执行完整
`pnpm check` 并通过，见 [实现验证](./Verification.md)。
