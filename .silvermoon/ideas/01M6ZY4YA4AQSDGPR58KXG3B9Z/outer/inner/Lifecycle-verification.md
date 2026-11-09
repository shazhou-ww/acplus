# 本地服务生命周期：设计与验证

本文为 [Implementation.md](Implementation.md)
的主体世界证据，不改变已验收理想契约，不包含发布或 Ubuntu 部署结论。

## 决策与约束

### 只读历史不是服务接管

`cli.ts` 区分显式 `--url`/`ACPLUS_URL`
与本地选择；显式 URL 即使是 loopback 也不进入发现或启动分支。无 URL 的 sessions/turns
list/get 和 events list 从配置定位 `sessions.sqlite`，以 SQLite
readOnly 打开。配置解析不检查 Agent 文件存在、不读取 secret，不创建 profile、数据库或 writer
lock。

`Store` 原有行 guard、完整性、sequence/外键检查仍复用；只读初始化采用
`BEGIN`，不执行
`BEGIN IMMEDIATE`、迁移、Turn 对账或 auth 写入。公开 Session 投影、分页、cursor
scope、UUID、整数和 query 校验由 `acp-history.ts`
共同服务 HTTP 和 CLI。读取的 running/cancelling 仅为最后持久化观测；一次查询一致，多个命令/分页不是永久冻结快照。

### 唯一写者与可证明的发现

保留既有数据目录独占文件 lease，增加释放前的文件 identity/随机 owner 校验。真实路径统一别名；Windows 路径大小写归一。并发启动允许产生短暂竞争候选，但只有独占写者可初始化数据库并发布服务信息；失败候选的 IPC
`data_directory_locked` 表示等待真实写者，不表示执行失败或成功。

后台是同一安装包的 native detached Node CLI；不使用 shell、command-name
kill、外部进程管理器或新增依赖。stdio 与 caller 断开，仅启动 IPC 传递非敏感错误，ready 后断开；caller 退出不会持有服务 lifetime。

`service.json` 是原子发布的私有记录，包含 canonical dataDir、ephemeral loopback
URL 和随机实例密钥。Unix 验证当前 uid/owner-only 文件权限；Windows 通过
`whoami.exe` 与 `icacls.exe`
设置/验证只有当前用户的完整控制 ACL，拒绝 inherited/foreign
grants。发现需要随机 challenge 的 HMAC 正确匹配；端口返回 200、PID 存在、回显字段都不是身份凭据。请求以时间戳随机 nonce 的 HMAC 签名，拒绝重放/过期签名；不向 HTTP 对端发送实例密钥。内部协议不增加 public
exports/OpenAPI/SDK facade。

启动截止为 15000
ms，显式区分 spawn、子进程过早退出、配置/凭据失败、发现损坏/权限失败和 readiness
timeout。IPC 错误与 child
exit 是异步的：循环入口及每次可能 spawn 前都检查终结性失败，保证失败后不会再创建候选写者、打开数据库并意外对账。回归测试同时检查只 spawn 一次和缺失 owner 的 cancel 前后数据库 bytes 一致。既有 stale/foreign
writer/profile
lease 不依 PID 或端口猜测清除；异常 ownership 仍须单独处理，不能冒充恢复或取消。

### 空闲不是 Session 完成

默认 grace 为 **30000 ms**；启动服务的本地命令可设置 `--idle-grace-ms N`，范围
**100..86400000**。复用不会修改现有配置/grace。显式 `serve` 和公共
`start(config)` 保持常驻。

最多每 100 ms 检查一次；在途 HTTP handler 和 response、Service job、Agent
RPC/prompt、登录流程、可观测/不明后台活动都会禁止退出并刷新 quiet-time 起点。caller 断开不等于 handler 完成。

空闲关闭先同步封闭 admission，再 drain 已接纳请求。job 的 Turn 终态和事件已提交后才清理 Agent、Store 和自己的发现记录，最后释放 data/profile
ownership。新请求竞争会得到明确拒绝或连接错误，不隐式重放 POST；lost
response 必须查历史对账。新服务不能代替失踪 owner 证明取消，离线 cancel 即使看到 running 也报错。

正常空闲退出后再次启动沿用 Store 的 error/unknown 对账与 ACP load/resume；replay
events 保持 Session 来源，不重新发送历史 prompt。持久化 unknown 保留并阻止后续 same-Session
dispatch；不是空闲清理的“完成”证据。

## 本地验证

环境为 Windows、项目已有依赖。全部测试 scratch 位于项目内 UUID 目录并在结束清理；无需包安装或 registry/publish 调用。

重点测试：

- `test/auto-lifecycle.test.ts`：HTTP/Store/CLI
  shape、cursor/过滤/validation；文件 bytes/mtime/mode 不变；缺失/坏库/旧新 schema/坏行；Agent/secret 不可用；五个并发 native
  caller 唯一写者；caller 退出后服务仍活跃；不同数据目录；显式 URL 不启动、serve 常驻且可复用；1500
  ms grace 下 HOLD 超过 2500
  ms 不退出；真实取消、终态/事件先提交、退出重启/load；缺失 owner 的 persisted
  running 不被改写；初始化凭据失败清理；登录长流程；unknown 不重放；HTTP
  caller 断开但已接纳 handler 仍提交。
- `test/local-service.test.ts`：私有 detached/IPC 启动参数、HMAC
  readiness、伪造 listener/错误响应、spawn/error/early-exit、竞争失败和 bounded
  startup timeout；不盗取 stale ownership。
