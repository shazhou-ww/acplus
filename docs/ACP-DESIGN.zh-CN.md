# 基于 ACP 的 HTTP 服务设计

[English](ACP-DESIGN.md) | 简体中文

状态：仓库中已实现的设计，不代表 npm 已发布。独立入口验证后，正常入口已切换为直接 ACP
`/v2`；已发布的旧软件包保持不变，实施与部署证据另行记录。

## Silvermoon 设计工作

构想的
[设计决策支持文档](../.silvermoon/ideas/01M6ZA9HR2B1A5H9QYVRN0CKX0/outer/inner/ideal/Design-decisions.md)
说明产品选择与边界，并链接到对应的项目详细设计文档。

本次方向由仓库中的
[ACP HTTP idea](../.silvermoon/ideas/01M6ZA9HR2B1A5H9QYVRN0CKX0/outer/inner/ideal/Idea.md)
推进。理想世界契约定义结果与边界；本文记录详细设计，但文档本身不替代生命周期验收或检查证据。主体世界已将确认的细节导出到本文、英文版、根级需求与约束，以及 HTTP/OpenAPI、CLI 和配置文档；各份契约必须一致，并区分仓库实现与已发布软件包。

## 已确认的决策

- 当前软件包、命令和 GitHub 仓库名统一为
  `acplus`；不可变验收历史中的旧名字不代表运行时别名。
- 直接连接支持 ACP 的 Agent。目标执行链路中不再包含 AHP、AHPD 或 VS Code Agent
  Host。
- 引入 `/v2`，不保留 `/v1` 兼容，也不静默转换旧配置、资源 URI 或历史记录。
- 创建 Session 时只写入本地记录。首次执行 Turn 时，才启动配置中的 Agent 并创建其 ACP
  Session。
- 持久保存用户与 Agent 的消息、工具调用及结果、执行观测记录。不保存认证密钥或原始登录交互记录。
- 转接显式 Agent 认证流程，单独缓存脱敏认证观测；凭据仍保存在 Agent 专用 profile 中。
- 所有 HTTP
  GET 操作都读取本地记录，绝不启动 Agent，也不触发认证、加载、恢复或后端查询。
- 保持单一 ESM 软件包、现有包名和公共导出及发布文件布局。发布与版本选择另行决策，不属于本次设计。

这些决策替代原有的 AHP 资源模型与在线读取约束。目标需求与设计约束分别见
[REQUIREMENTS.md](REQUIREMENTS.md) 和
[DESIGN-INVARIANTS.md](../DESIGN-INVARIANTS.md)。

## 整体架构

```text
HTTP / CLI 客户端
        |
HTTP /v2 + 请求校验
        |
Session 服务 ----------------------> SQLite 存储
        |                              |
        | 执行请求                     +-- 本地历史 / 状态查询
        v
Agent 运行时管理器
        |
服务拥有的进程 + 基于 stdio 的 ACP SDK
        |
配置中的 Agent，例如 copilot --acp
```

使用官方 `@agentclientprotocol/sdk`
处理消息封装和协议类型，不手写 JSON-RPC。首先接入已验证的 Copilot CLI。其他 ACP
Agent 必须分别完成初始化、认证、工具权限策略和重启测试；CLI 能运行或声称支持 ACP，都不足以证明集成可用。

本地存储已采用 `node:sqlite`：在私有 `dataDir`
下使用一个数据库，由单一服务写入，支持显式 schema 版本检查、事务和索引分页。不需要 ORM 或外部数据库服务，较早未发布的 schema
1 开发数据库被明确拒绝。

## 配置与进程归属

运维配置使用 YAML。CLI 默认配置为 `~/.acplus/acplus.yaml`，数据为
`~/.acplus/state`，Copilot profile 为 `~/.acplus/copilot-profile`。 `init`
只自动创建默认配置父目录，权限受限且不覆盖已有文件；显式指定的其他父目录必须已存在。
`serve` 未指定 `--config`
时读取固定用户路径，不扫描当前目录或迁移旧文件。配置、数据及 profile 的显式参数分别优先；配置内相对路径仍以配置目录为基准。HTTP 请求与响应仍使用 JSON。

