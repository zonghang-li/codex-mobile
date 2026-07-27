import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

describe('CLI shutdown wiring', () => {
  it.each(['./safe.ts', './index.ts'])(
    '%s retains and invokes bounded connection cleanup',
    async (relativePath) => {
      const source = await readSource(relativePath)
      expect(source).toContain('const closeWebSocket = attachWebSocket(server)')
      expect(source).toContain('const closeServer = listening.close()')
      expect(source).toContain('closeWebSocket()')
      expect(source).toContain('dispose()')
      expect(source).toContain('await closeServer')
      expect(source).not.toContain('server.close(() =>')
    },
  )
})
