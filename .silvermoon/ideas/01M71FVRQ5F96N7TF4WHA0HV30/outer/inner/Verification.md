# 双入口实现验证

## 实现边界

- 工作目录为
  `D:\Code\ahplex.worktrees\acplus-dual-cli`，实现开始时工作区干净，基线为
  `15a7f0d`。未修改另一工作区、理想契约、部署契约或生命周期事件。
- 一个包、两个 bin；业务执行位于
  `src/cli-core.ts`，两条入口在同一进程内调用，没有 CLI 之间的子进程转发。exports、files、HTTP、存储和 ACP 协议保持不变。
- Human 保留短前缀、位置参数、stdin、TTY 删除确认、自动 Turn ID、
  `--json`、`--no-wait`、`--timeout-ms` 及原等待行为。
- AI 固定非交互、全量 UUID、显式 Turn ID、默认 admission、 `--wait-ms`
  有界等待；无隐式重试、自动同意或默认永不返回的公开服务命令。
- AI acknowledgement-only 响应输出 JSON `null`，不继承 Human
  JSON 模式的空输出。Node SQLite 等运行时警告在实际 AI bin 中转换为 JSON
  Lines，避免污染 stderr。模型回复和事件 payload 保留原文，只转换资源诊断中的命令引导。

## 可复现验证

2026-11-10，Node.js `v24.11.1`、pnpm `11.22.0`：

| 命令                                                                                                         | 结果                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm test -- test\cli-ai.test.ts test\cli-dual-entry.test.ts test\acp-cli.test.ts test\acp-package.test.ts` | 4 个测试文件、77 项通过                                                                  |
| `pnpm typecheck`                                                                                             | 通过                                                                                     |
| `pnpm lint`                                                                                                  | 通过                                                                                     |
| `pnpm test:coverage`                                                                                         | 15 个测试文件通过；265 项通过、1 项跳过                                                  |
| `pnpm build`                                                                                                 | 通过                                                                                     |
| `pnpm lint:package`                                                                                          | publint 通过，两条真实构建入口检查通过                                                   |
| `node scripts\check-cli-entry.js`                                                                            | 两条 bin 的版本、shebang、帮助通过；AI 帮助实际 stdout 为 5563 UTF-8 bytes（含末尾换行） |

覆盖率：statements 95.51%、branches 92.05%、functions 95.21%、lines
96.41%，均超过项目 90% 阈值。

新增测试覆盖 TTY/非 TTY 属性、禁止 readline/stdin、保持未关闭 stdin 的子进程、命名参数及副作用前拒绝、JSON
stdout/stderr 和文本例外、精确提交回执、同 ID/原文幂等与更改输入冲突、默认仅提交、有界等待与终态退出、超时不取消/不重发、实际取消、未知状态读取、认证轮次与显式存储同意。真实 HTTP 服务中双入口交替读写同一 Session，并覆盖分页和认证；本地 AI 创建触发既有
`cli.js _auto-serve`，Human/AI 读取同一离线历史，无 Agent 进程启动，空闲服务释放锁。

并发覆盖率运行暴露 Human 会话测试把服务的 1500
ms 空闲回收窗口与多次 CLI 启动、Windows
ACL 校验混在一起的时序竞争；单独运行通过。只将该功能用例的空闲窗口调为 5000
ms，保留独立回收时长测试及生产默认值不变。子进程入口组合用例也显式设置 30 秒测试上限，保持单个子进程 20 秒上限；最终完整覆盖率运行通过。

## 完整质量门与协调者复核

实施 subagent 的首次 `pnpm check` 在 `format:check`
阶段报告以下文档不符合Prettier；其中理想文件在实现期间未改动，部署文件由部署负责人维护：

- `outer/inner/ideal/Idea.md`
- `outer/inner/ideal/CLI-INTERFACES.md`
- `outer/Deployment.md`

实施 subagent 保留该阻塞，由协调者处理自己的准备文档；未放宽格式规则或质量门脚本。协调者仅格式化理想文档，未改变其语义，同时完成用户新要求的 Ubuntu 部署契约。理想文档因格式变化产生的新修订须重新提交并依授权审查。

协调者于 2026-11-10 10:04（开发机本地时间）重新执行完整
`pnpm check`：格式、lint、类型、完整覆盖率测试（265 项通过、1 项跳过）、构建及包校验全部通过。覆盖率与前述结果一致，AI 帮助为 5563
UTF-8 bytes。`I-AC03`
据此完成。代码审查核对了共享执行路径、AI 参数限制和诊断、Human 兼容、双 bin 包边界及真实子进程测试。这些实现证据不替代
`office-ubuntu` 上的独立首用实测。

开发机有效 npm/pnpm
registry 为腾讯镜像，未切换 registry，未向 CI 传播配置。pnpm 首次运行按照现有配置自动恢复缺失依赖，全部复用本地缓存；未新增依赖。没有 npm 发布、版本变更、暂存、提交、推送或生命周期事件。