引入 `schemaVersion: 2`，新运行时明确拒绝旧版 schema
1。保留 HTTP 监听配置、服务实例标识、私有数据根目录和单一所有者锁；将 `hosts`
替换为静态 `agents` 注册表。

每个 Agent 配置声明：

- 稳定的 `id`、显示名称、原生可执行文件、参数数组和启动超时。
- 专用的凭据及状态 profile，以及显式的环境变量引用。
- 允许的工作区根目录、配置中的 MCP 服务和工具权限策略。
- 空闲超时，以及必要时针对该 Agent 的认证适配器。

请求只能选择 `agentId`
和允许根目录内的工作目录。不能提交可执行文件路径、Shell 命令、环境变量覆盖、凭据 profile、MCP 服务或任意 provider 配置。对工作区路径进行规范化，并在边界校验中考虑符号链接。配置和工作区校验可以访问本地文件系统，但不得因此启动 Agent。

每个配置中的 Agent 对应一个由本服务拥有的 ACP 进程；Agent 支持时，该进程可以承载多个 Session。合并并发启动请求。初始调度策略是每个 Agent 同时只接受一个 prompt，忙碌时返回
`agent_busy`，避免假设 ACP 普遍保证跨 Session 并发。同时，每个 Session 最多有一个活跃 Turn。不引入任务队列，也不为每个 HTTP 读取或请求单独创建进程。

不同 Agent 配置使用不同的 profile，可以独立运行。不得自动发现或复制其他应用的 profile，拒绝在多个活跃运行时之间共享 profile。目录隔离和工具权限策略都不等于操作系统沙箱。

## 资源模型

```text
配置中的 Agent
  Session（本地持久身份）
    Turn（本地持久身份）
    Events（有序的本地观测记录）
```

ACP
Session 本身就是一个会话。不引入人为构造的 Chat，也不假装 ACP 提供 AHP 的 defaultChat、fork 或 multipleChats 语义。

- `agentId` 标识静态配置，而不是正在运行的进程。
- `sessionId`
  是服务生成的 UUID，在创建后端之前就存在，并在 HTTP 连接变化、服务重启和 Agent 重启后保持稳定。
- `turnId` 是调用方生成的 UUID，在一个 Session 内唯一。
- `backendSessionId` 是 ACP 返回的不透明 ID，与绑定信息一起保存在内部。
- 运行时代次是临时信息，用于隔离旧连接的回调。后端绑定还记录 Agent/profile 身份，避免配置变更后意外恢复到另一个会话。

提交、查询和取消均使用同一个本地 Turn ID。它不冒充 ACP 原生 Turn ID：ACP
prompt 请求由客户端关联，而 Session 更新通常只标识所属的 ACP Session。

## 持久记录

会话内容使用三张表，另设独立的认证观测表：

| 表         | 重要字段                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| `sessions` | 本地 ID、Agent ID、规范化的工作目录、后端绑定、创建及更新时间、历史覆盖情况            |
| `turns`    | Session/Turn ID、提交的 prompt、观测状态、停止原因或错误、最后持久化的事件序号、时间戳 |
| `events`   | Session ID、可选的 Turn ID、单调递增序号、事件类型、经过过滤的类型化内容、观测时间     |

保证 `(sessionId, turnId)` 和 `(sessionId, sequence)`
唯一。每个 Event 必须属于一个 Session，可选地关联一个 Turn；非空的 Turn 引用必须指向同一个 Session 内的 Turn，通过复合外键保证。为按 Turn 过滤的事件查询建立
`(sessionId, turnId, sequence)`
索引。提交的用户消息只保存一次，不把 ACP 回传的同一消息分块再追加为另一条用户消息。工具 ID 的作用域是所属 Session/Turn 或历史重放上下文；增量
`tool_call_update`
用于更新派生的工具视图。保留消息边界与内容块类型，不把所有通知粗暴拼接成一个字符串。

