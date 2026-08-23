# Agent Note: Session unarchive and the Archived section

Status: implemented

English | [中文](2026-08-21-workspace-session-unarchive.zh.md)

## Problem

Archiving a session was a one-way door in the UI. The registry kept the session's log and its workspace accounting slot, but no surface listed archived sessions and no control reversed the archive, so a mis-click hid a conversation forever (the documented recovery was editing `~/.dsh/storages/workspace.json` by hand with the harness stopped). The [session-archive note](2026-07-31-session-archive-global-set.md) already anticipated the reverse operation — "a future unarchive restores its position" — but nothing downstream existed.

## Decision

`unarchiveSession` now runs the full seam, mirroring `archiveSession` at every role: the registry service removes one id durably while preserving the remaining archive order, `workspace.unarchiveSession` answers the same full-set snapshot the changed frame carries, and the client manager/service install the echo without waiting for the frame.

The idempotence asymmetry between the two directions is deliberate and follows from what each write authorizes. Archiving validates existence because it mints membership; unarchiving only dissolves membership, so it validates nothing — an unknown or already-restored id resolves without writing and the RPC has no business-failure branch. This also keeps stray ids removable: an id can sit in the set after its log is gone, and the only sensible action on a stray is removal.

The sidebar browser grows a trailing **Archived** section in both grouped and flat modes, present only while the set is non-empty. It lists archived sessions newest-first with relative time and live status, outside the drag/order machinery — restoring, not reordering, is the section's single verb. Blank placeholders stay excluded: New Session mints fresh blanks and never reuses an archived one, so an archived blank has nothing to restore into.

Activating an archived row unarchives first and then opens. The runtime sweep clears any current selection still inside the archive set (one rule for local echoes, remote frames, and reconnect baselines), so opening before the unarchive echo lands would drop the restored session straight back to the New Session view. Folding restore into the open gesture keeps the invariant that an open session is always visible; the row menu's Unarchive entry restores without switching the selection for users who are tidying rather than reading.

## Alternatives considered

**A view-options toggle ("show archived") overlaying normal rows.** Archived rows would re-enter the drag/order accounts and search, forcing every derivation and the order stores to reason about two visibility regimes. A separate section keeps the existing derivations untouched: archived stays "excluded everywhere" as one rule, and the section derives its rows independently.

**Restore-on-open without unarchiving.** Making an archived session current would fight the sweep rule directly — the projection would immediately clear it. Changing the sweep to admit open-but-hidden sessions would break its actual guarantee (a hidden row must not stay open behind the list).

**A settings-page archive manager.** Archive/unarchive is a per-conversation gesture that belongs next to the conversations; a detached page would add navigation without adding capability.

## Consequences

Unarchiving restores a session at its retained accounting position, so long-lived manual orders survive archive round trips. The RPC surface gains one method; the wire schema, carrier tables, fixture hosts, test doubles, and generated catalogs all carry the new member because they are compiler- or freshness-coupled to the map. Search still never matches archived sessions; the section is the only place they appear.

## Testing

Registry unit tests cover ordered removal, idempotent no-ops for non-archived and unknown ids, durability across restart, and untouched accounting. Gateway tests cover the round trip including the single snapshot frame per commit. Runtime tests cover unary-echo installation and failure surfacing. Component tests cover the section's rendering in both modes, the restore-then-open ordering, menu unarchive without opening, and rejection logging; tree tests pin the derivation's recency ordering and exclusions. `apps/web/tests/workspace-management.e2e.ts` drives archive → reload → unarchive over the real wire.
