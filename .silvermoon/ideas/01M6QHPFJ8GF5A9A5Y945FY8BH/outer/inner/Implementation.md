# Implementation

本候选复用现有 Host adapter 与官方 Microsoft AHP SDK，不添加 AHPD
SDK/runtime 依赖或自行实现 ACP。实现与可复核证据见
[Verification.md](Verification.md)；独立 daemon 实验不能代替 AHPlex 全链路验收，真实 Ubuntu 和现有 VS
Code 部署效果由协调者另行验收。

前置依赖：[softov/ahpd#246](https://github.com/softov/ahpd/pull/246)
修复了底层会话 ID 与 AHP Session
ID 不同导致的重启恢复问题，已用修改后构建在 Ubuntu 验证。接入时锁定已验证修复构建或包含该修复的官方版本，不跟随浮动分支；必要时另行确定临时构建的供应方式。

## Steps

### I-S01: 接入受管 AHPD 主机

新增内置 `ahpd` adapter、静态选项 schema 和隔离 Ubuntu 示例，首轮只接 Copilot
CLI。通过配置显式供应锁定的 AHPD 可执行文件与 ACP 插件；不安装、打包或更新第二套 runtime。主机拥有固定的 HOME／XDG／配置／会话目录及 transport
token 路径，原生 profile 必须显式指定；允许直接绑定操作者授权的实验 profile，但不读取或复制其凭据。首轮原生 AHPD 运行仅支持独立 Linux 环境，其他平台明确拒绝启动，避免误用共享 keychain。

启动与重连继续由现有 `NativeHost`／`MultiHostClient`
管理。只在 AHP 协议初始化、有效 root
snapshot 和精确匹配本连接的显式 workspace-trust 配置确认后标记就绪；仅信任静态配置中的 file
URI，不能从 API 工作目录自动扩张信任。重连不启动进程；退出与失败清理仅使用现有自有进程服务。

daemon 的 `paths` 必须由同一显式可信目录转换而来，满足锁定 CLI 的 `--no-cwd`
约束；不能发送空路径列表，也不能自动扩张为 API 请求目录。原生 agent record 显式
`hostTools:false`。启动只公开已知错误的静态分类，不输出原始 stderr、私有路径或凭据。

### I-S02: 桥接原生登录交互

提供 `copilot-cli` 的 `login` 和 `reuse`
方法；路径和环境来自同一 Host，不允许认证绑定另指定 profile。使用已检查的官方
`copilot login --device-code` 行为，Linux util-linux `script` 提供真实终端并以
`/dev/null` 禁止记录原始终端输出。只公开严格解析的链接／设备码以及
`confirmPlaintextStorage` 单项输入；仅显式 `"yes"` 才写入
`y`，拒绝或超时不会自动批准。

TTY 与 JSON 使用原有 `auth begin/get/input`
接口，不透传原始输出或任意终端输入。认证绑定必须是当前连接真实广告的
`copilot`／`https://api.github.com/repos`，不能借 `$host`
绕过 provider 认证边界。非付费验证首先读取公开
`config.values["ahpd.copilotAccount"]`；支持的原生 signedIn 可验证，signedOut 拒绝，当前 Copilot 不报告 ACP
authStatus 时不能由缺失值推断登录。

新登录只接受同一明确 command／profile 中，显式存储确认后出现的完整官方 OAuth 成功行、匹配
`loginAccount`
的账号及成功退出三者共同构成的 receipt。仅退出、仅设备 challenge、残缺／提前成功行、账号不符或失败退出均不能验证。此证明是 OAuth 身份／存储，不声称 Copilot
entitlement。另可由调用者主动发起的真实 provider
Turn，在同一连接确认原生 complete 且具有 agent
markdown 后建立执行授权；只对本连接已准入、可关联原 Session
provider 的 Turn 建立 ticket。历史、user-only、取消、失败或不确定结果不能提升认证。reuse 在没有证据时保持未知；有本连接有效证据时才可 succeeded。挑战 epoch、连接变更、停止及新登录使缓存失效，不使用隐式付费探测，也不重放执行。保留现有 VS
Code 验证逻辑。

### I-S03: 补齐恢复与兼容验收

复用现有 HTTP、CLI 与原生 Session／Chat／Turn 路径，增加 AHPD
adapter 的 HTTP／SDK 回归，以及固定目录、连接恢复、原资源 ID、准确取消、忙碌冲突与无自动重放测试。执行完整
`pnpm check`，保持 exports、files allowlist、版本及既有 VS
Code 行为。README、配置／CLI／内部扩展文档说明供应边界、真实登录限制和手动恢复要求；推荐配置切换仍以外部验收为前提，不迁移旧配置。

## Acceptance criteria

### I-AC01: 生命周期与配置有回归证明

`test/ahpd.test.ts`
与现有生命周期／进程测试证明并发启动合并、按需启动、协议和 trust 确认、超时清理及仅清理自有进程；重连不创建重复 daemon，固定配置／profile 路径不随重启改变。文档示例通过公开配置 schema 验证，既有配置测试保持通过。

### I-AC02: 登录不泄露或误报

合成子进程测试覆盖正向完整 receipt 与 expected-account 匹配，以及仅退出、残缺／提前输出、错误账号、失败退出、挑战竞争、取消、超时、无 keychain 的显式允许／拒绝及脱敏。公开 account 状态、真实已准入 provider
Turn、初始未知和挑战后的负向验证均有回归；不读取／传递 profile
token，不隐式提交 Turn，不由历史或 user-only 状态伪造授权。保留 VS
Code 登录语义。此证明不声称完成真实浏览器授权或提供 entitlement；真实设备 challenge 观察、授权实验 profile 的实际执行与复用由部署阶段独立记录。

### I-AC03: 原生资源与质量门槛保持

HTTP／官方 SDK 合成集成回归证明原 Session、Chat、Turn 身份及能力语义保持，断连不自动重放，既有不确定结果不能伪装成终态；`pnpm check`
通过且 aggregate
coverage 四项均不低于 90%，公共 exports 与 files 约束未变。真实 AHPD 文件恢复、跨重启上下文、Ubuntu
HTTP／CLI 与 VS Code 冒烟由部署契约另行验证，合成测试不能替代这些结果。
