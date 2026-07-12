import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation per-block copy integration', () => {
  it('covers structured message, command, reasoning, plan, and error output', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toContain('CopyableOutputBlock')
    expect(source).toContain(':copy-text="messageBlockCopyText(message, block)"')
    expect(source).toContain(':label="messageBlockCopyLabel(message)"')
    expect(source).toContain('label="Copy command output"')
    expect(source).toContain('label="Copy reasoning"')
    expect(source).toContain('label="Copy plan explanation"')
    expect(source).toContain('label="Copy plan step"')
    expect(source).toContain('label="Copy error"')
  })

  it('passes exact raw output payloads and excludes image and visual diff controls', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toContain(':copy-text="cmd.commandExecution?.aggregatedOutput ?? \'\'"')
    expect(source).toContain(':copy-text="message.commandExecution?.aggregatedOutput ?? \'\'"')
    expect(source).toContain(':copy-text="liveOverlay.reasoningText"')
    expect(source).toContain(':copy-text="step.step"')
    expect(source).not.toMatch(/CopyableOutputBlock[^>]+(?:block\.markdown|block\.url)/u)
    expect(source).not.toMatch(/diff-viewer[\s\S]{0,300}CopyableOutputBlock/u)
  })
})

describe('CopyableOutputBlock interaction and responsive contract', () => {
  it('isolates clicks and exposes success and failure feedback accessibly', async () => {
    const source = await readFile(new URL('./CopyableOutputBlock.vue', import.meta.url), 'utf8')
    const button = source.match(/<button\s+[\s\S]*?@click\.stop="copyOutput"[\s\S]*?>/u)?.[0]
    const liveStatus = source.match(/<span\s+class="output-block-copy-status"\s+aria-live="polite">\{\{ errorText \}\}<\/span>/u)?.[0]
    expect(button).toBeDefined()
    expect(button).toContain(":aria-label=\"copied ? 'Copied' : label\"")
    expect(liveStatus).toBeDefined()
    expect(source).toContain('createOutputBlockCopyController')
  })

  it('keeps a 32px visible mobile target and reveals desktop controls on focus', async () => {
    const source = await readFile(new URL('./CopyableOutputBlock.vue', import.meta.url), 'utf8')
    expect(source).toContain('min-width: 32px')
    expect(source).toContain('min-height: 32px')
    expect(source).toContain('@media (hover: none), (pointer: coarse)')
    expect(source).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*opacity: 1[\s\S]*pointer-events: auto/u)
    expect(source).toContain('@media (hover: hover) and (pointer: fine)')
    expect(source).toContain('.output-block-copy-button:focus-visible')
  })
})
