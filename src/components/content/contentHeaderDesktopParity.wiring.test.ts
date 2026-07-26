import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('./ContentHeader.vue', import.meta.url), 'utf8')
const branchSource = readFileSync(new URL('./HeaderGitBranchDropdown.vue', import.meta.url), 'utf8')

describe('selected thread header desktop parity wiring', () => {
  it('keeps the selected title readable, truncated, and editable', () => {
    expect(headerSource).toContain('IconTablerFilePencil')
    expect(headerSource).toContain('editable?: boolean')
    expect(headerSource).toContain('disabled?: boolean')
    expect(headerSource).toContain('emit(\'rename\'')
    expect(headerSource).toContain('@keydown.enter.prevent="submitRename"')
    expect(headerSource).toContain('@keydown.esc.prevent="cancelRename"')
    expect(headerSource).toMatch(/\.content-title\s*\{[^}]*text-overflow:\s*ellipsis/su)
    expect(appSource).toContain(':editable="route.name === \'thread\' && selectedThreadId.length > 0"')
    expect(appSource).toContain('@rename="onRenameSelectedThread"')
  })

  it('retains sidebar, terminal, and branch actions with their state guards', () => {
    expect(appSource).toContain('@toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"')
    expect(appSource).toContain('v-if="canShowTerminalToggle"')
    expect(appSource).toContain(':disabled="isComposerTerminalControlDisabled"')
    expect(appSource).toContain('v-if="canShowContentHeaderBranchDropdown"')
    expect(appSource).toContain(':busy="isSwitchingThreadBranch"')
    expect(appSource).toContain(':key="selectedThreadId"')
  })

  it('closes the branch menu on checkout, outside click, Escape, and thread change', () => {
    expect(branchSource).toContain(':aria-expanded="isOpen"')
    expect(branchSource).toContain('@click="checkoutSelectedBranch(branch.value)"')
    expect(branchSource).toContain('function closeMenu()')
    expect(branchSource).toMatch(/function selectBranch\(branch: string\)[\s\S]*checkoutSelectedBranch\(branch\)/u)
    expect(branchSource).toContain('function onDocumentPointerDown')
    expect(branchSource).toContain('function onDocumentKeyDown')
    expect(branchSource).toContain("event.key !== 'Escape'")
    expect(branchSource).toContain("window.addEventListener('keydown', onDocumentKeyDown)")
    expect(branchSource).toContain("window.removeEventListener('keydown', onDocumentKeyDown)")
  })
})
