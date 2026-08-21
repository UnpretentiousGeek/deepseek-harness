/**
 * Background-task carrier paths of the host ApiProxy: the subscription
 * baseline is sent only for a session that has tasks, every registry change
 * pushes that owner's whole set, an unowned change fans out to every
 * subscribed session, the projection drops the three internal snapshot
 * fields, a composition without `ctx.jobs` emits nothing, and listing never
 * resumes a cold session.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

type JobFrame = Extract<MuxFrame, { type: 'session/jobs' }>

/**
 * A producer whose settlement the test drives. `cancel` deliberately does not
 * settle, so a kill is observable as the distinct `stopping` step before the
 * test supplies the terminal outcome and its detail.
 */
function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  // A stream producer, so the carrier CAN consume the cursor if it ever calls
  // `read()`; `reads` is what proves it never does.
  const reads = { count: 0 }
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      readOutput: () => { reads.count += 1; return 'stolen output' },
    }),
  }
  return { spec, reads, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

async function harness(withRegistry: boolean): Promise<{
  ctx: Context
  session: Session
  agent: Agent
  /** The owner agent's injected-notice spy (the model-facing stop account). */
  inject: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('api-proxy-test')
  }
  const session = ctx.sessions.create()
  const inject = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    inject,
    ctx,
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, session, agent, inject }
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

/** Drain the mux until `count` session/jobs frames arrived, then abort. */
async function collect(
  iterable: AsyncIterable<RpcRequest<MuxFrame>>,
  count: number,
  abort: AbortController,
): Promise<JobFrame[]> {
  const frames: MuxFrame[] = []
  for await (const envelope of iterable) {
    frames.push(envelope.payload)
    if (frames.filter(frame => frame.type === 'session/jobs').length >= count) abort.abort()
  }
  return frames.filter((frame): frame is JobFrame => frame.type === 'session/jobs')
}

describe('session/jobs subscription baseline', () => {
  it('is omitted for a session with no tasks — absence is the empty set', async () => {
    const { ctx, session } = await harness(true)
    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-empty'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.some(frame => frame.type === 'session/subscribed')) abort.abort()
      }
    })()
    await drained
    expect(frames.some(frame => frame.type === 'session/jobs')).toBe(false)
    expect(frames.some(frame => frame.type === 'session/subscribed')).toBe(true)
    void session
  })

  it('carries the live set for a session that already has tasks when the stream opens', async () => {
    const { ctx, session, agent } = await harness(true)
    ctx.jobs.start({ ...producer('pnpm run build').spec, owner: agent })
    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-baseline'), payload: {} }, abort.signal)
    const [baseline] = await collect(stream, 1, abort)
    expect(baseline?.sessionId).toBe(session.id)
    expect(baseline?.jobs).toHaveLength(1)
    const [job] = baseline?.jobs ?? []
    expect(job?.startedAt).toBeTypeOf('number')
    expect({ ...job, startedAt: 0 }).toEqual({
      id: 'bash-1',
      kind: 'bash',
      label: 'pnpm run build',
      status: 'running',
      startedAt: 0,
    })
  })
})

