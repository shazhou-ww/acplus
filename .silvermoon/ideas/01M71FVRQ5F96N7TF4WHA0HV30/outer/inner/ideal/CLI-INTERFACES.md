# acplus 双入口交互设计

本文是 [Idea](./Idea.md) 的 supporting document，记录交互决策、边界及验证方向，不是独立契约。实现文件划分和具体任务在实施阶段细化。

## 1. 设计动机

- Human 擅长阅读有空间布局的文本与实时屏幕反馈，但手工输入长命令成本较高，分组有助于发现和记忆。
- Agent 可以接受更长、更显式的命令，适合结构化结果与命令组合；不应在执行中等待终端输入。
- Agent 获取上下文也有成本。命令规模有限时，完整紧凑的顶层帮助优于反复查询分组帮助。
- 优化目标是一次拿到正确调用所需的信息，不是永久强制所有命令只有一层。
- 两个可执行入口分别固定交互契约，不通过 TTY 或调用者身份猜测模式；`--json` 不能替代交互模型的分离。

## 2. 包与能力边界

保持单个 ESM npm 包，提供两个 bin：

| 入口 | 定位 |
| --- | --- |
| `acplus` | Human Interface，优化理解、输入、实时反馈 |
| `acplus-ai` | Artificial Intelligence / Agent Interface，优化发现、确定调用、结果组合 |

共用应用能力，包括配置校验、历史查询、服务发现、消息提交、等待、取消与认证。前端分别负责命令解析、帮助、终端确认及输出。

两个入口不通过子进程调用对方。共用配置、数据目录、HTTP `/v2` 和所有权机制，不创建两份历史，也不运行两套互相竞争的服务。

保留包的 exports map、files allowlist 和既有公共导出边界。

## 3. Human 命令组织

保留现有复数资源分组及常用路径：

```text
acplus init
acplus serve
acplus health
acplus agents list|auth|login|auth-input|logout
acplus sessions list|create|get|send|delete
acplus turns list|start|get|cancel
acplus events list
```

顶层帮助按设置、认证、会话、执行和诊断分区。组帮助用于发现，命令帮助用于具体调用；普通会话优先展示，底层生命周期操作继续可用。

保留 `sessions send SESSION "MESSAGE"`、唯一 Session 短前缀、可读文本以及必要的 TTY 确认。无 TTY 时不尝试交互，危险操作要求显式授权。

本轮保留现有等待和展示能力，不以实现完整 TUI、交互式聊天或实时屏幕布局为双入口交付前提。流式展示可以独立演进。

## 4. Agent 命令组织

默认单层命令，单数资源前缀提供语义分组，不增加同义别名：

```text
acplus-ai init
acplus-ai health
acplus-ai agent-list
acplus-ai agent-auth
acplus-ai agent-login
acplus-ai agent-auth-input
acplus-ai agent-logout
acplus-ai session-list
acplus-ai session-create
acplus-ai session-get
acplus-ai session-send
acplus-ai session-delete
acplus-ai turn-list
acplus-ai turn-start
acplus-ai turn-get
acplus-ai turn-cancel
acplus-ai event-list
```

使用显式命名参数，不依赖位置参数或隐式“最近一次”目标。保留 `session-send` 高层能力，不能迫使 Agent 总是拼接底层流程。

持久前台服务由 `acplus serve` 管理；AI 入口复用自动服务机制，不提供默认永不返回的公开 `serve`。内部 `_auto-serve` 不出现在任何公共帮助中。

以下为准备阶段建议，实施时须明确最终参数及覆盖测试，不应误认为已获单项行为变更批准：

- AI Session 操作使用完整 UUID，Human 保留唯一短前缀。
- AI 提交 Turn 要求显式 `--turn UUID`，让调用方在首次调用前持有幂等标识；Human 继续自动生成并打印回执。
- `session-send` 默认返回提交结果；允许显式有界等待，具体参数在实施阶段统一。

## 5. 非交互与授权

AI 入口即使连接 TTY，也不得创建 readline 提示、打开交互 UI 或阻塞读取 stdin。

