/**
 * session.delete gateway behavior: permanent removal of a session's stored
 * log (a coordinator-backed in-memory medium, so the real live-session guard
 * and removal event apply), its workspace accounting slot, and its
 * archive-set entry. Running turns and live sessions owned outside this
 * gateway refuse with `agent-busy`; unknown ids answer `session-not-found`.
 * Every committed removal reaches clients as `host/session-removed` — the
 * disposal edge for a disposed live session, the persistence-removed push
 * for a persisted-only one.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type {
  Session, SessionEvent, SessionHeader, SessionPreparation,
} from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import {
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  PersistenceBackend, StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`delete-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(
  stream: AsyncIterator<RpcRequest<HostFrame>>,
): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

function stubAgent(session: Session, status: 'idle' | 'running' = 'idle'): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status,
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
  } as never
}

/** One-turn durable log used to materialize seeded sessions. */
function oneTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Map-backed backend behind the real coordinator, mirroring the persistence
 * suite's MemoryPersistence: no torn tails, atomic writes, real deletion.
 */
class MapPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-map-delete-spec'

  static inject = ['sessions']

  private readonly coordinator: PersistenceCoordinator<never>

  readonly store = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()

  constructor(ctx: Context) {
    super(ctx)
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this)
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): ReturnType<PersistenceCoordinator['load']> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): ReturnType<PersistenceCoordinator['inspect']> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): ReturnType<PersistenceCoordinator['readFrom']> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  delete(id: SessionId, signal?: AbortSignal): Promise<boolean> {
    return this.coordinator.delete(id, signal)
  }

  locate(): undefined {
    // No physical artifact behind the map medium: raw export and cold probes
    // report absence.
    return undefined
  }

  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    const entry = this.store.get(id)
    if (entry === undefined) return undefined
    return {
      meta: structuredClone(entry.meta),
      events: structuredClone(entry.events),
      revision: SessionPersistenceRevision(revisionOf(entry)),
    }
  }

  async readStoredRevision(id: SessionId) {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : SessionPersistenceRevision(revisionOf(entry))
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], _materialized: boolean): Promise<void> {
    const existing = this.store.get(meta.id)
    if (existing === undefined) {
      this.store.set(meta.id, { meta: structuredClone(meta), events: structuredClone(events) as SessionEvent[] })
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    const entry = this.store.get(meta.id)
    /* v8 ignore next -- repairs only run for stored sessions */
    if (entry !== undefined && closers.length > 0) entry.events.push(...structuredClone(closers))
  }

  async list(): Promise<SessionHeader[]> {
    return [...this.store.values()].map(entry => structuredClone(entry.meta))
  }

  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return [...this.store.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(revisionOf(entry)),
    }))
  }

  async deleteStored(id: SessionId): Promise<boolean> {
    return this.store.delete(id)
  }
}

function revisionOf(entry: { meta: SessionHeader; events: SessionEvent[] }): string {
  return `${entry.meta.id}:${entry.events.length}`
}

/**
 * Compose the API over real Session/Agent/Storage/Domain/Workspace services
 * plus the coordinator-backed map medium. Agent handles created through the
 * factory detach their session on disposal exactly like the production
 * registry teardown.
 */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)

  const forgetten: SessionId[] = []
  const medium = await ctx.plugin(MapPersistence)
  const persistence = ctx.sessionPersistence as MapPersistence
  await ctx.plugin(WorkspaceRegistry)
  // Wrap forgetSession to observe purge calls without replacing the real logic.
  const realForget = ctx.workspaceRegistry.forgetSession.bind(ctx.workspaceRegistry)
  ctx.workspaceRegistry.forgetSession = async (id: SessionId) => {
    forgetten.push(id)
    await realForget(id)
  }

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.prepare(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      return {
        agent,
        dispose: () => {
          detach()
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume(_ownerCtx, options) {
      // A resume publishes the coordinator's reserved Session — the exact
      // object its `session/created` listener consumes — so the preparation
      // comes from `persistence.prepare`, never `sessions.prepare`, and
      // publication mirrors the production factory's enter/announce order.
      using preparation = await persistence.prepare(options.resumeSessionId)
      const session = preparation.session
      const agent = stubAgent(session)
      const detachSession = ctx.sessions.enter(session)
      const unregister = ctx.agents.enter(agent, undefined)
      ctx.sessions.announce(session)
      ctx.agents.announce(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          detachSession()
          return Promise.resolve()
        },
      }
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: '/tmp',
  })
  return { api, ctx, persistence, forgetten, mediumFiber: medium }
}

