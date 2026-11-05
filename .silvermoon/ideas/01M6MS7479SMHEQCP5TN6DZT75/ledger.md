# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 明确受支持的 GitHub 授权交接方式
- [x] **I-S02:** 将授权绑定到目标 Host 连接
- [x] **I-S03:** 独立验证从登录到 Turn 执行的链路

### Implementation acceptance criteria

- [x] **I-AC01:** 所选登录机制具有受支持的授权传递契约
- [x] **I-AC02:** 连接绑定的授权正确且相互隔离
- [x] **I-AC03:** 实现具备真实认证验收条件

## Deployment

### Deployment steps

- [ ] **D-S01:** 准备隔离的 VS Code Host 并完成用户授权
- [ ] **D-S02:** 通过 AHPlex 提交并观察真实的已授权 Turn
- [ ] **D-S03:** 验证授权隔离和完整关闭

### Deployment acceptance criteria

- [ ] **D-AC01:** 用户登录使实际 AHPlex Host 连接获得授权
- [ ] **D-AC02:** 用户提交的 Turn 在绑定的 Host 上成功完成
- [ ] **D-AC03:** 授权与清理始终限定在各自范围内
