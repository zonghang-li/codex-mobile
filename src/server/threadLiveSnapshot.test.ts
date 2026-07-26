import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseThreadLiveSnapshot, readThreadLiveSnapshotFile } from './threadLiveSnapshot'

const nowMs = Date.parse('2026-07-27T00:00:00.000Z')

function validSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    threadId: 'thread-1',
    activeTurnId: 'turn-1',
    revision: 12,
    generatedAt: '2026-07-26T23:59:59.000Z',
    expiresAt: '2026-07-27T00:00:30.000Z',
    source: 'desktop-writer',
    state: 'running',
    footer: {
      stepCurrent: 2,
      stepTotal: 6,
      completedPercent: 33.3333,
      fileCount: 29,
      additions: 5485,
      deletions: 417,
      label: 'Step 2 / 6 · 29 files changed +5485 -417',
    },
    timeline: [],
    pendingRequest: null,
    sidebar: { indicator: 'running' },
    ...overrides,
  }
}

describe('thread live snapshots', () => {
  it('accepts a fresh snapshot for the requested thread and active turn', () => {
    expect(parseThreadLiveSnapshot(validSnapshot(), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toMatchObject({
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      revision: 12,
      footer: {
        stepCurrent: 2,
        stepTotal: 6,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
      },
    })
  })

  it('rejects expired, wrong-thread, wrong-turn, and stale-revision snapshots', () => {
    expect(parseThreadLiveSnapshot(validSnapshot({ expiresAt: '2026-07-26T23:59:59.000Z' }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
    expect(parseThreadLiveSnapshot(validSnapshot({ threadId: 'thread-2' }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
    expect(parseThreadLiveSnapshot(validSnapshot({ activeTurnId: 'turn-2' }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
    expect(parseThreadLiveSnapshot(validSnapshot({ revision: 9 }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
      minRevision: 10,
    })).toBeNull()
  })

  it('rejects malformed footer values instead of coercing them', () => {
    expect(parseThreadLiveSnapshot(validSnapshot({
      footer: {
        stepCurrent: '2',
        stepTotal: 6,
        completedPercent: 33,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
        label: 'bad',
      },
    }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
  })

  it('reads a snapshot file and returns null for missing or invalid files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
    try {
      await writeFile(join(dir, 'thread-1.json'), JSON.stringify(validSnapshot()), 'utf8')
      await writeFile(join(dir, 'thread-bad.json'), '{not json', 'utf8')

      await expect(readThreadLiveSnapshotFile(dir, 'thread-1', {
        activeTurnId: 'turn-1',
        nowMs,
      })).resolves.toMatchObject({ revision: 12 })
      await expect(readThreadLiveSnapshotFile(dir, 'thread-missing', {
        activeTurnId: 'turn-1',
        nowMs,
      })).resolves.toBeNull()
      await expect(readThreadLiveSnapshotFile(dir, 'thread-bad', {
        activeTurnId: 'turn-1',
        nowMs,
      })).resolves.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
