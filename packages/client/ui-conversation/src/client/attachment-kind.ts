/** Browser-side file classification for the composer intake. @module */

import type { DocumentMediaType, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Unsupported browser-declared document type, localized by the UI boundary. */
export class UnsupportedDocumentMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported document media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedDocumentMediaTypeError'
    this.mediaType = mediaType
  }
}

/** Document media types a File object may already declare on its `type` field. */
const DOCUMENT_BY_MEDIA_TYPE: ReadonlyMap<string, DocumentMediaType> = new Map([
  ['text/plain', 'text/plain'],
  ['text/markdown', 'text/markdown'],
  ['text/csv', 'text/csv'],
  ['application/json', 'application/json'],
  ['application/pdf', 'application/pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])

/**
 * Extension fallbacks for files whose browser-declared type is empty or
 * generic (`application/octet-stream`). Plain-text code and config formats
 * ride as `text/plain`; the host extraction path is format-agnostic there.
 */
const DOCUMENT_BY_EXTENSION: ReadonlyMap<string, DocumentMediaType> = new Map([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['mdx', 'text/markdown'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['jsonl', 'text/plain'],
  ['ndjson', 'text/plain'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ...(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'lua', 'sql', 'r',
    'html', 'css', 'scss', 'vue', 'svelte', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
    'conf', 'env', 'log', 'diff', 'patch'] as const).map(extension => [extension, 'text/plain'] as const),
])

/** One browser file resolved to its composer attachment kind and wire media type. */
export type ClassifiedAttachment =
  | { kind: 'image'; mediaType: ImageMediaType }
  | { kind: 'document'; mediaType: DocumentMediaType }

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Image media types offered to the file picker before the limits frame arrives. */
export const DEFAULT_PICKER_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Document extensions offered to the file picker: browsers report empty or
 * generic types for text-like files, so the picker needs the spellings.
 */
export const DOCUMENT_PICKER_EXTENSIONS: readonly string[] = [
  '.txt', '.md', '.markdown', '.mdx', '.csv', '.json', '.jsonl', '.ndjson',
  '.pdf', '.docx', '.xlsx',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh',
  '.fish', '.lua', '.sql', '.r', '.html', '.css', '.scss', '.vue', '.svelte', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.diff', '.patch',
]

/**
 * Classify one browser file into the image or document intake path.
 * @param file - the picked, pasted, or dropped browser file.
 * @returns the attachment kind with its canonical wire media type.
 * @throws UnsupportedDocumentMediaTypeError for every unrecognized declaration.
 */
export function classifyBrowserFile(file: File): ClassifiedAttachment {
  if (file.type.startsWith('image/')) {
    if (IMAGE_MEDIA_TYPES.has(file.type)) return { kind: 'image', mediaType: file.type as ImageMediaType }
    throw new UnsupportedDocumentMediaTypeError(file.type.length > 0 ? file.type : file.name)
  }
  const byType = DOCUMENT_BY_MEDIA_TYPE.get(file.type)
  if (byType !== undefined) return { kind: 'document', mediaType: byType }
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const byExtension = DOCUMENT_BY_EXTENSION.get(extension)
  if (byExtension !== undefined) return { kind: 'document', mediaType: byExtension }
  throw new UnsupportedDocumentMediaTypeError(file.type.length > 0 ? file.type : file.name)
}
