# 实施验证

## 本地配置生成

`init`
的独立本地输入为运行时安装前缀、原生 Copilot 可执行文件和现有工作区。输出固定为一个按需启动的
`ahpd`
host；生成过程不创建数据或配置档目录，不启动运行时、发现凭据、发起 HTTP 请求或付费探测。输出文件使用
`wx` 和 Linux 0600；已存在文件及正常、悬空符号链接均不替换。

父验收审阅拒绝了第一版将所有文件系统错误归类为配置错误的写法。修订后仅预期路径、权限与排他创建错误转换为带 errno 的输入错误；EIO、ENOSPC 和非文件系统异常原样失败，不删除可能留下的部分文件。单元测试覆盖配置、默认值、显式隔离、错误、TTY/JSON 和帮助路由。初始化模块实际覆盖计数全部命中，不以空 coverage 条目作为成功证据。

## 外部运行时准备

父验收在 Ubuntu 实际执行第一版三 tarball 安装说明，发现 ERESOLVE：ACP 的 SDK
peer 范围排除 `0.15.0-rc.1`。该版本说明不通过。

修订使用同源 SDK、server、ACP 三个 tarball、协议 1.0.0、zod
4.5.4，以及只绑定显式 SDK 的 npm override
`$@ahpd/sdk`，不整体禁用 peer 检查。隔离安装成功，server 与 ACP 解析到同一个指定 SDK，ACP
ESM 导入成功。文档保留固定 fork revision、SDK → ACP → server
pack 顺序与私有新目录边界。

外部依赖安装同时报告一条 high 审计警告，且可选 node-pty 安装脚本被阻止。不因此声称依赖审计通过；未运行强制升级、放宽 peer 检查或更改上游。真实 ACP 链路与已打包配置的验证属于部署门限。

## 最终候选与发布诊断

最终输入为提交 `054c1b51b9b50c928cc606cb1aa5500c8f6eea75`，tree
`a3faf8782a618c476ee9e55c54030ea880679ebc`；原生 Ubuntu 完整检查再次 148
passed、0 skipped，覆盖率仍为 95.92% / 92.89% / 95.58% /
96.79%。最终候选 tarball SHA-256：
`f76317ea464fcd13bf3adbef76eacb3cef2e7d60d07c2af8df593c2d54ed7037`。

父验收拒绝了虽成功但包含 npm
manifest 自动修正警告的第一次诊断。跳过 prepack 的对照试验仍有同样警告，故恢复原有 prepack；并非构建竞态。根因是 npm 将
`./dist/cli.js` 规范化为 `dist/cli.js`
时给出误导性的移除提示。只将 bin 路径改为规范形式，命令名称、目标文件、exports 和 files 均保持。新增 CLI 存在检查和自动修正警告失败门限。

Actions
[42201209392](https://github.com/shazhou-ww/ahplex/actions/runs/42201209392)
最终成功：全量检查及 OIDC 非发布诊断通过，75 个文件包含 CLI、ESM 入口和 init，没有 manifest 自动修正警告。首轮该 run 因既有 20ms
device
deadline 测试时序失败而未执行诊断；仅重跑未发布的失败 job，无标签或版本复用。此处仍不是实际 npm 发布证明。

## 早期源候选检查

父独立 `pnpm check` 通过：147 tests passed、1
skipped（Windows 的 POSIX 检查）。覆盖率 statements 96.03%、branches
92.97%、functions 95.89%、lines
96.91%；初始化模块 100%。格式、lint、严格类型检查、构建、publint 均通过。README 的共同编辑格式问题已由 formatter 修正后完整重跑。

Actions 版本检查只接受官方 registry 的 HTTP
200、匹配包名及有效 versions/tag 文档。已发布版本、HTTP
404/错误、网络故障、无效 JSON/metadata 均失败关闭，23 项隔离 fixture 测试通过；这些测试不访问真实 registry。

Actions
[42197611098](https://github.com/shazhou-ww/ahplex/actions/runs/42197611098)
成功返回有效 registry 文档：获准版本 `0.1.1-canary.20261106.1` 可用，
`latest=0.1.0`，此前 `canary=0.1.1-canary.20261105.1`。随后更新 manifest。

Windows 后续检查出现既有合成子进程启动、认证轮询超时及临时目录 EBUSY，串行时也有时序失败；没有放宽超时、断言或覆盖率。版本检查 fixture 改为直接调用有类型的内部脚本，避免为每个响应另起 Node，仅保留一个 CLI 边界子进程。

确切候选提交 `97319c93e96162b5013633d461f027ef7e5368b3` 的 tree
`8cb438fe7af89ee4e12369facde05a7276d9e2cd` 被原样传到独立 Ubuntu 目录。原生
`pnpm check` 全部通过：148 passed、0 skipped；statements 95.92%、branches
92.89%、functions 95.58%、lines
96.79%，init 模块 100%。同样通过格式、lint、严格类型检查、构建与 publint，未改变测试配置。

该快照的实际候选包包含 `dist/init.js`，没有 `docs/`，SHA-256：
`ae2fd8ce851ef7302a81da6cb4a147332fe8bb4d75b7443e5157fd853069f8a9`。这不是 npm 发布证明；后续 Actions 诊断及真实安装链路属于独立部署验收。
