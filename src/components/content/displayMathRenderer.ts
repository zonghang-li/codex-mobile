export type DisplayMathRenderOptions = {
  displayMode: boolean
  throwOnError: true
  trust: false
  strict: 'warn'
}

export type DisplayMathRenderFunction = (
  value: string,
  options: DisplayMathRenderOptions,
) => string

export function tryRenderMathToHtml(
  renderer: DisplayMathRenderFunction | null,
  value: string,
  displayMode: boolean,
): string | null {
  if (!renderer) return null
  try {
    return renderer(value, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'warn',
    })
  } catch {
    return null
  }
}

export function tryRenderDisplayMathToHtml(
  renderer: DisplayMathRenderFunction | null,
  value: string,
): string | null {
  return tryRenderMathToHtml(renderer, value, true)
}
