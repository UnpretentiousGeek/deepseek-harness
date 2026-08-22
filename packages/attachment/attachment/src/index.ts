/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */

import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentError } from './error.ts'
import { DOCUMENT_TRUNCATION_MARKER } from './document.ts'
import type {
  DocumentAttachmentLimits,
  ExtractedDocument,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
  SubmitDocumentAttachment,
} from './types.ts'

export { AttachmentId, ImageVariantId } from './brand.ts'
export { AttachmentError, isImageAdmissionError } from './error.ts'
export type { AttachmentErrorCode, DocumentAdmissionErrorCode, ImageAdmissionErrorCode } from './error.ts'
export { admitEncodedImages } from './admission.ts'
export { DOCUMENT_TRUNCATION_MARKER } from './document.ts'
export type {
  AttachmentId as AttachmentIdType,
  DocumentAttachmentLimits,
  DocumentMediaType,
  EncodedImageAttachment,
  ExtractedDocument,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  ImageMediaType,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
  SubmitDocumentAttachment,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Deployment-resolved document policy. The base default accepts no
   * documents at all: an empty media-type list makes every batch fail
   * admission with `UNSUPPORTED_DOCUMENT_TYPE`, so a backend without
   * extraction support refuses documents loudly instead of pretending.
   */
  readonly documentLimits: DocumentAttachmentLimits = Object.freeze({
    maxDocumentBytes: 1,
    maxDocumentsPerMessage: 1,
    maxMessageDocumentBytes: 1,
    maxExtractedChars: 1,
    mediaTypes: Object.freeze([]),
  })

  /**
   * Validate one ordered document batch and extract each member's text.
   * Batch failures (count, aggregate bytes, unsupported type, oversize file)
   * start no extraction; a per-file failure fails the whole prompt, matching
   * the image path's no-partial-admission rule.
   * @param inputs - uploaded documents in their owning message order.
   * @param signal - optional cancellation for extraction work.
   * @returns extracted texts in the exact input order, truncated at the configured cap.
   * @throws an `AttachmentError` carrying a caller-correctable code for every refusal.
   */
  async extractDocuments(
    inputs: readonly SubmitDocumentAttachment[],
    signal?: AbortSignal,
  ): Promise<readonly ExtractedDocument[]> {
    const { maxDocumentsPerMessage, maxMessageDocumentBytes, maxDocumentBytes, mediaTypes } = this.documentLimits
    if (inputs.length > maxDocumentsPerMessage) {
      throw new AttachmentError('Document batch exceeds the configured document-count limit.', 'TOO_MANY_DOCUMENTS')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageDocumentBytes) {
      throw new AttachmentError('Document batch exceeds the configured aggregate document-byte limit.', 'DOCUMENTS_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Document type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_DOCUMENT_TYPE')
      }
      if (input.data.byteLength > maxDocumentBytes) {
        throw new AttachmentError(`Document exceeds the configured ${maxDocumentBytes}-byte limit.`, 'DOCUMENT_TOO_LARGE')
      }
    }
    const extracted: ExtractedDocument[] = []
    for (const input of inputs) {
      signal?.throwIfAborted()
      let text = await this.extractDocumentText(input)
      if (text.length > this.documentLimits.maxExtractedChars) {
        text = text.slice(0, this.documentLimits.maxExtractedChars) + DOCUMENT_TRUNCATION_MARKER
      }
      extracted.push({
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
        text,
      })
    }
    return extracted
  }

  /**
   * Extract the raw text of one already size-validated document. The base
   * implementation refuses every format, matching the accepting-nothing
   * default policy; extraction-capable backends override it.
   * @param input - declared media type and source bytes.
   * @returns extracted text; empty text is refused by the caller as a failed extraction.
   * @throws an `AttachmentError` with `UNSUPPORTED_DOCUMENT_TYPE`.
   */
  protected extractDocumentText(input: SubmitDocumentAttachment): Promise<string> {
    void input
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot extract document text.',
      'UNSUPPORTED_DOCUMENT_TYPE',
    ))
  }

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * Validate one ordered image batch before committing any member.
   * Validation failures start no writes; storage failures return no partial
   * references, although already published content-addressed objects may stay
   * unreachable until a future retention policy collects them.
   * @param inputs - encoded images in their owning message order.
   * @returns durable references in the exact input order.
   */
  protected validateImageBatch(inputs: readonly SaveImageAttachment[]): void {
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
      }
    }
  }

  /**
   * Validate and durably commit one ordered image batch.
   * @param inputs - encoded images in owning-message order.
   * @returns durable normalized attachment references in the same order after every member succeeds.
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    for (const input of inputs) await this.validateImage(input)

    const refs: ImageAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * The returned reference describes the persisted normalized image. When
   * normalization reduces the raster, its `originalDimensions` records the
   * orientation-applied input dimensions.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns the durable content-addressed normalized image reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and normalized attachment reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

  /**
   * Generate or read one deterministic model-request version from the stored normalized image.
   * @param ref - durable provider-independent normalized attachment reference.
   * @param policy - exact route pixel and encoded-byte budget.
   * @param signal - optional cancellation.
   * @returns request bytes and the cache/upload identity covering every transform input.
   */
  readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    void ref
    void policy
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot derive model-request images.',
      'ATTACHMENT_PROJECTION_UNSUPPORTED',
    ))
  }

}

export default AttachmentStore
