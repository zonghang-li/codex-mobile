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

  it('safe CLI shares in-flight shutdown and keeps signal listeners installed', async () => {
    const source = await readSource('./safe.ts')
    expect(source).toContain("import { createSharedShutdown } from './shared/shutdown.js'")
    expect(source).toContain('const shutdown = createSharedShutdown(async () => {')
    expect(source).toContain("process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)))")
    expect(source).toContain("process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)))")
    expect(source).not.toContain("process.once('SIGINT',")
    expect(source).not.toContain("process.once('SIGTERM',")
  })
})
