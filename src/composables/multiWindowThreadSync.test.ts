import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMultiWindowThreadSync,
  type MultiWindowThreadSyncChannel,
} from './multiWindowThreadSync'

type Listener = (event: { data: unknown }) => void

class FakeBroadcastChannel implements MultiWindowThreadSyncChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()

  readonly listeners = new Set<Listener>()
  closed = false

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set<FakeBroadcastChannel>()
    peers.add(this)
    FakeBroadcastChannel.channels.set(name, peers)
  }

  postMessage(message: unknown): void {
    const peers = FakeBroadcastChannel.channels.get(this.name) ?? new Set<FakeBroadcastChannel>()
    for (const peer of peers) {
      if (peer === this || peer.closed) continue
      for (const listener of peer.listeners) {
        listener({ data: message })
      }
    }
  }

  addEventListener(eventName: 'message', listener: Listener): void {
    if (eventName === 'message') this.listeners.add(listener)
  }

  removeEventListener(eventName: 'message', listener: Listener): void {
    if (eventName === 'message') this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

function createSync(instanceId: string) {
  return createMultiWindowThreadSync({
    instanceId,
    channelFactory: (name) => new FakeBroadcastChannel(name),
    leaderSettleMs: 10,
    followerTimeoutMs: 100,
  })
}

describe('multi-window active thread text sync', () => {
  afterEach(() => {
    vi.useRealTimers()
    FakeBroadcastChannel.channels.clear()
  })

  it('lets one visible leader load a shared active text page while followers reuse the broadcast', async () => {
    vi.useFakeTimers()
    const leader = createSync('a-leader')
    const follower = createSync('b-follower')
    const leaderLoader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { items: ['delta-1'] }
    })
    const followerLoader = vi.fn(async () => ({ items: ['should-not-load'] }))

    const leaderPromise = leader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: leaderLoader,
    })
    const followerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: followerLoader,
    })

    await vi.advanceTimersByTimeAsync(40)

    await expect(leaderPromise).resolves.toEqual({ items: ['delta-1'] })
    await expect(followerPromise).resolves.toEqual({ items: ['delta-1'] })
    expect(leaderLoader).toHaveBeenCalledTimes(1)
    expect(followerLoader).not.toHaveBeenCalled()

    leader.dispose()
    follower.dispose()
  })

  it('does not share active text pages across different threads', async () => {
    vi.useFakeTimers()
    const first = createSync('a-window')
    const second = createSync('b-window')
    const firstLoader = vi.fn(async () => ({ items: ['thread-a'] }))
    const secondLoader = vi.fn(async () => ({ items: ['thread-b'] }))

    const firstPromise = first.loadActiveTextPage({
      threadId: 'thread-a',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: firstLoader,
    })
    const secondPromise = second.loadActiveTextPage({
      threadId: 'thread-b',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: secondLoader,
    })

    await vi.advanceTimersByTimeAsync(20)

    await expect(firstPromise).resolves.toEqual({ items: ['thread-a'] })
    await expect(secondPromise).resolves.toEqual({ items: ['thread-b'] })
    expect(firstLoader).toHaveBeenCalledTimes(1)
    expect(secondLoader).toHaveBeenCalledTimes(1)

    first.dispose()
    second.dispose()
  })

  it('lets a follower take over when the elected leader disappears before publishing', async () => {
    vi.useFakeTimers()
    const disappearingLeader = createSync('a-leader')
    const follower = createSync('b-follower')
    const leaderLoader = vi.fn(async () => new Promise<never>(() => undefined))
    const followerLoader = vi.fn(async () => ({ items: ['takeover'] }))

    void disappearingLeader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: leaderLoader,
    }).catch(() => undefined)
    const followerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: followerLoader,
    })

    await vi.advanceTimersByTimeAsync(20)
    disappearingLeader.dispose()
    await vi.advanceTimersByTimeAsync(120)

    await expect(followerPromise).resolves.toEqual({ items: ['takeover'] })
    expect(leaderLoader).toHaveBeenCalledTimes(1)
    expect(followerLoader).toHaveBeenCalledTimes(1)

    follower.dispose()
  })

  it('lets a follower take over without waiting for timeout when the leader retires', async () => {
    vi.useFakeTimers()
    const retiringLeader = createSync('a-leader')
    const follower = createSync('b-follower')
    const leaderLoader = vi.fn(async () => new Promise<never>(() => undefined))
    const followerLoader = vi.fn(async () => ({ items: ['retired-takeover'] }))

    void retiringLeader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: leaderLoader,
    }).catch(() => undefined)
    const followerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: followerLoader,
    })

    await vi.advanceTimersByTimeAsync(5)
    retiringLeader.dispose()
    await vi.advanceTimersByTimeAsync(20)

    await expect(followerPromise).resolves.toEqual({ items: ['retired-takeover'] })
    expect(leaderLoader).toHaveBeenCalledTimes(1)
    expect(followerLoader).toHaveBeenCalledTimes(1)

    follower.dispose()
  })

  it('lets a waiting follower take over immediately when the elected leader retires', async () => {
    vi.useFakeTimers()
    const retiringLeader = createSync('a-leader')
    const follower = createSync('b-follower')
    const leaderLoader = vi.fn(async () => new Promise<never>(() => undefined))
    const followerLoader = vi.fn(async () => ({ items: ['waiting-takeover'] }))
    let followerResolved = false

    void retiringLeader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: leaderLoader,
    }).catch(() => undefined)
    const followerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: followerLoader,
    })
    followerPromise.then(() => {
      followerResolved = true
    }).catch(() => undefined)

    await vi.advanceTimersByTimeAsync(20)
    expect(leaderLoader).toHaveBeenCalledTimes(1)
    expect(followerLoader).not.toHaveBeenCalled()

    retiringLeader.dispose()
    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()

    expect(followerResolved).toBe(true)
    await expect(followerPromise).resolves.toEqual({ items: ['waiting-takeover'] })
    expect(followerLoader).toHaveBeenCalledTimes(1)

    follower.dispose()
  })

  it('lets a follower take over without waiting for timeout when the leader is hidden', async () => {
    vi.useFakeTimers()
    const hiddenLeader = createSync('a-leader')
    const follower = createSync('b-follower')
    const leaderLoader = vi.fn(async () => new Promise<never>(() => undefined))
    const followerLoader = vi.fn(async () => ({ items: ['hidden-takeover'] }))

    void hiddenLeader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: leaderLoader,
    }).catch(() => undefined)
    const followerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest',
      load: followerLoader,
    })

    await vi.advanceTimersByTimeAsync(5)
    hiddenLeader.setVisible(false)
    await vi.advanceTimersByTimeAsync(20)

    await expect(followerPromise).resolves.toEqual({ items: ['hidden-takeover'] })
    expect(leaderLoader).not.toHaveBeenCalled()
    expect(followerLoader).toHaveBeenCalledTimes(1)

    hiddenLeader.dispose()
    follower.dispose()
  })

  it('releases completed request claims before later requests elect a leader', async () => {
    vi.useFakeTimers()
    const firstLeader = createSync('a-leader')
    const follower = createSync('b-follower')
    const firstLeaderLoader = vi.fn(async () => ({ items: ['first-page'] }))
    const firstFollowerLoader = vi.fn(async () => ({ items: ['should-not-load'] }))

    const firstLeaderPromise = firstLeader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest:full',
      load: firstLeaderLoader,
    })
    const firstFollowerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest:full',
      load: firstFollowerLoader,
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(firstLeaderPromise).resolves.toEqual({ items: ['first-page'] })
    await expect(firstFollowerPromise).resolves.toEqual({ items: ['first-page'] })
    expect(firstLeaderLoader).toHaveBeenCalledTimes(1)
    expect(firstFollowerLoader).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 600)
    const laterFollowerLoader = vi.fn(async () => ({ items: ['later-page'] }))
    const laterFollowerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest:full',
      load: laterFollowerLoader,
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(laterFollowerPromise).resolves.toEqual({ items: ['later-page'] })
    expect(laterFollowerLoader).toHaveBeenCalledTimes(1)

    firstLeader.dispose()
    follower.dispose()
  })

  it('prunes stale request claims from windows that disappear without retiring', async () => {
    vi.useFakeTimers()
    const staleLeader = createSync('a-stale-leader')
    const follower = createSync('b-follower')
    const staleLeaderLoader = vi.fn(async () => new Promise<never>(() => undefined))
    const followerLoader = vi.fn(async () => ({ items: ['stale-takeover'] }))

    void staleLeader.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest:full',
      load: staleLeaderLoader,
    }).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(20)
    expect(staleLeaderLoader).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 2_000)
    const followerPromise = follower.loadActiveTextPage({
      threadId: 'thread-1',
      turnId: 'turn-1',
      requestKey: 'newest:full',
      load: followerLoader,
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(followerPromise).resolves.toEqual({ items: ['stale-takeover'] })
    expect(followerLoader).toHaveBeenCalledTimes(1)

    staleLeader.dispose()
    follower.dispose()
  })
})
