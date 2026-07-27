import { describe, expect, it } from 'vitest'
import { createSnapshotTextStreamer } from './snapshotTextStreaming'

describe('snapshot text streaming display buffer', () => {
  it('reveals the first streamable snapshot in chunks after a refresh', () => {
    const streamer = createSnapshotTextStreamer({ textChunkSize: 5, outputChunkSize: 4 })

    expect(streamer.update([{
      id: 'assistant-1',
      text: 'hello',
      streamable: true,
    }])).toEqual({ changed: true, pending: true })
    expect(streamer.readText('assistant-1')).toBe('')

    expect(streamer.advance()).toBe(true)
    expect(streamer.readText('assistant-1')).toBe('hello')
    expect(streamer.hasPending()).toBe(false)

    expect(streamer.update([{
      id: 'assistant-1',
      text: 'hello world',
      streamable: true,
    }])).toEqual({ changed: false, pending: true })
    expect(streamer.readText('assistant-1')).toBe('hello')

    expect(streamer.advance()).toBe(true)
    expect(streamer.readText('assistant-1')).toBe('hello worl')
    expect(streamer.hasPending()).toBe(true)

    expect(streamer.advance()).toBe(true)
    expect(streamer.readText('assistant-1')).toBe('hello world')
    expect(streamer.hasPending()).toBe(false)
  })

  it('shows non-streamable snapshots immediately', () => {
    const streamer = createSnapshotTextStreamer({ textChunkSize: 5, outputChunkSize: 4 })

    expect(streamer.update([{
      id: 'assistant-1',
      text: 'historical text',
      streamable: false,
    }])).toEqual({ changed: true, pending: false })

    expect(streamer.readText('assistant-1')).toBe('historical text')
  })

  it('streams only the latest streamable snapshot and shows earlier streamable snapshots immediately', () => {
    const streamer = createSnapshotTextStreamer({ textChunkSize: 3, outputChunkSize: 4 })

    expect(streamer.update([
      {
        id: 'assistant-1',
        text: 'previous assistant text',
        streamable: true,
      },
      {
        id: 'assistant-2',
        text: 'latest assistant text',
        streamable: true,
      },
    ])).toEqual({ changed: true, pending: true })

    expect(streamer.readText('assistant-1')).toBe('previous assistant text')
    expect(streamer.readText('assistant-2')).toBe('')

    expect(streamer.advance()).toBe(true)
    expect(streamer.readText('assistant-1')).toBe('previous assistant text')
    expect(streamer.readText('assistant-2')).toBe('lat')
  })

  it('does not let a non-renderable trailing snapshot steal streaming from the latest visible snapshot', () => {
    const streamer = createSnapshotTextStreamer({ textChunkSize: 4, outputChunkSize: 4 })

    expect(streamer.update([
      {
        id: 'assistant-visible',
        text: 'visible assistant text',
        streamable: true,
      },
      {
        id: 'hidden-plan-footer',
        text: 'hidden plan footer',
        streamable: true,
        renderable: false,
      },
    ])).toEqual({ changed: true, pending: true })

    expect(streamer.readText('assistant-visible')).toBe('')
    expect(streamer.readText('hidden-plan-footer')).toBe('hidden plan footer')

    expect(streamer.advance()).toBe(true)
    expect(streamer.readText('assistant-visible')).toBe('visi')
    expect(streamer.readText('hidden-plan-footer')).toBe('hidden plan footer')
  })

  it('reveals command output growth without delaying the command row itself', () => {
    const streamer = createSnapshotTextStreamer({ textChunkSize: 8, outputChunkSize: 3 })

    streamer.update([{
      id: 'cmd-1',
      text: 'pnpm test',
      commandOutput: 'one',
      streamable: true,
    }])
    expect(streamer.readText('cmd-1')).toBe('pnpm test')
    expect(streamer.readCommandOutput('cmd-1')).toBe('')

    streamer.advance()
    expect(streamer.readCommandOutput('cmd-1')).toBe('one')

    streamer.update([{
      id: 'cmd-1',
      text: 'pnpm test',
      commandOutput: 'one two three',
      streamable: true,
    }])
    expect(streamer.readCommandOutput('cmd-1')).toBe('one')

    streamer.advance()
    expect(streamer.readCommandOutput('cmd-1')).toBe('one tw')
  })

  it('resets immediately when a snapshot is not a prefix growth', () => {
    const streamer = createSnapshotTextStreamer({ textChunkSize: 2, outputChunkSize: 2 })

    streamer.update([{ id: 'assistant-1', text: 'abcdef', streamable: true }])
    streamer.update([{ id: 'assistant-1', text: 'abcXYZ', streamable: true }])

    expect(streamer.readText('assistant-1')).toBe('abcXYZ')
    expect(streamer.hasPending()).toBe(false)
  })
})
