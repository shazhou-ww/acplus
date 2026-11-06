# 实现验证

## 候选范围

- `src/ahpd.ts`：内置 owned
  HostDriver，供应锁定 runtime；固定数据、配置、会话及显式 profile；私有 transport
  token；原有 SDK 连接／重连；仅按静态 URI 配置 workspace
  trust 并等待本连接确认。
- `src/copilot-cli.ts`：原生 `login --device-code` 的 Linux PTY 交互和显式
  `reuse`。只公开设备链接、码和存储确认，不输出 token、原始日志或退出码推导的登录成功。
- `src/extensions.ts`、`authentication.ts`、`native.ts`：窄范围可选的连接配置和 host-owned 原生认证 hook；保留原有认证校验、连接代际、超时及不确定 Turn 规则。
- `src/processes.ts`：单独启用受控 stdin
  pipe 和可信静态错误分类；不引入 shell 透传、全局进程查杀或另一个 supervisor。
- `docs/ahpd.example.json`、配置 schema 和 README／配置／CLI／扩展文档：独立候选部署及明确限制。未改动 public
  exports、files allowlist、依赖、包版本或现有部署。

## 已检查的原生行为及供应边界

2026-11-06 在当前设备检查官方 Copilot CLI `1.0.100` 的 `--version`、
`login --help` 和 `help`；支持 `login --device-code`，但没有公开的
`auth status`／`whoami` 验证子命令。部署目标为已实验验证的 Copilot
`1.0.106`；其 Linux 无 keychain 存储确认来自现有实验观察，不能由本次合成测试当作新的真实浏览器授权证明。需要 util-linux
`/usr/bin/script`，禁止 transcript 录制，原生 AHPD 首轮不支持 Windows／macOS；既有 VS
Code 支持不变。

