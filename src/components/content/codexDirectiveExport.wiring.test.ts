import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Codex directive export wiring', () => {
  it('appends readable directive metadata after message prose', async () => {
    const appSource = await readFile(new URL('../../App.vue', import.meta.url), 'utf8')

    expect(appSource).toContain("import { codexDirectiveExportLines } from './utils/codexDirectives'")
    expect(appSource).toContain('for (const directive of message.directives ?? [])')
    expect(appSource).toContain('lines.push(...codexDirectiveExportLines(directive, t))')

    const messageProseIndex = appSource.indexOf('const normalizedText = message.text.trim()')
    const directiveExportIndex = appSource.indexOf('for (const directive of message.directives ?? [])')
    const commandExportIndex = appSource.indexOf('if (message.commandExecution)')

    expect(messageProseIndex).toBeGreaterThan(-1)
    expect(directiveExportIndex).toBeGreaterThan(messageProseIndex)
    expect(directiveExportIndex).toBeLessThan(commandExportIndex)
  })
})
