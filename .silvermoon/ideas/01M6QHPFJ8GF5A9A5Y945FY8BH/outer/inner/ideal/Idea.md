# 接入 AHPD 作为 headless 后端

## 问题

当前内置后端依赖 VS Code Agent Host，headless 部署及 provider 授权链路较重。独立实验已验证 AHPD 与 Copilot CLI 的可行性，但尚未接入 AHPlex。

## 结果

用户无需启动 VS Code，即可通过 AHPlex 登录并使用 Copilot CLI；服务重启后仍能通过原 Session、Chat 地址读取历史并续聊。验收后将 AHPD 作为 headless 场景的推荐后端，保留 VS Code 选项。

## 边界

- AHPlex 保持薄网关定位，不实现 ACP、agent runtime 或任务队列。
- 保持现有 API、原生资源身份及 VS Code 配置兼容；不静默迁移旧部署或复用其他账号凭据。
- 恢复会话不等于恢复正在执行的 Turn；中断必须可见，不自动重放提交。

## 验收标准

- 无 VS Code 的环境可通过 AHPlex 完成原生登录、多 Chat 和多轮执行。
- AHPlex 或 AHPD 重启后，原地址、历史及上下文仍可使用。
- 既有 VS Code 后端继续工作；主机按配置显式或按需启动，不无条件同时启动两种后端。
