# Ledger

## Implementation

### Implementation steps

- [ ] **I-S01:** Establish a supported GitHub authorization handoff
- [ ] **I-S02:** Bind authorization to the intended Host connections
- [ ] **I-S03:** Independently validate the login-to-Turn path

### Implementation acceptance criteria

- [ ] **I-AC01:** The chosen login mechanism has a supported delivery contract
- [ ] **I-AC02:** Connection-bound authorization is correct and isolated
- [ ] **I-AC03:** The implementation is ready for real authenticated acceptance

## Deployment

### Deployment steps

- [ ] **D-S01:** Prepare isolated VS Code hosts and complete user authorization
- [ ] **D-S02:** Submit and observe real authenticated Turns through AHPlex
- [ ] **D-S03:** Verify authorization isolation and clean shutdown

### Deployment acceptance criteria

- [ ] **D-AC01:** User login authorizes the actual AHPlex Host connection
- [ ] **D-AC02:** User-submitted Turns finish successfully on the bound hosts
- [ ] **D-AC03:** Authorization and cleanup remain scoped
