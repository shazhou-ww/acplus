# Deployment

本契约为外部验收初版。此前直接连接 AHPD 的成功不计作本 idea 的 AHPlex 验收；所有结果需绑定实际构建、配置及可复核证据。此记录不授权发布 npm 版本或替换现有服务。

## Steps

### D-S01: 准备隔离的 Ubuntu 候选部署

使用包含恢复修复的锁定 AHPD 构建、Copilot CLI 和候选 AHPlex，记录版本与来源。建立独立数据目录及显式授权的登录 profile，不读取或复制其他部署的凭据；不启动 VS Code。

### D-S02: 验证 HTTP 与 CLI 完整链路

通过 AHPlex 完成登录、发现与创建 Session、创建普通 Chat、各 Chat 多轮执行、准确取消和取消后续聊。覆盖 TTY／JSON 行为及需要交互的可见状态，不以绕过 AHPlex 的 SDK 调用代替结果。

### D-S03: 验证重启连续性与旧后端兼容

分别重启 AHPlex 与 AHPD，验证固定数据目录下的原资源、历史和续聊。检查断连／中断没有重复提交；执行已有 VS Code 后端的兼容冒烟，结束后只停止实验自有进程并保存脱敏证据。

## Acceptance criteria

### D-AC01: 无 VS Code 的真实执行成功

证据显示实际启动的是 AHPD 与 Copilot CLI，AHPlex 的 HTTP／CLI 登录及两个 Chat 的执行均成功。终态与 agent 实际回答同时匹配调用方标记，精确取消后可在同 Chat 继续执行。

### D-AC02: 原资源可跨两种重启续聊

记录重启前后的同一 Session、Chat 地址及可读取历史；分别重启 AHPlex、AHPD 后，新 Turn 在不提示预期答案的情况下正确回忆各 Chat 的不同标记，不出现重复底层会话行。对运行中 Turn 的中断明确报告，不承诺或模拟自动续执行。

### D-AC03: 现有部署与凭据边界保持

VS Code 配置及原有服务的冒烟结果仍正常，未静默迁移或复用凭据；实验退出后无自有 daemon 遗留。验证材料不含 token、原始敏感登录输出或个人凭据；新增推荐配置以这些证据为依据。
