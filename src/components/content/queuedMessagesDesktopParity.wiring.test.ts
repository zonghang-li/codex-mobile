import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./QueuedMessages.vue', import.meta.url), 'utf8')

describe('QueuedMessages desktop parity', () => {
  it('keeps semantic queue actions and uses explicit touch-safe ordering controls', () => {
    expect(source).toContain("emit('edit'")
    expect(source).toContain("emit('steer'")
    expect(source).toContain("emit('delete'")
    expect(source).toContain("emit('reorder'")
    expect(source).not.toContain(':draggable=')
    expect(source).not.toContain('@dragstart=')
    expect(source).toContain('queued-row-move-up')
    expect(source).toContain('queued-row-move-down')
  })

  it('guards every mutation while externally owned', () => {
    expect(source).toMatch(/function onEdit\(messageId: string\): void \{\n  if \(props\.disabled\) return/u)
    expect(source).toMatch(/function onSteer\(messageId: string\): void \{\n  if \(props\.disabled\) return/u)
    expect(source).toMatch(/function onDelete\(messageId: string\): void \{\n  if \(props\.disabled\) return/u)
    expect(source).toMatch(/function onMove\(messageId: string, direction: -1 \| 1\): void \{\n  if \(props\.disabled\) return/u)
  })
})
