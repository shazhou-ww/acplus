# Implementation

## Steps

### I-S01: 分离本地只读历史查询

为 sessions/turns 的 list/get 和 events list 提供无服务只读入口。`Store`
以 SQLite `readOnly`
打开既有 schema-2 文件，在 deferred 读事务中复用原有完整性/行校验，跳过迁移、任务恢复和认证更新；`acp-history.ts`
统一 HTTP/CLI 的校验、分页与 Session 公开投影。CLI 只解析配置定位数据，不检查可执行文件是否存在或读取凭据；不得创建数据库、修改权限或申请写者/凭据所有权。缺失、损坏、不兼容和访问失败均显式报错。

### I-S02: 接入按需启动与复用

本地 sessions create、turns
start 按真实路径（Windows 不区分大小写）发现唯一写者；沿用数据目录独占 lease，竞争失败的子进程不能写入数据库或发布发现信息。使用 native
Node detached 子 CLI、私有 IPC 启动错误通道、ephemeral loopback
listener 和 15 秒启动截止。只有写者发布 owner-only
`service.json`；Unix 验证 uid/0600，Windows 用 `whoami.exe`/`icacls.exe`
限制并检查当前用户 DACL。随机实例密钥对 challenge 和每请求 nonce 做 HMAC，拒绝伪造 listener、过期/重复签名，不在请求或输出中传输密钥。取消只定位现有真实服务，不启动替代者。显式 URL（含 ACPLUS_URL）始终 HTTP-only；公共
`start(config)`、exports/files 不扩张。同步 CLI/API/安装包 README。

### I-S03: 实现空闲安全退出

仅自动服务采用默认 30000 ms 宽限期；本地启动命令可用
`--idle-grace-ms N`（100..86400000）配置新实例，复用不会修改现有实例。计时器间隔最多 100
ms，任何在途 handler/response、Service job、Agent
prompt、登录或可观测/不明后台活动都会阻止空闲关闭并重新计时。关闭先停止 admission，drain 已接纳请求，再关闭 Agent/Store，删除自己持有的发现记录并释放数据/profile
lease；请求竞争有明确拒绝/连接失败，不隐式重放 POST。显式 serve 常驻。异常退出的 stale/foreign
lease 保留为显式错误，不依 PID/端口清理；既有 Store 重启对账、unknown 和 ACP
resume/load 无历史 prompt 重放保持原样。详见[设计与验证证据](Lifecycle-verification.md)。

## Acceptance criteria

### I-AC01: 历史查询无副作用且兼容

通过 Store/HTTP/CLI 和 native 进程测试证明提交快照、分页、过滤、UUID/游标/整数校验和公开输出一致；无服务、不可用 Agent 和不可读凭据仍可查询，文件内容/mtime/权限不变，不生成目录/数据库。覆盖缺失、损坏、不兼容 schema 和非法行；不以持久化 running/cancelling 冒充实时状态。

### I-AC02: 并发启动与模式隔离可靠

通过五个并发 native CLI、不同数据目录隔离、caller 退出后的 lease、真实 owner
challenge/签名及失败注入证明只产生一个写者、失败显式可见。显式 URL/ACPLUS_URL 不启动或替换服务；无 owner 的取消报错，显式 serve 在短宽限期之后仍常驻并可被本地调用复用。

### I-AC03: 空闲退出不丢失执行证据

用可控 ACP Agent 和实测时序验证执行超过 1500
ms 测试宽限期仍保持存活，真实取消后终态/事件持久化，再退出并使用新实例恢复 ACP
load。模拟请求 caller 断开但 handler 未完成，证明已接纳写入仍提交后才退出；验证登录流程和 unknown 不被空闲清理或 prompt 重放。运行
`pnpm --config.verifyDepsBeforeRun=false check`；全部格式/lint/typecheck/90% 四项覆盖门槛/build/package-shape 原样通过。
