import { describe, expect, it } from 'vitest'
import { parseRolloutRecord } from './rolloutLifecycle'

describe('parseRolloutRecord', () => {
  it('parses session metadata and lifecycle timestamps', () => {
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:47:19.971Z',
      type: 'session_meta',
      payload: { id: 'thread-1', source: 'vscode' },
    }))).toEqual({
      kind: 'session',
      threadId: 'thread-1',
      notificationScope: 'topLevel',
    })

    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:47:19.971Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }))).toEqual({
      kind: 'started',
      turnId: 'turn-1',
      occurredAt: Date.parse('2026-07-14T22:47:19.971Z'),
    })
  })

  it.each([
    [{ id: 'child-1', parent_thread_id: 'parent-1', source: 'vscode' }, 'child'],
    [{ id: 'child-2', source: { subagent: 'review' } }, 'child'],
    [{ id: 'unknown-1', source: 'unknown' }, 'unknown'],
  ] as const)('retains notification scope from session metadata %#', (payload, notificationScope) => {
    expect(parseRolloutRecord(JSON.stringify({ type: 'session_meta', payload }))).toEqual({
      kind: 'session',
      threadId: payload.id,
      notificationScope,
    })
  })

  it('prefers completed_at and preserves terminal duration', () => {
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:58:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        completed_at: '2026-07-14T22:57:59.971Z',
        duration_ms: 600_000,
        last_agent_message: 'must never be surfaced',
      },
    }))).toEqual({
      kind: 'terminal',
      turnId: 'turn-1',
      status: 'completed',
      occurredAt: Date.parse('2026-07-14T22:57:59.971Z'),
      durationMs: 600_000,
    })
  })

  it('parses aborted turns as interrupted and falls back to the row timestamp', () => {
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:58:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'turn_aborted',
        turn_id: 'turn-2',
        reason: 'user_interrupt',
      },
    }))).toEqual({
      kind: 'terminal',
      turnId: 'turn-2',
      status: 'interrupted',
      occurredAt: Date.parse('2026-07-14T22:58:00.000Z'),
      durationMs: null,
    })
  })

  it('falls back from an invalid completed_at and rejects invalid lifecycle timestamps', () => {
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:58:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        completed_at: 'not-a-date',
      },
    }))).toEqual({
      kind: 'terminal',
      turnId: 'turn-1',
      status: 'completed',
      occurredAt: Date.parse('2026-07-14T22:58:00.000Z'),
      durationMs: null,
    })

    expect(parseRolloutRecord(JSON.stringify({
      timestamp: 'invalid',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }))).toBeNull()
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: 'invalid',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        completed_at: 'also-invalid',
      },
    }))).toBeNull()
  })

  it.each([
    -1,
    '600000',
    null,
  ])('normalizes invalid duration %j to null', (duration) => {
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:58:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        duration_ms: duration,
      },
    }))).toMatchObject({ durationMs: null })
  })

  it('normalizes a non-finite duration to null', () => {
    expect(parseRolloutRecord(
      '{"timestamp":"2026-07-14T22:58:00.000Z","type":"event_msg",'
      + '"payload":{"type":"task_complete","turn_id":"turn-1","duration_ms":1e400}}',
    )).toMatchObject({ durationMs: null })
  })

  it.each([
    ['session without id', { type: 'session_meta', payload: {} }],
    ['session with empty id', { type: 'session_meta', payload: { id: '' } }],
    ['started turn without id', {
      timestamp: '2026-07-14T22:47:19.971Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    }],
    ['terminal turn with empty id', {
      timestamp: '2026-07-14T22:47:19.971Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: '' },
    }],
  ])('rejects %s', (_label, row) => {
    expect(parseRolloutRecord(JSON.stringify(row))).toBeNull()
  })

  it('ignores unrelated event messages and unknown lifecycle types', () => {
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:47:19.971Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'private conversation content' },
    }))).toBeNull()
    expect(parseRolloutRecord(JSON.stringify({
      timestamp: '2026-07-14T22:47:19.971Z',
      type: 'event_msg',
      payload: { type: 'future_lifecycle', turn_id: 'turn-1' },
    }))).toBeNull()
  })

  it.each([
    ['', 'invalid JSON'],
    ['{', 'incomplete JSON'],
    ['null', 'null'],
    ['42', 'primitive'],
    ['[]', 'array'],
    [JSON.stringify({ type: 'session_meta', payload: [] }), 'array payload'],
  ])('returns null for %s (%s)', (line) => {
    expect(parseRolloutRecord(line)).toBeNull()
  })
})
