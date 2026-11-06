# 部署验证

## 已打包首次使用

Ubuntu 安装最终候选 `0.1.1-canary.20261106.1`，tarball SHA-256：
`f76317ea464fcd13bf3adbef76eacb3cef2e7d60d07c2af8df593c2d54ed7037`。安装中没有仓库
`docs/`，CLI 版本、离线帮助、配置生成正常。运行时按修订后的私有 manifest 从同源 SDK/server/ACP
tarball 重新组装，不是复用既有 daemon；SDK override、协议 1.0.0、zod
4.5.4 解析正确。

父独立安装 gate 于 2026-11-06T10:23:33Z 至 10:24:23Z 通过：

- 指定不存在的运行时也能读取帮助，不访问 API。
- 创建私有 0600 配置，没有创建数据根、发现配置档或监听 4293/19493。
- 重复创建、正常符号链接、悬空符号链接均以 2 拒绝，原配置哈希不变。
- 配置只有一个 `ahpd` host；GET 不启动，明确的 Session 创建才按需启动。
- 显式旧配置档复用最初诚实返回 `auth_verification_unsupported`，不当作凭据无效。
- 调用者明确请求一个不使用工具、不改文件的真实 Turn，精确答案完成；之后当前连接授权复用成功，未执行隐式付费探测。
- daemon 与网关两种重启后，原 Session/Chat/caller Turn ID 的完成结果均可读取。
- 跟踪的 15 个拥有进程均停止，4293/19493 已释放，原 4280 服务健康；已授权原生配置文件仍为 0600，没有复制或删除凭据。

门限机器记录保留在本次私有测试目录的
`native-result.json`；证明只有一个新的真实完成 Turn，不将历史读取算作新的执行或授权。

## 发布准备

Actions 可用性检查
[42199974100](https://github.com/shazhou-ww/ahplex/actions/runs/42199974100)
确认指定版本尚未发布，稳定渠道为 0.1.0。非发布 OIDC 诊断
[42201209392](https://github.com/shazhou-ww/ahplex/actions/runs/42201209392)
成功：完整检查、CLI 文件及 75 个发布文件正确，没有 manifest 自动修正。这些检查均在 Actions 内进行；没有本地 npm
publish、长期 npm token 或 OTP。

## 实际发布与独立安装验收

获准注解标签 `v0.1.1-canary.20261106.1` 指向同步 main tip
`80cbe5ad2206954fd938a6be753c8d3f6fc8ded8`，标签未移动或复用。发布 run
[42202819261](https://github.com/shazhou-ww/ahplex/actions/runs/42202819261)
全部成功，完整检查通过后由 OIDC 发布到
`canary`。2026-11-06T10:28:23Z 官方 registry PUT 返回 202；来源证明已签名并写入
[透明日志](https://search.sigstore.dev/?logIndex=3714993599)。

首次立即验证曾返回 E404，不能将上传接受当作版本可安装证明，也没有重发。只重跑 verification-only
run
[42203054842](https://github.com/shazhou-ww/ahplex/actions/runs/42203054842)，于 2026-11-06T10:31:47Z 成功确认：

- 实际 registry 版本为 `0.1.1-canary.20261106.1`。
- `canary=0.1.1-canary.20261106.1`，`latest=0.1.0`。
- registry 的 CLI bin 为 `ahplex: dist/cli.js`，
  [npm 来源证明](https://registry.npmjs.org/-/npm/v1/attestations/ahplex@0.1.1-canary.20261106.1)
  存在。
- 干净目录按确切版本安装成功，公共 ESM 导入、声明文件、exports/files 形状正确。
- CLI 版本、帮助、参数错误退出码和 init 均成功；已发布 init 在没有 docs 的安装中生成有效配置，输出 0600，不创建数据根，拒绝已有文件及两类符号链接。

完整临时源码验证依赖、生成 dist 和传输 tar 已按明确路径清理；私有接受记录、已停止的隔离配置与原生历史保留，凭据未复制或删除。原服务再次返回 HTTP
204，4293/19493 保持无监听。未对上游作任何变更。

## 限制

仅承诺固定 Linux/Copilot 组合，外部运行时需显式准备，配置来源声明不是完整性验证。外部运行时安装报告一条 high 审计警告及可选 node-pty 安装脚本被阻止；已证明 ACP 链路可用，但不声称依赖审计通过或生产就绪，未强制升级或改动上游。原服务未自动迁移，运行中的 Turn 不承诺跨强制重启恢复。
