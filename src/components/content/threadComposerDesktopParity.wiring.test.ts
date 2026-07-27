import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')

describe('ThreadComposer desktop parity wiring', () => {
  it('renders desktop-order goal, combined model/effort, mic, and primary action controls without a fixed permission status', () => {
    const controls = source.indexOf('class="thread-composer-controls"')
    const attach = source.indexOf('thread-composer-attach-trigger', controls)
    const goal = source.indexOf('thread-composer-goal-trigger', controls)
    const combined = source.indexOf('thread-composer-model-effort', controls)
    const mic = source.indexOf('thread-composer-mic', controls)
    const primary = source.indexOf('thread-composer-stop', controls)

    expect(attach).toBeGreaterThan(controls)
    expect(goal).toBeGreaterThan(attach)
    expect(combined).toBeGreaterThan(goal)
    expect(mic).toBeGreaterThan(combined)
    expect(primary).toBeGreaterThan(mic)
    expect(source).not.toContain('thread-composer-permission-trigger')
    expect(source).not.toContain('composerControlState.permissionLabel')
    expect(source).toContain('composerControlState.modelEffortLabel')
  })

  it('keeps Goal and Model/Effort in one compact configuration group across thread states', () => {
    const controls = source.indexOf('class="thread-composer-controls"')
    const configGroup = source.indexOf('class="thread-composer-config-controls"', controls)
    const goal = source.indexOf('thread-composer-goal-trigger', configGroup)
    const combined = source.indexOf('thread-composer-model-effort', configGroup)
    const actions = source.indexOf('class="thread-composer-actions"', configGroup)
    const mic = source.indexOf('thread-composer-mic', actions)

    expect(configGroup).toBeGreaterThan(controls)
    expect(goal).toBeGreaterThan(configGroup)
    expect(combined).toBeGreaterThan(goal)
    expect(actions).toBeGreaterThan(combined)
    expect(mic).toBeGreaterThan(actions)
    const actionRuleStart = source.indexOf('.thread-composer-actions {')
    const actionRuleEnd = source.indexOf('}', actionRuleStart)
    expect(source.slice(actionRuleStart, actionRuleEnd)).not.toContain('ml-auto')
  })

  it('uses stable mobile-sized config controls and a compact model label', () => {
    expect(source).not.toContain('v-if="goalSupported"')
    expect(source).toContain(':selected-label="desktopModelEffortTriggerLabel"')
    expect(source).toContain('formatComposerModelEffortTriggerLabel')
    expect(source).not.toContain('function formatCompactModelLabel')
    expect(source).toContain('thread-composer-control-label')
    expect(source).not.toContain('@apply px-1.5 text-xs')
    expect(source).not.toContain('@apply max-w-[8.75rem]')
  })

  it('lets the desktop-style Model/Effort label use available bottom bar space before truncating', () => {
    const modelRuleStart = source.indexOf('.thread-composer-model-effort {')
    const modelRuleEnd = source.indexOf('}', modelRuleStart)
    const modelRule = source.slice(modelRuleStart, modelRuleEnd)
    const mobileRuleStart = source.indexOf('  .thread-composer-model-effort {', source.indexOf('@media (max-width: 640px)'))
    const mobileRuleEnd = source.indexOf('  }', mobileRuleStart)
    const mobileRule = source.slice(mobileRuleStart, mobileRuleEnd)
    const spacerRuleStart = source.indexOf('.thread-composer-controls-spacer {')
    const spacerRuleEnd = source.indexOf('}', spacerRuleStart)
    const spacerRule = source.slice(spacerRuleStart, spacerRuleEnd)

    expect(modelRule).toContain('flex: 1 1 auto')
    expect(modelRule).not.toContain('max-width: 11rem')
    expect(mobileRule).not.toContain('max-width: 10.5rem')
    expect(spacerRule).not.toContain('flex-1')
  })

  it('keeps skills, speed, plan, and in-progress mode inside desktop-style menus', () => {
    expect(source).toContain('thread-composer-attach-skills')
    expect(source).toContain("t('Fast mode')")
    expect(source).toContain("t('Plan mode')")
    expect(source).toContain("t('In-progress send')")
  })

  it('uses the selected-thread placeholder and forwards Goal mutations through App', () => {
    expect(source).toContain("t('Do anything')")
    expect(source).toContain("'set-goal':")
    expect(appSource).toContain(':goal-supported="selectedThreadGoalSupported"')
    expect(appSource).toContain(':has-goal="selectedThreadGoal !== null"')
    expect(appSource).toContain('@set-goal="updateSelectedThreadGoal"')
  })
})