- `test/acp-cli.test.ts`：本地读写选择、短 grace 配置、取消禁止 startup、ACPLUS_URL 优先、URL-only
  health/agents、managed child 配置与 IPC；原 CLI 路由/输入/选项继续覆盖。
- 既有 Agent/Store/service/login/profile 测试继续约束取消、后台未知活动、凭据隔离、unknown 与 resume/load。

已执行针对性命令：

```powershell
pnpm --config.verifyDepsBeforeRun=false lint
pnpm --config.verifyDepsBeforeRun=false typecheck
pnpm --config.verifyDepsBeforeRun=false test -- test\acp-cli.test.ts test\auto-lifecycle.test.ts test\local-service.test.ts
```

lint/typecheck 均通过，三个文件 **30/30** 测试通过。最终 runtime component
gates：

```powershell
pnpm --config.verifyDepsBeforeRun=false test:coverage
pnpm --config.verifyDepsBeforeRun=false build
pnpm --config.verifyDepsBeforeRun=false lint:package
pnpm --config.verifyDepsBeforeRun=false test -- test\auto-lifecycle.test.ts --disableConsoleIntercept
```

- coverage：**12 个文件通过，188 passed / 1
  skipped**（既有平台条件跳过）；statements **95.61%**、branches
  **91.84%**、functions **94.92%**、lines **96.72%**，原四项 90% 门槛通过。
- build、publint 和 `Public CLI entry verified` 全部通过；exports map/files
  allowlist 未改。
- 无 console interception 的进程测试：**12/12 passed**；配置 1500 ms
  grace，最后创建返回并读取 owner 后至 lease 释放实测 **2127
  ms**；观察到真实 cancelled 后至释放 **2186 ms**。数值包含 timer 粒度及 native
  cleanup 延迟，并不是承诺精确 1500 ms 强杀。HOLD 在 running 后额外持续 **2500
  ms** 仍保留 writer；source handler 断开 caller 后额外 **700 ms**（grace 300
  ms）仍保留已接纳工作。
- 原样执行 `pnpm --config.verifyDepsBeforeRun=false check`
  **未通过**：仅在 format:check 阶段报 parent-owned `outer/Deployment.md`
  未符合 Prettier。未修改该文件或绕过格式门禁；须 parent 格式化自己的变更后重新运行完整命令，`I-AC03`
  因此仍未勾选。上述 component 成功不是完整 check 成功的替代，也不是实施接受。

不改 gate
mode，不把仓库测试当作安装/Ubuntu 验收。历史 npm 验证来源不挪用为本次结果。

## 父级门限校验与委托审批

用户明确授权实现交给一个 subagent，父级负责所有门限校验和审批，推进至 complete，发布新 Canary 并在 Ubuntu 验证，不逐门询问。授权不替代实际证据，仍提交并接受准确修订，不设置 waived 门禁。

父级审阅了只读 Store、共享历史路由、CLI 分流、native 启动与私有发现、HTTP
admission/drain、Agent/Service 活动判定和 ownership 释放的实际变更。修正一处新选项边界：`--idle-grace-ms`
仅接受于能启动服务的 sessions create 和 turns
start，历史读与 cancel 在执行或访问存储前拒绝；增加独立回归测试。

父级格式化 Deployment 初版后重新运行完整
`pnpm --config.verifyDepsBeforeRun=false check`，在最终选项修正后再次通过：12 个测试文件，**189
passed / 1 skipped**；statements **95.61%**、branches **91.85%**、functions
**94.92%**、lines
**96.72%**。format、lint、严格 typecheck、build、publint 与安装入口校验全部通过；没有降低四项 90% 门槛或移除既有条件跳过。针对 CLI 的回归为
**14/14 passed**。

该结果解除前述首次完整 check 的格式阻塞，I-AC03 已满足。Canary 发布、Ubuntu 独立安装与真实 Agent 执行仍由 Outer
World 单独提供证据，未以本地测试宣称 deployment 已完成。

## 独立安装验收入口

发布、安装包 provenance 与 Ubuntu 证据由 Outer
World 负责，本节仅提供复现语法。既有 YAML 可复用；明确 unset
`ACPLUS_URL`，避免误测 HTTP 模式：

```bash
unset ACPLUS_URL
acplus sessions create --config /absolute/private/config.yaml \
  --idle-grace-ms 1500 --agent copilot --working-directory /absolute/workspace
acplus turns start --config /absolute/private/config.yaml \
  --session SESSION-UUID --turn CALLER-TURN-UUID --text-file /absolute/prompt.txt
acplus turns get --config /absolute/private/config.yaml \
  --session SESSION-UUID --turn CALLER-TURN-UUID
acplus events list --config /absolute/private/config.yaml \
  --session SESSION-UUID --turn CALLER-TURN-UUID --after 0 --limit 100
```

grace 必须给启动新实例的 create 或 start；后续 start 复用时不必重复。需要改变 grace 时先等待旧实例正常退出。只读 get/list 不能续租，所以可在持续轮询历史时观察
`owner.lock`/`service.json`
被正常释放。短 grace 只用于加速生命周期验收；正常默认 30 秒。

显式认证和 health/agents 继续用 `acplus serve --config FILE` 与其输出的
`--url BASE/v2`；不把认证目录、账户、token、发现密钥或未完成真实工作当作可销毁 fixture。README 保留历史 package-verification 链接和来源，不将其重新标注为本次发布证明。