保存选定的 ACP 更新，以及规范化的消息与工具视图。默认排除原始认证响应、环境变量完整内容、传输凭据、原始进程标准错误、原始登录交互记录和隐藏推理内容。入库及 HTTP 输出前对已知密钥脱敏，包括工具参数和结果中的密钥。Agent 的任意输出仍可能包含敏感工作区内容，不能声称通用脱敏能够识别所有秘密。数据库访问、备份及未来的保留或删除策略也必须按此风险处理。

脱敏认证观测单独保存在 `agent_auth`
表中，不进入 Session/Turn/Events。只持久保存 Agent/profile 身份、脱敏方法描述、最近认证结果、证据来源、验证时间、已知过期时间和失效原因。设备验证码、待完成登录交互数据及含环境变量值的原始方法描述仅短期保存在内存中，不另外复制 Agent
token。服务重启后，已持久观测只代表过期的历史证据。

本地记录准确表达的是“服务观察到了什么”，而不是“Agent 曾经做过的一切”。返回
`observedAt`、`lastSequence` 和覆盖情况：在已知观测区间内使用
`complete`、`partial` 或
`unknown`。只有最终响应之前的全部更新都已持久提交，才能宣称该 Turn 的记录完整。一个 Turn 已完成，并不能证明此前导入或断连过的 Session 的全部历史完整。

## 执行流程与崩溃边界

1. 校验请求、工作区策略、Session 身份和重复 ID。
2. 串行处理 Session 与 Agent 的执行准入。接受另一个 prompt 前，先拒绝忙碌或结果尚未确认的工作。
3. 返回 HTTP 202 之前，提交 Turn、用户消息和 `accepted`
   观测记录。这表示请求已持久接收，不表示后端已经执行。
4. 准备 Agent 进程，完成 ACP 协商，使用其配置中的 profile 认证，然后创建或恢复后端 Session。
5. 调用 `session/prompt` 前先持久化 `dispatching`，确认已派发后记录
   `running`。按到达顺序持久保存通知。
6. prompt 响应到达后，先提交此前所有更新、停止原因和终态观测，再对外暴露终态。

观测状态包括 `accepted`、`starting`、`dispatching`、`running`、
`cancelling`、`complete`、`cancelled`、`error` 和
`unknown`。单独保留 ACP 停止原因；不能因为 RPC 正常返回，就把 token 限制或请求被拒绝表示成用户所需结果已经成功产生。完成只意味着执行结束，不意味着用户任务已达成。

服务崩溃后，如果持久记录是 `accepted` 或
`starting`，且没有已持久化的派发意图，可以将其终结为
`error: dispatch_not_started`，不得稍后隐式执行。已有派发意图但缺乏可信终态证据的记录转为
`unknown`，即便 Agent 进程已经不存在。SQLite 与 ACP 进程之间不存在跨两者的原子事务。

重复提交同一 ID 和相同 prompt 时，返回已有记录，不再次派发；输入改变则返回
`409 turn_id_conflict`。结果未知时，既不自动重放，也不在同一 Session 中派发另一个 prompt。客户端断开不会取消已经持久接收的 Turn。

存储故障时，停止接受新工作，显式报告故障，并尝试在有限时间内取消活跃 prompt。更新尚未提交时不得发布完成，也不能一边运行一边静默丢弃通知。使用有界写入缓冲和背压；缓冲溢出必须标记历史缺口及未知观测状态，不能伪造完整历史。

## Agent 重启与历史重放

读取本地历史不需要恢复后端；继续执行已有 Session 则需要：

- 如果绑定的 ACP Session 仍连接到当前运行时，直接复用。
- 重启后，优先使用 Agent 已声明的
  `sessionCapabilities.resume`，在不重放历史的情况下重新连接。
- 否则，仅在声明 `loadSession` 时调用 `session/load`。
- 两者都不支持时，返回
  `409 session_resume_unsupported`，但保留只读历史访问。后端 Session 不存在则返回独立的
  `session_backend_unavailable` 错误。
- 绝不创建替代后端 Session，再把缓存文本提交进去，冒充原始模型及工具上下文已恢复。

