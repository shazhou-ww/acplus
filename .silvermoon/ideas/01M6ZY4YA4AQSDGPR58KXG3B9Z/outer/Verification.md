# Canary 发布与 Ubuntu 生命周期验收

本文支持 [Deployment.md](Deployment.md)，不改动已验收的 Ideal/Inner
World。用户明确委托父级负责门限校验和审批、推进至 complete，并发布新 Canary 后在 Ubuntu 验收；以下结论来自实际发布、安装、执行及进程观察，而不是把授权当作成功证据。

## 产物、环境与来源

- 软件包：`acplus@0.1.0-canary.20261109.3`，CLI 为 `acplus`，安装入口
  `dist/cli.js`，HTTP `/v2`，ACP wire v1。
- 发布提交：`15761d6ba5f14e68c8c17e347403432d764b76d6`；annotated
  tag：`v0.1.0-canary.20261109.3`，未移动或复用 tag。
- 确切发布候选的本地完整 check：189 passed / 1
  skipped；四项覆盖率依次 95.61%、91.85%、94.92%、96.72%，format/lint/typecheck/build/publint/
  public CLI entry 均通过，未降低 90% 门槛。
- 发布提交的 [CI](https://github.com/shazhou-ww/acplus/actions/runs/42612021313)
  成功，执行项目既有 Node 22.13.0 / 24.11.1 矩阵。
- 独立设备：Ubuntu 26.04.1 LTS、Node 24.22.2、Copilot CLI
  1.0.107。新建私有验收根目录 `~/acplus-lifecycle-20261109.5tQEQY`，安装到其
  `install` prefix；数据、workspace 和 fixture profile 单独隔离。
- 真实 Agent 明确复用先前已授权的专用 profile；没有复制凭据、输出 token/ 原始登录内容，或修改原有配置和全局安装。
- Ubuntu 安装的锁文件记录版本 `.3`、下载 host
  `mirrors.cloud.tencent.com`，integrity 为
  `sha512-ZpDbUY4U0UcI6yLlz3CHGNUmIqV0LyniSfSW2iTcL3GVYJyAjcI0ZSDN+ndLmBqhZt/SiyHtgbaH35WTUqj3BQ==`。

## D-AC01：真实发布及 registry/install 验证

1. [版本可用性](https://github.com/shazhou-ww/acplus/actions/runs/42605193069)
   确认候选未占用；该预检不代表已经发布。
2. 同步确切候选后执行
   [非发布诊断](https://github.com/shazhou-ww/acplus/actions/runs/42612025958)，package
   shape 与 `dist/cli.js` 存在性通过，未发生 manifest auto-correction。
3. [tag 发布](https://github.com/shazhou-ww/acplus/actions/runs/42612261271)
   通过 OIDC 返回
   `+ acplus@0.1.0-canary.20261109.3`，provenance 已签名；只推送一次新 tag，未在本地运行 npm
   publish。
4. 最初
   [验证 run](https://github.com/shazhou-ww/acplus/actions/runs/42612436265)
   在发布后约 16 秒遇到 registry
   E404。未将它当成未发布，也未再次发布；保留原 tag 并等待传播。
5. 后续
   [验证 run](https://github.com/shazhou-ww/acplus/actions/runs/42612700677)
   成功：确切版本、bin、exports/files、provenance、installed
   CLI/import/init 全部通过，`canary=.3`，
   `latest=0.0.0`（稳定占位版本，未被 Canary 替换）。

registry 与安装包诊断均在 GitHub
Actions 完成。Ubuntu 最初按名安装遇到镜像 ETARGET；尝试镜像 tarball
URL 被设备的 remote-package 策略拒绝后，未更改或绕过该策略。传播后继续通过允许的 named
registry package 安装成功，包与依赖均使用腾讯镜像；没有切换到本地官方 registry。

## D-AC02：Ubuntu 自动生命周期与真实执行

测试使用安装包的 Node
CLI 入口，不是源码 import 或内存 Service。未显式启动后台服务，已 unset
`ACPLUS_URL`，本地命令使用 `--config FILE`。

确定性 ACP fixture 的最终完整探测：

| 观察                          | 实际结果                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- |
| 五个并发 sessions create      | 五个不同 Session，同一 writer PID；创建后没有 Agent boot                     |
| 4500 ms 的执行、1500 ms grace | running 后继续观察 2586 ms，writer 仍存活、Turn 仍 running                   |
| 正常完成与空闲退出            | LONG_OK 与 complete 先持久化；终态观察后 4118 ms 内进程退出且发现/写者锁释放 |
| 再启动继续同一 Session        | 使用新 writer，观察到 `session/resume`；三次实际 prompt，无历史 prompt 重发  |
| 真实取消                      | fixture 收到 `session/cancel`，持久化 cancelled 后自动退出                   |

退出测量包含 timer 粒度、Agent/native 清理和 CLI 观察开销，不承诺 grace 到期即强杀。第一次父级 fixture
harness 的断言误把公开错误消息当成机器码，第二次误要求 load 而排除合法 resume；仅修正 harness 并重新在独立目录完整运行，未修改产品或降低产品要求。最终 fixture 探测全部通过。

真实 Copilot 验收：

- 同一个 Session：`e4a99610-eba3-4bae-8ff2-8b63cf8f84fe`。
- 首次 Turn：`06bdd907-5e47-4ae8-9891-bb7669fa198a`，精确拼接 live
  agent_message_chunk 为 `ACPLUS_CANARY_OK`，`state=complete`，10 条过滤事件。
- 自动服务退出后第二个 Turn： `8205cad8-3470-464a-86f9-3ddd11422bc1`，精确结果
  `ACPLUS_CANARY_RESUMED`，`state=complete`，12 条过滤事件，新 writer
  PID、同一 Session，历史未被作为新 prompt 重发。
- 两次 grace 都为 2500
  ms，观察终态后至 writer 进程退出及发现/写者锁清理分别为 5474 ms 与 5572 ms。
- 没有调用登录或额外付费健康探针；上述两个 prompt 本身即用户授权的实际执行验收。

原始受控结果保留在 Ubuntu 验收根目录的 `fixture-evidence.jsonl`、
`real-evidence.jsonl` 及独立 run 的 fixture trace；只有脱敏结论进入仓库。

## D-AC03：离线、兼容、异常与清理

- 停止后 sessions/turns/events 仍可直接读取；把 Agent
  command 改为不存在的文件、配置不存在的 secret
  reference，仍读取真实提交结果，数据库 bytes/mtime/mode 不变，不生成 writer 或启动进程。
- 显式 loopback
  URL 指向不可用端口时明确失败，不隐式启动；没有真实 owner 的 cancel 明确失败，不修改数据库或宣称取消。
- 显式 serve 在短 grace 之后仍存活且 health 可访问；本地创建安全复用该常驻 writer；`ACPLUS_URL`
  能查询同一 Session。
- 独立 crash fixture 在 running 时只向已跟踪的测试 writer
  PID 发送 SIGKILL：writer 和其 Agent 均退出，离线读取保留最后观测 running，cancel 报真实 owner 不可用，数据库不被改写，没有伪造完成或取消。对应 Session 为
  `757c03b3-db8a-4e37-9f75-8e8c12bf4973`，Turn 为
  `3687d075-4792-433d-a148-fc83fa657bed`。
- crash 测试的 data/profile stale
  ownership 故意保留在独立目录作为 fail-closed 证据，未根据 PID 猜测删除或自动接管；它不表示正常 idle
  cleanup 失败。
- 最终定向检查覆盖 14 个测试所属 Agent/writer
  PID，全部不存在；六个正常数据目录的 owner/discovery 文件均不存在，六个正常/明确选定 profile 的 lease 均已释放。
- 原有全局 `acplus` 仍为
  `.2`，未被独立 prefix 安装替换；原配置、历史和授权 profile 保留，无无关服务被停止。

检查摘要保留在 Ubuntu 根目录
`cleanup-evidence.json`；异常历史与 ownership 证据保留，不把失败记录删除成成功。

## 审批范围与限制

Ideal/Inner 的准确修订已分别提交、验证并由明确委托的父级审批，未采用 waived 门禁。当前 Outer 候选在上述实际结果就绪后才提交并接受。本次证明 Windows 仓库测试和该 Ubuntu 独立安装环境；不声称其他平台、其他 Agent、自动清除 crash
ownership 或无能力时的上下文恢复。
