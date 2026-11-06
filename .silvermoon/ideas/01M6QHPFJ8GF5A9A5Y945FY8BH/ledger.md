# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 接入受管 AHPD 主机
- [x] **I-S02:** 桥接原生登录交互
- [x] **I-S03:** 补齐恢复与兼容验收

### Implementation acceptance criteria

- [x] **I-AC01:** 生命周期与配置有回归证明
- [x] **I-AC02:** 登录不泄露或误报
- [x] **I-AC03:** 原生资源与质量门槛保持

## Deployment

### Deployment steps

- [x] **D-S01:** 准备隔离的 Ubuntu 候选部署
- [x] **D-S02:** 验证 HTTP 与 CLI 完整链路
- [x] **D-S03:** 验证重启连续性与旧后端兼容

### Deployment acceptance criteria

- [x] **D-AC01:** 无 VS Code 的真实执行成功
- [x] **D-AC02:** 原资源可跨两种重启续聊
- [x] **D-AC03:** 现有部署与凭据边界保持
