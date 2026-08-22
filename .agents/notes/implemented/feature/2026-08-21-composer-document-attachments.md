# Agent Note: Composer document attachments extracted to text

Status: implemented

English | [中文](2026-08-21-composer-document-attachments.zh.md)

## Problem

The composer accepted images only. JSON, Markdown, CSV, PDF, DOCX, and XLSX files from outside the workspace had no path into a prompt: the attachment seam was raster-only, and the model-visible content contract had no place for them. Users resorted to manual copy-paste or workspace staging by hand.

## Decision

Documents are the attachment seam's second intake kind, and they become plain text before anything is durable. The composer's paperclip picker, paste, and drop accept both kinds; a document draft renders as a name chip in the rail and submits as a `document` wire part. At prompt admission the host validates the batch against the store's `documentLimits` and extracts each member's text, wrapping it in a pinned `<document name="…" type="…">` envelope as an ordinary durable text block.

Because the durable record is text, nothing downstream changed: no new session event, no provider serialization, no compaction placeholder, no SDK projection. Model-visible ⟺ logged holds trivially, and every model route — including text-only ones — consumes documents without gating.

Extraction is per-format: text-like media decode as UTF-8 under a binary guard (NUL bytes or dominant replacement glyphs refuse the file); PDF goes through the bundled pdf.js build, DOCX through mammoth's raw-text reader, XLSX workbooks serialize as per-sheet TSV blocks. An empty extraction (empty file, scanned page) fails the prompt loudly instead of attaching nothing. Over-cap extractions are admitted and truncated with a visible `[Document truncated.]` marker; the caps (defaults: 10 MiB per file, 10 documents and 30 MiB per message, 200,000 characters per document) are attachment-backend config, projected to the client as `documentLimits` next to `imageLimits` for the same whole-batch intake pre-check.

The base `AttachmentStore` accepts no documents — its default policy carries an empty media-type list so every batch refuses with `UNSUPPORTED_DOCUMENT_TYPE` — and extraction-capable backends override the limits and the per-file extractor. Slash commands keep their image-only contract: a document attached to an image-accepting command refuses with product copy, and the generic unsupported notice now speaks of attachments.

## Alternatives considered

**A new durable `document` content part.** It would ripple through the session log contract, every provider adapter, compaction placeholders, and both SDK projections to carry bytes no provider accepts natively. Extracting at admission keeps the wire honest and the log portable.

**Workspace handoff (save the file, tell the agent where it is).** Zero dependencies and format-agnostic forever, but content never reaches the context automatically, an extra tool round-trip per use, and it needs materialization plumbing into the session workspace. Chosen against after the inline-extraction decision; revisitable as a companion for oversized files.

**Client-side extraction.** Keeps the host thin but bundles pdf.js, mammoth, and ExcelJS into the browser payload and duplicates admission policy. Server-side extraction keeps one limit story and one dependency set.

## Consequences

Documents work on every route with three new runtime dependencies in the local attachment backend (unpdf, mammoth, exceljs). Extraction quality is that of the parsers: layout-heavy PDFs and merged spreadsheet cells extract imperfectly, scanned PDFs fail loudly, and legacy binary formats (.doc, .xls, .ppt) are refused by name. Large documents consume context proportionally to their extracted text, bounded by the character cap and truncation marker.

## Testing

The local-backend spec round-trips a hand-built PDF, a hand-built DOCX zip, and an ExcelJS-written workbook, and pins the binary guard, empty-extraction refusal, batch limit order, truncation marker, and the accepting-nothing base policy. The api-proxy spec pins the durable envelope text and the unsupported-type refusal. Composer specs cover mixed-kind intake, limit pre-checks per kind, the document wire part, the command-plane refusal, and the picker accept hint. `DSH_SNAPSHOT=replay pnpm run test:web` pins the assembled composer output.
