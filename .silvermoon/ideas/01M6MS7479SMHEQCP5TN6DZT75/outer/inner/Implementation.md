# Implementation

Preparation seed: refine only after the Idea is accepted.

## Steps

### I-S01: Establish a supported GitHub authorization handoff

Select and verify a headless GitHub/Copilot-compatible login and credential
delivery mechanism using the existing authentication adapters where suitable.
Resolve credential acquisition, custody, and supported transfer before coding a
fallback. The prior
[native-login findings](../../../01M6JXS10N8Q35QNNPD0GGDAY7/outer/Verification.md)
are the baseline: successful CLI login is not Host authorization.

### I-S02: Bind authorization to the intended Host connections

Implement the minimal configuration and authentication lifecycle required to use
explicit user authorization for selected VS Code hosts/resources. Preserve
native resource operations, independent transport tokens, exact Turn identity,
and explicit expiry/reconnect handling. Update directly related API/CLI docs.

### I-S03: Independently validate the login-to-Turn path

Add protocol-backed tests for credential delivery, host isolation, negative
authentication, expiry, and reconnect. Review the integrated path and run
repository/package checks without weakening thresholds or acceptance semantics.

## Acceptance criteria

### I-AC01: The chosen login mechanism has a supported delivery contract

Document the concrete login component, required application/scopes or other
prerequisites, and authorized credential handoff. Tests demonstrate a credential
can reach the actual AHP connection without scraping unrelated profiles or
logging secrets; unsupported prerequisites fail explicitly.

### I-AC02: Connection-bound authorization is correct and isolated

Protocol tests prove explicit host/resource selection, supported reuse only when
configured, negative-result handling, and expiry/reconnect behavior. Neither
identity substitution nor replay of possibly accepted Turns occurs.

### I-AC03: The implementation is ready for real authenticated acceptance

Independent review, `pnpm check`, and package/CLI smoke checks pass. The minimal
login-to-Turn workflow is documented and testable without a VS Code GUI. Mocked
authentication is labelled as such and is not live deployment evidence.
