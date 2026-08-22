/**
 * Text extraction for the document attachment path: one dispatcher over the
 * accepted media types plus one extractor per format. Every failure is a
 * caller-correctable {@link AttachmentError} naming what to change; parser
 * internals never leak into diagnostics.
 *
 * Extraction is a pure bytes-to-text transform — no storage, no request
 * policy. The caller owns limits enforcement around these functions.
 * @module @deepseek-ai/dsh-attachment-local/document-text
 */

import { extractText, getDocumentProxy } from 'unpdf'
import type { DocumentMediaType, SubmitDocumentAttachment } from '@deepseek-ai/dsh-attachment'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'

/** UTF-8 text-like formats decoded without a format-specific parser. */
const TEXT_LIKE_MEDIA_TYPES: ReadonlySet<DocumentMediaType> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
])

/** Maximum share of replacement glyphs a text-like decode may contain before the bytes are judged binary. */
const MAX_REPLACEMENT_RATIO = 0.01

/**
 * Extract the model-visible text of one uploaded document.
 * @param input - declared media type and raw source bytes.
 * @returns extracted text; empty text is a refusal, not an empty success.
 * @throws AttachmentError with `UNSUPPORTED_DOCUMENT_TYPE` for a type no extractor owns,
 * or `DOCUMENT_EXTRACTION_FAILED` when the bytes do not parse as their declared format.
 */
export async function extractDocumentText(input: SubmitDocumentAttachment): Promise<string> {
  try {
    const text = TEXT_LIKE_MEDIA_TYPES.has(input.mediaType)
      ? decodeTextLike(input)
      : await extractBinaryDocument(input)
    if (text.trim() === '') {
      throw new AttachmentError(
        'No text could be extracted from this document; it may be empty, scanned, or purely graphical.',
        'DOCUMENT_EXTRACTION_FAILED',
      )
    }
    return text
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError(
      `This file could not be read as ${input.mediaType}.`,
      'DOCUMENT_EXTRACTION_FAILED',
      { cause: error },
    )
  }
}

/** Decode UTF-8 text-like bytes, refusing binary payloads masquerading as text. */
function decodeTextLike(input: SubmitDocumentAttachment): string {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(input.data)
  let replacements = 0
  for (const character of decoded) {
    // U+FFFD is emitted for every malformed sequence; a run of them means the
    // payload is binary (or an incompatible encoding), not sloppy text.
    if (character === '\uFFFD') replacements += 1
    if (character === '\0') throw new Error('document contains NUL bytes')
  }
  if (replacements / Math.max(decoded.length, 1) > MAX_REPLACEMENT_RATIO) {
    throw new Error('document is not valid UTF-8 text')
  }
  return decoded
}

/** Dispatch one binary document to its format extractor. */
async function extractBinaryDocument(input: SubmitDocumentAttachment): Promise<string> {
  switch (input.mediaType) {
    case 'application/pdf': return extractPdfText(input.data)
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocxText(input.data)
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return await extractXlsxText(input.data)
    default:
      throw new AttachmentError(
        `Document type ${input.mediaType} is not accepted by this deployment.`,
        'UNSUPPORTED_DOCUMENT_TYPE',
      )
  }
}

/** Extract the merged text layer of a PDF through the bundled pdf.js build. */
async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data)
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

/** Extract the raw body text of a .docx package through mammoth. */
async function extractDocxText(data: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: Buffer.from(data) })
  return result.value
}

/** Serialize every worksheet of a workbook as TSV blocks with sheet headers. */
async function extractXlsxText(data: Uint8Array): Promise<string> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(data as never)
  const sheets: string[] = []
  workbook.eachSheet((worksheet) => {
    const rows: string[] = []
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      // `values` is one-based; slot zero is always absent.
      const cells = (row.values as readonly unknown[]).slice(1).map(cellValue)
      rows.push(cells.join('\t'))
    })
    sheets.push(`## ${worksheet.name}\n${rows.join('\n')}`)
  })
  return sheets.join('\n\n')
}


/** The ExcelJS object-cell shapes this renderer understands. */
interface ObjectCell {
  result?: unknown
  richText?: readonly { text?: unknown }[]
  text?: unknown
  error?: unknown
}

/** Single-line text of one resolved cell value; empty for absent values. */
function cellToText(value: unknown): string {
  // Cell payloads are ExcelJS primitives or already-resolved display fields,
  // so stringification never meets a bare object here.
  // oxlint-disable-next-line typescript/no-base-to-string
  return value === undefined || value === null ? '' : String(value).replace(/[\t\r\n]+/gu, ' ')
}

/** Render one worksheet cell value as plain single-line text; computed results win over formulas. */
function cellValue(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return cellToText(raw)
  // ExcelJS object cells: formula results win over formulas, rich text joins
  // its runs, hyperlinks keep their display text, errors render their code.
  // Unknown future shapes normalize to an empty cell instead of leaking a
  // structural dump into the model-visible text.
  const record = raw as ObjectCell
  if ('result' in record) return cellToText(record.result)
  if (record.richText !== undefined) {
    return record.richText.map(run => cellToText(run.text)).join('')
  }
  if ('text' in record) return cellToText(record.text)
  if ('error' in record) return cellToText(record.error)
  return ''
}
