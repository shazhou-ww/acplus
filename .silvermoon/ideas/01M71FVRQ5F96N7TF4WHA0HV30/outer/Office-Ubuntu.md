# office-ubuntu 部署与无上下文首用验收

## 结论与范围

2026-11-10，独立 subagent 首次使用通过。它没有读取项目设计、源码、测试、README 或其他会话，仅凭公开帮助完成真实 Copilot 只读任务及历史清理。主 Agent 已复核结构化输出，并将回复的 UTF-8
SHA-256 与设备上标记文件的实际字节比较，一致。

本证据对应 [部署契约](./Deployment.md)
的 D-S01..03 和 D-AC01..03。执行前，该契约已同步到 primary；当时部署修订为
`4aa896f68f2a8b538c1966aa5bf9ea8999d41ce4`，实现已通过委托验收。本文件记录外部结果，不改变验收目标或实现。

## 候选来源与隔离安装

| 项目           | 实际结果                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 源码提交       | `f8fc694af2ae5074548ec46d0a5c189e41a88edd`                                                                                      |
| 实现验收提交   | `e1dcaddce5b15da373b67e30f48a81503d992f9b`                                                                                      |
| 包版本         | `0.1.0-canary.20261110.2`，本地候选，不是新发布                                                                                 |
| 包 SHA-256     | `fe8c845b3e9126b37ac6db0dfd31942c357e52812cf26cd593a3bea38b3d0e9e`                                                              |
| 主机           | `office-ubuntu`，Linux                                                                                                          |
| Node.js / pnpm | `v24.22.2` / `11.22.0`                                                                                                          |
| 消费安装       | 在独立目录对候选 tgz 执行 `npm install --prefix consumer --ignore-scripts --no-audit --no-fund ./candidate.tgz`，9 个包安装成功 |
| 入口           | `consumer/node_modules/.bin/acplus` 与 `consumer/node_modules/.bin/acplus-ai`                                                   |
| 版本验证       | 两个实际入口均输出正确名称、上述版本、HTTP `/v2` 和 ACP v1                                                                      |

测试根目录记为：

```text
$TEST_ROOT = $HOME/.local/state/acplus-dual-cli-01M71FVRQ5F96N7TF4WHA0HV30
$TEST_WORKSPACE = $TEST_ROOT/workspace
```

使用候选入口时，将 `$TEST_ROOT/consumer/node_modules/.bin`
放在 PATH 前端，并保留设备已有 Node/pnpm 路径。本次没有覆盖全局安装、切换远程 registry 或发布 npm。

包从开发机通过 SCP 传输，传输前后包摘要一致。以下构建文件的本地和远程摘要也逐项一致，避免把已有同版本全局包误认为候选：

| 文件                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `dist/cli-core.js`        | `b84c2483ddb0fee02a6878c7e2d08614f07ed0fbf2f96fc1569c5f11e5a81700` |
| `dist/cli-ai.js`          | `452f240ffac66a0bac6343c1e4a0ccf8a0630aa84c9210d6769b381fe5a3c9a5` |
| `dist/cli-ai-contract.js` | `aad378d64957ff619351c083f09ad37b2f0f6e0cbda68c3910abf435732ca40f` |

## 独立性与受限任务

首用 subagent：`70c78ef7-055e-4fbb-80ac-d64fe5f38976`。它与实施 subagent 是不同的新实例，未被提供设计上下文。

其输入仅包含 SSH 连接方式、候选 PATH、测试工作目录、证据存放位置、安全边界和任务目标。没有命令示例、参数教程、Session/Turn
ID、标记内容或先前测试结果；主 Agent 未在试用中途提供语法指点。

任务目标为发现能力、列出 Agent、新建 Session、让真实 Agent 读取标记文件并原样回复、观察结果与事件、用 Human 入口查看相同会话、验证无授权删除立即失败，再显式清理自己的测试历史。禁止读取或复制凭证、改登录状态、安装依赖、改 registry、操作其他 Session 或修改工作文件。

## 首次使用过程

共 16 次公开 CLI 调用。帮助只查询 2 次：AI 顶层一次、Human 顶层一次。没有额外分组帮助、语法猜测、非预期错误调用、提示后重试或人工指导。两次无授权删除及删除后的两次查询是预期的负向测试，不是首用失败。

记录中的本次标识：

```text
SESSION = 4dd5e7ec-cd3c-400f-acd5-920887678957
TURN = d001a033-369f-432f-b6e4-1cb58f05c34e
```

下表为便于阅读而用上述变量替代完整值；原始逐字命令及分离的 stdout/stderr 保留在设备证据中。

