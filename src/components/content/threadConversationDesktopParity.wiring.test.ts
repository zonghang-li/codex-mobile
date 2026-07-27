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
const appSource = readFileSync(
  new URL('../../App.vue', import.meta.url),
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

  it('renders subagent chips and concrete activity rows without expandable action details', () => {
    expect(source).toContain('class="codex-agent-activity-chip"')
    expect(source).toContain('activitySegmentAgents(readActivitySegment(message))')
    expect(source).toContain('class="codex-activity-row"')
    expect(source).not.toContain('@click="toggleActivitySegment(message.id)"')
    expect(source).not.toContain('activitySegmentStatus(')
  })

  it('renders action activity as non-expandable concrete rows on the main transcript', () => {
    expect(source).not.toContain('toggleActivitySegment(message.id)')
    expect(source).not.toContain('class="codex-activity-row codex-activity-button"')
    expect(source).not.toContain('class="cmd-group-wrap codex-activity-details"')
    expect(source).not.toContain('activitySegmentCanExpand(')
    expect(source).not.toContain('activitySegmentCommands(')
    expect(source).not.toContain('activitySegmentFileChanges(')
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

  it('does not collapse consecutive command events into a synthetic command group', () => {
    expect(source).toContain('const groupedCommandsByLatestId = computed<Record<string, UiMessage[]>>(() => ({}))')
    expect(source).not.toContain("return 'Ran commands'")
    expect(source).not.toContain('next[latest.id] = block.slice(0, -1)')
  })

  it('labels in-progress command rows as RUNNING instead of an exit status', () => {
    expect(source).toContain("case 'inProgress': return 'RUNNING'")
    expect(source).toContain("if (s === 'inProgress') return 'cmd-status-running'")
    expect(source).toMatch(/\.cmd-status-running \.cmd-status\s*\{[\s\S]*@apply [^;]*text-emerald-600/u)
  })

  it('enables snapshot text streaming from external running state after refresh', () => {
    expect(appSource).toMatch(/<ThreadConversation[\s\S]*:is-thread-in-progress="isSelectedThreadInProgress"[\s\S]*:read-only="selectedThreadRuntimeOwnership === 'external'"/u)
    expect(source).toContain('isThreadInProgress?: boolean')
    expect(source).toContain('props.isThreadInProgress === true')
    expect(source).toContain('const activeSnapshotTextStreamTurnId = computed(() =>')
    expect(source).toContain('latestSnapshotTextStreamTurnId.value')
    expect(source).not.toContain('isSnapshotTextStreamingEnabled = computed(() =>\n  props.readOnly === true &&\n  Boolean(props.activeTurnId?.trim()) &&\n  isLiveTurnRuntime.value')
  })

  it('uses a readable snapshot streaming cadence and locks to bottom while streaming from bottom', () => {
    expect(source).toContain('const SNAPSHOT_TEXT_STREAM_INTERVAL_MS = 56')
    expect(source).toContain('textChunkSize: 18')
    expect(source).toContain('outputChunkSize: 96')
    expect(source).toContain('const snapshotTextStreamBottomLock = ref(false)')
    expect(source).toContain('function beginSnapshotTextStreamBottomLock(): void')
    expect(source).toContain('return autoFollowOutput.value || snapshotTextStreamBottomLock.value')
    expect(source).toContain('@touchstart.passive="onConversationUserScrollIntent"')
    expect(source).toContain('@wheel.passive="onConversationUserScrollIntent"')
  })

  it('renders the latest snapshot streaming command directly instead of hiding it behind an activity summary', () => {
    expect(source).toContain('const snapshotTextStreamTargetMessageId = computed(() =>')
    expect(source).toContain('function isSnapshotTextStreamTargetMessage(message: UiMessage): boolean')
    expect(source).toContain('if (isSnapshotTextStreamTargetMessage(message)) return null')
  })

  it('does not auto-expand command output at the end of a running transcript', () => {
    expect(source).toContain('isCommandOutputExpanded(')
    expect(source).toContain('toggleCommandOutputExpanded(')
    expect(source).toContain('@click="toggleCommandExpand(message)"')
    expect(source).toContain("'cmd-output-visible': isCommandExpanded(message)")
    expect(source).not.toContain('message.id === activeCommandMessageId.value')
    expect(source).not.toContain('|| isSnapshotTextStreamTargetMessage(message)')
  })

  it('does not treat programmatic bottom-follow scroll events as user scroll-away intent', () => {
    expect(source).toContain('let userScrollIntentUntilMs = 0')
    expect(source).toContain('function hasRecentUserScrollIntent(): boolean')
    expect(source).toContain('if (!atBottom && shouldLockToBottom() && !hasRecentUserScrollIntent())')
    expect(source).toContain('autoFollowOutput.value = false')
  })

  it('uses the desktop turn projector for completion folding and final-response identity', () => {
    expect(source).toContain('projectConversationTurns({')
    expect(source).toContain('section.isCollapsed && section.completionMessageId !== null')
    expect(source).toContain('projectedActivityMessageIds.value.has(message.id)')
    expect(source).toContain(':data-turn-final-response="isProjectedFinalResponse(message)')
  })
})
