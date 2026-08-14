import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendQueueProcessor,
  appendThreadQueuedMessage,
  handleThreadQueueStoreChanged,
  mergeSessionSkillInputsIntoTurns,
  parseAutomationToml,
  prepareThreadRpcResultForClient,
  removeThreadQueuedMessage,
  reorderThreadQueuedMessages,
  replaceThreadQueueState,
  sanitizeThreadTurnsInlinePayloads,
  toAutomationApiRecord,
  writeWorkspaceRootsState,
} from './codexAppServerBridge'

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const pngDataUrl = `data:image/png;base64,${pngBase64}`
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
const webpBase64 = 'UklGRiIAAABXRUJQVlA4IC4AAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA='

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function localImagePathFromProxyUrl(value: string): string {
  const parsed = new URL(value, 'http://localhost')
  expect(parsed.pathname).toBe('/codex-local-image')
  const imagePath = parsed.searchParams.get('path')
  expect(imagePath).toBeTruthy()
  return imagePath ?? ''
}

describe('thread inline media sanitization', () => {
  it('externalizes inline image data from common thread payload fields', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'image', url: pngDataUrl }],
                images: [pngDataUrl],
              },
              {
                id: 'generated-1',
                type: 'imageGeneration',
                result: pngBase64,
              },
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: pngBase64,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<Record<string, unknown>>
        }>
      }
    }

    const [userMessage, generatedImage, toolOutput] = result.thread.turns[0].items
    const content = userMessage.content as Array<Record<string, unknown>>
    const images = userMessage.images as string[]

    expect(content[0].url).toMatch(/^\/codex-local-image\?path=/)
    expect(images[0]).toMatch(/^\/codex-local-image\?path=/)
    expect(generatedImage.type).toBe('imageView')
    expect(generatedImage.path).toEqual(expect.any(String))
    expect(toolOutput.result).toMatch(/^\/codex-local-image\?path=/)

    expect(existsSync(localImagePathFromProxyUrl(content[0].url as string))).toBe(true)
    expect(existsSync(localImagePathFromProxyUrl(images[0]))).toBe(true)
    expect(existsSync(generatedImage.path as string)).toBe(true)
    expect(existsSync(localImagePathFromProxyUrl(toolOutput.result as string))).toBe(true)
  })

  it('leaves non-image result strings untouched', async () => {
    const textResult = 'a'.repeat(128)
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: textResult,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ result: string }>
        }>
      }
    }

    expect(result.thread.turns[0].items[0].result).toBe(textResult)
  })

  it('caps command execution output in thread payloads', async () => {
    const longOutput = `first-line\n${'x'.repeat(70_000)}\nlast-line`
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'command-1',
                type: 'commandExecution',
                command: 'journalctl --user -n 5000',
                aggregatedOutput: longOutput,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ aggregatedOutput: string }>
        }>
      }
    }

    const output = result.thread.turns[0].items[0].aggregatedOutput

    expect(output.length).toBeLessThan(20_000)
    expect(output).toContain('first-line')
    expect(output).toContain('last-line')
    expect(output).toContain('truncated')
  })

  it('compresses activity-only raw payload fields that are not rendered directly', async () => {
    const longToolOutput = `tool-head\n${'x'.repeat(40_000)}\ntool-tail`
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'mcp-1',
                type: 'mcpToolCall',
                server: 'codegraph',
                tool: 'codegraph_explore',
                status: 'completed',
                arguments: { query: 'large query', source: 'a'.repeat(20_000) },
                result: {
                  content: [{ type: 'text', text: longToolOutput }],
                },
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{
            arguments: { type: string; originalBytes: number; preview: string }
            result: { type: string; originalBytes: number; preview: string }
          }>
        }>
      }
    }

    const item = result.thread.turns[0].items[0]

    expect(item.arguments.type).toBe('compressedRawPayload')
    expect(item.arguments.originalBytes).toBeGreaterThan(20_000)
    expect(item.arguments.preview.length).toBeLessThan(600)
    expect(item.result.type).toBe('compressedRawPayload')
    expect(item.result.originalBytes).toBeGreaterThan(40_000)
    expect(item.result.preview).toContain('tool-head')
  })

  it('windows oversized turn item arrays while retaining the user prompt and latest activity', async () => {
    const items = [
      {
        id: 'user-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'start a huge turn' }],
      },
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `cmd-${index}`,
        type: 'commandExecution',
        command: `echo ${index}`,
        aggregatedOutput: `output ${index}`,
      })),
      {
        id: 'assistant-final',
        type: 'agentMessage',
        text: 'latest final text',
      },
    ]

    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items,
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ id: string }>
          rawItemCompression: {
            originalItemCount: number
            retainedItemCount: number
            omittedItemCount: number
          }
        }>
      }
    }

    const turn = result.thread.turns[0]

    expect(turn.items.length).toBeLessThanOrEqual(240)
    expect(turn.items[0].id).toBe('user-1')
    expect(turn.items.at(-1)?.id).toBe('assistant-final')
    expect(turn.rawItemCompression).toEqual({
      originalItemCount: 502,
      retainedItemCount: turn.items.length,
      omittedItemCount: 502 - turn.items.length,
    })
  })

  it('windows items appended by recovered session enrichment before returning thread RPC results', async () => {
    const result = await prepareThreadRpcResultForClient(
      'thread/read',
      {
        thread: {
          turns: [
            {
              id: 'turn-1',
              items: [
                {
                  id: 'user-1',
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'start a huge turn' }],
                },
              ],
            },
          ],
        },
      },
      false,
      async (value) => {
        const record = value as {
          thread: {
            turns: Array<{
              items: Array<Record<string, unknown>>
            }>
          }
        }
        return {
          ...record,
          thread: {
            ...record.thread,
            turns: record.thread.turns.map((turn) => ({
              ...turn,
              items: [
                ...turn.items,
                ...Array.from({ length: 500 }, (_, index) => ({
                  id: `recovered-cmd-${index}`,
                  type: 'commandExecution',
                  command: `echo ${index}`,
                  aggregatedOutput: `recovered output ${index}`,
                })),
              ],
            })),
          },
        }
      },
    ) as {
      thread: {
        turns: Array<{
          items: Array<{ id: string }>
          rawItemCompression: {
            originalItemCount: number
            retainedItemCount: number
            omittedItemCount: number
          }
        }>
      }
    }

    const turn = result.thread.turns[0]

    expect(turn.items.length).toBeLessThanOrEqual(240)
    expect(turn.items[0].id).toBe('user-1')
    expect(turn.items.at(-1)?.id).toBe('recovered-cmd-499')
    expect(turn.rawItemCompression).toEqual({
      originalItemCount: 501,
      retainedItemCount: turn.items.length,
      omittedItemCount: 501 - turn.items.length,
    })
  })

  it('preserves recent visible assistant text when activity items would otherwise fill the window', async () => {
    const items = [
      {
        id: 'user-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'start a huge turn' }],
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        id: `assistant-${index}`,
        type: 'agentMessage',
        text: `visible assistant update ${index}`,
      })),
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `cmd-${index}`,
        type: 'commandExecution',
        command: `echo ${index}`,
        aggregatedOutput: `output ${index}`,
      })),
    ]

    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items,
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ id: string; type: string }>
        }>
      }
    }

    const retainedItems = result.thread.turns[0].items
    const retainedIds = new Set(retainedItems.map((item) => item.id))

    expect(retainedItems.length).toBeLessThanOrEqual(240)
    expect(retainedItems[0].id).toBe('user-1')
    expect(retainedIds.has('assistant-79')).toBe(true)
    expect(retainedItems.some((item) => item.type === 'agentMessage')).toBe(true)
    expect(retainedItems.at(-1)?.id).toBe('cmd-299')
  })

  it('leaves non-image data URLs untouched in image-like fields', async () => {
    const dataUrl = 'data:text/plain;base64,aGVsbG8='
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: dataUrl,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ result: string }>
        }>
      }
    }

    expect(result.thread.turns[0].items[0].result).toBe(dataUrl)
  })

  it('externalizes supported bare base64 image signatures with matching extensions', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                images: [jpegBase64, webpBase64, gifBase64],
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ images: string[] }>
        }>
      }
    }

    const images = result.thread.turns[0].items[0].images
    expect(images).toHaveLength(3)
    expect(images.every((image) => image.startsWith('/codex-local-image?path='))).toBe(true)

    const [jpegPath, webpPath, gifPath] = images.map(localImagePathFromProxyUrl)
    expect(jpegPath.endsWith('.jpg')).toBe(true)
    expect(webpPath.endsWith('.webp')).toBe(true)
    expect(gifPath.endsWith('.gif')).toBe(true)
    expect(existsSync(jpegPath)).toBe(true)
    expect(existsSync(webpPath)).toBe(true)
    expect(existsSync(gifPath)).toBe(true)
  })

  it('externalizes nested replacement history image URLs', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'message-1',
                type: 'message',
                replacement_history: [
                  {
                    content: [
                      {
                        type: 'image',
                        image_url: pngDataUrl,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{
            replacement_history: Array<{
              content: Array<{ image_url: string }>
            }>
          }>
        }>
      }
    }

    const imageUrl = result.thread.turns[0].items[0].replacement_history[0].content[0].image_url
    expect(imageUrl).toMatch(/^\/codex-local-image\?path=/)
    expect(existsSync(localImagePathFromProxyUrl(imageUrl))).toBe(true)
  })

  it('does not sanitize inline images for methods without thread turns', async () => {
    const payload = {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: pngBase64,
              },
            ],
          },
        ],
      },
    }

    const result = await sanitizeThreadTurnsInlinePayloads('thread/list', payload)

    expect(result).toBe(payload)
  })
})

