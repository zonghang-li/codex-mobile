export type DisplayMathRenderOptions = {
  displayMode: true
  throwOnError: true
  trust: false
  strict: 'warn'
}

export type DisplayMathRenderFunction = (
  value: string,
  options: DisplayMathRenderOptions,
) => string

const DISPLAY_MATH_OPTIONS: DisplayMathRenderOptions = {
  displayMode: true,
  throwOnError: true,
  trust: false,
  strict: 'warn',
}

export function tryRenderDisplayMathToHtml(
  renderer: DisplayMathRenderFunction | null,
  value: string,
): string | null {
  if (!renderer) return null
  try {
    return renderer(value, DISPLAY_MATH_OPTIONS)
  } catch {
    return null
  }
}
