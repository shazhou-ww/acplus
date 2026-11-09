# 最终安装产物与现实世界验收

本文件支持
[Deployment.md](Deployment.md)。所有下列探测都在最终部署契约同步后执行，使用安装后的正常
`ahplex` 命令，不是旧 AHPD 链路或源码内存模拟。

## 产物与环境

- 源码提交：`79c69a7c31e371a1dd4da6eb6e9ea3ff466a526a`。
- 本地开发 tarball：`ahplex@0.1.1-canary.20261106.1`。
- SHA-256：`3b1ff6a05a31e8750c3a0cf4fde4f7255165bef54fb03ac165ec8e0c4fada55a`，本地与远端值相同。
- Node 24.22.2、Copilot CLI 1.0.107、独立 SQLite schema 2
  dataDir，显式已授权的专用 profile。
- 普通 `.bin/ahplex --version` 精确输出 HTTP `/v2`、ACP wire
  v1 标识，帮助可运行。
- 安装依赖包含 SDK 2.4.0，不含 Microsoft AHP SDK；npm 安装审计报告 0 个漏洞。
- 未执行 npm 发布或推送 release tag；版本号只标识开发包，不冒充新的注册表版本。

运行时源码的 [CI](https://github.com/shazhou-ww/ahplex/actions/runs/42581174632)
成功，覆盖 Node 22.13.0 与 Node 24.11.1。

## D-AC01：真实正式入口可用

- Session：`75af48df-1008-4237-9a4c-6e78e23d9c7e`。
- Turn：`7ac61e92-21e6-4d68-9014-54af9f3e266d`。
- 精确响应 `DEPLOY_OK`，状态 `complete`。
- 重复同 ID/原文返回已有完成记录，不再次执行。
- 真实文件读取 Turn：`6218bf40-038f-4fe2-8a5d-4f106ee5a78d`，正确读取测试文件内容，记录 2 个工具调用/更新事件。
- 对该 Turn 每页 1 条读取 11 条过滤事件，序号递增、无重复、无其他 Turn 混入。
- 另一 Session 的取消 Turn： `a6a972a8-c6f8-4445-aea5-65700d4e0e18`，真实确认
  `state=cancelled`、`stopReason=cancelled`。

## D-AC02：离线历史仍可读

停止所属 Agent 和 HTTP 服务后，使用同一数据库、不可用的 Agent 可执行文件，由普通命令重新启动 HTTP：

- 仍读取精确 `DEPLOY_OK` 和完成状态。
- 仍读取对应工具 Turn 的 11 条过滤事件，所属 ID 不变。
- Session 目录、详情、Turn 和事件查询可用。
- Agent 子进程数为 0。
- 认证观测为 `stale`，未沿用历史成功为当前证据。

## D-AC03：同 Session 恢复与清理

恢复原配置并再次启动普通命令：

- 同一个 Session 的新 Turn： `930fe4cb-54e5-46f5-8dc6-afb2bd1b2ea3`。
- 精确返回 `DEPLOY_RESUMED`，状态 `complete`。
- 当前 Turn 10 条事件不包含重放；Session 的 11 条重放事件独立标为
  `replay`，不建立伪造的当前 Turn 关联。
- 最终停止全部所属测试服务及其 Agent，验证原 PID 和直接子进程均消失。
- dataDir 所有者锁及 profile 租约均已删除。
- 数据库权限 `600`，专用 profile 目录权限 `700`。
- 原先独立 `/v1` 服务保持可用，未被修改或停止。
- 历史、配置和已授权 profile 保留；凭据及原始登录输出不进入证据。

## 检查与审批

当前任务用户明确授权助手负责全部门限检查和审批，无需逐门询问。本验收基于上述实际 HTTP、进程、文件权限、哈希与 CI 结果，不是把授权本身当作成功证据。构想已被接受，实施通过已授权的 waived 门禁；现实世界仍提交准确修订，并在所有结果完成后记录针对同一修订的验收事件。

本次只交付经过验证的仓库实现及本地安装产物。没有声称已经更新 npm 上的旧包，也没有自动迁移或替换另一个正在运行的部署。