加载时可能重放用户、Agent 和工具历史。标记加载阶段，将重放暂存在独立区域，不混入实时 Turn 事件。不能按文本哈希去重任意消息，因为内容相同也可能是真实的重复消息。有稳定后端消息 ID 时据此对账；否则保留独立快照，明确来源与覆盖情况，既不追加到已经观测到的实时记录，也不凭空建立本地 Turn 关联。

加载后端本身不能确认被中断 prompt 的结果。ACP 没有通用的精确 Turn 查询机制。只有经过验证、针对具体 Agent 的证据才能消除
`unknown`；否则该 Session 仍禁止继续执行。创建另一个 Session 必须是调用方的显式操作，不能当作恢复。

## 取消、回调与空闲进程

取消操作指向精确的本地 Session/Turn 及其当前运行时绑定。尚未派发的 Turn 可以在准入锁保护下直接完成本地取消。已经派发的 Turn 发送
`session/cancel`，但在待处理 prompt 返回取消证据之前保持
`cancelling`。如果之后正常完成，仍如实记录正常完成。取消通知或 HTTP
202 都不是完成证据。

ACP 回调是运行时的一部分，不能将其错误视为可忽略项：

- 只有完整处理函数及其配置策略都已实现，才声明文件系统或终端能力。校验目录边界与输出大小限制。
- `session/request_permission`
  按显式允许或拒绝策略处理；默认拒绝，并记录拒绝结果。初版 `/v2`
  不承诺交互式权限审批或任意用户提问处理。
- 不支持的交互请求必须明确失败，不能挂起 prompt 或自动批准。
- 保存已支持的消息和工具内容；不支持的内容应显式体现为记录覆盖限制，而不是静默丢弃。

不能因为下一个 Turn 正在执行，就将重放、无法关联或迟到的后台通知归给它。这类事件可以使用
`turnId: null`。只有经过测试的 Agent 专用映射，才能使用协商后的消息身份或活跃状态扩展。

空闲退出要求不存在待处理的 prompt、加载、登录、回调或已知后台工作。Copilot 活跃状态扩展可以提供更强的证据；通用 ACP 并不保证能观察到所有已脱离当前执行的后台工作。无法确认静止状态时，保留运行时并报告该情况，而不是盲目触发空闲计时退出。服务优雅退出时关闭所属连接和进程，并将无可信终态的记录保留为不确定。

## HTTP /v2 契约

所有 GET 结果都来自本地。读取操作不附带 `live=true`
后端回退、隐藏同步或自动认证。

| 方法 | 路径                                                             | 行为                                                      |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| GET  | `/v2/health`                                                     | HTTP 和存储就绪检查，不启动 Agent                         |
| GET  | `/v2/agents`                                                     | 静态 Agent 选项、带观测时间的能力缓存、当前本地运行时状态 |
| GET  | `/v2/agents/{agentId}/auth`                                      | 本地脱敏方法、最近认证观测及正在进行的登录进度            |
| POST | `/v2/agents/{agentId}/auth`                                      | 显式启动已声明或已配置的认证方法，返回 202                |
| POST | `/v2/agents/{agentId}/auth/input`                                | 回答精确的白名单非敏感登录步骤，返回 202                  |
| POST | `/v2/agents/{agentId}/auth/logout`                               | 显式请求已支持的上游退出，返回 202                        |
| POST | `/v2/sessions`                                                   | 创建本地 Session，返回 201                                |
| GET  | `/v2/sessions?agentId=...&cursor=...&limit=...`                  | 分页查询本地 Session 目录                                 |
| GET  | `/v2/sessions/{sessionId}`                                       | 本地元数据、后端可用性证据、历史覆盖情况                  |
| GET  | `/v2/sessions/{sessionId}/events?turnId=...&after=...&limit=...` | 有序的持久消息与工具事件，可按 Turn 过滤                  |
| POST | `/v2/sessions/{sessionId}/turns`                                 | 使用调用方 Turn ID 持久接收请求，返回 202                 |
| GET  | `/v2/sessions/{sessionId}/turns?cursor=...&limit=...`            | 查询本地 Turn 目录                                        |
| GET  | `/v2/sessions/{sessionId}/turns/{turnId}`                        | 已持久化的观测记录与响应投影                              |
| POST | `/v2/sessions/{sessionId}/turns/{turnId}/cancel`                 | 请求精确取消，返回 202                                    |

