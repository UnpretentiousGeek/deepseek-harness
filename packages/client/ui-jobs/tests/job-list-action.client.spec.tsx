// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId, SessionListState, JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction, type JobListActionProps } from '../src/client/JobListAction.tsx'
import { zh } from '../src/client/locales.ts'

// Live rows render `now - startedAt`, so every assertion needs a pinned clock.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const SESSION = 'session' as SessionId
const START = 1_700_000_000_000
const t: JobListActionProps['t'] = makeTranslate(zh)

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: 'bash-1' as JobView['id'],
    kind: 'bash',
    label: 'pnpm run build',
    status: 'running',
    startedAt: START,
    ...over,
  }
}

/** Default injected kill face: records the call and answers a requested cancellation. */
function killJobMock(): JobListActionProps['killJob'] {
  return vi.fn(() => Promise.resolve({ ok: true as const, value: { outcome: 'cancellation-requested' as const } }))
}

function props(jobs: readonly JobView[] | undefined, killJob: JobListActionProps['killJob'] = killJobMock()): JobListActionProps {
  const state = {
    ids: [SESSION],
    byId: {},
    current: SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: jobs === undefined ? {} : { [SESSION]: jobs },
    currentAddress: undefined,
  } satisfies SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  return { sessionId: SESSION, useSessions, killJob, t } as unknown as JobListActionProps
}

/**
 * Rows in render order as `[kind, label, status, duration]`. Adjacent spans
 * carry no whitespace between them, so the cells are read one element at a
 * time rather than split out of a flattened string.
 */
function rowCells(): string[][] {
  return within(screen.getByRole('list', { name: zh['list.aria'] }))
    .getAllByRole('listitem')
    .map(row => [...row.children]
      .map(cell => cell.textContent ?? '')
      .filter(text => text !== ''))
}

