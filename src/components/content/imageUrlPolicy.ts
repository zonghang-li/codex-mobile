const SAFE_DATA_IMAGE_URL =
  /^data:image\/(?:avif|bmp|gif|jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/u
const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u
const UNSAFE_URL_CHARACTERS = /[\u0000-\u001f\u007f]/u

export function safeImageFallbackHref(value: string): string {
  const normalized = value.trim()
  if (!normalized || UNSAFE_URL_CHARACTERS.test(normalized)) return ''

  if (SAFE_DATA_IMAGE_URL.test(normalized)) return normalized
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized
  }
  if (normalized.startsWith('blob:') && normalized.length > 'blob:'.length) {
    return normalized
  }

  if (
    normalized.startsWith('//')
    || normalized.startsWith('\\\\')
    || EXPLICIT_SCHEME.test(normalized)
  ) {
    return ''
  }

  return normalized
}
