# 授权交接的实现前置条件

## Windows 原生 gh 的隔离限制

实施调研与协调 agent 的独立核对确认：GitHub CLI 2.103.3 的 `GH_CONFIG_DIR`
只限定文件配置目录，不隔离 Windows 全局凭据库。即使指定
`--insecure-storage`，账户切换与 token 查找仍可能访问全局keychain。因此不能在当前工作用户下把它声称为“不会触及现有登录”的独立授权环境。

官方依据：

- [GitHub CLI 2.103.3 配置实现](https://github.com/cli/cli/blob/v2.103.3/internal/config/config.go)
  的 `ActiveToken`、`TokenForUser` 和 `setActiveCredential`。
- [同版本 keyring 实现](https://github.com/cli/cli/blob/v2.103.3/internal/keyring/keyring.go)
  调用系统凭据后端，没有按 GH_CONFIG_DIR 分区。

这不改变首期功能目标，而是对受支持交接方式的部署前置约束。

## 当前实施方向

使用官方 GitHub CLI 完成设备授权和正式 `auth token`
接口交接，但将其放入明确配置、无系统 keychain 的独立执行环境。AHPlex 接收交接结果后，只提交到配置所绑定的 VS
Code Host/资源；不读取 Windows 默认 gh 或 Copilot 账户。

协调 agent 为真实验收准备临时 WSL 发行版 `AHPlexAuth358d`，不使用或修改 Docker
Desktop 的内部发行版。基础 rootfs 与 gh 二进制来自官方发布源并验证 SHA-256；它仅是验收环境，不成为 npm 包的运行依赖或要求所有部署使用 WSL。

实现需明确凭据存储、环境变量清理、固定命令前缀及凭据读写边界。尚未发起此环境中的用户登录，也未宣称真实 AHP
Turn 已执行成功。
