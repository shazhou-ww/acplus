# Implementation

## Steps

### I-S01: Replace the legacy runtime with native host and authentication adapters

Implement static configuration, owned lifecycle, official AHP connections, and
authentication using the agreed
[contracts](../../../../../docs/REQUIREMENTS.md). Preserve unrelated upstream
fixes and existing package publication metadata.

### I-S02: Implement the native resource HTTP and CLI contract

Implement the fourteen MVP operations, minimal payloads, ordinary Chat creation,
exact Turn correlation, busy rejection, and the documented service/client CLI.
Update user documentation to distinguish implemented from unsupported
capabilities.

### I-S03: Independently review and verify the candidate

The implementation subagent supplies code and targeted tests. The coordinating
agent reviews the changes and runs independent contract/process checks, the
complete repository checks, and package validation before submission.

## Acceptance criteria

### I-AC01: Configuration and ownership invariants are enforced

Automated tests prove schema/adapter validation, file/stdin overrides, isolated
data roots, coalesced startup, failure isolation, and owned-process cleanup.

### I-AC02: Native operations and authentication match the API

Protocol-backed tests exercise all fourteen operations and exact response
shapes, capability/interactivity checks, same-chat admission races, ambiguous
outcomes, exact cancellation, and authentication steps/expiry/verification.

### I-AC03: The package is ready for real-host verification

An independent gate finds no blocking defect. `pnpm check`, pack/install CLI
smoke checks, and generated API/schema checks pass without lowering thresholds.
Evidence identifies any real-environment prerequisites instead of claiming them.

## Review authority

The user explicitly delegated implementation to a subagent and gate review and
acceptance to the coordinating agent, with autonomous decisions on 2026-11-04.
Acceptance is recorded only after reviewing the exact synchronized candidate;
delegation is not evidence that checks or external outcomes have already passed.