创建请求：`{"agentId":"copilot","workingDirectory":"/srv/work/project"}`。提交请求：`{"turnId":"<uuid>","text":"Explain the entry point"}`。路径中使用本地 ID，而不是后端 ACP
ID。响应包含本地身份与观测元数据。事件分页默认每页 100 条，上限 1,000 条，游标基于已提交的事件序号，保证不重复、不跳过。这些 API 常量已实现并通过分页测试。

事件查询支持可选的 `turnId` 过滤参数：

- 不传：返回整个 Session 的事件，包括 `turnId: null` 的事件。
- 传入：只返回所选 Session 中关联该 Turn 的事件，不包含未归属 Turn 的事件。
- `turnId`
  格式非法、为空或重复传入时返回 400。格式正确但该 Session 中不存在的 Turn
  ID 返回 404，仅属于其他 Session 的 Turn ID 也返回 404。
- Turn 已存在但没有匹配事件时，返回带观测覆盖信息的空页，不报 Turn 不存在。
- 先过滤，再应用分页条数限制。 `after`
  仍表示 Session 全局已提交事件序号的排他游标，不对过滤后的事件重新编号。下一页使用本页最后返回的序号，并保持相同过滤条件。过滤后序号不连续是正常现象，不代表数据丢失。

例如，`/v2/sessions/{sessionId}/events?turnId={turnId}&after=42&limit=100`
查询 Session 序号 42 之后匹配该 Turn 的下一页事件。这仍然是纯本地查询，不启动或访问 Agent，也不需要另设一个嵌套在 Turn 下的事件接口。

未知本地 ID 返回 404。已知但不完整的记录返回其覆盖情况，而不是误导性的 404 或空的完整历史。忙碌、冲突、恢复失败和执行结果未知等情况使用可操作的 409 错误；启动、协议和存储故障使用明确的错误码，不能返回类似成功的结果。

外部网关继续负责入站身份、授权与 TLS。服务必须仅监听回环地址，或位于受保护的私有网络。历史持久化不会授予调用方访问其他用户工作区的权限。

## 认证与 CLI

### 显式认证转接

Agent 认证属于运维配置，不要求普通执行请求携带凭据。通过受运维权限保护的 HTTP
auth 接口及目标 `agents login`
CLI 暴露流程；外部网关必须限制认证接口访问，并授权调用方使用指定 Agent。缓存上游登录状态不等于授予 HTTP 调用方使用该账号的权限。

通过 `initialize.authMethods` 发现认证方法。对于 `agent`
类型（包括省略 type 的情况），只向 ACP `authenticate` 提交已声明的
`methodId`。对于 `terminal` 类型，只有完整交互启动器已实现时才声明
`auth.terminal`：使用配置中的可执行文件及经过批准的方法参数、环境变量启动登录进程，成功后重新连接并初始化 ACP。绝不能将 terminal 方法传给
`authenticate`，也不能让方法描述选择另一程序，或静默改变程序查找、解释器启动、代理及 TLS 信任。

ACP 未统一规定终端设备码输出。Copilot 原生登录命令、链接与验证码提取、存储同意和账号验证仍由专用适配器实现；ACP 未声明所需流程时，也可显式配置该适配器的公开方法。不引入通用 OAuth 应用或 AHP
token 交接，不隐藏调用模型探测登录，也不在 Turn 内自动发起交互登录。

POST auth 接受
`{"methodId":"<已声明或已配置的方法ID>"}`，可以显式启动已停止的 Agent 来协商认证方法。每个 Agent/profile 最多一个认证操作；活跃或结果不明的执行会阻止冲突的登录或退出，而不是关闭其他调用方的 Session。认证流程有明确期限，只展示公开设备链接与验证码，或配置中的非敏感输入步骤。POST
auth/input 接受 `stepId` 和白名单
`values`，例如明文存储的显式同意；它不是通用密码或 token 接收接口。只有声明
`agentCapabilities.auth.logout`，或已配置并测试原生退出适配器时，才执行上游退出；否则返回
`409 agent_logout_unsupported`。不能把清理本地缓存当作上游退出成功。ACP 不统一保证退出后已有 Session 的行为，必须明确处理差异。

