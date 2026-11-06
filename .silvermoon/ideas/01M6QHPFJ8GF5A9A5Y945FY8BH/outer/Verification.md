# 独立部署验证

## 当前门限结论

下面记录的限定构建实机检查已全部通过，D-* 清单已完成；本文件提供检查证据，不自行代表 acceptance，最终生命周期决定以同一 idea 的事件记录为准。推荐仅适用于该确切 Linux／AHPD／Copilot 组合，不推导官方发行版、其他版本或平台已通过，也不授权 npm 发布或迁移原服务。

## 当前候选与已备妥的供应物

追加缺陷已在 fork 修复并提交
[softov/ahpd#250](https://github.com/softov/ahpd/pull/250)。协调者独立验证 687 个 SDK／ACP 测试通过、6 个既有测试跳过；合并最新 upstream 后，222 个聚焦测试以及 typecheck、boundary、完整 build 再次通过。该结果是本地回归证明，不是新构建的真实 Ubuntu 重验。

当前 AHPlex 源码基线为 `8ba0c0caf88d1af6bac150a60a7f1b9ea30c84ec`，重新执行
`pnpm check`
的 115 个测试及全部质量／包形状检查通过。driver、schema、示例及负向测试统一要求来源
`1d52d06c65ec1006d548bad7c477e032b9dc6782`，旧 Session-only 来源被明确拒绝；新实现 revision 已重新提交和接受，没有冒用旧 acceptance。

下列未发布 tarball 已传送至 Ubuntu，逐个校验 SHA-256 后安装到隔离目录：

| 供应物                    | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| AHPlex 新候选             | `c5121216ef2c80f203ecb8ffc9e460ec2121ca55399dd0314a9139db26978909` |
| AHPD ACP `0.15.0-rc.1`    | `ec186ec0d35b2323086a36bbd24d4837771ab61eeeeda2a3187306aed06b77a1` |
| AHPD SDK `0.15.0-rc.1`    | `ebc9c2f16135980ebcc0504e07edc026a439f3c251e410364e3b803d8706ab91` |
| AHPD server `0.15.0-rc.1` | `d1430c52fd3684bf75e05424f322bd00f00ef6fd61056c3428b2d91bbf306bf0` |

必须同时部署匹配 SDK 与 ACP。缺失／不稳定 messageId，或旧记录缺少原生 anchor，不能据此自动恢复旧 caller
ID；新来源的完整 HTTP／CLI 重验已完成，结果如下。

## 最终实机检查

用户确认 IP／port 未变且 VPN 已恢复后，协调者重新连接同一 Ubuntu。Node 为
`v24.22.2`，沿用原 SSH 配置，没有切换设备、关闭 host-key 检查或读取凭据。实际安装的是上述 R3 包与来源
`1d52d06c65ec1006d548bad7c477e032b9dc6782`
的匹配 SDK／server／ACP。后续 README 的条件推荐说明与世界证据变化没有修改任何运行时输入；相对
`8ba0c0c`
的源码、manifest、lockfile、编译配置、schema／示例差异为空，不把文档变化当作另一个已部署包。

### 完整 HTTP／CLI 链路

运行窗口：`2026-11-06T06:57:59.286Z` 至
`06:59:55.473Z`，结果为 passed，无 error 或 cleanupError。所有执行与控制操作经候选 AHPlex
HTTP／CLI，不以直接 AHP／ACP 调用替代。

- 停止主机时 GET Session 返回 503，不自动启动；并发 start 均成功。
- 原生设备 challenge 的真实链接／码经 API 到达客户端。没有重复浏览器授权；关闭服务取消未完成设备流程，10 个受跟踪进程均清理。
- 当前连接初次 reuse 如实未知；正常调用方发起真实 Turn 后，reuse 成功，没有应用隐式探测。读取旧历史不能恢复新连接的认证缓存。
- TTY 表格、显式 JSON、两个 Chat、多轮及准确取消／取消后续聊通过；活跃 Chat 并发提交与主机 stop 均返回冲突。
- 主链路 7 个 Turn 均为 native complete 且精确返回各自标记；取消的
  `4ab321b0-c981-4e49-a942-32c530d6c0d6` 为 cancelled。
- 关闭及重启时按 PID 与出生标识检查，分别清理 10／8／8 个受跟踪进程，未停止原服务。

| 资源              | 重启前后保持的原身份                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| Session           | `ahp-session:/a62f9392-0b8e-4511-9a5e-b966bd26ea96`                                     |
| 默认 Chat         | `ahp-chat://default/YWhwLXNlc3Npb246L2E2MmY5MzkyLTBiOGUtNDUxMS05YTVlLWI5NjZiZDI2ZWE5Ng` |
| 额外 Chat         | `ahp-chat:/61511a9e-2569-4b83-bc51-acc66c276c57`                                        |
| 默认 Chat 首 Turn | `a08b0acd-b22e-4429-86d7-98375f1ba149`                                                  |
| 额外 Chat 首 Turn | `d325f497-bcd8-4323-95d2-d7855c844c8f`                                                  |

### 两类重启与两个 Chat 的矩阵

补充窗口：`2026-11-06T07:04:02.646Z` 至
`07:05:09.988Z`，同一安装包、配置、数据目录与资源，passed，无 error 或 cleanupError。每种重启后，两项原 caller
Turn ID 的 GET 均返回 complete 与原答案；Session 及默认／额外 Chat 地址不变。API
Session 列表包含原 Session，两个 native backend
conversation 均未被重复列为独立 Session。

| 重启                              | Chat | 新 Turn 的精确 agent 回答           |
| --------------------------------- | ---- | ----------------------------------- |
| AHPlex 进程重新启动               | 默认 | `AHPLEX_AHPD_0715f582ef39d8bd`      |
| AHPlex 进程重新启动               | 额外 | `PEER_AHPLEX_AHPD_0715f582ef39d8bd` |
| AHPD stop／start，AHPlex 保持运行 | 默认 | `AHPLEX_AHPD_0715f582ef39d8bd`      |
| AHPD stop／start，AHPlex 保持运行 | 额外 | `PEER_AHPLEX_AHPD_0715f582ef39d8bd` |

四个新 Turn 均为 native
complete；询问记忆时未携带预期标记。补充检查结束后，8 个受跟踪进程清理成功。恢复指资源、历史及后续请求，不宣称正在运行的 Turn 可跨强杀或机器重启继续执行。

### 当前候选的 VS Code 兼容与最终清理

独立窗口：`2026-11-06T06:58:06.737Z` 至 `06:58:26.915Z`。同一 R3
AHPlex，短的独立数据根，原 VS Code executable／flags 和官方 GitHub
CLI 显式 reuse 约定，passed，无 error 或 cleanupError。真实 Turn
`833b0b12-1f69-4dac-a091-55f679e578ff` 返回 native complete，agent 回答精确为
`AHPLEX_VSCODE_COMPAT_ad9fdfc09257f622`；HTTP 与 CLI 对该 Turn 的读结果相同。6 个候选自有进程已清理。

三份当前检查合计 12 个真实 complete、1 个准确 cancelled。最终检查确认测试端口 4291／4292／19491 均无监听，已知测试根目录没有运行中的自有进程，原生 profile 的 config
mode 保持 0600。原 4280 服务 ready，providers 为 copilotcli／claude，没有替换其安装包、配置或登录 profile。

## Fork 优先验证与上游暂停

用户已明确要求所有仓库均先在自己的 fork 验证，上游 PR 需另行确认。现有
[softov/ahpd#250](https://github.com/softov/ahpd/pull/250)
保留现状，后续没有更新其 head、评论或状态。已将本地验证过的
`1d52d06c65ec1006d548bad7c477e032b9dc6782` 非强制快进合入 `shazhou-ww/ahpd`
的 main，未推送 tag，也未触发或尝试 npm 发布；后续工作以 fork 为验证入口。

先前上游 CI 的 processes job 有一项 `computer-servercheck`
的 5000ms 超时，该 job 为 743 passed、1 failed、1
skipped。该日志不等于已证明是本补丁回归，也不能当作全 CI 通过；未修改无关超时阈值或对上游重跑检查。fork 未返回可确认的全 CI 结果，本次限定构建的依据是固定源码自建、相关回归以及上述指定实机门限，不把它扩展成上游全项目／全部发行版已通过。

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

## 历史运行：旧来源的真实链路

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

## 历史问题：旧来源的重启 Turn 身份

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

## 历史问题：VS Code 短路径与断联

首次用候选 AHPlex、独立数据目录及原 VS
Code 配置尝试冷启动，未达到授权或真实 Turn 阶段。原生日志显示 Linux UNIX
socket 的路径超过
`SUN_LEN`，不是已完成的兼容证明。受管进程已清理，已准备较短的独立数据目录，未改动 driver 或原服务来规避问题。

后续远程操作链路发生 SSH 连接重置，执行阶段当时不可观测，曾暂判短路径任务未启动。恢复连接后读取到原结果：`2026-11-06T05:47:26.526Z`
至
`05:47:55.295Z`，passed，且没有 error／cleanupError，证明该暂判不准确；在此校正记录，不把旧结果替代当前 R3 的再次实测。

原后台 SSH 会话随后结束。恢复时确认 Ubuntu 已于 14:43 重启，旧原服务的 owner
PID 不存在，原端口及已知自有进程均未运行；仅移除已确认过期的单个 owner.lock，使用既有已安装
`0.1.1-canary.20261105.1`
与原 hosts 配置恢复服务，再显式执行原 github-reuse。原 host
ready、复用 succeeded，后续检查确认仍健康。没有通过替换全局包、删除 runtime/profile 目录或终止不明进程来恢复。