输入使用命名参数或显式文件路径。拒绝 `--text-file -`、`--input-file -` 以及配置 stdin 输入；Human 保留已有 stdin 能力。

删除必须显式 `--yes`，缺失则立即报错。认证存储同意仍须明确提供，不因为调用方是 Agent 就自动批准。

登录等流程返回操作标识、当前状态及可用的下一步信息。需要用户浏览器操作或补充信息时返回 `action_required`，由下一轮调用推进；不伪造完成，也不收集不受支持的凭证。

轮次式不等于禁止等待结果：显式等待可以有上限，但执行期间不能突然索要交互输入。

## 6. AI 帮助与发现契约

`acplus-ai --help` 一次展示：

- 全部公共命令、所需参数和可用选项。
- 每条命令的简短用途、返回资源和关键约束。
- 共用配置、服务选择、默认值与分页规则。
- stdout、stderr、退出码以及提交和执行成功的区别。
- 幂等、超时、取消、未知结果及认证后续步骤。

每条命令仍可有聚焦帮助，但基本正确调用不依赖第二次查询。共用选项集中说明，避免逐命令重复长文。

以约 8 KiB UTF-8 作为初始紧凑度目标，不作为删掉关键约束的硬上限。实施时记录实际体积与覆盖情况；增长后可调整组织，但仍保留一次展示完整调用说明的能力。

Human 和 AI 的帮助只展示各自语法，顶层允许一句指向另一入口的说明。错误、认证引导和下一步建议也必须使用当前入口的命令，不能从 AI 帮助跳回 Human 交互路径。

## 7. 输出、退出码与恢复

AI 默认输出 JSON，无须 `--json`。优先复用现有资源和分页形状，不为拆入口引入无必要的新协议。

- stdout 为单个 JSON 结果，不混入进度、展示文本或 ANSI 控制符。
- stderr 为结构化错误和必要的提交回执；多个事件须有明确的逐行边界。
- `--help`、`--version` 明确为文本例外。
- 沿用退出码 0（成功观察或交互）、1（操作失败）、2（无效输入），逐命令明确成功含义。
- 进程终止、异常中断等无最终结果的情况不能被描述为一定存在 JSON stdout。

保留业务语义：

- `turn-get` 读取到 `error` 或 `unknown` 仍是成功观察，不是任务执行成功。
- 等待命令必须区分提交、终态、执行失败与等待超时。
- 超时、客户端断开或停止等待不等于取消执行；取消必须指向精确 Turn。
- 丢失写响应后复用原 ID 和原文进行核对，不自动用新 ID 重发。
- `unknown` 不能被伪装为完成、错误或安全重试。
- 只读历史不启动 Agent，不以付费探测证明活性或认证。
- 显式 URL 不回退启动本地服务，认证与权限策略不因入口而改变。

## 8. 兼容与实施顺序

1. 提取共享执行能力，先用现有测试保持 `acplus` 行为不变。
2. 新增 `acplus-ai` 及其非交互、输出和帮助契约。
3. 整理 Human 帮助与文档；保留现有 `acplus --json` 和低层命令的兼容路径，不再将其作为 Agent 推荐用法。

破坏性移除另行规划，不能借整理帮助静默删除参数或改变已有脚本。拆入口不改 HTTP、数据 schema、权限、服务所有权或 ACP 协议。

## 9. 验证方向

- 两个入口操作同一 Session，业务结果与副作用一致；本地和显式远程都覆盖。
- 用 TTY、非 TTY 及未关闭 stdin 验证 AI 入口不会等待输入；非法参数在副作用前失败。
- 覆盖 stdout 整体 JSON 解析、stderr 回执和错误、退出码、无 ANSI 及文本例外。
- 顶层帮助覆盖公开命令、参数和恢复约束，并测量 UTF-8 字节数。
- 覆盖分页、认证、授权、幂等、超时、取消和未知状态。
- 验证两条实际安装入口、版本标识和自动服务启动路径，防止仅源码调用通过。
- 保留原兼容行为测试，最终运行 `pnpm check`。

发布不属于创建 idea 的动作。未来如需 npm 验证或发布，遵循仓库 Trusted Publishing 流程，不本地发布。
