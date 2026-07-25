import { describe, expect, it } from 'vitest'
import {
  commandActivityCategories,
  commandDisplayLabel,
} from './commandActivity'

describe('command activity', () => {
  it('prefers official app-server command actions', () => {
    const actions = [{
      type: 'search',
      command: 'custom-wrapper',
      query: 'UiMessage',
      path: 'src',
    }]

    expect(commandActivityCategories('custom-wrapper', actions)).toEqual(['search'])
    expect(commandDisplayLabel('custom-wrapper', actions)).toBe('Searched UiMessage in src')
  })

  it('classifies conservative restored-history read, list, and search commands', () => {
    expect(commandActivityCategories('sed -n "1,80p" src/App.vue', [])).toEqual(['read'])
    expect(commandActivityCategories('tail -40 /tmp/server.log', [])).toEqual(['read'])
    expect(commandActivityCategories('rg --files src', [])).toEqual(['listFiles'])
    expect(commandActivityCategories('find src -maxdepth 2 -type f', [])).toEqual(['listFiles'])
    expect(commandActivityCategories('rg -n "UiMessage" src', [])).toEqual(['search'])
    expect(commandActivityCategories('git grep "UiMessage" -- src', [])).toEqual(['search'])
  })

  it('keeps mutations and general execution unknown', () => {
    expect(commandActivityCategories('pnpm test', [])).toEqual(['unknown'])
    expect(commandActivityCategories('sed -i "s/a/b/" src/App.vue', [])).toEqual(['unknown'])
    expect(commandActivityCategories('cat input > output', [])).toEqual(['unknown'])
  })

  it('preserves ordered unique categories from compound commands', () => {
    expect(commandActivityCategories(
      'sed -n "1,80p" a && rg -n x b; pnpm test',
      [],
    )).toEqual(['read', 'search', 'unknown'])
    expect(commandActivityCategories('cat a | rg x', [])).toEqual(['read', 'search'])
  })
})
