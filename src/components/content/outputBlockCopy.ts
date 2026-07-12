import type { ListItem, MessageBlock } from './messageBlockTypes'

type CopyableMessage = {
  role: 'user' | 'assistant' | 'system'
  messageType?: string
}

function indentLines(value: string, depth: number): string {
  const indent = '  '.repeat(depth)
  return value.split('\n').map((line) => `${indent}${line}`).join('\n')
}

function serializeListItem(item: ListItem, depth: number): string {
  const continuationDepth = depth + 1
  const paragraphs = item.paragraphs.map((paragraph, index) => {
    if (index > 0) return indentLines(paragraph, continuationDepth)
    const continuationIndent = '  '.repeat(continuationDepth)
    return paragraph.replace(/\n/gu, `\n${continuationIndent}`)
  }).join('\n\n')

  return [
    paragraphs,
    ...(item.children ?? []).map((child) => serializeMessageBlock(child, continuationDepth)),
  ].filter((part) => part.length > 0).join('\n\n')
}

function serializeMessageBlock(block: MessageBlock, depth: number): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
      return indentLines(block.value, depth)
    case 'unorderedList':
      return block.items
        .map((item) => `${'  '.repeat(depth)}- ${serializeListItem(item, depth)}`)
        .join('\n')
    case 'orderedList':
      return block.items
        .map((item, index) => `${'  '.repeat(depth)}${block.start + index}. ${serializeListItem(item, depth)}`)
        .join('\n')
    case 'taskList':
      return block.items
        .map((item) => `${'  '.repeat(depth)}- [${item.checked ? 'x' : ' '}] ${item.text}`)
        .join('\n')
    case 'table':
      return [block.headers, ...block.rows]
        .map((row) => indentLines(row.join('\t'), depth))
        .join('\n')
    case 'codeBlock':
      return indentLines(block.value, depth)
    case 'thematicBreak':
    case 'image':
      return ''
  }
}

export function serializeMessageBlockForCopy(block: MessageBlock): string {
  return serializeMessageBlock(block, 0)
}

export function messageBlockCopyText(message: CopyableMessage, block: MessageBlock): string {
  if (message.role === 'user') return ''
  return serializeMessageBlockForCopy(block)
}

export function messageBlockCopyLabel(message: CopyableMessage): string {
  if (message.messageType === 'turnError') return 'Copy error'
  if ((message.messageType ?? '').toLowerCase().includes('reasoning')) return 'Copy reasoning'
  return 'Copy output block'
}
