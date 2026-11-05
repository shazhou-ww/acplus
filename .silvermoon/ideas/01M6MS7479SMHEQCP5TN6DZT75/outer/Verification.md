# 真实授权与双 Host Turn 验收

## 结果

用户在设备码有效期内完成 GitHub
CLI 原生授权。安装包中的 AHPlex 将授权通过正式 gh
token 交接接口提交到实际 AHP 连接；两个显式绑定的 VS Code
Host 均成功完成真实 Turn，并精确返回各自随机响应标记。本次不是 CLI 直接回答或协议测试桩。

## 候选与环境

- 实现提交：`b3296e164e37e4d828debe6e5048406738c6a0eb`。
- 已接受的实现 revision：`8089416571dcf838185466ea0792d52ddd6ec851`。
- 部署契约在 primary `69c3e88bd724345278ee32b66c450310cda117d4` 上同步。
- 使用独立安装的 `ahplex@0.1.0` 本地 tarball，不发布 npm。
- VS Code 1.145.0，build `a717861c07586a53d83b80d742cd3f59b20a6273`；官方 GitHub
  CLI 2.103.3。
- 独立根目录 `D:\ahp-auth-gate-358d`；临时 WSL 发行版 `AHPlexAuth358d`。Alpine
  rootfs 和 gh 发布包已核对官方 SHA-256。
- Linux 环境无 keychain 服务，禁用 Windows 盘自动挂载和互操作。官方 CLI 在专用 profile 保管凭据，目录权限 700、凭据文件权限 600。没有读取默认 Windows
  gh、Copilot 或编辑器凭据，也没有注册或冒用 OAuth 应用。

## 授权与绑定

通过实际 HTTP `POST /hosts/a/auth` 选择
`github-login`，用户完成返回的设备授权。该绑定使用官方 gh 的默认 scopes，另外显式请求
`read:user`、`user:email`。适配器核对指定账号、配置来源和授予权限，正式导出 token 后调用当前连接的 AHP
`authenticate`。状态达到 `succeeded`，而非只观察登录程序退出。

Host `b` 初始认证状态为 `idle`。明确调用它的 `github-reuse`
后才使用同一授权，并完成自身连接的认证。未绑定 Host 的同名方法请求返回 404，没有隐式授权广播。状态响应和执行结果均未包含凭据。

## 精确 Turn 结果

验证在 2026-11-05 04:06:39 至 04:07:06
UTC 进行。每个 Host 使用实际 Session 和默认 Chat，提交新 turnId，要求只输出随机标记，不调用工具或读取、修改文件。

| Host | Turn ID                                | 原生状态   | 精确响应匹配 |
| ---- | -------------------------------------- | ---------- | ------------ |
| `a`  | `473010cc-f25c-4cad-a8dd-b4c62cfb5463` | `complete` | 是           |
| `b`  | `9106104d-72c1-4520-bbb4-f1accc9ebcf4` | `complete` | 是           |

Host `a`：

- Session：`ahp-session:/ffc54adc-b3e4-493e-91af-ff28396a5338`。
- Chat：`ahp-chat:/cb377d1d-88c8-4245-a9af-551dd9ce79f2`。
- 响应：`AHPLEX_AUTH_GATE_3a4b9625bbd34d6498c206742982fa02`。

Host `b`：

- Session：`ahp-session:/16964636-c162-4ee5-863d-4c0cd8c4c25e`。
- Chat：`ahp-chat:/2141a328-840d-4e37-86f9-dfda14b75e33`。
- 响应：`AHPLEX_AUTH_GATE_a7ed61dfa6304711a97f7ce5e256b211`。

两次提交返回无响应体的 202，随后查询精确 chat/turnId 得到 `complete`
和预期文本。对已完成 Turn 请求取消后，状态保持
`complete`。用另一个 Host 查询该 Session 均返回 404，未发生跨 Host 路由。

## 清理与边界

服务于 04:07:15 UTC 完成正常关闭。独立检查确认：

- 没有剩余使用本次 Host 数据目录的进程，根目录 owner.lock 已移除。
- 没有剩余官方 gh 登录进程；跨 WSL 包装器生命周期此前已独立验证。
- 测试工作目录仍为空。没有停止或修改现有编辑器会话。
- 专用授权 profile 保留，便于后续显式复用；未注销用户其他应用的授权。

本次证明受支持的登录交接、两个显式 Host 绑定和真实 Turn 执行闭环。WSL 只是本机用于避免共享 keychain 的验收设施，不是所有 AHPlex 部署必须采用的架构。过期、负面认证、连接重建和异常清理的边界另由实现阶段的协议/子进程测试覆盖。
