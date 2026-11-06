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

## 源候选检查

父独立 `pnpm check` 通过：147 tests passed、1
skipped（Windows 的 POSIX 检查）。覆盖率 statements 96.03%、branches
92.97%、functions 95.89%、lines
96.91%；初始化模块 100%。格式、lint、严格类型检查、构建、publint 均通过。README 的共同编辑格式问题已由 formatter 修正后完整重跑。

Actions 版本检查只接受官方 registry 的 HTTP
200、匹配包名及有效 versions/tag 文档。已发布版本、HTTP
404/错误、网络故障、无效 JSON/metadata 均失败关闭，23 项隔离 fixture 测试通过；这些测试不访问真实 registry。

当前先同步功能候选，以便 Actions 执行新增的非发布可用性检查。获准版本仍为
`0.1.1-canary.20261106.1`；尚不声称该版本可用或已发布。确认可用后再更新 manifest，并重新检查确切发布候选。
