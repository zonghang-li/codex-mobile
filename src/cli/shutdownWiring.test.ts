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
      expect(source).toContain('() => listening.close()')
      expect(source).toContain('closeWebSocket,')
      expect(source).toContain('dispose,')
      expect(source).not.toContain('server.close(() =>')
    },
  )

  it.each(['./safe.ts', './index.ts'])(
    '%s shares in-flight shutdown and reports signal cleanup status',
    async (relativePath) => {
      const source = await readSource(relativePath)
      expect(source).toContain(
        "import { createSharedShutdown, runBestEffortShutdown } from './shared/shutdown.js'",
      )
      expect(source).toContain('const shutdown = createSharedShutdown(() => runBestEffortShutdown(')
      expect(source).toContain('const handleShutdownSignal = () => {')
      expect(source).toContain('() => process.exit(0)')
      expect(source).toContain('process.exit(1)')
      expect(source).toContain("process.on('SIGINT', handleShutdownSignal)")
      expect(source).toContain("process.on('SIGTERM', handleShutdownSignal)")
      expect(source).not.toContain('let shuttingDown = false')
      expect(source).not.toContain("process.once('SIGINT',")
      expect(source).not.toContain("process.once('SIGTERM',")
    },
  )
})
