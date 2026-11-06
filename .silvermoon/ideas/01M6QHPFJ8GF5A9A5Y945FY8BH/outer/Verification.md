# 独立部署验证

## 当前门限结论

外部门限尚未通过，不能标记完成或提升为默认推荐。真实链路已验证多个正向及负向条件，但历史 Turn 身份恢复出现上游缺陷，随后 Ubuntu 的 SSH 连接中断，剩余验证受阻。所有 D-* 条目保持未勾选。

## 验证对象

- AHPlex 源码：`edb8209c0db59fd6992fa3566124cf37847ff64f`；实现门限由协调者独立执行
  `pnpm check`，115 个测试通过，详见 [实现验证](inner/Verification.md)。
- 安装包 SHA-256：
  `bf5e006d38e0cb2aa738e6b04b21e95ab12ac92802b111a903828a00d7e129fb`。包内版本仍为
  `0.1.1-canary.20261105.1`，但这是未发布的本地候选，不等于 npm 上同版本的既有发布，也未创建新 release
  tag。
- 固定的 AHPD SDK／server／ACP： `0.15.0-rc.1`，来源提交
  `8c6f4645b90a05d47e43359565cb5697b011a43d`；
  [softov/ahpd#246](https://github.com/softov/ahpd/pull/246)
  在观察时尚未合并，11 项上游检查已通过。
- Copilot CLI：`1.0.106`；Ubuntu
  Node：`v24.22.2`。全链路检查使用独立 AHPlex 数据目录、回环端口及显式指定的既有实验 profile，不读取或复制 provider
  token，也不替换原服务。

## 已观察的真实 AHPlex 链路

2026-11-06，协调者仅经候选安装包的 HTTP／CLI 执行以下检查，不以直接 AHP／ACP 调用代替这些结果：

- 停止状态读取 Session 返回 503，没有启动主机；两个并发 start 均被接受并就绪。
- 原生登录的真实 GitHub 链接／设备码经 `auth get`
  到达客户端。没有再次完成浏览器授权；关闭服务取消未完成流程，核对 PID 与出生标识后，8 个受跟踪进程均已退出。
- 新连接的初次 reuse 如实返回
  `auth_verification_unsupported`，未把未知状态写作成功；调用方明确请求的真实 Turn 完成后，再次 reuse 成功，应用未发送隐式探测 Turn。
- TTY 主机表格与显式 JSON 客户端输出均通过。
- 一个 Session 中两个 Chat 分别完成真实执行，同 Chat 第二轮保留上下文。
- 活跃 Chat 的并发提交和主机 stop 均被拒绝；准确取消指定 Turn 后，同 Chat 可继续完成后续请求。

| 真实执行             | 原生终态 | agent 回答                          |
| -------------------- | -------- | ----------------------------------- |
| 默认 Chat 首轮       | complete | `AHPLEX_AHPD_bdadf15a5b068737`      |
| 额外 Chat 首轮       | complete | `PEER_AHPLEX_AHPD_bdadf15a5b068737` |
| 默认 Chat 第二轮     | complete | `AHPLEX_AHPD_bdadf15a5b068737`      |
| 取消后默认 Chat 续聊 | complete | `AHPLEX_AHPD_bdadf15a5b068737`      |

预期标记由调用方预先确定；询问记忆的后续请求未携带预期答案。取消的原生 Turn
ID 为 `4a963383-7f1c-42cf-ba45-be6a592c0ac4`，观测终态为 cancelled。

## 未通过：重启后的历史 Turn 身份

AHPlex 与其受管 daemon 退出后，受跟踪进程已清理。重新启动后，原 Session 与两个原 Chat 地址仍可发现。但查询首个已完成 Turn
`6285ecce-4115-4bbf-a9d8-49c973d25ee6` 返回404
`turn_not_found`，因此未继续声称原 Turn 历史及整个恢复门限通过。

独立诊断确认：AHPD 的 caller／transcript 映射文件确实存在，但 ACP
`replayedTurns` 使用随机 UUID，不能与原 caller
ID 匹配。不存在已找到的配置开关可以补齐。把 404 改成 503 只能表达不确定性，不能恢复身份；AHPlex 不增加私有 alias 或 durable
Turn store 来掩盖问题。

原生 Copilot 更新包含
`agent_message_chunk.messageId`，该字段在两个独立重放进程中保持稳定；协调者另行明确请求的一次原生诊断 Turn 也提供了相同可重放的 message
ID，并返回预定标记。此直接 ACP 调用只用于定位上游缺陷，不计作 AHPlex 验收。后续供应修复必须在上游正确关联 native
message ID 与 caller Turn ID，然后重新锁定构建、同步契约并完整重跑。

## 尚未通过：候选 VS Code 兼容冒烟

首次用候选 AHPlex、独立数据目录及原 VS
Code 配置尝试冷启动，未达到授权或真实 Turn 阶段。原生日志显示 Linux UNIX
socket 的路径超过
`SUN_LEN`，不是已完成的兼容证明。受管进程已清理，已准备较短的独立数据目录，未改动 driver 或原服务来规避问题。

重试在安装包／配置传输阶段遭遇 SSH 连接重置，随后对同一已配置目标的一次连接检查也超时；短路径的候选服务尚未启动。原后台 SSH 会话随后结束。最后可达时原服务为 ready；不据此推断失联后的远端服务状态，也没有执行停止原服务的命令。连接恢复前不能完成此项、最终清理复核或部署验收。