describe('session/jobs change pushes', () => {
  it('pushes the owner\'s whole set on registration, stopping, and settlement', async () => {
    const { ctx, session, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-changes'), payload: {} }, abort.signal)
    const collected = collect(stream, 3, abort)

    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent })
    ctx.jobs.kill(id, agent, 'test')
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })

    const frames = await collected
    expect(frames.map(frame => frame.sessionId)).toEqual([session.id, session.id, session.id])
    expect(frames.map(frame => frame.jobs[0]?.status)).toEqual(['running', 'stopping', 'killed'])
    // Terminal detail rides the same whole-set push; no separate signal.
    expect(frames[2]?.jobs[0]?.detail).toBe('signal: SIGTERM')
    expect(frames[2]?.jobs[0]?.finishedAt).toBeTypeOf('number')
  })

  it('drops ownerSession, reported, and outputLimitBytes from the wire view', async () => {
    const { ctx, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-fields'), payload: {} }, abort.signal)
    const collected = collect(stream, 1, abort)
    ctx.jobs.start({ ...producer().spec, owner: agent, outputLimitBytes: 1_024 })

    const [frame] = await collected
    const fields: readonly string[] = Object.keys(frame?.jobs[0] ?? {})
    expect([...fields].sort()).toEqual(['id', 'kind', 'label', 'startedAt', 'status'])
  })

  it('fans an unowned change out to every subscribed session', async () => {
    const { ctx } = await harness(true)
    const second = ctx.sessions.create()
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-unowned'), payload: {} }, abort.signal)
    const collected = collect(stream, 2, abort)

    ctx.jobs.start(producer('open to every caller').spec)

    const frames = await collected
    expect(new Set(frames.map(frame => frame.sessionId)).size).toBe(2)
    expect(frames.some(frame => frame.sessionId === second.id)).toBe(true)
    for (const frame of frames) expect(frame.jobs[0]?.label).toBe('open to every caller')
  })

  it('serves a cold session the unowned set without resuming it', async () => {
    const { ctx } = await harness(true)
    const coldId = SessionId('session-cold-tasks')
    let loaded = false
    ctx.provide('sessionPersistence', {
      list: async () => [{ version: 0, id: coldId, createdAt: 5, cwd: '/tmp' }],
      locate: () => undefined,
      load: () => { loaded = true; throw new Error('task listing must not load a cold log') },
    } as never)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-cold'), payload: {} }, abort.signal)
    const collected = collect(stream, 1, abort)

    ctx.jobs.start(producer().spec)
    await collected
    expect(loaded).toBe(false)
    expect(ctx.agents.get(coldId)).toBeUndefined()
  })
})

describe('session/jobs without the registry', () => {
  it('emits no frames at all, so the client renders no entry point', async () => {
    const { ctx, session } = await harness(false)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-absent'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.filter(frame => frame.type === 'session/event').length >= 1) abort.abort()
      }
    })()
    session.append('turn/start', { turn: 1 })
    await drained
    expect(frames.some(frame => frame.type === 'session/jobs')).toBe(false)
  })
})

describe('session/jobs never consumes model output', () => {
  it('drives the whole lifecycle without calling the single consuming cursor', async () => {
    // `ctx.jobs.read()` consumes the one output cursor, so a carrier read
    // silently takes bytes the model's `job_output` will never see. The
    // failure is invisible at the call site, which is why this asserts the
    // count rather than trusting review.
    const { ctx, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-no-read'), payload: {} }, abort.signal)
    const collected = collect(stream, 3, abort)

    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent })
    ctx.jobs.kill(id, agent, 'test')
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await collected

    expect(p.reads.count).toBe(0)
  })

  it('reads nothing while minting the subscription baseline either', async () => {
    const { ctx, agent } = await harness(true)
    const p = producer()
    ctx.jobs.start({ ...p.spec, owner: agent })

    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-no-read-baseline'), payload: {} }, abort.signal)
    const [baseline] = await collect(stream, 1, abort)

    expect(baseline?.jobs).toHaveLength(1)
    expect(p.reads.count).toBe(0)
  })
})

describe('session/jobs baseline for a session born after the stream opened', () => {
  it('carries the already-visible unowned set to the new session', async () => {
    const { ctx } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-late-session'), payload: {} }, abort.signal)

    // One unowned task exists before the new session is created; the subscribe
    // frame clears the client mirror, so the baseline has to follow it.
    ctx.jobs.start(producer('visible to every caller').spec)
    const created = ctx.sessions.create()

    const frames = await collect(stream, 2, abort)
    const forNew = frames.filter(frame => frame.sessionId === created.id)
    expect(forNew.at(-1)?.jobs[0]?.label).toBe('visible to every caller')
  })
})

