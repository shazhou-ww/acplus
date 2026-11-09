# Deployment

最终发布与 Ubuntu 验收证据见 [Verification.md](Verification.md)。

## Steps

### D-S01: 发布并验证新的 Canary

用户已授权助手负责全部门限校验与审批，推进至 complete，并发布新版 Canary 后在 Ubuntu 设备验收。候选版本为 acplus@0.1.0-canary.20261109.3；若版本已占用或发布失败，必须确认实际注册表结果，选择新的未发布序号，不能移动或复用 tag。

完整检查通过并将发布候选同步到 main 后，在 GitHub
Actions 执行非发布诊断；校验通过才推送与 package.version 精确匹配的 release
tag。仅通过 OIDC 发布，随后用 Actions 验证 registry、canary/latest、provenance、安装后 CLI 和 import；不运行本地 npm
publish 或 registry 验证。

### D-S02: 验证 Ubuntu 本地生命周期

在授权的 Ubuntu 26.04.1 LTS 设备，以 Node 24.22.2 和 Copilot CLI
1.0.107 安装精确发布版本，使用新的私有验收目录及明确选择的已有授权 profile，不复制凭据或修改旧部署。安装使用用户允许的腾讯镜像，不因传播延迟重复发布。

验证无需手动 serve 的创建、真实执行、查询、空闲退出及再次启动。补充确定性 Agent 验证并发启动与长执行超过空闲阈值；记录实际时间、进程与持久化结果，而非引用源码测试代替安装验收。

### D-S03: 验证兼容模式与恢复边界

在同一独立安装环境验证显式常驻服务、显式 URL 和 ACPLUS_URL，以及取消、服务异常后的历史可读性和不重放。用不可用的 Agent 可执行文件证明离线历史不启动进程。检查测试所属进程及 data/profile 所有权释放，不停止或修改无关服务；记录实际支持的平台与 resume/load 边界。

## Acceptance criteria

### D-AC01: Canary 的发布与安装结果真实可验证

Actions 记录证明新版本已发布，canary 指向该版本、latest 仍为稳定版本，provenance 与安装后 CLI/import 验证通过。保留发布 commit/tag、诊断、发布、验证 run 链接；不能只凭 workflow 成功或取消推断 registry 状态。

### D-AC02: Ubuntu 安装后无需维护后台服务

Ubuntu 上精确新版本的真实 Copilot
Turn 返回预期标记并持久化终态，自动服务在实际空闲阈值后退出，历史仍可读，后续执行可再启动。独立安装的确定性探测证明并发只有一个写者，长执行不会被空闲退出打断。

### D-AC03: 兼容、恢复和隔离清理成立

安装验收转录证明显式 serve 不自动退出、指定 URL 不隐式起服务、取消或异常不伪造完成或自动重放；不可用 Agent 下查询仍可用。通过进程与锁检查证明没有测试所属孤儿，原部署未受影响。证据存于本世界支持文件，明确平台、制品与限制。