### 认证观测缓存

凭据保留在 Agent 专用 profile 或显式配置的凭据库中。缓存按 Agent/profile 身份和当前运行时代次划分，不按 Session 划分，也不作为多个 HTTP 用户共享的登录授权。只持久保存脱敏的历史投影。

Agent 已停止或不可访问时，GET
auth 仍只读本地。认证观测与进行中的登录流程分开表达：

- `lastKnownStatus`：`authenticated`、`required` 或 `unknown`。
- `verifiedAt`、已知 `expiresAt`（未知为 `null`）及证据来源。
- `freshness`：`current`、`stale` 或 `unknown`，以及失效原因。
- 脱敏的方法 ID、名称和类型，以及可选的公开登录进度。

`current`
只表示观测仍属于当前在线运行时与 profile，且尚无已知失效；不保证外部尚未撤销凭据。ACP 未提供过期或刷新保证时不得凭空推断，发现认证方法也不是登录成功证据。

运行时重启或重连、profile 或账号配置变化、`auth_required`、显式退出及已知过期都会使当前证据失效。旧观测只以
`stale`
保留，不能将历史成功当作当前授权。退出请求派发前即让当前缓存失效，即使后续结果不明也不能继续沿用；后续显式认证成功可以建立新证据。

缓存失效不等于必须重新让用户登录：先使用配置中的已保存凭据，并尊重 Agent 的真实响应。存在已测试的非付费验证机制时可使用，否则在出现合法协议或真实执行证据前保持未知。不能因数据库中有历史成功，就跳过后端认证检查或认定凭据有效。缺少登录返回可操作的
`agent_auth_required`，与网络、存储故障和认证情况未知区分；登录成功不代表付费执行权限。

保留 `serve`、本地以独占方式创建配置的 `init`，以及薄层 HTTP 客户端命令，但围绕
`agents`、`sessions`、`turns` 和 `events`
重新设计。认证配置在服务部署环境中执行，并与 profile 使用串行协调。移除旧
`hosts`、`chats` 和 AHP
auth-input 命令，不静默转换它们。初期使用轮询及分页事件查询即可，首版不要求 SSE。

## 迁移与实施顺序

### 先建立独立入口，验证后直接替换

在同一个软件包中为 ACP 实现建立独立入口，开发阶段先使用 `node dist/acp-cli.js`
启动。暂不改变旧 `ahplex` 命令、公共 `start` 导出或 `/v1`
请求的行为。新入口使用自己的 schema
2 配置、数据库及数据根目录、profile 和端口。这种临时共存只是切换过程的隔离，不是向前或向后兼容：新入口只接受
`/v2`，不转换旧 ID 或旧配置。

新入口通过自动测试、已安装构建产物测试和隔离的真实 Agent 测试之前，旧入口继续正常工作。验证范围包括离线读取、认证缓存失效、重启、取消和故障处理。验证通过后，将正常 CLI 与库入口直接替换为 ACP 实现，删除旧运行时、路由、适配器、仅服务于已移除行为的测试及依赖；临时入口不再需要时一并删除。不发布第二个软件包，也不长期维护两套执行链路。最终再对已提升为正式入口的安装包进行验收。

| 阶段 | 工作内容                                                            | 完成门槛                                                         |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | `/v2` OpenAPI、schema 2、ID/状态/错误类型、ACP SDK 选型             | 契约测试与已确认需求一致                                         |
| 2    | SQLite schema/迁移、准入日志、事件投影与读取路由                    | 重启及全部离线 GET 测试通过，且不启动 Agent                      |
| 3    | 服务拥有的 stdio ACP 运行时、能力协商、回调、Copilot 登录适配器     | 模拟运行时的生命周期、认证和策略测试通过；并发启动只创建一个进程 |
| 4    | 延迟创建后端 Session、prompt/事件持久化、精确取消                   | 经 `/v2` 的真实 Copilot prompt 与工具事件采集通过                |
| 5    | 按能力支持 resume/load、隔离重放、崩溃及 unknown 处理、空闲生命周期 | 离线读取、重启、恢复和故障注入验收通过                           |
| 6    | 提升已验证的独立入口，更新 CLI/库/文档，移除旧运行时及依赖          | 软件包检查及正式入口的已安装软件包验收通过                       |

