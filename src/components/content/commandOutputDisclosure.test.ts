import { describe, expect, it } from 'vitest'
import {
  isCommandOutputExpanded,
  toggleCommandOutputExpanded,
} from './commandOutputDisclosure'

describe('command output disclosure', () => {
  it('stays collapsed across snapshot updates until the user toggles it', () => {
    const commandId = 'command-1'
    let expandedIds = new Set<string>()

    expect(isCommandOutputExpanded(expandedIds, commandId, true)).toBe(false)

    // A refreshed snapshot can replace the message object while retaining its
    // stable command id. That update must not implicitly disclose the output.
    expect(isCommandOutputExpanded(expandedIds, commandId, true)).toBe(false)

    expandedIds = toggleCommandOutputExpanded(expandedIds, commandId, true)
    expect(isCommandOutputExpanded(expandedIds, commandId, true)).toBe(true)

    expandedIds = toggleCommandOutputExpanded(expandedIds, commandId, true)
    expect(isCommandOutputExpanded(expandedIds, commandId, true)).toBe(false)
  })

  it('ignores disclosure toggles for commands without output', () => {
    const expandedIds = new Set<string>()
    const next = toggleCommandOutputExpanded(expandedIds, 'command-without-output', false)

    expect(next).toBe(expandedIds)
    expect(isCommandOutputExpanded(next, 'command-without-output', false)).toBe(false)
  })
})
