import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readThreadTextPage,
  ThreadTextPageError,
} from './threadTextPage'

const fixtureDirectories: string[] = []

afterEach(async () => {
  await Promise.all(fixtureDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

function event(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'event_msg',
    payload: { type, ...payload },
  }
}

function assistant(
  text: string,
  id: string,
  phase?: string,
): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      id,
      phase,
      content: [{ type: 'output_text', text }],
    },
  }
}

function reasoning(text: string, id: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id,
      summary: [{ type: 'summary_text', text }],
      content: null,
      encrypted_content: null,
    },
  }
}

function functionCall(
  name: string,
  argumentsJson: string,
  callId: string,
): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      arguments: argumentsJson,
      call_id: callId,
    },
  }
}

async function writeRollout(lines: Array<Record<string, unknown> | string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'thread-text-page-'))
  fixtureDirectories.push(directory)
  const sessionPath = join(directory, 'rollout.jsonl')
  await writeFile(
    sessionPath,
    `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  )
  return sessionPath
}

describe('readThreadTextPage', () => {
  it('pages active-turn text chronologically without exposing tool payloads', async () => {
    const rows = [
      event('task_started', { turn_id: 'turn-old' }),
      assistant('old text', 'old-agent'),
      event('task_complete', { turn_id: 'turn-old' }),
      event('task_started', { turn_id: 'turn-active' }),
      reasoning('First thought', 'reason-1'),
      functionCall('exec_command', '{"cmd":"secret output must not escape"}', 'call-1'),
      assistant('First update', 'agent-1', 'commentary'),
      event('context_compacted', {}),
      reasoning('Second thought', 'reason-2'),
      assistant('Second update', 'agent-2', 'commentary'),
    ]
    const sessionPath = await writeRollout(rows)

    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 3,
    })

    expect(first.items.map((item) => item.type)).toEqual([
      'contextCompaction',
      'reasoning',
      'agentMessage',
    ])
    expect(first.items[0]?.id).toMatch(/^rollout:contextCompaction:\d+$/u)
    expect(first.items.slice(1).map((item) => item.id)).toEqual(['reason-2', 'agent-2'])
    expect(JSON.stringify(first)).not.toContain('secret output')
    expect(first.hasMoreOlder).toBe(true)
    expect(first.nextOlderCursor).toEqual(expect.any(String))

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      cursor: first.nextOlderCursor!,
      limit: 3,
    })

    expect(second.items.map((item) => item.id)).toEqual(['reason-1', 'agent-1'])
    expect(second.hasMoreOlder).toBe(false)
    expect(second.nextOlderCursor).toBeNull()
  })

  it('skips malformed lines and oversized irrelevant tool records', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      reasoning('Visible summary', 'reason-visible'),
      '{"type":"response_item",broken',
      functionCall('exec_command', JSON.stringify({
        ignored: 'x'.repeat((1024 * 1024) + 64),
      }), 'oversized-call'),
      assistant('Visible update', 'agent-visible'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => item.id)).toEqual([
      'reason-visible',
      'agent-visible',
    ])
    expect(result.hasMoreOlder).toBe(false)
  })

  it('rejects a cursor used with a different thread identity', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Older update', 'agent-older'),
      assistant('Latest update', 'agent-latest'),
    ])
    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 1,
    })

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-2',
      turnId: 'turn-active',
      cursor: first.nextOlderCursor!,
    })
    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      name: 'ThreadTextPageError',
      statusCode: 400,
    })
  })

  it('rejects a cursor whose rollout snapshot has been truncated', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Older update', 'agent-older'),
      assistant('Latest update', 'agent-latest'),
    ])
    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 1,
    })
    await truncate(sessionPath, 8)

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      cursor: first.nextOlderCursor!,
    })
    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      name: 'ThreadTextPageError',
      statusCode: 409,
    })
  })

  it('stops before a normal page response would exceed 256 KiB', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('a'.repeat(150 * 1024), 'agent-older'),
      assistant('b'.repeat(150 * 1024), 'agent-latest'),
    ])

    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 10,
    })

    expect(first.items.map((item) => item.id)).toEqual(['agent-latest'])
    expect(first.hasMoreOlder).toBe(true)

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      cursor: first.nextOlderCursor!,
      limit: 10,
    })
    expect(second.items.map((item) => item.id)).toEqual(['agent-older'])
    expect(second.hasMoreOlder).toBe(false)
  })

  it('returns one relevant record between 256 KiB and 1 MiB', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('a'.repeat(300 * 1024), 'agent-large'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: 'agent-large',
      type: 'agentMessage',
      text: expect.any(String),
    })
    expect(result.hasMoreOlder).toBe(false)
  })
})
