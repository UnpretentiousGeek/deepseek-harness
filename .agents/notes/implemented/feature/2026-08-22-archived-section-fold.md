# Agent Note: Collapsible Archived Sidebar Section

Status: implemented

English | [中文](2026-08-22-archived-section-fold.zh.md)

## Problem

The sidebar's trailing Archived section rendered every archived session unconditionally. A long archive — the section's normal state, since archiving is the low-friction alternative to deleting — pushed it to the same height a busy Workspace group can reach, while Workspace groups already folded. The section needed the same folding affordance without inventing a second interaction model or losing the archive count when folded.

## Decision

The Archived section header is a disclosure control styled like a Workspace folder row: hover and keyboard focus swap the archive glyph for the same filled triangle chevron, which points right folded and rotates 90° open. Activating the header toggles the section's rows; the header and its session count stay visible while folded, so the section remains discoverable and the count keeps answering "is anything archived?" at a glance.

The fold state lives in the browser-persisted workspace viewing store (`archivedExpanded`, default expanded) alongside Workspace group expansion ([sidebar order and folding](2026-08-11-workspace-sidebar-order-and-folding.md)), and the grouped tree and flat list share it: folding in one presentation folds the other, because both render the same trailing section. The store's persistence key bumped to `dsh.workspace.view.v6` — persistence is whole-value JSON, so a stored pre-v6 value would otherwise replace the state and leave `archivedExpanded` undefined.

The section still renders nothing while the archive set is empty, and archived rows remain outside the drag/order machinery.

## Alternatives considered

**Component-local `useState` in each list body.** Folding would reset on every wide/rail and grouped/flat remount, and the two list components would disagree about the section's state.

**Reuse `groupExpansion` with a reserved key.** The same store action already prunes `groupExpansion` entries against the retained workspace account keys, so the archived key would need a pruning carve-out and the field's documented meaning ("per-Workspace identity") would silently widen.

**Keep the old key and coalesce `undefined` to expanded at the read sites.** Every reader would carry migration logic for a value the type promises never to hold; the version bump moves the cost to a one-time reset of browser-local viewing preferences.

## Consequences

- A collapsed archive no longer crowds the sidebar, and the fold survives reloads and presentation switches.
- The one-time v5→v6 key bump resets grouping mode, order mode, group expansion, and per-account session orders to defaults; browser-local viewing preferences carry no compatibility promise.
- Folding hides rows only — restore/unarchive/delete still operate on visible rows, so no gesture needs to auto-expand the section today.

## Testing

Component tests cover default-expanded rendering, folding to a hidden row list with the header and count intact, fold persistence across a full unmount/remount through the persisted store, and one shared fold state across the grouped and flat presentations.
