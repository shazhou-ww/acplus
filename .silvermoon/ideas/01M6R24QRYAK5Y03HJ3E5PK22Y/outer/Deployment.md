# Deployment

## Steps

### D-S01: 验证已打包的首次配置链路

以已接受实现的最终 tarball 在独立 Ubuntu 前缀安装，SHA-256 为
`f76317ea464fcd13bf3adbef76eacb3cef2e7d60d07c2af8df593c2d54ed7037`。使用文档中已验证的私有 manifest、同源三个 AHPD
tarball 和指定 SDK override 新建运行时，而非借用既有 daemon；原生 Copilot
CLI 仍固定 1.0.106。

通过已安装 CLI 生成一个仅含 AHPD 的配置，使用独立数据根及 4293/19493 端口。工作区信任和已授权原生配置档均由调用者显式指定，不发现或复制凭据。验证 0600、拒绝覆盖与符号链接、没有数据目录或服务副作用。随后单独启动服务，由调用者明确请求一个不使用工具、不改文件的真实 Turn，核对完成结果和当前连接的授权复用；检查 daemon 与网关重启后的原 caller
Turn。保留原 4280 服务。

### D-S02: 执行获准 Canary 发布

官方 registry 可用性检查及不含自动修正警告的非发布诊断必须成功。通过 D-S01 后，正常推送已获准的
`v0.1.1-canary.20261106.1` 注解标签，其提交必须是同步 main
tip；只通过现有 GitHub Actions OIDC 工作流发布。不改变
`latest`、复用标签、重发已存在版本或运行本地 npm publish。

### D-S03: 验证 registry 和清理隔离进程

在 Actions 中验证实际 registry、安装包、公共 ESM 导出、CLI、init 和来源证明。已发布 init 必须在没有仓库 docs 的安装中生成有效配置，且拒绝已有文件和正常、悬空符号链接；旧版本验证保持可用。按 PID 与出生标识清理本次测试进程，确认 4293/19493 释放、原服务健康与原生配置文件私有权限。

## Acceptance criteria

### D-AC01: 生成配置真实可用

保存安装包哈希、纯生成、权限、不覆盖及真实 Session/Chat/Turn 证据。一个调用者明确请求的 Turn 完成，随后授权复用成功；两种重启均能按原 Chat 与 caller
Turn ID 读取完成结果。历史记录不被当作新授权，也不承诺恢复运行中的 Turn。

### D-AC02: 指定版本可安装且渠道正确

`0.1.1-canary.20261106.1` 实际存在，`canary` 指向该版本，`latest`
仍为稳定版；Actions 的 registry、安装、入口、init 与 CLI 验证成功，并存在 npm 来源证明。

### D-AC03: 原服务和外部贡献边界保持

原 4280 服务不被替换，隔离服务已停止且端口释放，配置档保持 0600。不改动上游 PR、复用发布标签或覆盖已发布版本。保留外部运行时安装的一条 high 审计警告，不强制升级或声称依赖审计、生产就绪。
