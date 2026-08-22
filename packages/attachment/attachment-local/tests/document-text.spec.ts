// Document text extraction: per-format extractors, the binary guard, and the
// store-level batch policy (limits order, truncation marker, no-partial rule).

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AttachmentError, DOCUMENT_TRUNCATION_MARKER } from '@deepseek-ai/dsh-attachment'
import type { DocumentMediaType, SubmitDocumentAttachment } from '@deepseek-ai/dsh-attachment'
import { extractDocumentText } from '../src/document-text.ts'
import LocalAttachmentStore from '../src/index.ts'

function document(mediaType: DocumentMediaType, bytes: Uint8Array | string, name?: string): SubmitDocumentAttachment {
  return {
    mediaType,
    data: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
    ...(name === undefined ? {} : { name }),
  }
}

/** Minimal CRC32 for the hand-built .docx zip (IEEE 802.3, reflected). */
function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (~crc) >>> 0
}

/**
 * Build a minimal stored-entry ZIP archive. mammoth reads the three members a
 * Word package needs; entries are uncompressed so the writer stays trivial.
 */
function zip(entries: readonly { name: string; body: string }[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const body = encoder.encode(entry.body)
    const crc = crc32(body)
    const local = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(8, 0, true) // stored
    view.setUint32(14, crc, true)
    view.setUint32(18, body.length, true)
    view.setUint32(22, body.length, true)
    view.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    chunks.push(local, body)
    const directory = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(directory.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(8, 20, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, body.length, true)
    centralView.setUint32(24, body.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    directory.set(nameBytes, 46)
    central.push(directory)
    offset += local.length + body.length
  }
  const directoryOffset = offset
  const directorySize = central.reduce((sum, entry) => sum + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, directorySize, true)
  endView.setUint32(16, directoryOffset, true)
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + directorySize + 22
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

/** A one-page PDF whose text layer carries the fixture sentence. */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const startxref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`
  return new TextEncoder().encode(body)
}

function docx(bodyText: string): Uint8Array {
  return zip([
    {
      name: '[Content_Types].xml',
      body: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      body: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1"'
        + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"'
        + ' Target="word/document.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'word/document.xml',
      body: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + `<w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ])
}

describe('document text extraction', () => {
  it('decodes text-like formats directly', async () => {
    await expect(extractDocumentText(document('text/plain', 'hello notes'))).resolves.toBe('hello notes')
    await expect(extractDocumentText(document('text/markdown', '# Title\nbody'))).resolves.toBe('# Title\nbody')
    await expect(extractDocumentText(document('text/csv', 'a,b\n1,2'))).resolves.toBe('a,b\n1,2')
    await expect(extractDocumentText(document('application/json', '{"k":1}'))).resolves.toBe('{"k":1}')
  })

  it('refuses binary bytes posing as text and empty documents', async () => {
    const nul = document('text/plain', new Uint8Array([104, 0, 105]))
    await expect(extractDocumentText(nul)).rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_FAILED' })
    const mojibake = document('text/plain', new Uint8Array([0xFF, 0xFE, 0xFF, 0xFE]))
    await expect(extractDocumentText(mojibake)).rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_FAILED' })
    await expect(extractDocumentText(document('text/plain', '   '))).rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_FAILED' })
    // Outside the accepted union entirely: refused by name before any parser runs.
    await expect(extractDocumentText(document('text/rtf' as never, '{rtf}')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT_TYPE' })
  })

  it('extracts the PDF text layer', async () => {
    await expect(extractDocumentText(document('application/pdf', minimalPdf('Hello fixture PDF'))))
      .resolves.toContain('Hello fixture PDF')
  })

  it('extracts .docx body text through the Word package reader', async () => {
    await expect(extractDocumentText(document(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docx('Fixture document body'),
    ))).resolves.toContain('Fixture document body')
  })

  it('serializes every worksheet of a workbook as TSV blocks', async () => {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Scores')
    sheet.addRow(['name', 'score'])
    sheet.addRow(['alpha', 3])
    // Formula results win over formulas; rich text joins its runs; a
    // hyperlink renders its display text.
    const special = workbook.addWorksheet('Special')
    special.addRow([
      { formula: '1+1', result: 2 },
      { richText: [{ text: 'rich' }, { text: '-cell' }] },
      { text: 'Docs', hyperlink: 'https://example.test' },
      { error: '#N/A' },
    ])
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
    const text = await extractDocumentText(document(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes,
    ))
    expect(text).toContain('## Scores')
    expect(text).toContain('name\tscore')
    expect(text).toContain('alpha\t3')
    expect(text).toContain('## Special')
    expect(text).toContain('2\trich-cell\tDocs')
    expect(text).toContain('#N/A')
  })

  it('refuses corrupt binary documents with the declared format named', async () => {
    await expect(extractDocumentText(document('application/pdf', new Uint8Array([1, 2, 3]))))
      .rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_FAILED' })
  })
})

describe('document batch admission', () => {
  function storeWith(overrides: Partial<ConstructorParameters<typeof LocalAttachmentStore>[1]> = {}): LocalAttachmentStore {
    return new LocalAttachmentStore(new Context(), overrides)
  }

  it('extracts a mixed batch in order, carrying names through', async () => {
    const store = storeWith()
    const extracted = await store.extractDocuments([
      document('text/plain', 'first body', 'first.txt'),
      document('application/json', '{"k":2}'),
    ])
    expect(extracted).toHaveLength(2)
    expect(extracted[0]).toMatchObject({ name: 'first.txt', text: 'first body' })
    expect(extracted[1]?.text).toBe('{"k":2}')
    expect(extracted[1]?.name).toBeUndefined()
  })

  it('applies limits in batch order: count, aggregate bytes, type, per-file bytes', async () => {
    const store = storeWith({
      maxDocumentsPerMessage: 2,
      maxMessageDocumentBytes: 10,
      maxDocumentBytes: 4,
    })
    const text = 'abcdef'
    await expect(store.extractDocuments([
      document('text/plain', 'a'), document('text/plain', 'b'), document('text/plain', 'c'),
    ])).rejects.toMatchObject({ code: 'TOO_MANY_DOCUMENTS' })
    await expect(store.extractDocuments([
      document('text/plain', text), document('text/plain', text),
    ])).rejects.toMatchObject({ code: 'DOCUMENTS_TOO_LARGE' })
    await expect(store.extractDocuments([document('application/x-unknown' as never, 'a')]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT_TYPE' })
    await expect(store.extractDocuments([document('text/plain', text)]))
      .rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' })
  })

  it('truncates over-cap extractions with the pinned marker', async () => {
    const store = storeWith({ maxExtractedChars: 4 })
    const [extracted] = await store.extractDocuments([document('text/plain', 'abcdefgh')])
    expect(extracted?.text).toBe(`abcd${DOCUMENT_TRUNCATION_MARKER}`)
  })

  it('fails the whole batch on a per-file extraction failure without partial output', async () => {
    const store = storeWith()
    await expect(store.extractDocuments([
      document('text/plain', 'fine'),
      document('application/pdf', new Uint8Array([1])),
    ])).rejects.toBeInstanceOf(AttachmentError)
  })

  it('a base store accepts no documents at all', async () => {
    const bare = new LocalAttachmentStore(new Context(), {})
    await expect(bare.extractDocuments([document('application/x-octet' as never, 'x')]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT_TYPE' })
  })
})
