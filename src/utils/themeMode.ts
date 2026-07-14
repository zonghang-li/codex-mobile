export type ThemeMode = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

export function readThemeMode(value: string | null): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function resolveEffectiveTheme(mode: ThemeMode, systemDark: boolean): EffectiveTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

export function nextQuickThemeMode(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return resolveEffectiveTheme(mode, systemDark) === 'dark' ? 'light' : 'dark'
}