describe('gateway session deletion', () => {
  it('deletes an archived persisted session: purges medium, archive set, and accounting', async () => {
    const { api, persistence, forgetten, mediumFiber } = await harness()
    try {
      const header: SessionHeader = {
        id: SessionId('delete-archived'), version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: '/tmp', delegationDepth: 0,
      }
      await persistence.create(header)
      await persistence.append(header.id, oneTurn())

      // Archive first so deletion must also clear the archive set.
      expectOk(await api.workspace.archiveSession(request({ sessionId: header.id })))
      expect(expectOk(await api.workspace.list(request({}))).archivedSessionIds).toEqual([header.id])

      const removed = expectOk(await api.sessions.delete(request({ sessionId: header.id })))
      expect(removed.deleted).toBe(true)
      expect(persistence.store.has(header.id)).toBe(false)
      expect(forgetten).toEqual([header.id])
      expect(expectOk(await api.workspace.list(request({}))).archivedSessionIds).toEqual([])
      expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId))
        .not.toContain(header.id)
    } finally {
      await mediumFiber.dispose()
    }
  })

  it('deletes a persisted-only session without any live edge', async () => {
    const { api, persistence, mediumFiber } = await harness()
    try {
      const header: SessionHeader = {
        id: SessionId('delete-cold'), version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: '/tmp', delegationDepth: 0,
      }
      await persistence.create(header)
      await persistence.append(header.id, oneTurn())
      expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId))
        .toContain(header.id)

      expectOk(await api.sessions.delete(request({ sessionId: header.id })))
      expect(persistence.store.has(header.id)).toBe(false)
      expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId))
        .not.toContain(header.id)
    } finally {
      await mediumFiber.dispose()
    }
  })

  it('deletes a session made live by the shared resolver through its retained handle', async () => {
    const { api, ctx, persistence, forgetten, mediumFiber } = await harness()
    try {
      const header: SessionHeader = {
        id: SessionId('delete-resolver-live'), version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: '/tmp', delegationDepth: 0,
      }
      await persistence.create(header)
      await persistence.append(header.id, oneTurn())

      // A generic entry point (the model catalog) resolves the cold identity
      // through the shared resolver instead of ensureSession; its resume must
      // still land in the gateway's retained-handle map.
      ctx.provide('llm', { listProviders: () => [] } as never)
      const modelsResponse = await api.sessions.models(request({ sessionId: header.id }))
      expect(expectOk(modelsResponse).routable !== undefined).toBe(true)
      expect(ctx.agents.get(header.id)).toBeDefined()

      const deleteResponse = await api.sessions.delete(request({ sessionId: header.id }))
      expect(expectOk(deleteResponse).deleted).toBe(true)
      expect(ctx.agents.get(header.id)).toBeUndefined()
      expect(persistence.store.has(header.id)).toBe(false)
      expect(forgetten).toEqual([header.id])
    } finally {
      await mediumFiber.dispose()
    }
  })

  it('refuses a running turn and a foreign live session with agent-busy, and an unknown id with session-not-found', async () => {
    const { api, ctx, persistence, mediumFiber } = await harness()
    try {
      const running = ctx.sessions.create(SessionId('delete-running'))
      ctx.agents.register(stubAgent(running, 'running'))
      const foreign = ctx.sessions.create(SessionId('delete-foreign'))
      ctx.agents.register(stubAgent(foreign, 'idle'))

      const busyRunning = await api.sessions.delete(request({ sessionId: running.id }))
      expect(busyRunning.result).toMatchObject({
        ok: false,
        error: { code: 'agent-busy', details: { reason: 'turn-running' } },
      })
      const busyForeign = await api.sessions.delete(request({ sessionId: foreign.id }))
      expect(busyForeign.result).toMatchObject({
        ok: false,
        error: { code: 'agent-busy', details: { reason: 'foreign-live-owner' } },
      })

      const missing = await api.sessions.delete(request({ sessionId: SessionId('delete-ghost') }))
      expect(missing.result).toMatchObject({
        ok: false,
        error: { code: 'session-not-found' },
      })
      expect(persistence.store.size).toBe(0)
    } finally {
      await mediumFiber.dispose()
    }
  })

  it('pushes host/session-removed for a persisted-only deletion', async () => {
    const { api, persistence, mediumFiber } = await harness()
    try {
      const header: SessionHeader = {
        id: SessionId('delete-frame'), version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: '/tmp', delegationDepth: 0,
      }
      await persistence.create(header)
      await persistence.append(header.id, oneTurn())

      const abort = new AbortController()
      const stream: AsyncIterator<RpcRequest<HostFrame>> =
        api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
      const removed = nextHostFrame(stream)
      expectOk(await api.sessions.delete(request({ sessionId: header.id })))
      expect(await removed).toMatchObject({
        payload: { type: 'host/session-removed', sessionId: header.id },
      })
      abort.abort()
    } finally {
      await mediumFiber.dispose()
    }
  })
})
