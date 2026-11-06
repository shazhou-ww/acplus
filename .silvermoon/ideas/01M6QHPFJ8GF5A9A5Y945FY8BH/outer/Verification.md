# 独立部署验证

## 当前门限结论

外部门限尚未通过，不能标记完成或提升为默认推荐。真实链路已验证多个正向及负向条件，但历史 Turn 身份恢复出现上游缺陷，随后 Ubuntu 的 SSH 连接中断，剩余验证受阻。所有 D-* 条目保持未勾选。

## 当前候选与已备妥的供应物

追加缺陷已在 fork 修复并提交
[softov/ahpd#250](https://github.com/softov/ahpd/pull/250)。协调者独立验证 687 个 SDK／ACP 测试通过、6 个既有测试跳过；合并最新 upstream 后，222 个聚焦测试以及 typecheck、boundary、完整 build 再次通过。该结果是本地回归证明，不是新构建的真实 Ubuntu 重验。

当前 AHPlex 源码基线为 `8ba0c0caf88d1af6bac150a60a7f1b9ea30c84ec`，重新执行
`pnpm check`
的 115 个测试及全部质量／包形状检查通过。driver、schema、示例及负向测试统一要求来源
`1d52d06c65ec1006d548bad7c477e032b9dc6782`，旧 Session-only 来源被明确拒绝；新实现 revision 已重新提交和接受，没有冒用旧 acceptance。

本地已构建下列未发布 tarball，尚未传送至失联的真实目标：

| 供应物                    | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| AHPlex 新候选             | `c5121216ef2c80f203ecb8ffc9e460ec2121ca55399dd0314a9139db26978909` |
| AHPD ACP `0.15.0-rc.1`    | `ec186ec0d35b2323086a36bbd24d4837771ab61eeeeda2a3187306aed06b77a1` |
| AHPD SDK `0.15.0-rc.1`    | `ebc9c2f16135980ebcc0504e07edc026a439f3c251e410364e3b803d8706ab91` |
| AHPD server `0.15.0-rc.1` | `d1430c52fd3684bf75e05424f322bd00f00ef6fd61056c3428b2d91bbf306bf0` |

必须同时部署匹配 SDK 与 ACP。缺失／不稳定 messageId，或旧记录缺少原生 anchor，不能据此自动恢复旧 caller
ID；新来源的完整 HTTP／CLI 重验仍待连接恢复。

## Fork 优先验证与上游暂停

用户已明确要求所有仓库均先在自己的 fork 验证，上游 PR 需另行确认。现有
[softov/ahpd#250](https://github.com/softov/ahpd/pull/250)
保留现状，后续没有更新其 head、评论或状态。已将本地验证过的
`1d52d06c65ec1006d548bad7c477e032b9dc6782` 非强制快进合入 `shazhou-ww/ahpd`
的 main，未推送 tag，也未触发或尝试 npm 发布；后续工作以 fork 为验证入口。

先前上游 CI 的 processes job 有一项 `computer-servercheck`
的 5000ms 超时，该 job 为 743 passed、1 failed、1
skipped。该日志不等于已证明是本补丁回归，也不能当作全 CI 通过；未修改无关超时阈值或对上游重跑检查。fork 尚未返回可确认的 CI 结果，真实 Ubuntu 门限仍因 SSH 不可达而未通过。

## 此前真实运行的对象

- AHPlex 源码：`edb8209c0db59fd6992fa3566124cf37847ff64f`；实现门限由协调者独立执行
  `pnpm check`，115 个测试通过，详见 [实现验证](inner/Verification.md)。
- 安装包 SHA-256：
  `bf5e006d38e0cb2aa738e6b04b21e95ab12ac92802b111a903828a00d7e129fb`。包内版本仍为
  `0.1.1-canary.20261105.1`，但这是未发布的本地候选，不等于 npm 上同版本的既有发布，也未创建新 release
  tag。
- 固定的 AHPD SDK／server／ACP： `0.15.0-rc.1`，来源提交
  `8c6f4645b90a05d47e43359565cb5697b011a43d`；
  [softov/ahpd#246](https://github.com/softov/ahpd/pull/246) 于
  `2026-11-06T04:51:23Z` 合并；此前观察到 11 项上游检查通过。
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
