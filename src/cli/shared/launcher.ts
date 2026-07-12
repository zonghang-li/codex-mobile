import type { Server } from 'node:http'
import { spawn } from 'node:child_process'

export type ListeningServer = {
  server: Server
  port: number
  host: string
  close: () => Promise<void>
}

export function listenWithFallback(server: Server, startPort: number, host: string): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (port !== 0 && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
          attempt(port + 1)
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address()
        const actualPort = address && typeof address === 'object' ? address.port : port
        resolve({
          server,
          port: actualPort,
          host,
          close: () => new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => error ? closeReject(error) : closeResolve())
          }),
        })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    attempt(startPort)
  })
}

export function openBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? { cmd: 'open', args: [url] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
      : { cmd: 'xdg-open', args: [url] }
  const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}
