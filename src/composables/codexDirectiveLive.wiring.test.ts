import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Codex directive live-message wiring', () => {
  it('parses cumulative raw agent deltas without feeding rendered text back into the stream', async () => {
    const source = await readFile(new URL('./useDesktopState.ts', import.meta.url), 'utf8')

    expect(source).toContain('liveAgentRawTextByThreadId')
    expect(source).toContain('suppressIncompleteTrailingDirective: true')
    expect(source).toMatch(/liveAgentRawTextByThreadId[\s\S]*liveAgentMessageDelta\.delta/u)
    expect(source).toContain('areCodexDirectivesEqual')
  })

  it('clears private raw text at every live-message lifecycle boundary', async () => {
    const source = await readFile(new URL('./useDesktopState.ts', import.meta.url), 'utf8')

    expect(source).toMatch(/completedAgentMessage[\s\S]*clearLiveAgentRawText/u)

    const clearThreadBody = source.match(
      /function clearLiveAgentMessagesForThread\(threadId: string\): void \{([\s\S]*?)\n  \}/u,
    )?.[1]
    expect(clearThreadBody).toBeDefined()
    expect(clearThreadBody).toContain('clearLiveAgentRawTextForThread(threadId)')
    expect(clearThreadBody?.indexOf('clearLiveAgentRawTextForThread(threadId)'))
      .toBeLessThan(clearThreadBody?.indexOf("if (!(threadId in liveAgentMessagesByThreadId.value)) return") ?? -1)

    expect(source).toMatch(
      /function pruneThreadScopedState[\s\S]*pruneLiveAgentRawText\(activeThreadIds\)[\s\S]*liveAgentMessagesByThreadId\.value = pruneThreadStateMap/u,
    )
    expect(source).toMatch(
      /liveAgentMessagesByThreadId\.value = \{\}[\s\S]*liveAgentRawTextByThreadId\.clear\(\)/u,
    )
  })
})
