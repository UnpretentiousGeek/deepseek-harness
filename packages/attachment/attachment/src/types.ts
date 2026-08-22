/** Durable attachment vocabulary. @module @deepseek-ai/dsh-attachment/types */

import type { AttachmentId, ImageVariantId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable reference to one immutable normalized image. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number
    height: number
  }
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

/** Base64-encoded image upload accompanying one wire request. */
export interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/** Deterministic request-image policy selected by one exact model route. */
export interface ImageRequestPolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number
  /** Encoded-byte cap before base64 expansion or Files API upload. */
  maxBytes: number
}

/** Cached request version derived from one provider-independent normalized attachment. */
export interface RequestImageAttachment {
  /** Cache and upload-index key over the attachment id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId
  /** Durable normalized attachment from which this request version was derived. */
  attachment: ImageAttachmentRef
  /** Encoded request bytes. */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar'
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb'
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean
}

/**
 * Document formats accepted by the text-extraction path. Text-like formats
 * decode directly; the three binary formats have dedicated extractors. Legacy
 * binary formats without a maintained extractor (`.doc`, `.xls`, `.ppt`) are
 * deliberately absent — admission refuses them by name instead of guessing.
 */
export type DocumentMediaType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'application/json'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Deployment-resolved limits used by document upload admission. */
export interface DocumentAttachmentLimits {
  /** Maximum encoded source bytes for one document. */
  maxDocumentBytes: number
  /** Maximum documents in one submitted message. */
  maxDocumentsPerMessage: number
  /** Maximum aggregate encoded document bytes in one submitted message. */
  maxMessageDocumentBytes: number
  /** Maximum extracted characters per document before truncation marks it. */
  maxExtractedChars: number
  mediaTypes: readonly DocumentMediaType[]
}

/** Base64-encoded document upload accompanying one wire request. */
export interface EncodedDocumentAttachment {
  /** Declared media type; verified against the bytes during extraction. */
  mediaType: DocumentMediaType
  /** Canonical base64 encoding of the document bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/** Request to validate and extract text from one uploaded document. */
export interface SubmitDocumentAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against the bytes by the extractor. */
  mediaType: DocumentMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Extracted text projection of one admitted document, in input order. */
export interface ExtractedDocument {
  mediaType: DocumentMediaType
  /** Optional display name carried through to the model-visible envelope. */
  name?: string
  /** Extracted UTF-8 text, truncated at the configured character cap. */
  text: string
}
