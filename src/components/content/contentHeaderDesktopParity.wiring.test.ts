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

  it('retains sidebar and branch actions without exposing the terminal control', () => {
    expect(appSource).toContain('@toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"')
    expect(appSource).not.toContain('content-header-terminal-command')
    expect(appSource).not.toContain('<ThreadTerminalPanel')
    expect(appSource).not.toContain('onSelectHeaderTerminalCommand')
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

  it('labels detached HEAD by sha instead of showing the commit subject as a branch', () => {
    expect(branchSource).not.toMatch(/if \(props\.headSubject\) return props\.headSubject/u)
    expect(branchSource).toContain("if (props.detached && props.headSha) return `Detached ${props.headSha}`")
  })

  it('uses the running runtime cwd for thread branch controls before falling back to thread metadata cwd', () => {
    expect(appSource).toContain('selectedThreadRuntimeCwd')
    expect(appSource).toContain('const threadGitCwd = computed(() => {')
    expect(appSource).toContain('const failedRuntimeGitCwd = ref')
    expect(appSource).toContain('runtimeCwd && runtimeCwd !== failedRuntimeGitCwd.value')
    expect(appSource).toContain('? runtimeCwd')
    expect(appSource).toContain(': composerCwd.value.trim()')
    expect(appSource).toContain('void loadThreadBranches(cwd, { fallbackCwd: composerCwd.value })')
  })
})
