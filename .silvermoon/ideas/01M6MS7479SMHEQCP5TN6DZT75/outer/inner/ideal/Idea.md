# 将 GitHub 用户授权代理到 VS Code Host

## Problem

用户可以通过原生 Copilot CLI 登录，但在已测试的独立 VS Code
Host 上，新的客户端仍无法在没有 provider 凭据的情况下执行。AHPlex 需要在自己实际使用的 Host 连接上代理用户授权，而不是假设能够继承另一个应用的登录状态。

## Outcome

用户无需打开 VS Code
GUI，完成受支持的 GitHub 授权后，即可通过 AHPlex 提交原生 Turn，并获得成功的 Copilot 响应。AHPlex 统一管理该授权、所需资源与各个选定 VS
Code Host 连接之间的显式对应关系。

## Boundaries

- 首期仅支持 VS Code Agent
  Host 和 GitHub/Copilot 认证。HTTP/CLI 接口保持 MVP 范围，保留原生 Session、Chat 和 Turn 身份，不新增账号、租户或 Task 系统。
- 登录可以由受支持的外部或原生组件完成。AHPlex 必须通过明确且受支持的交接方式接收授权结果，不抓取无关应用的凭据，也不冒用 OAuth 应用身份。Host 连接令牌与 provider 凭据保持分离。
- 入站访问控制仍由网关负责。跨 Host 复用凭据必须显式绑定；凭据过期或连接重建时，不得静默切换身份或重放 Turn。本 IDEA 不包含 npm 发布。

## Acceptance criteria

- 用户可见的 GitHub 登录授权流程，能够让目标 AHPlex 到 VS Code
  Host 的连接获得可用授权，无需用户暴露密码或在对话中粘贴 token。
- Host/资源与凭据的绑定明确，并可通过不泄露敏感信息的状态或错误观察；凭据不会广播给未选定的 Host，也不会泄露。
- 部署证据证明：用户登录后，通过 AHPlex 提交的真实 Turn 达到原生 `complete`
  状态并返回预期响应。仅有登录成功、HTTP
  202、健康检查或测试桩输出，不满足此目标。
