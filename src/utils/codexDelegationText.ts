const RAW_CODEX_DELEGATION_OPEN_RE = /<codex_delegation\b[^>]*>/iu
const ESCAPED_CODEX_DELEGATION_OPEN_RE = /&(?:amp;)*lt;\s*codex_delegation\b/iu

function decodeHtmlEntity(entity: string): string {
  switch (entity.toLowerCase()) {
    case 'lt':
    case '#60':
    case '#x3c':
      return '<'
    case 'gt':
    case '#62':
    case '#x3e':
      return '>'
    case 'amp':
      return '&'
    case 'quot':
      return '"'
    case 'apos':
    case '#39':
    case '#x27':
      return "'"
    default:
      return `&${entity};`
  }
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(/&([A-Za-z]+|#\d+|#x[0-9A-F]+);/giu, (_match, entity: string) =>
    decodeHtmlEntity(entity),
  )
}

export function normalizeCodexDelegationText(value: string): string {
  if (RAW_CODEX_DELEGATION_OPEN_RE.test(value)) return value
  if (!ESCAPED_CODEX_DELEGATION_OPEN_RE.test(value)) return value

  let decoded = value
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = decodeHtmlEntitiesOnce(decoded)
    if (next === decoded) break
    decoded = next
    if (RAW_CODEX_DELEGATION_OPEN_RE.test(decoded)) return decoded
  }
  return value
}
