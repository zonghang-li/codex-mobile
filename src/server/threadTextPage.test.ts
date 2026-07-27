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

function userMessage(text: string, id: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      id,
      content: [{ type: 'input_text', text }],
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

  it.each([
    ['a stale turn', 'turn-old'],
    ['a nonexistent turn', 'turn-missing'],
  ])('does not cross the first intervening turn boundary for %s', async (_label, turnId) => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-old' }),
      assistant('Old update', 'agent-old'),
      event('task_complete', { turn_id: 'turn-old' }),
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Active update', 'agent-active'),
    ])

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId,
    })

    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it.each([
    ['assistant', (text: string) => assistant(text, 'agent-oversized')],
    ['reasoning', (text: string) => reasoning(text, 'reason-oversized')],
    ['payload-first assistant', (text: string) => {
      const row = assistant(text, 'agent-payload-first')
      return {
        payload: row.payload,
        type: row.type,
      }
    }],
  ])('fails explicitly for an oversized relevant %s record', async (_label, createRow) => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      createRow('x'.repeat((1024 * 1024) + 64)),
    ])

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      statusCode: 413,
    })
  })

  it('enforces the 1 MiB cap on the complete serialized response', async () => {
    const emptyRowBytes = Buffer.byteLength(JSON.stringify(assistant('', 'agent-envelope')), 'utf8')
    const textBytes = (1024 * 1024) - emptyRowBytes - 1
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('x'.repeat(textBytes), 'agent-envelope'),
    ])

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      statusCode: 413,
    })
  })

  it('does not advertise an older page when limit lands immediately after turn start', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Only update', 'agent-only'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 1,
    })

    expect(result.items.map((item) => item.id)).toEqual(['agent-only'])
    expect(result.hasMoreOlder).toBe(false)
    expect(result.nextOlderCursor).toBeNull()
  })

  it('rejects a stale direct read before a low limit can return newer-turn rows', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First active update', 'agent-active-1'),
      assistant('Second active update', 'agent-active-2'),
      assistant('Third active update', 'agent-active-3'),
    ])

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-stale',
      limit: 1,
    })

    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('rejects a forged active-turn cursor whose offset points into an older turn', async () => {
    const rows = [
      event('task_started', { turn_id: 'turn-old' }),
      assistant('First old update', 'agent-old-1'),
      assistant('Second old update', 'agent-old-2'),
      event('task_complete', { turn_id: 'turn-old' }),
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Active update', 'agent-active'),
    ]
    const sessionPath = await writeRollout(rows)
    const serializedRows = rows.map((row) => JSON.stringify(row))
    const beforeOffset = Buffer.byteLength(`${serializedRows.slice(0, 3).join('\n')}\n`, 'utf8')
    const snapshotEndOffset = Buffer.byteLength(`${serializedRows.join('\n')}\n`, 'utf8')
    const forgedCursor = Buffer.from(JSON.stringify({
      v: 1,
      threadId: 'thread-1',
      turnId: 'turn-active',
      beforeOffset,
      snapshotEndOffset,
    }), 'utf8').toString('base64url')

    const result = readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      cursor: forgedCursor,
      limit: 1,
    })

    await expect(result).rejects.toBeInstanceOf(ThreadTextPageError)
    await expect(result).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('skips an oversized user message that is definitely irrelevant', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Visible update', 'agent-visible'),
      userMessage('x'.repeat((1024 * 1024) + 64), 'user-oversized'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => item.id)).toEqual(['agent-visible'])
    expect(result.hasMoreOlder).toBe(false)
  })

  it('returns a cursorless terminal page when only the provisional cursor exceeds 1 MiB', async () => {
    const marker = event('task_started', { turn_id: 'turn-active' })
    const markerLine = JSON.stringify(marker)
    const sessionOrder = Buffer.byteLength(`${markerLine}\n`, 'utf8')
    const maxBytes = 1024 * 1024

    const measure = (textLength: number) => {
      const row = assistant('x'.repeat(textLength), 'agent-terminal')
      const rowLine = JSON.stringify(row)
      const snapshotEndOffset = sessionOrder + Buffer.byteLength(`${rowLine}\n`, 'utf8')
      const item = {
        id: 'agent-terminal',
        type: 'agentMessage',
        text: 'x'.repeat(textLength),
        sessionOrder,
      }
      const cursor = Buffer.from(JSON.stringify({
        v: 1,
        threadId: 'thread-1',
        turnId: 'turn-active',
        beforeOffset: sessionOrder,
        snapshotEndOffset,
      }), 'utf8').toString('base64url')
      return {
        row,
        rowBytes: Buffer.byteLength(rowLine, 'utf8'),
        terminalBytes: Buffer.byteLength(JSON.stringify({
          threadId: 'thread-1',
          turnId: 'turn-active',
          items: [item],
          nextOlderCursor: null,
          hasMoreOlder: false,
        }), 'utf8'),
        provisionalBytes: Buffer.byteLength(JSON.stringify({
          threadId: 'thread-1',
          turnId: 'turn-active',
          items: [item],
          nextOlderCursor: cursor,
          hasMoreOlder: true,
        }), 'utf8'),
      }
    }

    let textLength = maxBytes - 512
    let measured = measure(textLength)
    textLength += maxBytes - measured.terminalBytes
    measured = measure(textLength)
    if (measured.terminalBytes > maxBytes) {
      textLength -= measured.terminalBytes - maxBytes
      measured = measure(textLength)
    }
    expect(measured.rowBytes).toBeLessThanOrEqual(maxBytes)
    expect(measured.terminalBytes).toBeLessThanOrEqual(maxBytes)
    expect(measured.provisionalBytes).toBeGreaterThan(maxBytes)

    const sessionPath = await writeRollout([marker, measured.row])
    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => item.id)).toEqual(['agent-terminal'])
    expect(result.nextOlderCursor).toBeNull()
    expect(result.hasMoreOlder).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(maxBytes)
  })
})
