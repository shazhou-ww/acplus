# CLI Redesign 讨论进度

记录截至 **2026-11-11
00:51（UTC+08:00）**。本次按用户要求把会话内完整设计和进度保存为仓库 Idea；不是完整设计验收、不是实施批准，也不是发布批准。

- Idea：`01M735YJ4JJNGKHYVNTAFFA7B0`，别名 `cli-redesign`，处于 preparing。
- [方向卡](./Idea.md) 是 canonical 理想契约。
- [需求模型](./REQUIREMENTS.md) 保存五步建模。
- [完整 CLI Spec](./CLI-SPEC.html)
  保存两个入口、44 个可调用章节及成功/失败示例。
- 下游 [Implementation](../Implementation.md) /
  [Deployment](../../Deployment.md)
  仅为可调整的轻量种子，ledger 全部未勾选；未进行运行时实施或外部验收。

## 从哪里继续

**刚刚确认 `acplus config reset`。下一章是 `acplus agent auth-status`。**

继续时先阅读本文件，再打开
[身份与认证状态章节](./CLI-SPEC.html#human-agent-auth)，提出该章的语法、结果及边界，等待用户明确同意后自动进入下一章。不要重启五步建模，不把全部候选重新当作待定，也不要跳过剩余章节。每轮只讨论当前范围；反馈修改后需要修订确认，不能把提问、沉默或撤回当批准。

设计已全部保存在项目文件中，不依赖会话数据库、浏览器 Page
ID 或机器上的技能路径续接。HTML 的章节锚点为保留旧讨论链接的稳定标识，可能还带
`create/send/turn-cancel`
等旧内部名字；可见命令及参数已完成 ACP 命名对齐，不代表存在旧命令别名。

## 已确认的全局决策

| 项目         | 当前结论与批准范围                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| 五步模型     | 唯一 Agent 使用者、唯一主场景 S1、单轮仅输入与已有 Session，资源和辅助管理分层已确认                    |
| 双入口       | Human 资源分组 `acplus`，AI 浅层 `acplus-ai`；共享业务而非两套服务                                      |
| 输出         | 全部固定 JSON，包括帮助/版本；不提供 `--json`；stderr 多记录为 JSON Lines                               |
| 命名         | 单数 `session/turn/event/agent/config/server`；`new/prompt/cancel/authenticate` 对齐 ACP                |
| 标识         | `--session-id/--turn-id/--agent-id/--step-id/--config-id`；CLI 使用 workspace，内部协议不随之改名       |
| 默认 Session | 不设用户级日常会话、最新会话或自动创建；创建与发送分离                                                  |
| Turn         | 发送 ID 由 CLI 自动生成并回执，用户/AI 不手填；新调用是新轮次，不向原轮追加                             |
| 创建默认     | Agent：本次值 > `session.agentId`，无产品 Agent；workspace：本次 > `session.workspace` > 调用方当前目录 |
| 真实创建     | `session new` 异步建立真实 ACP 会话并获取实际配置，替代旧的本地元数据创建基线                           |
| setup        | `{state,error,observedAt}`，accepted/ready/error/unknown；未 ready 拒绝执行/ACP 修改，不排队            |
| 配置发现     | ACP `configOptions` 标准描述和本地 `configOptionsObservation` 分离；未知 null / 过时明确标注            |
| Session 修改 | 名称与 ACP 配置同一命令、逐项设置；本地提交和 Agent 确认不同；无批量入口                                |
| 修改结果     | 自动 changeId，accepted/succeeded/error/unknown；latestChange 及 Session 事件共同保留结果               |
| 服务         | 显式后台 start/status/stop，无隐式启动或空闲退出；Agent 进程仍按需管理                                  |
| 安全         | 精确取消、拒绝未知/活动删除、凭证不入历史、不重放、不猜测接管进程                                       |

JSON 帮助/版本的**格式**已批准，但其完整对象字段尚未正式讨论。统一流方向不等于所有退出码、中断、文件限额和错误字段细则都已批准。

## 接口章节的批准矩阵

“已确认”指实际讨论的语法、结果和边界；未明确讨论的共享细则仍待确认。AI 即使受全局决定约束，其独立章节尚未逐章批准。

| Human 命令           | 进度                     | 已确认范围                                                               |
| -------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `acplus`             | 已确认，部分共享字段待定 | 根/组帮助、版本、输入错误、无副作用；后续统一 JSON 替代原文本输出        |
| `session new`        | 已确认                   | 参数及默认、真实 ACP 异步建立、setup 回执与未就绪边界                    |
| `session prompt`     | 已确认                   | 明确 Session、输入二选一、Human stdin 文本、自动 Turn ID、异步受理不重发 |
| `session cancel`     | 已确认                   | 确切 Turn 本地保护，requested/not-needed，不确定失败                     |
| `session list`       | 已确认                   | 筛选、query.limit 默认 100/范围 1..1000、游标、摘要与只读                |
| `session get`        | 已确认                   | 基本信息、setup、ACP 配置项列表/未知与新鲜度观察                         |
| `session set`        | 已确认                   | 单项 name 或 configId/value/file；本地与异步变更、结果和事件历史         |
| `session delete`     | 已确认                   | 本地历史范围、活动/未知保护、完整 TTY JSON 确认或显式 yes                |
| `turn list`          | 已确认                   | 创建记录顺序、分页、本地摘要与非存活观察                                 |
| `turn get`           | 已确认                   | 输入/回复/state/stopReason/error/时间/coverage；查询失败状态仍是查询成功 |
| `event list`         | 已确认                   | 筛选先分页、Session 序列、单调增量位置、范围水位及完整性                 |
| `config get`         | 已确认                   | key/value/source user/product/unset；缺文件与坏文件区分，不解析凭证      |
| `config set`         | 已确认                   | 单项校验/保存/appliesTo，不重绑、不启停、不迁移                          |
| `config reset`       | 已确认，最新批准         | 移除覆盖、默认或 unset/null、changed 区分真实修改和无操作                |
| `agent auth-status`  | 未讨论接口，下一项       | 场景层已确认，只读身份/认证观察；字段及命令细节仍候选                    |
| `agent identity-set` | 未讨论接口               | 身份选择与关联已归 A5；具体键、结果、生效边界待接口确认                  |
| `agent authenticate` | 未讨论接口               | 认证方式由 Agent 协商、异步流程原则已确认；适配器细节待定                |
| `agent auth-input`   | 未讨论接口               | 真实步骤、明确授权原则已确认；步骤输入契约待定                           |
| `agent logout`       | 未讨论接口               | 真实能力与非伪造退出原则已确认；结果查询细节待定                         |
| `server start`       | 未讨论接口               | 显式后台/ready/身份原则已确认；参数、默认、回执、限时待定                |
| `server status`      | 未讨论接口               | 只读可信状态、未知报错原则已确认；字段待定                               |
| `server stop`        | 未讨论接口               | 默认活动拒停/显式取消并停止原则已确认；CLI 细节待定                      |

独立 AI 章节顺序见 Spec：根、`session-new/session-prompt/session-cancel/session-list/`
`session-get/session-set/session-delete`、`turn-list/turn-get`、`event-list`、
`config-get/config-set/config-reset`、`agent-auth-status/agent-identity-set/`
`agent-authenticate/agent-auth-input/agent-logout`、`server-start/server-status/server-stop`。这些 22 个章节均未逐章确认；不能从相同业务能力推断全部接口已通过。

## 需要继续决定的事项

1. 完成余下 Human 身份/认证、服务章节与全部 AI 章节的接口确认。
2. 共享 JSON 帮助/版本字段、错误流与退出码、提交后中断、输入限额、文件/TTY 行为、普通配置键白名单及未确认具体数值。
3. 实际 Agent/SDK 的配置类型与认证能力，原生 Copilot 适配器如何明确公开；不把 ACP
   schema 出现某方法当作所有 Agent 均已实现。
4. ACP 标准权限回调如何在异步服务中承接；移除自有通用权限策略参数不等于自动允许，也不授权新增未讨论的权限交互命令。
5. Session/Turn 跨请求分页不冻结快照、列表顺序等跨命令一致性细则。
6. 已有
   `serve/init`、Human 等待、短 UUID、URL/配置覆盖、AI 旧选项等的迁移方案；本 Idea 不暗自移除现有已发布行为。
7. 再做整份规格的一致性与视图验证，明确所有未决项后才能宣称定稿；需要生命周期验收时，另按 Silvermoon
   exact revision 提交，不从本次保存推断验收。

## 修订与撤回记录

| 先前提案                                | 后续明确结论                                           |
| --------------------------------------- | ------------------------------------------------------ |
| 三个使用角色，HTTP 独立角色/目标        | 只有 Agent 使用者，HTTP/本地只是访问方式，执行本地     |
| S2 历史回看为独立主场景                 | 是 S1 所生资源的衍生管理                               |
| Agent/workspace/模型/数据位置属单轮参数 | 分离为资源创建、配置与管理                             |
| 用户为 Agent 配置日常默认 Session       | 后来明确撤回，创建和对话分开                           |
| 会话创建传展示名                        | 默认无需命名；已有 Session 可改名，合入统一修改        |
| 配置查询另立操作、改名单独操作          | 分别并入详情、统一 set                                 |
| 自动过桥服务生命周期                    | 明确 start/status/stop，不隐式启动或空闲退出           |
| Human 文本 / AI JSON，手填 AI Turn ID   | 两入口统一 JSON、Turn ID 均自动生成                    |
| 复数组及 create/send/login 命名         | 单数资源与 ACP new/prompt/authenticate 对齐            |
| 创建只持久本地元数据                    | 为配置发现明确改为异步建立真实 ACP 会话，GET 仍不启动  |
| 模型逐轮参数、通用 token 限额           | 模型为支持的会话配置；无跨 Agent 通用 token 硬限额     |
| 认证方式用户默认                        | 来自实际 Agent 协商及公开流程步骤                      |
| set 使用批量 object                     | 用户明确恢复逐项设置；无批量/部分成功/名称最后写入语义 |

## 事实来源与验证边界

- 设计来源：2026-11-10 至 2026-11-11 的逐步讨论及明确“同意”。本文件保存结论与批准范围，不复制整段聊天或把临时工具结果当生命周期事件。
- 代码参考：[CLI](../../../../../../src/cli-core.ts)、
  [Agent](../../../../../../src/acp-agent.ts)、
  [历史存储](../../../../../../src/acp-store.ts)、
  [现行 CLI 文档](../../../../../../docs/CLI.md)。这些是现有实现证据，不是所有新设计已经实现的证明。
- 协议参考：[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)。已核实会话建立/恢复响应可含 configOptions，逐项 setter 返回配置，配置更新通知可推送新列表；没有独立通用 GET-config
  RPC。本次核对的是当时官方 schema，不保证本项目锁定 SDK 或每个 Agent 均支持。
- Task
  Engine 的本地服务 Spec 被用作已指定的生命周期参考；所需规则已归纳于需求文档，不依赖另一个工作目录的绝对路径读取。
- HTML 已做浏览器检查：44 个可调用章节与树锚点对应、示例 JSON、窄屏、打印、导航、分隔条键盘/指针缩放、折叠恢复及无 JS 导航。之后修订也核对相关字段和锚点；这些是**文档检查**，不是 CLI 实现测试。
- 独立 `cli-design`
  技能在当时设备未找到；未声称已调用，使用现有项目契约和指定参考形成候选，所有关键设计仍走显式确认。

## Idea 生命周期状态

仅创建 Idea、保存设计和进度，准备阶段继续由 Agent 侧持有。未写
`submitIdeal/acceptIdeal/submitInner/acceptInner/submitOuter/acceptOuter`，未把用户对章节的“同意”升级成整个 Ideal
World 的 exact-revision 验收。不请求当前尚未完成的完整设计验收。

## 本次归档验证

- 已把完整 HTML、需求模型与逐项确认状态纳入同一个 Ideal
  World，使用项目内相对链接。
- 本次结构检查通过：44 个可调用章节、112 个唯一 HTML
  ID、178 个命令代码块、97 个可解析 JSON 代码对象；文档相对链接与章节锚点有效。
- Implementation /
  Deployment 各三项步骤和三项标准，ledger 的 12 项镜像均未勾选；events 仅包含
  `setAlias`。
- 本次 `pnpm check`
  通过：格式、lint、类型检查、覆盖率、构建与包形状检查全部完成；15 个测试文件通过，271 项测试通过、1 项跳过。恢复缺失依赖使用既有 lockfile 与当前开发机镜像，未修改依赖清单或 lockfile。
- 上述检查证明归档和现有代码基线有效，不证明这份 CLI
  Redesign 已实现或已被整体验收。
