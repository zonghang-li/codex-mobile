import type { ListItem, MessageBlock } from './messageBlockTypes'

function serializeListItem(item: ListItem): string {
  return [
    item.paragraphs.join('\n\n'),
    ...(item.children ?? []).map(serializeMessageBlockForCopy),
  ].filter((part) => part.length > 0).join('\n\n')
}

export function serializeMessageBlockForCopy(block: MessageBlock): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
      return block.value
    case 'unorderedList':
      return block.items.map((item) => `- ${serializeListItem(item)}`).join('\n')
    case 'orderedList':
      return block.items.map((item, index) => `${block.start + index}. ${serializeListItem(item)}`).join('\n')
    case 'taskList':
      return block.items.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n')
    case 'table':
      return [block.headers, ...block.rows].map((row) => row.join('\t')).join('\n')
    case 'codeBlock':
      return block.value
    case 'thematicBreak':
    case 'image':
      return ''
  }
}
