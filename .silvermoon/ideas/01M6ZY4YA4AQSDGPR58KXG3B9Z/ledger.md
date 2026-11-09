# Ledger

## Implementation

### Implementation steps

- [ ] **I-S01:** 分离本地只读历史查询
- [ ] **I-S02:** 接入按需启动与复用
- [ ] **I-S03:** 实现空闲安全退出

### Implementation acceptance criteria

- [ ] **I-AC01:** 历史查询无副作用且兼容
- [ ] **I-AC02:** 并发启动与模式隔离可靠
- [ ] **I-AC03:** 空闲退出不丢失执行证据

## Deployment

### Deployment steps

- [ ] **D-S01:** 验证独立安装的本地使用流程
- [ ] **D-S02:** 验证兼容模式与恢复边界

### Deployment acceptance criteria

- [ ] **D-AC01:** 安装后无需维护后台服务
- [ ] **D-AC02:** 原有服务模式与持久历史可用
