import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('mobile sidebar interaction policy', () => {
  it('gates hover-only row swapping behind fine-pointer capability', async () => {
    const row = await readFile(new URL('./SidebarMenuRow.vue', import.meta.url), 'utf8')
    expect(row).toContain('@media (hover: hover) and (pointer: fine)')
    expect(row).toContain('@media (hover: none), (pointer: coarse)')
  })

  it('does not hide thread status indicators on coarse pointers', async () => {
    const tree = await readFile(new URL('./SidebarThreadTree.vue', import.meta.url), 'utf8')
    expect(tree).toContain('@media (hover: hover) and (pointer: fine)')
  })

  it('keeps thread navigation on the main button only', async () => {
    const tree = await readFile(new URL('./SidebarThreadTree.vue', import.meta.url), 'utf8')
    expect(tree).not.toContain('@click="onSelect(thread.id)"')
    expect(tree.match(/@click\.stop="onSelect\(thread\.id\)"/gu)).toHaveLength(4)
  })
})
