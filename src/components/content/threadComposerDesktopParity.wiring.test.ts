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
