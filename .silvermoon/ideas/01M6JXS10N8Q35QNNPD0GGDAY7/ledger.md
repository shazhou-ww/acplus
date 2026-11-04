# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** Replace the legacy runtime with native host and authentication
      adapters
- [x] **I-S02:** Implement the native resource HTTP and CLI contract
- [x] **I-S03:** Independently review and verify the candidate

### Implementation acceptance criteria

- [x] **I-AC01:** Configuration and ownership invariants are enforced
- [x] **I-AC02:** Native operations and authentication match the API
- [x] **I-AC03:** The package is ready for real-host verification

## Deployment

### Deployment steps

- [ ] **D-S01:** Start two independent real VS Code hosts
- [ ] **D-S02:** Verify native resources and upstream authentication
- [ ] **D-S03:** Verify cleanup and preserve external evidence

### Deployment acceptance criteria

- [ ] **D-AC01:** Independent real hosts are usable and isolated
- [ ] **D-AC02:** A real authenticated native Turn completes
- [ ] **D-AC03:** Shutdown cleans only operation-owned resources