阶段 2 和 3 依赖阶段 1，可以独立开发。阶段 4 依赖两者，阶段 5 依赖阶段 4，最终切换必须通过此前所有验收门槛。使用独立私有部署根目录和端口开展验收，不修改正在运行的旧部署，也不自动导入其凭据。

语义适用时，复用请求校验、安全错误处理、进程归属管理、数据根目录锁、密钥引用及脱敏、独占配置创建、原生设备登录解析。替换
`NativeHost`、`MultiHostClient`、AHP 传输、AHPD/VS
Code 适配器、原生 URI 路由和 AHP 认证提交。不能仅为了保留无用代码而维持双协议抽象。

已将验证通过的独立入口提升为正常入口，移除 `@microsoft/agent-host-protocol`
和旧运行时，使用 `@agentclientprotocol/sdk` 的稳定 wire v1 入口。公共类型通过
`src/index.ts`
导出，保留 exports 映射和发布文件白名单。旧 AHP 验证证据仍为历史记录，不能当作 ACP 验收。

## 验收门槛

1. 服务启动及每个 GET 操作都产生零次 Agent 启动和零次 ACP 请求。
2. 创建的 Session 在服务重启后仍存在，尚无后端 ID，且没有启动过 Agent。
3. 同一 Agent 的并发首次执行恰好启动一个进程；忙碌提交在派发前被拒绝，不额外发送后端 prompt。
4. 真实 Copilot
   Turn 精确返回要求的标记；终态可见前，此前所有消息和工具事件均已持久保存。
5. 停止 Agent 进程并故意使其可执行文件不可用后，重启服务仍能查询本地目录、详情、Turn 和事件。
6. 每页条数为 1、100 和 1,000 时，无论是否按 Turn 过滤，事件分页都保持顺序和身份，无重复或跳过。交错的其他 Turn 事件和无 Turn 归属的事件不能混入过滤结果，也不占用匹配结果的分页条数。非法过滤条件、条数和游标必须明确失败；未知或跨 Session 的 Turn
   ID 返回 404，已存在但无事件的 Turn 返回空页。
7. 相同 Turn
   ID 不会派发两次；修改 prompt 则发生冲突。在派发前后注入故障，都不得静默重放工作。
8. 已声明的 resume/load 恢复同一个后端 Session；未声明能力时明确失败，缓存历史仍可读取。
9. 重放不会重复实时记录，也不将旧事件归到新 Turn；内容相同但真实重复的消息仍保持独立。
10. 取消等待真实终态证据；存储、进程和传输故障如实保留部分记录与不确定结果。
11. 日志、存储的事件内容以及 HTTP/CLI 输出都不包含已知凭据值，包括工具结果测试；权限拒绝结果可见。
12. 停止和重启不遗留服务所属的孤儿进程或临时传输密钥，未知后台活跃状态绝不被视为空闲。
13. 认证 GET 在重启后也产生零次 ACP 请求。重启、profile 变化、退出、认证挑战和已知过期都会使缓存成功失效。不持久保存或返回 token、原始登录输出；过期观测不能屏蔽
    `auth_required`、触发付费探测或授予入站 HTTP 权限。agent 与 terminal 认证采用不同流程，不支持的上游退出明确失败。

## 协议参考

- [ACP 初始化与能力协商](https://agentclientprotocol.com/protocol/initialization)
- [ACP Session 创建、加载与恢复](https://agentclientprotocol.com/protocol/session-setup)
- [ACP prompt 流程与更新](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP 认证方法与退出](https://agentclientprotocol.com/protocol/v1/authentication.md)

实施以所选 SDK 和实际协商能力为准，不能假设每个 Agent 都具有这些持续演进的参考文档中的全部功能。
