/**
 * Browser-safe background-job domain contract. The registry's live records
 * never cross the wire; a view is the subset a human list needs, minted fresh
 * per push. The one write the web surface exposes is a human-initiated kill of
 * a job the requesting session can see.
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * One background job as the client sees it.
 *
 * Three registry fields are deliberately absent. `ownerSession` is redundant
 * beside the frame's own `sessionId`; `reported` is an internal notice-delivery
 * bit with no user meaning; `outputLimitBytes` is producer-owned model
 * presentation policy that never reaches a human surface.
 */
export interface JobView {
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId
  /**
   * Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …). Kept as a bare
   * string because producer plugins extend the kind map by declaration merging,
   * so no client build can enumerate the closed set.
   */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail ('exit code: 3'), present once the producer supplied one. */
  detail?: string
  /** Epoch ms when the task was registered. */
  startedAt: number
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number
}

/** Uniform acknowledgement that one human-initiated kill was admitted. */
export interface JobKillReceipt {
  /** `requested` for live work the registry asked to stop; `already-finished` otherwise. */
  outcome: 'cancellation-requested' | 'already-finished'
}

/** Background-job-domain unary methods (the web surface's single write). */
export interface JobsApi {
  /**
   * Requests cancellation of one job visible from `sessionId` — owned jobs
   * through their exact owner agent, unowned jobs open to every caller, per
   * the registry's own fence. Fire-and-return: the receipt acknowledges the
   * admitted cancel signal, not producer quiescence; the row settles as
   * `killed` through the ordinary change pushes. A live owner is told about a
   * requested stop through an injected model-facing notice, because the kill
   * marks the record reported and would otherwise suppress its completion
   * notice.
   */
  kill(
    request: RpcRequest<{ sessionId: SessionId; jobId: JobId; reason?: string }>,
  ): Promise<RpcResponse<JobKillReceipt>>
}