describe('JobListAction visibility', () => {
  it('renders nothing while the session has no jobs', () => {
    const { container } = render(<JobListAction {...props(undefined)} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts only live jobs, and falls back to the total when none are live', () => {
    const { rerender } = render(<JobListAction {...props([job(), job({ id: 'bash-2' as JobView['id'] })])} />)
    expect(screen.getByRole('button', { name: '2 个后台任务运行中' })).toBeDefined()

    rerender(<JobListAction {...props([job({ status: 'completed', finishedAt: START + 3_000 })])} />)
    expect(screen.getByRole('button', { name: '1 个后台任务' })).toBeDefined()
  })

  it('closes and unmounts when the last job disappears while the list is open', () => {
    const { container, rerender } = render(<JobListAction {...props([job()])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeDefined()

    rerender(<JobListAction {...props([])} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('JobListAction rows', () => {
  it('orders live jobs by start, then settled jobs newest-first', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-3' as JobView['id'], label: 'old done', status: 'completed', startedAt: START, finishedAt: START + 1_000 }),
      job({ id: 'bash-4' as JobView['id'], label: 'new done', status: 'failed', startedAt: START, finishedAt: START + 9_000 }),
      job({ id: 'bash-2' as JobView['id'], label: 'later live', startedAt: START + 5_000 }),
      job({ id: 'bash-1' as JobView['id'], label: 'earlier live', startedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells()).toEqual([
      ['bash', 'earlier live', '运行中', '0秒'],
      ['bash', 'later live', '运行中', '0秒'],
      ['bash', 'new done', '已失败', '9秒'],
      ['bash', 'old done', '已完成', '1秒'],
    ])
  })

  it('breaks a settled tie on start order so map iteration never decides it', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'second', status: 'completed', startedAt: START + 10, finishedAt: START + 100 }),
      job({ id: 'bash-1' as JobView['id'], label: 'first', status: 'completed', startedAt: START, finishedAt: START + 100 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => cells[1])).toEqual(['first', 'second'])
  })

  it('prefers the producer detail over the generic status word', () => {
    render(<JobListAction {...props([
      job({ status: 'killed', detail: 'signal: SIGTERM', finishedAt: START + 2_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells()[0]).toContain('signal: SIGTERM')
  })

  it('renders every status word, including the stopping transition', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'a', status: 'running' }),
      job({ id: 'bash-2' as JobView['id'], label: 'b', status: 'stopping' }),
      job({ id: 'bash-3' as JobView['id'], label: 'c', status: 'completed', finishedAt: START }),
      job({ id: 'bash-4' as JobView['id'], label: 'd', status: 'killed', finishedAt: START }),
      job({ id: 'bash-5' as JobView['id'], label: 'e', status: 'failed', finishedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    const words = rowCells().map(cells => cells[2])
    expect(new Set(words)).toEqual(new Set(['运行中', '正在停止', '已完成', '已取消', '已失败']))
  })
})

describe('JobListAction duration', () => {
  it('advances a live row once per second and freezes a settled one', () => {
    vi.setSystemTime(START + 1_000)
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'live' }),
      job({ id: 'bash-2' as JobView['id'], label: 'done', status: 'completed', finishedAt: START + 4_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells()[0]).toContain('1秒')
    expect(rowCells()[1]).toContain('4秒')

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(rowCells()[0]).toContain('3秒')
    expect(rowCells()[1]).toContain('4秒')
  })

  it('widens to minutes and then hours, and never shows a negative figure', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'm', status: 'completed', finishedAt: START + 125_000 }),
      job({ id: 'bash-2' as JobView['id'], label: 'h', status: 'completed', finishedAt: START + 7_380_000 }),
      // A clock that moved backwards must not render a negative duration.
      job({ id: 'bash-3' as JobView['id'], label: 'skew', status: 'completed', startedAt: START + 5_000, finishedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => cells[3])).toEqual(['2小时3分', '2分5秒', '0秒'])
  })

  it('runs no clock while the list is closed', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    render(<JobListAction {...props([job()])} />)
    expect(interval).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button'))
    expect(interval).toHaveBeenCalledTimes(1)
  })

  it('runs no clock for an open list holding only settled jobs', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    render(<JobListAction {...props([job({ status: 'completed', finishedAt: START })])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(interval).not.toHaveBeenCalled()
  })
})

describe('JobListAction dismissal', () => {
  it('closes on Escape and returns focus to the trigger', () => {
    render(<JobListAction {...props([job()])} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('ignores other keys and a closed-list Escape', () => {
    render(<JobListAction {...props([job()])} />)
    const trigger = screen.getByRole('button')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on an outside pointer press but not on one inside', () => {
    render(<JobListAction {...props([job()])} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)

    fireEvent.pointerDown(screen.getByRole('list', { name: zh['list.aria'] }))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('JobListAction wire tolerance', () => {
  it('treats a settled job with no finishedAt as zero-duration and sorts it by start', () => {
    // `finishedAt` is optional on the wire; the Host always sets it, so this
    // covers a producer or carrier that ever stops doing so.
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'no finish', status: 'completed' }),
      job({ id: 'bash-2' as JobView['id'], label: 'finished', status: 'completed', startedAt: START - 1_000, finishedAt: START + 2_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => [cells[1], cells[3]])).toEqual([
      ['finished', '3秒'],
      ['no finish', '0秒'],
    ])
  })

  it('falls back to start order when neither settled job carries a finish time', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'later', status: 'failed', startedAt: START + 1_000 }),
      job({ id: 'bash-1' as JobView['id'], label: 'earlier', status: 'failed', startedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => cells[1])).toEqual(['later', 'earlier'])
  })
})

describe('JobListAction stop control', () => {
  const stopButton = (label: string): HTMLElement =>
    within(screen.getByRole('list', { name: zh['list.aria'] })).getByRole('button', { name: label })

  it('offers a stop control on running rows only, named by the job label', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'live one' }),
      job({ id: 'bash-2' as JobView['id'], label: 'stopping one', status: 'stopping' }),
      job({ id: 'bash-3' as JobView['id'], label: 'done one', status: 'completed', finishedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(stopButton(zh['kill.aria'].replace('{label}', 'live one'))).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['kill.aria'].replace('{label}', 'stopping one') })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['kill.aria'].replace('{label}', 'done one') })).toBeNull()
  })

  it('kills through the injected face with the session reason and waits for the mirror', async () => {
    const killJob = killJobMock()
    render(<JobListAction {...props([job({ id: 'bash-1' as JobView['id'], label: 'live one' })], killJob)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(stopButton(zh['kill.aria'].replace('{label}', 'live one')))
    expect(killJob).toHaveBeenCalledWith('bash-1', 'stopped by the user from the web interface')
    await act(async () => { await Promise.resolve() })
    // The row itself never flips locally: the `stopping` transition arrives
    // through the jobsBySession push, so a still-running row keeps its button.
    expect(stopButton(zh['kill.aria'].replace('{label}', 'live one'))).toBeDefined()
  })

  it('disables every stop control while one kill request is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const killJob: JobListActionProps['killJob'] = vi.fn(() => gate.then(() => ({ ok: true as const, value: { outcome: 'cancellation-requested' as const } })))
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'first' }),
      job({ id: 'bash-2' as JobView['id'], label: 'second' }),
    ], killJob)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(stopButton(zh['kill.aria'].replace('{label}', 'first')))
    expect((stopButton(zh['kill.aria'].replace('{label}', 'first')) as HTMLButtonElement).disabled).toBe(true)
    expect((stopButton(zh['kill.aria'].replace('{label}', 'second')) as HTMLButtonElement).disabled).toBe(true)
    release()
    await act(async () => { await gate })
    expect((stopButton(zh['kill.aria'].replace('{label}', 'second')) as HTMLButtonElement).disabled).toBe(false)
  })

  it('marks a failed kill on the row until the next attempt or push', async () => {
    const killJob: JobListActionProps['killJob'] = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: { code: 'job-kill-failed' as const, message: 'cancel threw', details: { jobId: 'bash-1' } } }))
    render(<JobListAction {...props([job({ id: 'bash-1' as JobView['id'], label: 'stuck' })], killJob)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(stopButton(zh['kill.aria'].replace('{label}', 'stuck')))
    await act(async () => { await Promise.resolve() })
    expect(within(screen.getByRole('list', { name: zh['list.aria'] })).getByText(zh['kill.failed'])).toBeDefined()
  })

  it('keeps the failure marker off rows the failure does not belong to', async () => {
    const killJob: JobListActionProps['killJob'] = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: { code: 'job-not-found' as const, message: 'gone', details: { jobId: 'bash-1' } } }))
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'gone' }),
      job({ id: 'bash-2' as JobView['id'], label: 'healthy' }),
    ], killJob)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(stopButton(zh['kill.aria'].replace('{label}', 'gone')))
    await act(async () => { await Promise.resolve() })
    const list = within(screen.getByRole('list', { name: zh['list.aria'] }))
    expect(list.getByText(zh['kill.failed'])).toBeDefined()
    expect(list.getByText(zh['status.running'])).toBeDefined()
  })
})