describe('thread session skill recovery', () => {
  it('adds selected skill inputs from session JSONL to matching user messages', () => {
    const turns = [{
      id: 'turn-1',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'use a skill', text_elements: [] }],
      }],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'use a skill' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n---\n# Browser\n</skill>',
          }],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns
    expect(merged[0].items[0].content).toEqual([
      { type: 'text', text: 'use a skill', text_elements: [] },
      { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
    ])
  })

  it('does not duplicate skill inputs that are already present', () => {
    const turns = [{
      id: 'turn-1',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [
          { type: 'text', text: 'use a skill', text_elements: [] },
          { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
        ],
      }],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n</skill>',
          }],
        },
      }),
    ].join('\n')

    expect(mergeSessionSkillInputsIntoTurns(turns, sessionLog)).toBe(turns)
  })

  it('adds selected skill inputs to the last user message in a multi-message turn', () => {
    const turns = [{
      id: 'turn-1',
      items: [
        {
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'first message', text_elements: [] }],
        },
        {
          id: 'item-2',
          type: 'agentMessage',
          content: [{ type: 'text', text: 'assistant reply', text_elements: [] }],
        },
        {
          id: 'item-3',
          type: 'userMessage',
          content: [{ type: 'text', text: 'second message', text_elements: [] }],
        },
      ],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n</skill>',
          }],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns
    expect(merged[0].items[0].content).toEqual([{ type: 'text', text: 'first message', text_elements: [] }])
    expect(merged[0].items[2].content).toEqual([
      { type: 'text', text: 'second message', text_elements: [] },
      { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
    ])
  })
})

