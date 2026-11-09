# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 分离本地只读历史查询
- [x] **I-S02:** 接入按需启动与复用
- [x] **I-S03:** 实现空闲安全退出

### Implementation acceptance criteria

- [x] **I-AC01:** 历史查询无副作用且兼容
- [x] **I-AC02:** 并发启动与模式隔离可靠
- [x] **I-AC03:** 空闲退出不丢失执行证据

## Deployment

### Deployment steps

- [x] **D-S01:** 发布并验证新的 Canary
- [x] **D-S02:** 验证 Ubuntu 本地生命周期
- [x] **D-S03:** 验证兼容模式与恢复边界

### Deployment acceptance criteria

- [x] **D-AC01:** Canary 的发布与安装结果真实可验证
- [x] **D-AC02:** Ubuntu 安装后无需维护后台服务
- [x] **D-AC03:** 兼容、恢复和隔离清理成立
