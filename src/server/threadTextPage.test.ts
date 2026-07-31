import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
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

function userMessageWithoutId(text: string): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  }
}

function userMessageEvent(text: string, clientId: string): Record<string, unknown> {
  return {
    type: 'event_msg',
    payload: {
      type: 'user_message',
      client_id: clientId,
      message: text,
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
  it('does not project agent_reasoning event messages into visible text pages', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      {
        type: 'event_msg',
        payload: { type: 'agent_reasoning', text: '**Planning precise source line extraction**' },
      },
      assistant('Visible update', 'agent-1'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ type: item.type, text: item.text }))).toEqual([
      { type: 'agentMessage', text: 'Visible update' },
    ])
  })

  it('does not project internal subagent notifications as user messages', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage('<subagent_notification>\n{"status":{"completed":"hidden internal result"}}', 'subagent-note'),
      assistant('Visible update after subagent result', 'agent-1'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'agent-1', type: 'agentMessage', text: 'Visible update after subagent result' },
    ])
  })

  it('does not project codex internal goal context as user messages', async () => {
    const goalContext = [
      '<codex_internal_context source="goal">',
      'Once the blocked threshold is satisfied, call update_goal with status "blocked".',
      '</codex_internal_context>',
    ].join('\n')
    const encodedGoalContext = [
      '&lt;codex_internal_context source="goal"&gt;',
      'Once the blocked threshold is satisfied, call update_goal with status "blocked".',
      '&lt;/codex_internal_context&gt;',
    ].join('\n')
    const ordinarySimilarPrefix = '<codex_internal_contextual source="user">visible ordinary text</codex_internal_contextual>'
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage(goalContext, 'goal-context-response'),
      userMessageEvent(goalContext, 'goal-context-event'),
      userMessage(encodedGoalContext, 'encoded-goal-context-response'),
      userMessage(ordinarySimilarPrefix, 'ordinary-similar-prefix'),
      assistant('Visible update after goal context', 'agent-1'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'ordinary-similar-prefix', type: 'userMessage', text: ordinarySimilarPrefix },
      { id: 'agent-1', type: 'agentMessage', text: 'Visible update after goal context' },
    ])
  })

  it('projects delegated handoff envelopes as collapsed-capable active-turn user messages', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage('<codex_delegation>\n<input>visible handoff</input>\n</codex_delegation>', 'handoff-note'),
      assistant('Visible update after handoff', 'agent-1'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      {
        id: 'handoff-note',
        type: 'userMessage',
        text: '<codex_delegation>\n<input>visible handoff</input>\n</codex_delegation>',
      },
      { id: 'agent-1', type: 'agentMessage', text: 'Visible update after handoff' },
    ])
    expect(JSON.stringify(result)).toContain('codex_delegation')
    expect(JSON.stringify(result)).toContain('visible handoff')
  })

  it('decodes escaped delegated handoff envelopes before returning user message text', async () => {
    const escaped = [
      '&lt;codex_delegation&gt;',
      '&lt;source_thread_id&gt;old-thread&lt;/source_thread_id&gt;',
      '&lt;input&gt;PLAN02A_RESUME',
      'Task2 is superseded where it conflicts...&lt;/input&gt;',
      '&lt;/codex_delegation&gt;',
    ].join('\n')

    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage(escaped, 'handoff-note'),
      assistant('Visible update after handoff', 'agent-1'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items[0]).toMatchObject({
      id: 'handoff-note',
      type: 'userMessage',
      text: [
        '<codex_delegation>',
        '<source_thread_id>old-thread</source_thread_id>',
        '<input>PLAN02A_RESUME',
        'Task2 is superseded where it conflicts...</input>',
        '</codex_delegation>',
      ].join('\n'),
      content: [{
        type: 'input_text',
        text: [
          '<codex_delegation>',
          '<source_thread_id>old-thread</source_thread_id>',
          '<input>PLAN02A_RESUME',
          'Task2 is superseded where it conflicts...</input>',
          '</codex_delegation>',
        ].join('\n'),
      }],
    })
    expect(JSON.stringify(result)).not.toContain('&lt;codex_delegation')
  })

  it('drops empty and title-only response reasoning records from active-turn text pages', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-empty',
          summary: [],
          content: null,
          encrypted_content: null,
        },
      },
      reasoning('Weighing struct replication versus public inclusion', 'reason-title-1'),
      reasoning('Preventing shell injection in rg command', 'reason-title-2'),
      reasoning('Defining serialization fields for layer counts', 'reason-title-3'),
      reasoning('Comparing current and expected transaction shape', 'reason-title-4'),
      reasoning('Existing tests', 'reason-title-5'),
      reasoning('**Planning topology.cpp synchronization and testing**', 'reason-title-6'),
      reasoning('**Planning**', 'reason-title-7'),
      reasoning('Verifying std::array initialization and constexpr usage', 'reason-title-8'),
      reasoning('Planning ...', 'reason-title-ellipsis-1'),
      reasoning('Updating ...', 'reason-title-ellipsis-2'),
      reasoning('Inspecting ...', 'reason-title-ellipsis-3'),
      reasoning('Reviewing ...', 'reason-title-ellipsis-4'),
      reasoning('Visible summary', 'reason-visible'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => item.id)).toEqual(['reason-visible'])
  })

  it('pages active-turn text chronologically without exposing hidden activity payloads', async () => {
    const rows = [
      event('task_started', { turn_id: 'turn-old' }),
      assistant('old text', 'old-agent'),
      event('task_complete', { turn_id: 'turn-old' }),
      event('task_started', { turn_id: 'turn-active' }),
      reasoning('First thought', 'reason-1'),
      functionCall('exec_command', '{"cmd":"secret output must not escape"}', 'call-1'),
      assistant('First update', 'agent-1'),
      event('context_compacted', {}),
      reasoning('Second thought', 'reason-2'),
      assistant('Second update', 'agent-2'),
    ]
    const sessionPath = await writeRollout(rows)

    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 2,
    })

    expect(first.items.map((item) => item.type)).toEqual([
      'reasoning',
      'agentMessage',
    ])
    expect(first.items.map((item) => item.id)).toEqual(['reason-2', 'agent-2'])
    expect(JSON.stringify(first)).not.toContain('secret output')
    expect(first.hasMoreOlder).toBe(true)
    expect(first.nextOlderCursor).toEqual(expect.any(String))

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      cursor: first.nextOlderCursor!,
      limit: 2,
    })

    expect(second.items.map((item) => item.type)).toEqual(['agentMessage', 'contextCompaction'])
    expect(second.items.map((item) => item.id)).toEqual([
      'agent-1',
      expect.stringMatching(/^rollout:contextCompaction:\d+$/u),
    ])
    expect(second.items[1]?.text).toBe('Context automatically compacted')
    expect(second.hasMoreOlder).toBe(true)
    expect(second.nextOlderCursor).toEqual(expect.any(String))

    const third = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      cursor: second.nextOlderCursor!,
      limit: 2,
    })

    expect(third.items.map((item) => item.id)).toEqual(['reason-1'])
    expect(third.hasMoreOlder).toBe(false)
    expect(third.nextOlderCursor).toBeNull()
  })

  it('projects completed context compaction events as visible status rows', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      event('context_compacted', {}),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 5,
    })

    expect(result.items).toMatchObject([{
      id: expect.stringMatching(/^rollout:contextCompaction:\d+$/u),
      type: 'contextCompaction',
      text: 'Context automatically compacted',
      sessionOrder: expect.any(Number),
    }])
  })

  it('returns a not-modified active tail when the rollout tail signature is unchanged', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First update', 'agent-1'),
    ])

    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })

    expect(first.tailSignature).toEqual(expect.any(String))

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
      knownTailSignature: first.tailSignature,
    })

    expect(second).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-active',
      items: [],
      nextOlderCursor: null,
      hasMoreOlder: false,
      notModified: true,
      tailSignature: first.tailSignature,
    })
  })

  it('rejects an untrusted newest page after the requested turn is terminal', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Final update', 'agent-final'),
      event('task_complete', { turn_id: 'turn-active' }),
    ])

    await expect(readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('returns only assistant text appended after the last hydrated session order', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First update', 'agent-1'),
    ])
    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })
    const newestSessionOrder = Math.max(...first.items.map((item) => item.sessionOrder))

    await appendFile(sessionPath, `${JSON.stringify(assistant('Second update', 'agent-2'))}\n`, 'utf8')

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
      afterSessionOrder: newestSessionOrder,
      knownTailSignature: first.tailSignature,
    })

    expect(second.notModified).toBeUndefined()
    expect(second.items.map((item) => ({ id: item.id, text: item.text }))).toEqual([
      { id: 'agent-2', text: 'Second update' },
    ])
    expect(second.hasMoreOlder).toBe(false)
    expect(second.tailSignature).not.toBe(first.tailSignature)
  })

  it('projects user message events before assistant deltas so mobile can show the input immediately', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First update', 'agent-1'),
    ])
    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })
    const newestSessionOrder = Math.max(...first.items.map((item) => item.sessionOrder))

    await appendFile(
      sessionPath,
      [
        JSON.stringify(userMessageEvent('继续 Task2', 'client-steer-1')),
        JSON.stringify(assistant('收到，继续 Task2', 'agent-2')),
        '',
      ].join('\n'),
      'utf8',
    )

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
      afterSessionOrder: newestSessionOrder,
      knownTailSignature: first.tailSignature,
    })

    expect(second.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'rollout:userMessage:event:client-steer-1', type: 'userMessage', text: '继续 Task2' },
      { id: 'agent-2', type: 'agentMessage', text: '收到，继续 Task2' },
    ])
  })

  it('keeps recent user anchors in delta pages when the client already advanced past them', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First update', 'agent-1'),
      userMessageEvent('补充约束', 'client-steer-2'),
      assistant('Response after steer', 'agent-2'),
    ])
    const all = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })
    const newestSessionOrder = Math.max(...all.items.map((item) => item.sessionOrder))

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
      afterSessionOrder: newestSessionOrder,
      knownTailSignature: 'stale-tail-signature',
    })

    expect(second.notModified).toBeUndefined()
    expect(second.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'rollout:userMessage:event:client-steer-2', type: 'userMessage', text: '补充约束' },
    ])
  })

  it('does not collapse repeated user inputs with the same text across assistant output', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessageEvent('继续', 'client-steer-1'),
      assistant('First response', 'agent-1'),
      userMessage('继续', 'msg-steer-2'),
      userMessageEvent('继续', 'client-steer-2'),
      assistant('Second response', 'agent-2'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'rollout:userMessage:event:client-steer-1', type: 'userMessage', text: '继续' },
      { id: 'agent-1', type: 'agentMessage', text: 'First response' },
      { id: 'msg-steer-2', type: 'userMessage', text: '继续' },
      { id: 'agent-2', type: 'agentMessage', text: 'Second response' },
    ])
  })

  it('reorders late delegated user events before the assistant response they trigger', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('收到。继续 Task2。', 'agent-after-steer'),
      userMessageEvent(
        '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
        'client-late-delegation',
      ),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      {
        id: 'rollout:userMessage:event:client-late-delegation',
        type: 'userMessage',
        text: '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
      },
      { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
    ])
  })

  it('reorders wrapped late delegated user events before the assistant response they trigger', async () => {
    const wrappedDelegation = [
      'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite):',
      '<codex_delegation>',
      '<input>收到。继续 Task2。</input>',
      '</codex_delegation>',
    ].join('\n')
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('收到。继续 Task2。', 'agent-after-steer'),
      userMessageEvent(wrappedDelegation, 'client-late-wrapped-delegation'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      {
        id: 'rollout:userMessage:event:client-late-wrapped-delegation',
        type: 'userMessage',
        text: wrappedDelegation,
      },
      { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
    ])
  })

  it('does not reorder ordinary late event-sourced user messages ahead of existing output', async () => {
    const lateUserInput = 'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite)'
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('收到。继续 Task2。', 'agent-after-steer'),
      userMessageEvent(lateUserInput, 'client-late-user-input'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
      {
        id: 'rollout:userMessage:event:client-late-user-input',
        type: 'userMessage',
        text: lateUserInput,
      },
    ])
  })

  it('keeps multiple late delegated user events paired with their own response segment', async () => {
    const firstDelegation = '<codex_delegation>\n<input>FIRST_STEER</input>\n</codex_delegation>'
    const secondDelegation = '<codex_delegation>\n<input>SECOND_STEER</input>\n</codex_delegation>'
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First response', 'agent-first'),
      userMessageEvent(firstDelegation, 'client-late-first'),
      assistant('Second response', 'agent-second'),
      userMessageEvent(secondDelegation, 'client-late-second'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'rollout:userMessage:event:client-late-first', type: 'userMessage', text: firstDelegation },
      { id: 'agent-first', type: 'agentMessage', text: 'First response' },
      { id: 'rollout:userMessage:event:client-late-second', type: 'userMessage', text: secondDelegation },
      { id: 'agent-second', type: 'agentMessage', text: 'Second response' },
    ])
  })

  it('returns not-modified with a fresh tail signature when only filtered reasoning is appended', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('First update', 'agent-1'),
    ])
    const first = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
    })
    const newestSessionOrder = Math.max(...first.items.map((item) => item.sessionOrder))

    await appendFile(
      sessionPath,
      `${JSON.stringify(reasoning('Planning topology synchronization', 'reason-title'))}\n`,
      'utf8',
    )

    const second = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 20,
      afterSessionOrder: newestSessionOrder,
      knownTailSignature: first.tailSignature,
    })

    expect(second).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-active',
      items: [],
      nextOlderCursor: null,
      hasMoreOlder: false,
      notModified: true,
    })
    expect(second.tailSignature).toEqual(expect.any(String))
    expect(second.tailSignature).not.toBe(first.tailSignature)
  })

  it('projects assistant commentary phase messages as visible active-turn text', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('I will inspect this first', 'agent-commentary', 'commentary'),
      reasoning('可见推理摘要。', 'reason-visible'),
      assistant('Final answer text', 'agent-final'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type, text: item.text }))).toEqual([
      { id: 'agent-commentary', type: 'agentMessage', text: 'I will inspect this first' },
      { id: 'reason-visible', type: 'reasoning', text: undefined },
      { id: 'agent-final', type: 'agentMessage', text: 'Final answer text' },
    ])
  })

  it('drops command activity and command output from active-turn text pages', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Before command', 'agent-before'),
      functionCall('exec_command', JSON.stringify({
        cmd: 'cmake --build build --target test-log-observer-run-identity',
        cwd: '/tmp/project',
        output: 'argument payload must not be exposed',
      }), 'call-build'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-build',
          output: 'stdout must not be exposed',
        },
      },
      assistant('After command', 'agent-after'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'agent-before', type: 'agentMessage' },
      { id: 'agent-after', type: 'agentMessage' },
    ])
    expect(JSON.stringify(result)).not.toContain('cmake --build')
    expect(JSON.stringify(result)).not.toContain('argument payload must not be exposed')
    expect(JSON.stringify(result)).not.toContain('stdout must not be exposed')
  })

  it('projects active-turn steer user messages from text pages', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Before steer', 'agent-before'),
      userMessage('继续', 'user-steer'),
      assistant('After steer', 'agent-after'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'agent-before', type: 'agentMessage' },
      { id: 'user-steer', type: 'userMessage' },
      { id: 'agent-after', type: 'agentMessage' },
    ])
    expect(result.items[1]).toMatchObject({
      text: '继续',
      content: [{ type: 'input_text', text: '继续' }],
    })
  })

  it('includes the turn-start user message on a small active tail page', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage('设置 goal: 需要最终审核 0/0/0 通过', 'user-active'),
      assistant('Older update', 'agent-older'),
      assistant('Recent update', 'agent-recent'),
      assistant('Latest update', 'agent-latest'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 2,
    })

    expect(result.items.map((item) => item.id)).toEqual([
      'user-active',
      'agent-recent',
      'agent-latest',
    ])
    expect(result.items[0]).toMatchObject({
      type: 'userMessage',
      text: '设置 goal: 需要最终审核 0/0/0 通过',
      content: [{ type: 'input_text', text: '设置 goal: 需要最终审核 0/0/0 通过' }],
    })
    expect(result.hasMoreOlder).toBe(true)
  })

  it('keeps the turn-start user anchor when the active tail contains a later steer user message', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage('start prompt', 'user-active'),
      assistant('Older update', 'agent-older'),
      userMessage('later steer', 'user-steer'),
      assistant('Latest update', 'agent-latest'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 2,
    })

    expect(result.items.map((item) => item.id)).toEqual([
      'user-active',
      'user-steer',
      'agent-latest',
    ])
    expect(result.items[0]).toMatchObject({
      type: 'userMessage',
      text: 'start prompt',
      content: [{ type: 'input_text', text: 'start prompt' }],
    })
    expect(result.hasMoreOlder).toBe(true)
  })

  it('can skip the turn-start user anchor for internal active tail probes', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessage('设置 goal: 需要最终审核 0/0/0 通过', 'user-active'),
      assistant('Older update', 'agent-older'),
      assistant('Recent update', 'agent-recent'),
      assistant('Latest update', 'agent-latest'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
      limit: 2,
    }, {
      includeTurnStartUserAnchor: false,
    })

    expect(result.items.map((item) => item.id)).toEqual([
      'agent-recent',
      'agent-latest',
    ])
    expect(result.hasMoreOlder).toBe(true)
  })

  it('projects visible user messages without ids while dropping injected user context', async () => {
    const sessionPath = await writeRollout([
      event('task_started', { turn_id: 'turn-active' }),
      userMessageWithoutId('<environment_context>\n  <current_date>2026-07-28</current_date>\n</environment_context>'),
      assistant('Before user', 'agent-before'),
      userMessageWithoutId('这两个设备之间网络互通吗，设备间的带宽和RTT是多少'),
      assistant('After user', 'agent-after'),
    ])

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    })

    expect(result.items.map((item) => item.type)).toEqual([
      'agentMessage',
      'userMessage',
      'agentMessage',
    ])
    expect(result.items[1]).toMatchObject({
      type: 'userMessage',
      content: [{ type: 'input_text', text: '这两个设备之间网络互通吗，设备间的带宽和RTT是多少' }],
    })
    expect(result.items[1]?.id).toMatch(/^rollout:userMessage:\d+$/u)
    expect(JSON.stringify(result)).not.toContain('environment_context')
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

  it('bounds sparse newest-page scans across large irrelevant regions', async () => {
    const irrelevantRows = Array.from({ length: 2_500 }, (_, index) => (
      functionCall('exec_command', JSON.stringify({ index, output: 'x'.repeat(2_048) }), `call-${index}`)
    ))
    const rows = [
      event('task_started', { turn_id: 'turn-active' }),
      assistant('Visible update behind the sparse region', 'agent-visible'),
      ...irrelevantRows,
    ]
    const sessionPath = await writeRollout(rows)

    const result = await readThreadTextPage({
      sessionPath,
      threadId: 'thread-1',
      turnId: 'turn-active',
    }, {
      trustedActiveTurn: true,
    })

    expect(result.items).toEqual([])
    expect(result.hasMoreOlder).toBe(true)
    expect(result.nextOlderCursor).toEqual(expect.any(String))

    const [payload] = result.nextOlderCursor!.split('.')
    const cursor = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as {
      beforeOffset: number
      snapshotEndOffset: number
    }
    const serializedRows = rows.map((row) => `${JSON.stringify(row)}\n`)
    let cursorRowIndex = serializedRows.length
    let offset = cursor.snapshotEndOffset
    while (cursorRowIndex > 0 && offset > cursor.beforeOffset) {
      cursorRowIndex -= 1
      offset -= Buffer.byteLength(serializedRows[cursorRowIndex]!, 'utf8')
    }

    expect(offset).toBe(cursor.beforeOffset)
    expect(serializedRows.length - cursorRowIndex).toBeLessThanOrEqual(2_000)
    const largestRowBytes = Math.max(...serializedRows.map((row) => Buffer.byteLength(row, 'utf8')))
    expect(cursor.snapshotEndOffset - cursor.beforeOffset)
      .toBeLessThanOrEqual((2 * 1024 * 1024) + largestRowBytes)
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
