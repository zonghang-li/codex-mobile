import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)
const activityIconSource = readFileSync(
  new URL('./ThreadActivityIcon.vue', import.meta.url),
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
    expect(source).toContain('activitySegmentAgents(readActivitySegment(message))')
    expect(source).toContain('activitySegmentCommands(readActivitySegment(message))')
    expect(source).toContain('@click="toggleActivitySegment(message.id)"')
    expect(source).not.toContain('activitySegmentStatus(')
  })

  it('matches desktop activity icons for edit, read, and command summaries', () => {
    expect(source).toContain('activitySegmentIconKind')
    expect(source).toContain('<ThreadActivityIcon :kind="activitySegmentIconKind(readActivitySegment(message))" />')
    expect(activityIconSource).toContain("kind === 'book'")
    expect(activityIconSource).toContain("kind === 'search'")
    expect(activityIconSource).toContain("kind === 'edit'")
    expect(activityIconSource).toContain("kind === 'terminal'")
    expect(activityIconSource).toContain("kind === 'integration' || kind === 'agent'")
  })

  it('uses the same segment model inside completed Worked details', () => {
    expect(source).toContain('getTurnActivitySegmentsForWorked(messages, messages.indexOf(message))')
    expect(source).not.toContain('v-for="activity in getTurnActivityMessagesForWorked(')
  })

  it('only gives command rows disclosure affordances when output exists', () => {
    expect(source).toContain('function commandCanExpand(message: UiMessage): boolean')
    expect(source).toContain('v-if="commandCanExpand(cmd)"')
    expect(source).toContain('v-if="commandCanExpand(message)"')
    expect(source).toContain('class="cmd-row cmd-status-only"')
  })

  it('uses the desktop turn projector for completion folding and final-response identity', () => {
    expect(source).toContain('projectConversationTurns({')
    expect(source).toContain('section.isCollapsed && section.completionMessageId !== null')
    expect(source).toContain('projectedActivityMessageIds.value.has(message.id)')
    expect(source).toContain(':data-turn-final-response="isProjectedFinalResponse(message)')
  })
})
