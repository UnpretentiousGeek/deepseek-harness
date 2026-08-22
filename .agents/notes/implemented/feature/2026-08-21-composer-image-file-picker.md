# Agent Note: Composer paperclip file picker for image intake

Status: implemented

English | [中文](2026-08-21-composer-image-file-picker.zh.md)

## Problem

Draft images could enter the composer only through clipboard paste and document-level drag-drop. Both paths are invisible: nothing in the composer tells a user that attachments exist, and picking a screenshot from disk requires knowing a gesture first. Every other surface of the composer has a visible control, so media input alone was undiscoverable.

## Decision

The composer tool row carries a paperclip button beside the command button. It opens a hidden native file input and routes the picked files through the same intake the paste and drop paths use: the projected `imageLimits` pre-check runs first, and `addImages` stays the authoritative rejection. The button renders only while an attachment face exists, and it is disabled under the same condition that blocks drop acceptance (session lock, submitting, no face).

The input's `accept` hint follows the projected intake media types; when no limits frame has arrived it falls back to the fixed four-type image set. The hint never decides anything: a file the picker lets through is still rejected by `addImages` with the unsupported-type copy. The input clears its value after every change so re-picking the same file fires `change` again.

The button lives in the conversation bar entry, not the attachment presentation plugin. The `conversation.input.attachments` slot owns the draft rail, drop overlay, and lightbox and receives no draft-mutation face; the intake face is already a prop of the bar entry.

## Alternatives considered

**A menu item under the command button.** The "+" button opens the slash-command roster, which is a prompt-language surface, not media intake; nesting the picker there costs two gestures for the most common media action and mislabels the menu.

**Extend the attachment seam to arbitrary files.** The attachment backend, message content parts, and provider serialization are image-only, so generic file attachment is a cross-layer feature with its own product decisions (types, size caps, how non-image bytes become model-visible). The picker ships the capability that exists today; workspace files already reach the agent through @-references.

**Render the button from the ui-attachment plugin.** The slot contract gives that plugin presentation props only, so the button would need a new injected mutation face for one control the bar entry already wires.

## Consequences

Media attachment is discoverable, and all three intake paths share one limit story. The scope stays images: a user with a PDF still references it by path or pastes its text, and the picker's `accept` hint may allow a type the host then refuses. The hidden input is inert without an attachment face, matching the session-less composer posture.

## Testing

The input-bar spec covers the picker opening through the paperclip, picked files riding the shared intake with the value reset, the empty-pick no-op, the `accept` derivation from projected limits and the fallback set, absence without an attachment face, and the submitting-phase lock. `DSH_SNAPSHOT=replay pnpm run test:web` pins the assembled composer output.
