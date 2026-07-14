import { describe, expect, it } from 'vitest'
import {
  nextQuickThemeMode,
  readThemeMode,
  resolveEffectiveTheme,
} from './themeMode'

describe('theme mode decisions', () => {
  it.each([
    [null, 'system'],
    ['', 'system'],
    ['invalid', 'system'],
    ['system', 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
  ] as const)('reads %s as %s', (stored, expected) => {
    expect(readThemeMode(stored)).toBe(expected)
  })

  it('resolves system mode and chooses the opposite explicit quick mode', () => {
    expect(resolveEffectiveTheme('system', false)).toBe('light')
    expect(nextQuickThemeMode('system', false)).toBe('dark')
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(nextQuickThemeMode('system', true)).toBe('light')
  })

  it('alternates explicit modes without consulting the system', () => {
    expect(nextQuickThemeMode('light', true)).toBe('dark')
    expect(nextQuickThemeMode('dark', false)).toBe('light')
  })
})
