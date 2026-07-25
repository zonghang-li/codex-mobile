import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)

describe('ThreadConversation subagent status wiring', () => {
  it('renders aggregated child agents as non-interactive status-only spans', () => {
    expect(source).toContain('v-for="agent in activitySegmentAgents(readActivitySegment(message))"')
    expect(source).toContain('v-for="agent in segment.agents"')
    expect(source).toContain(':data-agent-state="agent.state"')
    expect(source).toContain('{{ agent.label }}')
    expect(source).toContain('{{ segment.status }}')
    expect(source).not.toContain('@click="openSubAgent')
    expect(source).not.toContain('tabindex="0"')
  })

  it('uses a neutral existing icon and neutral wrapping styles', () => {
    const iconRule = source.match(/\.codex-agent-activity-icon\s*\{([^}]*)\}/u)?.[1] ?? ''
    expect(source).toContain('<IconTablerBolt class="icon-svg codex-agent-activity-icon"')
    expect(source).toMatch(/\.codex-agent-activity-row\s*\{[\s\S]*?flex-wrap/u)
    expect(iconRule).toContain('text-zinc-')
    expect(iconRule).not.toContain('text-amber-')
  })
})
