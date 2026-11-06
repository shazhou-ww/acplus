# Deployment

本契约用于协调者独立外部验收。此前直接连接 AHPD 的成功不计作本 idea 的 AHPlex 验收；所有结果绑定实际源码、未发布安装包的摘要、配置及脱敏证据。此记录不授权发布 npm 版本或替换现有服务。

当前候选源码基线为 `8ba0c0caf88d1af6bac150a60a7f1b9ea30c84ec`，AHPD 必须使用
`1d52d06c65ec1006d548bad7c477e032b9dc6782` 构建的SDK／server／ACP
`0.15.0-rc.1`，Copilot CLI 使用 `1.0.106`。
[softov/ahpd#246](https://github.com/softov/ahpd/pull/246) 已合并，但还需要
[softov/ahpd#250](https://github.com/softov/ahpd/pull/250) 的 recorded
Turn 身份修复；不假定官方已发布匹配构建。此前 `edb8209`／`8c6f4645`
的真实运行只作为问题定位证据，不能替代新来源的完整重验。

本轮不要求用户再次完成浏览器授权：可以显式绑定此前由用户授权的独立实验 profile，由原生 CLI 读取自身存储，协调者及 AHPlex 不读取或复制 token。新设备流程只验证真实链接／设备码可经 AHPlex 到达客户端，随后关闭候选服务取消流程；不把该观察宣称为新的浏览器授权完成。当前连接初次复用未知是允许的，但不得伪报成功；后续调用方明确请求的真实执行可以建立执行授权，再验证显式 reuse。OAuth 认证与模型 entitlement、计费账号保证保持区分。

旧 VS Code 冒烟保持原有官方 GitHub CLI 私密 handoff 约定，由明确配置的
`github-cli`
reuse 方法处理凭据，协调者不接触 token。恢复身份检查使用在新构建下新建的 Session／Chat／Turn；缺失原生 messageId 或旧记录缺少 anchor 的历史不承诺追溯修复，也不通过内容或位置猜测身份。

## Steps

### D-S01: 准备隔离的 Ubuntu 候选部署

使用包含恢复修复的锁定 AHPD 构建、Copilot
CLI 和候选 AHPlex，记录版本与来源及安装包摘要。建立独立数据目录，使用新授权或显式指定的既有实验 profile，不直接读取、复制或默认复用其他部署的凭据；AHPD 链路不启动 VS
Code。

### D-S02: 验证 HTTP 与 CLI 完整链路

通过 AHPlex 观察真实原生登录 challenge，取消未完成的设备流程；显式复用已授权实验 profile 并在真实调用后验证 reuse。完成发现与创建 Session、创建普通 Chat、各 Chat 多轮执行、准确取消和取消后续聊；验证忙碌提交与停止保护。覆盖 TTY／JSON 行为，不以绕过 AHPlex 的 SDK 调用代替结果。

### D-S03: 验证重启连续性与旧后端兼容

分别重启 AHPlex 与 AHPD，验证固定数据目录下的原资源、原调用方 Turn
ID、历史和续聊。检查断连／中断没有重复提交，旧历史不恢复认证缓存；用候选 AHPlex 和独立数据目录执行原 VS
Code 配置的授权复用及真实 Turn 冒烟，而非只查询旧服务健康。结束后核对 PID 与进程出生标识，只清理实验自有进程并保存脱敏证据。

## Acceptance criteria

### D-AC01: 无 VS Code 的真实执行成功

证据显示实际启动的是 AHPD 与 Copilot
CLI，真实设备链接／码可经现有 HTTP／CLI 读取，未完成流程可被服务关闭清理。显式请求的真实 Copilot
Turn 使随后 reuse 验证成功；不发送隐式探测。两个 Chat 的原生终态及 agent 回答分别匹配调用方标记，精确取消后可在同 Chat 继续执行，TTY 表格与 JSON 输出正确。

### D-AC02: 原资源可跨两种重启续聊

记录重启前后的同一 Session、Chat 地址及原 Turn
ID 的可读取结果；分别重启 AHPlex、AHPD 后，新 Turn 在不提示预期答案的情况下正确回忆各 Chat 的不同标记，不出现重复底层会话行。旧历史不能使新连接的未知授权变成成功。对运行中 Turn 的中断明确报告，不承诺或模拟自动续执行。

### D-AC03: 现有部署与凭据边界保持

候选 AHPlex 的 VS
Code 授权与真实 Turn 冒烟正常，原有服务保持健康，未静默迁移或默认复用凭据；实验退出后无自有 daemon 或登录子进程遗留。验证材料不含 token、原始敏感登录输出或个人凭据；仅对已验证的锁定构建作 headless 推荐，不暗示通用官方版本已可用。
