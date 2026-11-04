# Operate multiple owned hosts through native AHP resources

## Problem

The existing service wraps one agent turn in a separate Task model and depends
on ahpc internals. Callers need several owned hosts, on-demand startup, and
authentication while retaining the actual AHP Session, Chat, and Turn concepts.

## Outcome

One small HTTP/CLI service operates configured hosts and bridges their login
steps. Callers can discover or create Sessions and ordinary Chats, then submit,
observe, and cancel exact native Turns without a service-side queue.

## Boundaries

- Preserve the agreed [MVP requirements](../../../../../../docs/REQUIREMENTS.md)
  and [OpenAPI contract](../../../../../../docs/openapi.yaml), not compatibility
  with the old Task API. Use the official AHP SDK and keep one package.
- Own all registered host processes; use static configuration, one data root,
  and explicit credential provisioning. Inbound access control stays outside.
- No npm release, copied editor credentials, dynamic host registry, task queue,
  fork/side-chat creation, or invented successful authentication.

## Acceptance criteria

- Independent hosts start on demand and clean up only owned processes; one
  host's failure does not disable another.
- Native Session/Chat identities and Turn IDs round-trip correctly. Chat
  creation respects capabilities, busy chats reject without queueing, and
  cancellation never targets a different turn.
- The caller can complete supported upstream authentication through API-visible
  steps; unsupported or missing prerequisites are explicit, not success-shaped.
