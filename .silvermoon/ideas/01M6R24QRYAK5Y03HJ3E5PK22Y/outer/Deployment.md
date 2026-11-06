# Deployment

## Steps

### D-S01: 验证已打包的首次配置链路

在隔离 Ubuntu 目录安装候选 tarball，通过实际 CLI 生成配置，验证帮助、拒绝覆盖与权限，再使用显式指定的已授权原生配置启动 AHPD 并完成真实调用。保留原有 4280 服务。

### D-S02: 执行获准 Canary 发布

在 Actions 中确认版本可用及非发布 OIDC 诊断；全部门限通过后，正常推送已获准的
`v0.1.1-canary.20261106.1` 标签，只由既有 Trusted Publishing 工作流发布。

### D-S03: 验证 registry 和清理隔离进程

在 Actions 中验证实际 registry、安装包、CLI 和来源证明；核对 Canary 与稳定渠道，按明确所有权清理本次测试进程和端口。

## Acceptance criteria

### D-AC01: 生成配置真实可用

保存隔离安装、输出权限与不覆盖证据；真实 Session、Chat、Turn 正常完成，配置生成本身不启动服务或读取凭据。

### D-AC02: 指定版本可安装且渠道正确

`0.1.1-canary.20261106.1` 实际存在，`canary` 指向该版本，`latest`
仍是稳定版；Actions 的安装、入口与 CLI 验证和 npm 来源证明全部通过。

### D-AC03: 原服务和外部贡献边界保持

原 4280 服务不被替换，隔离服务已停止且端口释放；不改动上游 PR、复用发布标签或覆盖已发布版本。