| 顺序 | 调用                                                                                                                         | 退出码及关键结果                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | `acplus-ai --help`                                                                                                           | 0；一次获得完整命令、参数、输出和恢复规则                            |
| 2    | `acplus --help`                                                                                                              | 0；发现 Human 分组入口                                               |
| 3    | `acplus-ai agent-list`                                                                                                       | 0；发现 `copilot`，最初停止，缓存认证证据过期                        |
| 4    | `acplus-ai session-create --agent copilot --working-directory $TEST_WORKSPACE --name first-use-acceptance-20261110-ccafee2b` | 0；创建专用 Session                                                  |
| 5    | `acplus-ai session-send --session $SESSION --turn $TURN --text "$READ_ONLY_TASK"`                                            | 0；一次提交，stdout 为 `accepted`，stderr 为 `turn_submitting` JSONL |
| 6    | `acplus-ai turn-get --session $SESSION --turn $TURN`                                                                         | 0；`running`，未误认为执行成功                                       |
| 7    | `acplus sessions get --session $SESSION`                                                                                     | 0；可读文本中显示相同会话                                            |
| 8    | `acplus-ai event-list --session $SESSION --turn $TURN --limit 100`                                                           | 0；34 项事件，最后 sequence 43，`nextAfter: null`                    |
| 9    | `acplus-ai turn-get --session $SESSION --turn $TURN`                                                                         | 0；`complete`、`end_turn`、完整回复                                  |
| 10   | `acplus sessions get --session $SESSION --json`                                                                              | 0；与 AI 会话标识和元数据一致                                        |
| 11   | `acplus-ai session-delete --session $SESSION`                                                                                | 2；0.315 秒返回 JSONL `invalid_input`，stdout 为空                   |
| 12   | `acplus sessions delete $SESSION`                                                                                            | 2；0.416 秒返回非交互确认错误，stdout 为空                           |
| 13   | `acplus-ai session-get --session $SESSION`                                                                                   | 0；负向测试未删除会话                                                |
| 14   | `acplus-ai session-delete --session $SESSION --yes`                                                                          | 0；`deleted: true`                                                   |
| 15   | `acplus-ai session-get --session $SESSION`                                                                                   | 1；结构化 `session_not_found`                                        |
| 16   | `acplus sessions get --session $SESSION --json`                                                                              | 1；结构化 `session_not_found`                                        |

实际只读任务原文：

```text
Read only acceptance-marker.txt in this Session working directory. Respond with its exact complete content and nothing else: no explanation, no markdown fences. Do not edit, create, or delete any files. Do not inspect other files or histories.
```

Turn
ID 在提交前生成并保存。总共一次模型提交，没有替换 ID、重放、取消或付费认证探测。从 Turn 创建到完成为 16.341 秒；未发生超时、传输失败、登录要求或 stdin 等待。无授权删除测试将 stdin
PIPE 保持打开、不发送输入，证明快速退出并非依赖 stdin EOF。

## 结果真实性与证据限制

- 回复为
  `ACPLUS_AI_OFFICE_ACCEPTANCE_01M71FVRQ5F96N7TF4WHA0HV30n`。末尾是测试文件实际包含的字母
  `n`，不是换行；首用 subagent 未被预先告知该内容。
- 首用 subagent 将回复与持久化读文件工具结果比较；随后主 Agent 独立读取文件摘要，与原始记录中最终回复的 UTF-8 字节摘要比较，均为
  `60e796423646d26a337dd1db344a0f2f985bd8d21d8c46e4cf04359b999fb0c9`。不是只以
  `complete` 状态代替任务正确性。
- 事件包含只读工具调用及其完成结果，没有文件编辑工具调用。主 Agent 后续检查测试工作目录，仍只有预置的标记文件；未执行全盘文件变更审计。
- 主 Agent 对记录中 9 个机器 stdout 结果重新进行 JSON 解析，并逐行解析机器 stderr；Human 文本与帮助不被错误地当作 JSON 验证。
- 原始 AI 首次帮助在记录器建立前查询，原始记录保存当时关键内容转述而非完整逐字输出。帮助实际构建输出大小由实现验证独立测得为 5563
  UTF-8 bytes，且远程安装的帮助实现文件摘要已与构建产物核对。
- “帮助较密但足够调用”是一次 subagent 的观察，不构成所有模型的泛化易用性结论。本次无故障，远程结果不冒充超时、重试冲突或 TTY 场景的全覆盖；这些另有本地自动测试。

原始设备证据保留于：

```text
$TEST_ROOT/evidence/first-use-report.md
$TEST_ROOT/evidence/first-use-transcript.json
```

完整 transcript 的 SHA-256 为
`61ebd7eb07179770365f5c8373c3ddcb8e3d361f6da08ae3235a9298e29c9d16`；取回开发机后再次核对一致。报告仅记录本次测试的公开命令、自己的历史及必要状态，不包含凭证或其他会话。

## 清理与门限判断

新建测试 Session 已显式删除，两个入口均验证其不存在。项目、凭证、既有会话、全局 acplus 安装及 Agent 自有后端历史未被删除。独立候选安装、包、只读标记和证据保留用于复查，无常驻测试辅助进程。

主 Agent 依据上述真实首用结果、实际字节比对、包来源及清理证据，判定部署标准通过；通过事件提交和验收准确部署修订后结束生命周期。此判断不是 npm 发布授权。