describe('backend queue scheduling', () => {
  it('schedules local draining when another process commits queue changes', () => {
    const scheduleThreadQueueDrain = vi.fn()

    handleThreadQueueStoreChanged(
      { scheduleThreadQueueDrain },
      { threadIds: ['thread-cross-process'], revision: 7 },
    )

    expect(scheduleThreadQueueDrain).toHaveBeenCalledWith('thread-cross-process', 0)
  })

  it('orders inverse-arrival appends by their client submission key', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-order-'))
    process.env.CODEX_HOME = codexHome
    const message = (id: string, queueAfterId?: string) => ({
      id,
      ...(queueAfterId ? { queueAfterId } : {}),
      text: id,
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    })

    try {
      await appendThreadQueuedMessage('thread-ordered', message('queued-second', 'queued-first'))
      await appendThreadQueuedMessage('thread-ordered', message('queued-first'))

      const persisted = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
      }
      expect(persisted['thread-queue-state']?.['thread-ordered']?.map((item) => item.id))
        .toEqual(['queued-first', 'queued-second'])
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not claim an inverse-arrival row before its predecessor is accepted', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-predecessor-'))
    process.env.CODEX_HOME = codexHome
    const processor = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const claim = () => (processor as unknown as {
      claimNextQueuedTurn: (threadId: string) => Promise<unknown>
    }).claimNextQueuedTurn('thread-predecessor')
    const message = (id: string, queueAfterId?: string) => ({
      id,
      ...(queueAfterId ? { queueAfterId } : {}),
      text: id,
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    })

    try {
      await appendThreadQueuedMessage('thread-predecessor', message('queued-second', 'queued-first'))
      await expect(claim()).resolves.toBeNull()

      await appendThreadQueuedMessage('thread-predecessor', message('queued-first'))
      await expect(claim()).resolves.toMatchObject({ message: { id: 'queued-first' } })
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('eventually releases an orphaned inverse-arrival dependency', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-orphan-'))
    process.env.CODEX_HOME = codexHome
    const processor = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const claim = () => (processor as unknown as {
      claimNextQueuedTurn: (threadId: string) => Promise<unknown>
    }).claimNextQueuedTurn('thread-orphan')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      await appendThreadQueuedMessage('thread-orphan', {
        id: 'queued-orphan',
        queueAfterId: 'queued-never-arrived',
        text: 'must eventually run',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })
      await expect(claim()).resolves.toBeNull()

      vi.mocked(Date.now).mockReturnValue(now + 60_000)
      await expect(claim()).resolves.toMatchObject({ message: { id: 'queued-orphan' } })
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('bounds historical append receipts after queue mutations', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-receipt-bound-'))
    process.env.CODEX_HOME = codexHome
    const statePath = join(codexHome, '.codex-global-state.json')

    try {
      await writeFile(statePath, JSON.stringify({
        'thread-queue-receipts': Array.from({ length: 5000 }, (_, index) => ({
          threadId: 'thread-history',
          messageId: `old-${index}`,
        })),
      }))
      await appendThreadQueuedMessage('thread-current', {
        id: 'queued-current',
        text: 'bounded state',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })

      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        'thread-queue-receipts'?: unknown[]
      }
      expect(persisted['thread-queue-receipts']?.length).toBeLessThanOrEqual(2048)
      expect(persisted['thread-queue-receipts']).toContainEqual(expect.objectContaining({
        threadId: 'thread-current',
        messageId: 'queued-current',
      }))
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('drops unreferenced receipts when the protected set fills the retention budget', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-protected-receipts-'))
    process.env.CODEX_HOME = codexHome
    const statePath = join(codexHome, '.codex-global-state.json')
    const protectedMessages = Array.from({ length: 2048 }, (_, index) => ({
      id: `protected-${index}`,
      text: 'protected',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default',
      model: 'gpt-test',
      effort: '',
    }))

    try {
      await writeFile(statePath, JSON.stringify({
        'thread-queue-state': { 'thread-protected': protectedMessages },
        'thread-queue-receipts': [
          ...protectedMessages.map((message) => ({
            threadId: 'thread-protected',
            messageId: message.id,
          })),
          { threadId: 'thread-history', messageId: 'unreferenced-old' },
        ],
      }))
      await reorderThreadQueuedMessages('thread-protected', protectedMessages.map((message) => message.id))

      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        'thread-queue-receipts'?: Array<{ threadId: string; messageId: string }>
      }
      expect(persisted['thread-queue-receipts']).not.toContainEqual({
        threadId: 'thread-history',
        messageId: 'unreferenced-old',
      })
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('lets a replacement processor reclaim a disposed same-process owner', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-disposed-owner-'))
    process.env.CODEX_HOME = codexHome
    const first = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const second = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const claim = (processor: BackendQueueProcessor) => (processor as unknown as {
      claimNextQueuedTurn: (threadId: string) => Promise<unknown>
    }).claimNextQueuedTurn('thread-disposed-owner')

    try {
      await appendThreadQueuedMessage('thread-disposed-owner', {
        id: 'queued-after-dispose',
        text: 'recover after bridge replacement',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })
      await expect(claim(first)).resolves.not.toBeNull()
      first.dispose()

      await expect(claim(second)).resolves.toMatchObject({
        message: { id: 'queued-after-dispose' },
      })
    } finally {
      first.dispose()
      second.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('allows only one live processor to claim a queued turn', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-claim-'))
    process.env.CODEX_HOME = codexHome
    const first = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const second = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const claim = (processor: BackendQueueProcessor) => (processor as unknown as {
      claimNextQueuedTurn: (threadId: string) => Promise<unknown>
    }).claimNextQueuedTurn('thread-claimed')

    try {
      await appendThreadQueuedMessage('thread-claimed', {
        id: 'queued-once',
        text: 'only one processor may own me',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })

      await expect(claim(first)).resolves.not.toBeNull()
      await expect(claim(second)).resolves.toBeNull()
    } finally {
      first.dispose()
      second.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not steal a claim from a live processor after the legacy lease window', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-live-claim-'))
    process.env.CODEX_HOME = codexHome
    const first = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const second = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
    const claim = (processor: BackendQueueProcessor) => (processor as unknown as {
      claimNextQueuedTurn: (threadId: string) => Promise<unknown>
    }).claimNextQueuedTurn('thread-live-claimed')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      await appendThreadQueuedMessage('thread-live-claimed', {
        id: 'queued-live-owner',
        text: 'do not duplicate a slow dispatch',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })
      await expect(claim(first)).resolves.not.toBeNull()

      vi.mocked(Date.now).mockReturnValue(now + 60_000)
      await expect(claim(second)).resolves.toBeNull()
    } finally {
      first.dispose()
      second.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not activate managed uploads while the queued turn is still blocked', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-blocked-upload-'))
    process.env.CODEX_HOME = codexHome
    let notify: ((notification: { method: string; params?: unknown }) => void) | undefined
    const processor = new BackendQueueProcessor({
      rpc: vi.fn(async (method: string) => {
        if (method === 'thread/read') {
          return { thread: { id: 'thread-blocked-upload', turns: [{ id: 'turn-running', status: 'inProgress', items: [] }] } }
        }
        return {}
      }),
      onNotification: (listener: typeof notify) => {
        notify = listener
        return () => undefined
      },
    } as never)
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload-deadbeef%2Fphoto.png&uploadHandle=managed-blocked'

    try {
      await appendThreadQueuedMessage('thread-blocked-upload', {
        id: 'queued-blocked-upload',
        text: 'wait for the running turn',
        imageUrls: [managedImageUrl],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })
      await processor.processThreadQueue('thread-blocked-upload')

      expect((processor as unknown as {
        activeManagedMessagesByThreadId: Map<string, unknown>
      }).activeManagedMessagesByThreadId.has('thread-blocked-upload')).toBe(false)
      notify?.({ method: 'turn/completed', params: { threadId: 'thread-blocked-upload' } })
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('rejects stale full replacement and preserves concurrent rows in exact mutations', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-cas-'))
    process.env.CODEX_HOME = codexHome
    const message = (id: string) => ({
      id,
      text: id,
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    })

    try {
      await appendThreadQueuedMessage('thread-cas', message('queued-1'))
      await expect(replaceThreadQueueState({}, 0)).rejects.toMatchObject({
        name: 'ThreadQueueRevisionConflictError',
      })
      await appendThreadQueuedMessage('thread-cas', message('queued-2'))
      await reorderThreadQueuedMessages('thread-cas', ['queued-1'])
      await removeThreadQueuedMessage('thread-cas', 'queued-1')

      const persisted = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
      }
      expect(persisted['thread-queue-state']?.['thread-cas']?.map((item) => item.id))
        .toEqual(['queued-2'])
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('persists reordered position constraints for later appends', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-reorder-'))
    process.env.CODEX_HOME = codexHome
    const message = (id: string, queueAfterId?: string) => ({
      id,
      ...(queueAfterId ? { queueAfterId } : {}),
      text: id,
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    })

    try {
      await appendThreadQueuedMessage('thread-reorder', message('queued-1'))
      await appendThreadQueuedMessage('thread-reorder', message('queued-2', 'queued-1'))
      await reorderThreadQueuedMessages('thread-reorder', ['queued-2', 'queued-1'])
      await appendThreadQueuedMessage('thread-reorder', message('queued-3', 'queued-1'))

      const persisted = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
      }
      expect(persisted['thread-queue-state']?.['thread-reorder']?.map((item) => item.id))
        .toEqual(['queued-2', 'queued-1', 'queued-3'])
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('returns durable managed capabilities when removing a recovered row', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-remove-managed-'))
    process.env.CODEX_HOME = codexHome
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=remove-managed'

    try {
      await appendThreadQueuedMessage('thread-remove', {
        id: 'queued-managed-remove',
        text: 'remove me',
        imageUrls: [managedImageUrl],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })
      await expect(removeThreadQueuedMessage('thread-remove', 'queued-managed-remove')).resolves.toMatchObject({
        id: 'queued-managed-remove',
        imageUrls: [managedImageUrl],
      })
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('preserves queue data when workspace roots are written concurrently', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-global-state-race-'))
    process.env.CODEX_HOME = codexHome
    const message = {
      id: 'queued-concurrent-state',
      text: 'preserve me',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    }

    try {
      await Promise.all([
        appendThreadQueuedMessage('thread-1', message),
        writeWorkspaceRootsState({
          order: [],
          labels: {},
          active: [],
          projectOrder: [],
          remoteProjects: [],
        }),
      ])

      const persisted = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
        'electron-saved-workspace-roots'?: string[]
      }
      expect(persisted['thread-queue-state']?.['thread-1']).toEqual([
        expect.objectContaining({ id: message.id }),
      ])
      expect(persisted['electron-saved-workspace-roots']).toEqual([])
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('atomically appends queued messages without resurrecting a popped snapshot', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-atomic-queue-'))
    process.env.CODEX_HOME = codexHome
    const statePath = join(codexHome, '.codex-global-state.json')
    const message = {
      id: 'queued-b',
      text: 'new work',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    }

    try {
      await writeFile(statePath, JSON.stringify({
        'thread-queue-state': {},
      }))

      await appendThreadQueuedMessage('thread-1', message)
      await appendThreadQueuedMessage('thread-1', message)

      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        'thread-queue-state': Record<string, Array<{ id: string }>>
      }
      expect(persisted['thread-queue-state']['thread-1']).toEqual([
        expect.objectContaining({ id: 'queued-b' }),
      ])
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not append an accepted message again after the queue consumer pops it', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-consumed-queue-'))
    process.env.CODEX_HOME = codexHome
    const statePath = join(codexHome, '.codex-global-state.json')
    const message = {
      id: 'queued-consumed',
      text: 'run exactly once',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    }
    const processor = new BackendQueueProcessor({
      onNotification: () => () => undefined,
    } as never)

    try {
      await writeFile(statePath, JSON.stringify({ 'thread-queue-state': {} }))
      await appendThreadQueuedMessage('thread-1', message)
      const queueProcessor = processor as unknown as {
        claimNextQueuedTurn: (threadId: string) => Promise<{
          threadId: string
          message: { id: string }
          attempted: boolean
        } | null>
        finalizeQueuedTurn: (turn: {
          threadId: string
          message: { id: string }
          attempted: boolean
        }) => Promise<void>
      }
      const popped = await queueProcessor.claimNextQueuedTurn('thread-1')

      expect(popped?.message.id).toBe(message.id)
      await queueProcessor.finalizeQueuedTurn(popped!)
      await appendThreadQueuedMessage('thread-1', message)

      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
        'thread-queue-receipts'?: Array<{ threadId: string; messageId: string }>
      }
      expect(persisted['thread-queue-state']?.['thread-1'] ?? []).toEqual([])
      expect(persisted['thread-queue-receipts']).toContainEqual(expect.objectContaining({
        threadId: 'thread-1',
        messageId: message.id,
      }))
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('keeps a durable dispatch claim until turn/start is accepted', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-durable-dispatch-'))
    process.env.CODEX_HOME = codexHome
    const started = deferred<Record<string, unknown>>()
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [] } }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return started.promise
      if (method === 'config/read') return { config: { model: 'gpt-test' } }
      return {}
    })
    const processor = new BackendQueueProcessor({
      rpc,
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never)
    const message = {
      id: 'queued-dispatch',
      text: 'survive dispatch crash window',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    }

    try {
      await appendThreadQueuedMessage('thread-1', message)
      const processing = processor.processThreadQueue('thread-1')
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('turn/start', expect.anything()))

      const duringDispatch = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
        'thread-queue-processing'?: Record<string, { messageId: string }>
      }
      expect(duringDispatch['thread-queue-state']?.['thread-1']).toEqual([
        expect.objectContaining({ id: message.id }),
      ])
      expect(duringDispatch['thread-queue-processing']?.['thread-1']).toMatchObject({
        messageId: message.id,
      })

      started.resolve({ turn: { id: 'turn-queued' } })
      await processing
      const afterDispatch = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
        'thread-queue-processing'?: Record<string, { messageId: string }>
      }
      expect(afterDispatch['thread-queue-state']?.['thread-1'] ?? []).toEqual([])
      expect(afterDispatch['thread-queue-processing']?.['thread-1']).toBeUndefined()
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('finalizes an ambiguously accepted turn by client user message id', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-ambiguous-dispatch-'))
    process.env.CODEX_HOME = codexHome
    let readCount = 0
    let turnStartParams: Record<string, unknown> | undefined
    const rpc = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'thread/read') {
        readCount += 1
        return readCount === 1
          ? { thread: { id: 'thread-1', turns: [] } }
          : {
              thread: {
                id: 'thread-1',
                turns: [{
                  id: 'turn-accepted',
                  status: 'inProgress',
                  items: [{ type: 'userMessage', id: 'user-1', clientId: 'queued-ambiguous', content: [] }],
                }],
              },
            }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        turnStartParams = params as Record<string, unknown>
        throw new Error('response lost after acceptance')
      }
      if (method === 'config/read') return { config: { model: 'gpt-test' } }
      return {}
    })
    const processor = new BackendQueueProcessor({
      rpc,
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never)
    const message = {
      id: 'queued-ambiguous',
      text: 'run once despite response loss',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-test',
      effort: '' as const,
    }

    try {
      await appendThreadQueuedMessage('thread-1', message)
      await processor.processThreadQueue('thread-1')

      expect(turnStartParams).toMatchObject({ clientUserMessageId: message.id })
      const persisted = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as {
        'thread-queue-state'?: Record<string, Array<{ id: string }>>
        'thread-queue-processing'?: Record<string, { messageId: string }>
      }
      expect(persisted['thread-queue-state']?.['thread-1'] ?? []).toEqual([])
      expect(persisted['thread-queue-processing']?.['thread-1']).toBeUndefined()
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('reschedules a pending drain when a run-now request needs an earlier drain', async () => {
    vi.useFakeTimers()
    const processor = new BackendQueueProcessor({
      onNotification: () => () => undefined,
    } as never)
    const processThreadQueue = vi
      .spyOn(processor as unknown as { processThreadQueue: (threadId: string) => Promise<void> }, 'processThreadQueue')
      .mockResolvedValue(undefined)

    processor.scheduleThreadQueueDrain('thread-1', 5000)
    processor.scheduleThreadQueueDrain('thread-1', 0)

    await vi.advanceTimersByTimeAsync(0)
    expect(processThreadQueue).toHaveBeenCalledTimes(1)
    expect(processThreadQueue).toHaveBeenCalledWith('thread-1')

    await vi.advanceTimersByTimeAsync(5000)
    expect(processThreadQueue).toHaveBeenCalledTimes(1)

    processor.dispose()
  })

  it('keeps a recovered persistent queue blocked while an external app-server owns the thread', async () => {
    vi.useFakeTimers()
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-external-queue-'))
    process.env.CODEX_HOME = codexHome
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'thread-queue-state': {
        'thread-1': [{
          id: 'queued-1',
          text: 'do not start concurrently',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
        }],
      },
    }))
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-1',
            path: join(codexHome, 'sessions', 'rollout-thread-1.jsonl'),
            status: { type: 'idle' },
            turns: [{ id: 'completed-turn', status: 'completed' }],
          },
        }
      }
      if (method === 'config/read') return { config: { model: 'gpt-test' } }
      return {}
    })
    const runtimeProbe = {
      registerThread: vi.fn(),
      inspect: vi.fn(async () => ({
        state: 'running' as const,
        turnId: 'external-turn',
        interruptible: false as const,
        source: 'external-session-writer' as const,
      })),
    }
    const processor = new BackendQueueProcessor({
      rpc,
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never, runtimeProbe)

    try {
      await processor.scheduleAllQueuedThreads(0)
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => {
        expect(runtimeProbe.registerThread).toHaveBeenCalledWith(
          'thread-1',
          join(codexHome, 'sessions', 'rollout-thread-1.jsonl'),
        )
      })
      expect(runtimeProbe.inspect).toHaveBeenCalledWith('thread-1', 31337)
      expect(rpc).not.toHaveBeenCalledWith('thread/resume', expect.anything())
      expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('conservatively blocks a Linux queue when external runtime evidence is inconclusive', async () => {
    const runtimeProbe = {
      registerThread: vi.fn(),
      inspect: vi.fn(async () => ({ state: 'unknown' as const })),
    }
    const processor = new BackendQueueProcessor({
      rpc: vi.fn(async () => ({
        thread: {
          id: 'thread-1',
          path: '/home/user/.codex/sessions/rollout-thread-1.jsonl',
          status: { type: 'idle' },
          turns: [],
        },
      })),
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never, runtimeProbe)

    try {
      const status = await (processor as unknown as {
        inspectQueuedTurn: (turn: {
          threadId: string
          message: { id: string }
          attempted: boolean
        }) => Promise<{ accepted: boolean; canStart: boolean }>
      }).inspectQueuedTurn({
        threadId: 'thread-1',
        message: { id: 'queued-1' },
        attempted: false,
      })

      expect(status).toEqual({ accepted: false, canStart: process.platform !== 'linux' })
      if (process.platform === 'linux') {
        expect(runtimeProbe.registerThread).toHaveBeenCalledOnce()
        expect(runtimeProbe.inspect).toHaveBeenCalledWith('thread-1', 31337)
      }
    } finally {
      processor.dispose()
    }
  })

  it('preserves idle queue draining when thread/read has no trusted rollout path', async () => {
    const runtimeProbe = {
      registerThread: vi.fn(),
      inspect: vi.fn(async () => ({ state: 'unknown' as const })),
    }
    const processor = new BackendQueueProcessor({
      rpc: vi.fn(async () => ({
        thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] },
      })),
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never, runtimeProbe)

    try {
      await expect((processor as unknown as {
        inspectQueuedTurn: (turn: {
          threadId: string
          message: { id: string }
          attempted: boolean
        }) => Promise<{ accepted: boolean; canStart: boolean }>
      }).inspectQueuedTurn({
        threadId: 'thread-1',
        message: { id: 'queued-1' },
        attempted: false,
      })).resolves.toEqual({ accepted: false, canStart: true })
      expect(runtimeProbe.registerThread).not.toHaveBeenCalled()
      expect(runtimeProbe.inspect).not.toHaveBeenCalled()
    } finally {
      processor.dispose()
    }
  })

  it('pins backend queued turns to the unrestricted no-approval runtime policy', async () => {
    const processor = new BackendQueueProcessor({
      rpc: vi.fn(async (method: string) => {
        if (method === 'config/read') return { config: { model: 'gpt-test', model_reasoning_effort: 'high' } }
        return {}
      }),
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never)

    try {
      const params = await (processor as unknown as {
        buildQueuedTurnParams: (turn: {
          threadId: string
          message: {
            id: string
            text: string
            imageUrls: string[]
            skills: Array<{ name: string; path: string }>
            fileAttachments: Array<{ label: string; path: string; fsPath: string }>
            collaborationMode: 'default'
          }
        }) => Promise<Record<string, unknown>>
      }).buildQueuedTurnParams({
        threadId: 'thread-queued',
        message: {
          id: 'queued-1',
          text: 'continue queued work',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
        },
      })

      expect(params).toMatchObject({
        threadId: 'thread-queued',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      })
    } finally {
      processor.dispose()
    }
  })

  it('uses the model and effort captured with a queued message', async () => {
    const processor = new BackendQueueProcessor({
      rpc: vi.fn(async (method: string) => {
        if (method === 'config/read') {
          return { config: { model: 'gpt-5.5', model_reasoning_effort: 'medium' } }
        }
        return {}
      }),
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never)

    try {
      const params = await (processor as unknown as {
        buildQueuedTurnParams: (turn: {
          threadId: string
          message: {
            id: string
            text: string
            imageUrls: string[]
            skills: Array<{ name: string; path: string }>
            fileAttachments: Array<{ label: string; path: string; fsPath: string }>
            collaborationMode: 'default'
            model: string
            effort: 'max'
          }
        }) => Promise<Record<string, unknown>>
      }).buildQueuedTurnParams({
        threadId: 'thread-queued',
        message: {
          id: 'queued-1',
          text: 'continue with selected settings',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
          model: 'gpt-5.6-sol',
          effort: 'max',
        },
      })

      expect(params).toMatchObject({
        model: 'gpt-5.6-sol',
        effort: 'max',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-5.6-sol',
            reasoning_effort: 'max',
          },
        },
      })
    } finally {
      processor.dispose()
    }
  })

  it('recovers managed upload capabilities from durable queue state after restart', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-managed-queue-'))
    process.env.CODEX_HOME = codexHome
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=managed-queue'
    const queuedMessage = {
      id: 'queued-managed',
      text: 'inspect later',
      imageUrls: [managedImageUrl],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-5.5',
      effort: 'high' as const,
    }
    await appendThreadQueuedMessage('thread-queued', queuedMessage)
    const processor = new BackendQueueProcessor({
      rpc: vi.fn(async (method: string) => {
        if (method === 'config/read') return { config: { model: 'gpt-5.5' } }
        return {}
      }),
      getPid: () => 31337,
      onNotification: () => () => undefined,
    } as never)

    try {
      const turn = await (processor as unknown as {
        claimNextQueuedTurn: (threadId: string) => Promise<{
          threadId: string
          message: {
            id: string
            text: string
            imageUrls: string[]
            skills: Array<{ name: string; path: string }>
            fileAttachments: Array<{ label: string; path: string; fsPath: string }>
            collaborationMode: 'default' | 'plan'
            model: string
            effort: 'high'
          }
          attempted: boolean
        } | null>
      }).claimNextQueuedTurn('thread-queued')

      expect(turn?.message.imageUrls).toEqual([managedImageUrl])
      const params = await (processor as unknown as {
        buildQueuedTurnParams: (queuedTurn: {
          threadId: string
          message: {
            id: string
            text: string
            imageUrls: string[]
            skills: Array<{ name: string; path: string }>
            fileAttachments: Array<{ label: string; path: string; fsPath: string }>
            collaborationMode: 'default' | 'plan'
            model: string
            effort: 'high'
          }
        }) => Promise<Record<string, unknown>>
      }).buildQueuedTurnParams(turn!)
      expect(params.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'localImage', path: '/tmp/codex-web-uploads/upload/photo.png' }),
      ]))
    } finally {
      processor.dispose()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('automation TOML handling', () => {
  it('parses TOML string arrays without requiring JSON-only syntax', () => {
    const automation = parseAutomationToml([
      'version = 1',
      'id = "cron-smoke"',
      'kind = "cron"',
      'name = "Cron Smoke"',
      'prompt = "run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY"',
      "cwds = ['/tmp/project-one', '/tmp/project,two']",
      'created_at = 111',
      'updated_at = 222',
      '[scheduler]',
      'execution_environment = "local"',
    ].join('\n'))

    expect(automation?.cwds).toEqual(['/tmp/project-one', '/tmp/project,two'])
    expect(automation?.createdAtMs).toBe(111)
    expect(automation?.extraTomlLines).toContain('[scheduler]')
  })

  it('omits preserved TOML internals from automation API records', () => {
    const automation = parseAutomationToml([
      'version = 1',
      'id = "cron-smoke"',
      'kind = "cron"',
      'name = "Cron Smoke"',
      'prompt = "run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY"',
      'cwds = ["/tmp/project-one"]',
      '[scheduler]',
      'execution_environment = "local"',
    ].join('\n'))

    expect(automation).toBeTruthy()
    expect(toAutomationApiRecord(automation as NonNullable<typeof automation>)).not.toHaveProperty('extraTomlLines')
  })
})