describe('jobs.kill RPC', () => {
  // One ApiProxy per context: createApiProxy registers host-side providers,
  // so a second construction over the same context would collide.
  const proxies = new WeakMap<Context, ReturnType<typeof api>>()
  const proxyFor = (ctx: Context): ReturnType<typeof api> => {
    let proxy = proxies.get(ctx)
    if (proxy === undefined) proxies.set(ctx, proxy = api(ctx))
    return proxy
  }
  const kill = (ctx: Context, sessionId: string, jobId: string) =>
    proxyFor(ctx).jobs.kill({ rpcId: RpcId('t-jobs-kill'), payload: { sessionId: sessionId as never, jobId: jobId as never } })

  it('requests cancellation of an owned live job and reports the outcome', async () => {
    const { ctx, session, agent } = await harness(true)
    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent })

    const response = await kill(ctx, session.id, id)
    expect(response.result).toEqual({ ok: true, value: { outcome: 'cancellation-requested' } })
    // The registry moved to `stopping`; the producer owns the terminal settle.
    expect(ctx.jobs.get(id, agent).status).toBe('stopping')
    // The wire mirror hears the transition through the ordinary change push.
  })

  it('injects a model-facing stop notice into the live owner', async () => {
    const { ctx, session, agent, inject } = await harness(true)
    const id = ctx.jobs.start({ ...producer('pnpm test').spec, owner: agent })

    await kill(ctx, session.id, id)
    expect(inject).toHaveBeenCalledTimes(1)
    const message = inject.mock.calls[0]?.[0] as {
      content: { type: string; text: string }[]
      source: { kind: string; plugin: string; form: string }
    }
    expect(message.content[0]?.text).toContain('bash-1')
    expect(message.content[0]?.text).toContain('stopped by the user')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'web-jobs', form: 'notice' })
  })

  it('answers already-finished for a settled job without injecting', async () => {
    const { ctx, session, agent, inject } = await harness(true)
    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent })
    ctx.jobs.kill(id, agent, 'test')
    p.settle({ status: 'killed' })
    // The registry settles through the producer's done continuation; let the
    // microtask land so the RPC reads the terminal record.
    await Promise.resolve()

    const response = await kill(ctx, session.id, id)
    expect(response.result).toEqual({ ok: true, value: { outcome: 'already-finished' } })
    expect(inject).not.toHaveBeenCalled()
  })

  it('rejects an unknown or foreign job with job-not-found', async () => {
    const { ctx, session, agent } = await harness(true)
    const other = ctx.sessions.create()
    const otherAgent = {
      id: other.id,
      session: other,
      inbox: new Inbox(other, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      inject: vi.fn(),
      ctx,
    } as unknown as Agent
    ctx.agents.register(otherAgent)
    const id = ctx.jobs.start({ ...producer().spec, owner: agent })

    const unknownJob = await kill(ctx, session.id, 'bash-99')
    expect(unknownJob.result.ok).toBe(false)
    const foreign = await kill(ctx, other.id, id)
    expect(foreign.result.ok).toBe(false)
    // Both denials share one code: the requester learns only "not visible".
    if (!unknownJob.result.ok) expect(unknownJob.result.error.code).toBe('job-not-found')
    if (!foreign.result.ok) expect(foreign.result.error.code).toBe('job-not-found')
    expect(ctx.jobs.get(id, agent).status).toBe('running')
  })

  it('serves an unowned job for a cold session without resuming it', async () => {
    const { ctx } = await harness(true)
    const cold = ctx.sessions.create()
    const id = ctx.jobs.start(producer().spec)

    const response = await kill(ctx, cold.id, id)
    expect(response.result).toEqual({ ok: true, value: { outcome: 'cancellation-requested' } })
    expect(ctx.agents.get(cold.id)).toBeUndefined()
  })

  it('reports jobs-unavailable when the composition carries no registry', async () => {
    const { ctx, session } = await harness(false)
    const response = await kill(ctx, session.id, 'bash-1')
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('jobs-unavailable')
  })
})
