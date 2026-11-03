# Implementation

## Steps

### I-S01: Verify service and authorization contracts

Verify the actual ahpc/ahpd capability matrix and native authorization path for
the initial supported service. Define the configuration and migration behavior
against [the requirements](./ideal/Requirements.md), recording unsupported
combinations explicitly.

### I-S02: Implement configuration-driven lifecycle and forwarding

Replace hardcoded service startup and the global provider credential gate with
explicit service selection, on-demand lifecycle, and bridge-backed HTTP routing.
Keep connection security and process ownership distinct from provider identity.

### I-S03: Test and document the supported behavior

Add focused regression tests and usable configuration/authorization recipes,
including changed CLI behavior and any intentional compatibility boundaries.

## Acceptance criteria

### I-AC01: Configured instances start and route independently

Automated tests prove configuration validation, launch arguments/context,
on-demand startup, concurrent startup deduplication, and independent instance
routing, covering R-01, R-02, and R-05.

### I-AC02: Authorization and ownership boundaries hold

Tests prove backend-owned authorization outcomes without an ahplex provider
login gate, secret-safe errors, and cleanup restricted to owned processes,
covering R-03, R-04, and R-06.

### I-AC03: The package and user-facing contract remain verifiable

`pnpm check` passes. Documentation provides a supported service recipe and
explicit compatibility changes, with no npm publication or change to the package
export/file boundaries as an incidental effect.
