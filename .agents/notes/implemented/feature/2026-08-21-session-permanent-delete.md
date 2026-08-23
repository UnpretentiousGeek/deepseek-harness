# Agent Note: Permanent session deletion

Status: implemented

English | [中文](2026-08-21-session-permanent-delete.zh.md)

## Problem

Sessions could be archived and restored, but never removed: no layer of the stack had a delete. The workspace-registration-deletion note recorded the boundary ("registration deletion never substitutes for session deletion"), the sidebar's Known Limitations said so too, and a user with a sensitive or junk conversation had no recourse — the log stayed on disk forever.

## Decision

Deletion runs as one confirmed gesture through every layer it touches:

- **Persistence** owns removal. `SessionPersistence.delete(id)` removes the log and every backend artifact — the JSONL backend removes the session's directory, SQLite deletes the row and its events in one transaction — and answers whether anything existed. The coordinator serializes against all per-id operations, refuses a live session (`cannot delete ... while it is live`), awaits an in-flight retirement drain before the medium write — from outside the serialization chain, whose tail the draining retirement itself joins after its flush, so an in-chain wait would queue removal ahead of the drain it awaits and deadlock both — drops bookkeeping and cached preparations after the medium write, and emits `session/persistence-removed`. Deletion is the one write that is not append-only; it is a separate operation rather than a log mutation precisely because append-only invariants stay intact for everything else.
- **Gateway** composes the gesture behind `session.delete`: refuse a running turn (`agent-busy`), refuse any live agent whose disposal capability this gateway does not hold (owner-held capability, so foreign live sessions and session-backed subagents are not ours to stop), gate existence over live-plus-persistence before touching anything, then dispose → persistence.delete → `workspaceRegistry.forgetSession` (accounting slot + archive-set entry). Every handle the gateway mints lands in one retained-handle map — `ensureSession`'s creates and resumes and the shared agent resolver's cold resumes alike (`ApiRemoteAgentOptions.retain`) — because generic entry points such as `session.models` make a cold session live without naming any other owner; a live identity without a retained handle would be undeletable by construction. Clients learn through the ordinary removed frame either way — `session/disposed` for a disposed live session, `persistence-removed` relayed to the same frame shape for a persisted-only one.
- **UI** keeps destructive apart from dialog-free: Archive/Unarchive commit directly because they only move visibility, while Delete opens the same browser-owned confirmation pattern as workspace registration deletion, naming the session and stating that the log goes too. Ordinary rows and Archived-section rows both carry it.

## Alternatives considered

**Soft delete / trash with grace period.** A second visibility state beside archive, plus scheduled-expiry machinery nobody asked for yet. The archive set already covers "hidden but recoverable"; permanent deletion exists precisely for when that is not enough.

**Registry-wide dispose face for live sessions.** Widening `AgentRegistry` so any caller could stop any live agent would break the handle-as-capability discipline. The gateway retains the handles of agents it created — the ownership it already holds — and refuses everything else.

**Client-side optimistic row removal without a host frame.** Other tabs would keep showing a deleted chat until reconnect. Relaying persisted-only deletions onto the existing `host/session-removed` frame gives every client the identical drop path live disposals already have.

## Consequences

A deleted id is gone everywhere at once: list, search index (rebuilt from persistence observations), workspace groups, archive section, and disk. Orphan edges remain by design and stay invisible: subagent children of a deleted parent keep their logs but render nowhere, attachment blobs referenced only by deleted logs await any future garbage collection, and the projection cache evicts nothing today for cold ids (rows for deleted ids become unreachable). The gateway-created-handle map is process-local: after a host restart every persisted session is cold and deletable, which is the common case.

## Testing

Backend suites pin ordered removal, live refusal, unknown-id absence, event emission, and durability across restarts for both physical backends. The gateway spec drives live disposal — including a session made live by the shared resolver through its retained handle — persisted-only deletion, both busy refusals, the not-found branch, and the removed frame over a coordinator-backed map medium. Component tests cover the dialog gating (cancel commits nothing, confirm calls once, failure keeps the dialog open) and both menus. `apps/web/tests/workspace-management.e2e.ts` forks the seeded session and deletes it over the real wire: cancel first, then confirm, asserting the row, its new log id, and every registry fact are gone.
