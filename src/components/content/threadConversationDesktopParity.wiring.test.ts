import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)

describe('ThreadConversation Codex desktop activity parity wiring', () => {
  it('renders derived activity segments before raw command and file-change rows', () => {
    expect(source).toContain('const activitySegments = computed(() => buildThreadActivitySegments(props.messages))')
    expect(source).toContain('v-if="readActivitySegment(message)"')
    expect(source.indexOf('v-if="readActivitySegment(message)"')).toBeLessThan(
      source.indexOf('v-else-if="isCommandMessage(message)"'),
    )
    expect(source).toContain('hiddenActivitySegmentSourceIds.value')
  })

  it('renders subagent chips and expandable command details from a summary segment', () => {
    expect(source).toContain('class="codex-agent-activity-chip"')
    expect(source).toContain('{{ activitySegmentAgentStatus(readActivitySegment(message)) }}')
    expect(source).toContain('activitySegmentCommands(readActivitySegment(message))')
    expect(source).toContain('@click="toggleActivitySegment(message.id)"')
    expect(source).not.toContain('activitySegmentStatus(')
  })

  it('uses the same segment model inside completed Worked details', () => {
    expect(source).toContain('getTurnActivitySegmentsForWorked(messages, messages.indexOf(message))')
    expect(source).not.toContain('v-for="activity in getTurnActivityMessagesForWorked(')
  })
})