已查阅 AHPD 修复提交 `8c6f4645b90a05d47e43359565cb5697b011a43d` 的 server
configuration／run、agent-acp preset／plugin、SDK agent records 以及 server
records 实现。使用 `config/ahpd/agents/copilot.json`、`sessions: "file"`、显式
`--config-file`／`--no-cwd` 和外部供应的 plugin；不是复制或修改 AHPD 源码。
`runtimeRevision` 是必须由操作者核对的来源约束，不是运行时二进制校验。
[softov/ahpd#246](https://github.com/softov/ahpd/pull/246)
不假定已发布，不能替换为浮动分支或原 `0.14.0`。

协调者对首次冻结候选的真实 Ubuntu 检查在认证前失败，未通过验收：生成的
`paths: []` 违反锁定 CLI 对 `--no-cwd` 的要求。已对照该版本
`commands/options.ts` 确认，修订生成同一显式可信目录对应的非空 paths，且
`hostTools:false`。这不是已完成真实部署的证明，必须由协调者重新执行 gate。

官方[认证文档](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
给出的完整成功行是
`Signed in successfully as LOGIN.`；本实现只在同一次明确 command／profile 的设备流程中，显式 plaintext 存储确认之后，收到完整换行成功行、账号匹配
`loginAccount`
且退出 0 时接纳。缺失预期账号或输出不匹配仍未知，不能从退出码或链接／设备码单独提升状态；OAuth 认证不等于模型 entitlement。

已查阅锁定 SDK 的 `host/root.ts`：账号公开在
`config.values["ahpd.copilotAccount"]`，由原生 account 观察提供，非用户可写配置。ACP
`connection.ts` 仅在 agent 广告 `authStatus`
时接纳 account 更新；当前 Copilot 可以没有该能力，缺失必须未知。另一个可验证路径是明确调用方发起的 Turn：记录当前连接已准入的准确 Chat／Turn／Session
provider，且只在原生 complete 和非空 agent
markdown 后接纳执行授权。它不是自动探测，也不是历史完成状态的再解释。

## 回归命令与证明

目标测试：`pnpm exec vitest run test\ahpd.test.ts`。

- 通过真实被跟踪的合成 Node 子进程与官方 SDK
  transport 验证启动合并、惰性启动、固定路径、trust 确认、重连不另启动以及停止后的目录复用。
- 通过协议合成主机与 HTTP 验证原资源 ID、精确 Turn
  ID、busy、取消、取消后续聊和断连不重放；未将合成主机宣称为真实 AHPD 持久化证明。
- 合成原生 CLI 子进程覆盖分块设备交互、显式允许／拒绝 plaintext、失败／超大输出脱敏、取消、超时及不支持平台。
- 显式 reuse 在无证据时保持未知；有本连接真实 provider
  Turn 后可验证。公开 account 状态、完整 receipt、错误账号、缺失／残缺／提前成功输出、失败退出和 auth-required 竞争均有测试；历史／user-only／取消不能提升状态，挑战使旧 ticket 与缓存失效。
- 全路径不读取 profile token、不执行 AHP
  authenticate、不发探测 Turn。原生 provider 必须广告准确 resource，不能借
  `$host` 绕过检查。
- 公共配置 schema 对示例及不支持 runtime revision 进行正负验证。

修订候选的 `pnpm check` 于 2026-11-06 通过：12 个测试文件、115 个测试，aggregate
statements 95.88%、branches 92.37%、functions 95.77%、lines
96.79%。命令包含 format、lint、typecheck、aggregate 90%
coverage、build 和 publint。首次候选结果不能替代本次修订证明；测试通过不代表真实 Ubuntu 或浏览器登录已完成。

`silvermoon check --worktree --audience agent`
同样通过；未 stage、commit、push 或 append 事件，所有 D-* 条目保持未勾选。

首次完整命令在既有已接受 `Idea.md` 与非本阶段所有的 `Deployment.md`
格式上失败；未重写这些世界契约，而在 `.prettierignore` 仅排除此 idea 的已接受
`ideal/Idea.md` 和非本阶段所有的 `outer/Deployment.md`
两条准确路径，保留其内容和 revision；不豁免其他 idea。实施契约及本证据仍受 format 检查。

## 协调者集成入口

在独立 Ubuntu 候选上使用构建后的 `dist/cli.js serve --config` 和
`docs/ahpd.example.json`。示例服务端口为 4291，AHPD 端口为 19491，provider 为
`copilot`，resource 为
`https://api.github.com/repos`，示例仅使用通用占位路径，工作目录为
`file:///srv/ahplex/workspace`。所有路径和 `loginAccount`
必须由部署者核对，尤其是实验 profile 的显式授权；不要覆盖现有 4280 服务。新授权测试改用新的
`copilotProfileDir`；既有实验授权可选择
`reuse-native-login`，而不是读取或复制凭据。可在新 profile 的 `native-login`
观察设备 challenge 后关闭候选服务取消，不声称完成授权。

无当前证据时 `failed`／`auth_verification_unsupported`
的含义是验证未知。实际 Turn 由调用者明确发起；终态须与 agent
markdown 标记同时验证，然后显式重试 reuse。该证据只在本连接／挑战 epoch 有效；重启后必须重新观察，不由旧历史恢复授权缓存。后续跨服务／daemon 重启、两 Chat 不同上下文及原 caller
Turn ID 的真实证明，以及旧 VS Code 部署冒烟，均由协调者按 Deployment 门禁记录。

## 已知限制与恢复

- 当前 CLI 没有独立状态命令，且可能不报告原生 account；没有有效 receipt 或当前连接明确执行证明时保持未知。不使用隐式 Turn 补齐，也不把 OAuth 当作 entitlement。
- 首轮 AHPD driver 限于独立 Linux runtime，登录要求安装 util-linux
  script；未静默安装依赖或创建跨平台包装。
- 固定端口必须专用；连接失败不会附加到其他 daemon，启动失败会清理自有进程。
- 未处理强杀后的自动锁接管；操作者必须先核对锁 PID、自有进程和 token 文件，再显式恢复。固定 AHPD 会话数据及原生 profile 不能删除。
- 权限／输入阻塞仍按现有 MVP 暴露，不能自动批准；跨重启恢复的是资源／历史，不是中断执行或认证流程。

## 协调者实现门限复核

首次候选未被接受：协调者在真实 Ubuntu 复现 daemon 因空 paths 与 `--no-cwd`
退出，同时退回了无条件未知验证、将 provider 登录绑定为 `$host`、默认开启 host
tools、机器专用示例路径及跨所有 idea 的 formatter 豁免。修订候选逐项修正；协调者审阅了进程、认证、连接代际、资源身份及公开配置／文档变更。

协调者独立执行 `pnpm check` 通过：12 个文件、115 个测试，statements
95.88%、branches 92.37%、functions 95.77%、lines
96.79%，format、lint、typecheck、build 与 publint 同时通过。测试证据包含未知和负向路径、当前连接实际请求的执行证明、完整账号匹配 receipt、认证挑战／重连竞争，以及原 VS
Code 回归。该复核仅支持实现门限，不把合成 receipt 测试当作新的真实浏览器授权，不提前接受部署契约。
