/** Model-visible constants shared by the document extraction path. @module @deepseek-ai/dsh-attachment/document */

/**
 * Marker appended to extracted text that hit the configured character cap.
 * Pinned model-visible text: it tells the model (and transcript readers) that
 * the attachment continues beyond what the message carries.
 */
export const DOCUMENT_TRUNCATION_MARKER = '\n\n[Document truncated.]'
