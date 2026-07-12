import {
  boundNtfyState,
  createEmptyNtfyState,
  type FileNtfyStateStore,
  type NtfyNotifierState,
  type PendingNtfyRecord,
} from '../safe/ntfyState'

export const NTFY_MIN_DURATION_MS = 600_000
export const NTFY_SUMMARY_MAX_LENGTH = 180
export const NTFY_REQUEST_TIMEOUT_MS = 5_000
export const NTFY_IMMEDIATE_ATTEMPTS = 3

type TerminalTitle = PendingNtfyRecord['title']
type Notification = { method: string; params?: unknown }
type StateStore = Pick<FileNtfyStateStore, 'load' | 'save'>

export type NtfySendRequest = {
  publishUrl: string
  record: PendingNtfyRecord
  signal: AbortSignal
}

export type NtfyCompletionNotifierOptions = {
  publishUrl: string
  stateStore: StateStore
  readThread: (threadId: string) => Promise<unknown>
  send?: (request: NtfySendRequest) => Promise<void>
  now?: () => number
  createTimeoutSignal?: (milliseconds: number) => AbortSignal
  warn?: (message: string) => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function truncateText(text: string, maximum: number): string {
  return Array.from(text).slice(0, maximum).join('')
}

function stripNotificationMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, '')
    .replace(/[*_~`]+/gu, '')
}

export function summarizeAssistantResponse(text: string): string {
  const normalized = stripNotificationMarkup(text).replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const sentence = normalized.match(/^.*?[。！？.!?](?=\s|$|[^。！？.!?])/u)?.[0] ?? normalized
  return truncateText(sentence.trim(), NTFY_SUMMARY_MAX_LENGTH)
}

export function readLatestAssistantText(threadReadResult: unknown): string {
  const response = asRecord(threadReadResult)
  const nestedThread = asRecord(response?.thread)
  const thread = nestedThread ?? response
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = asRecord(turns[turnIndex])
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = asRecord(items[itemIndex])
      if (item?.type !== 'agentMessage') continue
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (text) return text
    }
  }
  return ''
}

function readEvent(notification: unknown): {
  method: string
  threadId: string
  turnId: string
  status: string
} | null {
  const root = asRecord(notification)
  const method = readString(root?.method)
  const params = asRecord(root?.params)
  if (!method || !params) return null
  const thread = asRecord(params.thread)
  const turn = asRecord(params.turn)
  const threadId = readString(
    params.threadId,
    params.thread_id,
    thread?.id,
    thread?.threadId,
    thread?.thread_id,
    turn?.threadId,
    turn?.thread_id,
  )
  const turnId = readString(params.turnId, params.turn_id, turn?.id, turn?.turnId, turn?.turn_id)
  return {
    method,
    threadId,
    turnId,
    status: readString(turn?.status, params.status),
  }
}

function classifyStatus(status: string): { title: TerminalTitle; fallback: string } {
  if (status === 'completed') return { title: 'Codex 任务完成', fallback: '任务已完成。' }
  if (status === 'failed') return { title: 'Codex 任务失败', fallback: '任务执行失败。' }
  return { title: 'Codex 任务已中断', fallback: '任务已中断。' }
}

async function sendNtfyRequest(request: NtfySendRequest): Promise<void> {
  const response = await fetch(request.publishUrl, {
    method: 'POST',
    headers: {
      Title: request.record.title,
      Priority: 'default',
      Tags: 'white_check_mark',
    },
    body: request.record.message,
    signal: request.signal,
  })
  if (!response.ok) throw new Error(`ntfy request failed with HTTP ${String(response.status)}`)
}

export class NtfyCompletionNotifier {
  private state: NtfyNotifierState = createEmptyNtfyState()
  private work: Promise<void> = Promise.resolve()
  private started = false
  private readonly send: (request: NtfySendRequest) => Promise<void>
  private readonly now: () => number
  private readonly createTimeoutSignal: (milliseconds: number) => AbortSignal
  private readonly warn: (message: string) => void

  constructor(private readonly options: NtfyCompletionNotifierOptions) {
    this.send = options.send ?? sendNtfyRequest
    this.now = options.now ?? Date.now
    this.createTimeoutSignal = options.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds))
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  async start(): Promise<void> {
    if (this.started) return this.work
    this.started = true
    this.enqueue(async () => {
      try {
        this.state = boundNtfyState(await this.options.stateStore.load())
      } catch {
        this.state = createEmptyNtfyState()
        this.warn('Unable to load long-task notification state')
      }
      await this.drainPending()
    })
    await this.work
  }

  handle(notification: Notification): void {
    if (!this.started) return
    const receivedAt = this.now()
    this.enqueue(async () => {
      await this.processNotification(notification, receivedAt)
      await this.drainPending()
    })
  }

  async dispose(): Promise<void> {
    await this.work
  }

  private enqueue(task: () => Promise<void>): void {
    this.work = this.work.then(task).catch(() => {
      this.warn('Unable to process long-task notification state')
    })
  }

  private async processNotification(notification: unknown, receivedAt: number): Promise<void> {
    const event = readEvent(notification)
    if (!event || !event.threadId || !event.turnId) return
    const key = `${event.threadId}:${event.turnId}`

    if (event.method === 'turn/started') {
      const active = this.state.active.find((record) => record.key === key)
      if (active) return
      if (this.state.sent.some((record) => record.key === key)) return
      this.state.active.push({
        key,
        threadId: event.threadId,
        turnId: event.turnId,
        startedAt: receivedAt,
      })
      this.state = boundNtfyState(this.state)
      await this.options.stateStore.save(this.state)
      return
    }

    if (event.method !== 'turn/completed') return
    if (this.state.sent.some((record) => record.key === key)) return
    if (this.state.pending.some((record) => record.key === key)) return
    const activeIndex = this.state.active.findIndex((record) => record.key === key)
    if (activeIndex < 0) return
    const [active] = this.state.active.splice(activeIndex, 1)
    if (!active) return

    if (receivedAt - active.startedAt < NTFY_MIN_DURATION_MS) {
      await this.options.stateStore.save(this.state)
      return
    }

    const classification = classifyStatus(event.status)
    let assistantText = ''
    try {
      assistantText = readLatestAssistantText(await this.options.readThread(event.threadId))
    } catch {
      this.warn('Unable to read final assistant response for long-task notification')
    }
    const message = summarizeAssistantResponse(assistantText) || classification.fallback
    this.state.pending.push({
      key,
      title: classification.title,
      message,
      createdAt: receivedAt,
    })
    this.state = boundNtfyState(this.state)
    await this.options.stateStore.save(this.state)
  }

  private async drainPending(): Promise<void> {
    const keys = this.state.pending.map((record) => record.key)
    for (const key of keys) {
      const record = this.state.pending.find((candidate) => candidate.key === key)
      if (record) await this.deliver(record)
    }
  }

  private async deliver(record: PendingNtfyRecord): Promise<void> {
    for (let attempt = 0; attempt < NTFY_IMMEDIATE_ATTEMPTS; attempt += 1) {
      try {
        await this.send({
          publishUrl: this.options.publishUrl,
          record,
          signal: this.createTimeoutSignal(NTFY_REQUEST_TIMEOUT_MS),
        })
      } catch {
        // Delivery is best effort; only a redacted summary is reported after bounded retries.
        continue
      }
      this.state.pending = this.state.pending.filter((candidate) => candidate.key !== record.key)
      if (!this.state.sent.some((candidate) => candidate.key === record.key)) {
        this.state.sent.push({ key: record.key, sentAt: this.now() })
      }
      this.state = boundNtfyState(this.state)
      await this.options.stateStore.save(this.state)
      return
    }
    await this.options.stateStore.save(this.state)
    this.warn('Unable to deliver long-task notification; it remains pending')
  }
}
