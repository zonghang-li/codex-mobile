import { fileURLToPath } from 'node:url'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeFile, stat } from 'node:fs/promises'
import express, { type Express } from 'express'
import { createCodexBridgeMiddleware } from './codexAppServerBridge.js'
import { createAuthSession } from './authMiddleware.js'
import { createDirectoryListingHtml, createTextEditorHtml, decodeBrowsePath, getLocalDirectoryListing, isTextEditableFile, normalizeLocalPath } from './localBrowseUi.js'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PERMISSIVE_SECURITY_POLICY,
  type ServerSecurityPolicy,
} from './securityPolicy.js'
import { NtfyCompletionNotifier, type NtfyCompletionNotifierOptions } from './ntfyCompletionNotifier.js'
import {
  createExternalTurnMonitor,
  type ExternalTurnMonitor,
  type ExternalTurnMonitorOptions,
} from './externalTurnMonitor.js'
import { FileNtfyStateStore } from '../safe/ntfyState.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')
const spaEntryFile = join(distDir, 'index.html')
const spaBuildMetadataFile = join(distDir, 'codex-build.json')
export const FRONTEND_ENTRY_CACHE_CONTROL = 'private, no-store, max-age=0'

export type ServerOptions = {
  password?: string
  securityPolicy?: ServerSecurityPolicy
  ntfyNotifications?: {
    publishUrl: string
    statePath: string
  }
}

export type ServerInstance = {
  app: Express
  dispose: () => void
  attachWebSocket: (server: HttpServer) => () => void
}

type NtfyBridge = {
  readThreadForNotifier: (threadId: string) => Promise<unknown>
  getAppServerPidForNotifier: () => number | null
  getSessionsRootForNotifier: () => string
  subscribeNotifications: (
    listener: (notification: { method: string; params: unknown; atIso: string }) => void,
  ) => () => void
}

type NtfyNotifier = Pick<NtfyCompletionNotifier, 'start' | 'handle' | 'handleObserved' | 'dispose'>

export function createNtfyNotifierLifecycle(options: {
  bridge: NtfyBridge
  config?: ServerOptions['ntfyNotifications']
  createStateStore?: (statePath: string, warn: (message: string) => void) => FileNtfyStateStore
  createNotifier?: (options: NtfyCompletionNotifierOptions) => NtfyNotifier
  createExternalMonitor?: (options: ExternalTurnMonitorOptions) => ExternalTurnMonitor
  warn?: (message: string) => void
}): { dispose: () => void } {
  if (!options.config) return { dispose: () => undefined }
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const createStateStore = options.createStateStore ?? ((statePath, stateWarn) => (
    new FileNtfyStateStore(statePath, stateWarn)
  ))
  const createNotifier = options.createNotifier ?? ((notifierOptions) => (
    new NtfyCompletionNotifier(notifierOptions)
  ))
  const createExternalMonitor = options.createExternalMonitor ?? createExternalTurnMonitor
  const notifier = createNotifier({
    publishUrl: options.config.publishUrl,
    stateStore: createStateStore(options.config.statePath, warn),
    readThread: options.bridge.readThreadForNotifier,
    warn,
  })
  let disposed = false
  let externalMonitor: ExternalTurnMonitor | null = null
  const notifierStart = notifier.start()
  let unsubscribe: (() => void) | null = options.bridge.subscribeNotifications((notification) => {
    notifier.handle(notification)
  })
  const initialized = notifierStart.then(() => {
    if (disposed) return
    try {
      externalMonitor = createExternalMonitor({
        sessionsRoot: options.bridge.getSessionsRootForNotifier(),
        getExcludedPid: options.bridge.getAppServerPidForNotifier,
        onLifecycle: (event) => {
          return notifier.handleObserved(event)
        },
        warn,
      })
      void externalMonitor.start().catch(() => {
        warn('Unable to start external turn monitoring')
      })
    } catch {
      warn('Unable to start external turn monitoring')
    }
  }, () => {
    warn('Unable to start long-task notifications')
  })
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      unsubscribe = null
      const monitorDisposal = externalMonitor
        ? externalMonitor.dispose()
        : initialized.then(() => externalMonitor?.dispose())
      void monitorDisposal.catch(() => {
        warn('Unable to stop external turn monitoring')
      }).then(() => notifier.dispose()).catch(() => {
        warn('Unable to stop long-task notifications')
      })
    },
  }
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function renderFrontendMissingHtml(message: string, details?: string[]): string {
  const lines = details && details.length > 0 ? `<pre>${details.join('\n')}</pre>` : ''
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Codex Web UI Error</title></head>',
    '<body>',
    `<h1>${message}</h1>`,
    lines,
    '<p>Redirecting to chat in 3 seconds...</p>',
    '<p><a href="/">Back to chat</a></p>',
    '<script>',
    'setTimeout(() => { window.location.assign("/") }, 3000)',
    '</script>',
    '</body>',
    '</html>',
  ].join('')
}

export function shouldBypassSpaFallbackForStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest'
  )
}

let frontendBuildIdCache: {
  mtimeMs: number
  size: number
  buildId: string
} | null = null

export function readFrontendBuildIdFromMetadata(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { buildId?: unknown }
    return typeof parsed.buildId === 'string' ? parsed.buildId.trim() : ''
  } catch {
    return ''
  }
}

export function getFrontendBuildIdForClient(): string {
  try {
    const metadataBuildId = readFrontendBuildIdFromMetadata(readFileSync(spaBuildMetadataFile, 'utf8'))
    if (metadataBuildId) return metadataBuildId
  } catch {
    // Fall back to the entry hash for older builds without metadata.
  }

  try {
    const entryStat = statSync(spaEntryFile)
    const cached = frontendBuildIdCache
    if (cached && cached.mtimeMs === entryStat.mtimeMs && cached.size === entryStat.size) {
      return cached.buildId
    }
    const entry = readFileSync(spaEntryFile)
    const digest = createHash('sha256').update(entry).digest('hex').slice(0, 16)
    const buildId = `spa-${digest}-${entryStat.size}`
    frontendBuildIdCache = {
      mtimeMs: entryStat.mtimeMs,
      size: entryStat.size,
      buildId,
    }
    return buildId
  } catch {
    return 'spa-missing'
  }
}

function normalizeLocalImagePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('file://')) {
    try {
      return decodeURIComponent(trimmed.replace(/^file:\/\//u, ''))
    } catch {
      return trimmed.replace(/^file:\/\//u, '')
    }
  }
  return trimmed
}

function readWildcardPathParam(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join('/')
  return ''
}

export function createServer(options: ServerOptions = {}): ServerInstance {
  const app = express()
  const securityPolicy = options.securityPolicy ?? PERMISSIVE_SECURITY_POLICY
  const bridge = createCodexBridgeMiddleware({ securityPolicy })
  const ntfyLifecycle = createNtfyNotifierLifecycle({
    bridge,
    config: options.ntfyNotifications,
  })
  const authSession = options.password ? createAuthSession(options.password) : null

  // 1. Auth middleware (if password is set)
  if (authSession) {
    app.use(authSession.middleware)
  }

  app.get('/codex-api/app-version', (_req, res) => {
    res
      .status(200)
      .setHeader('Cache-Control', 'private, no-store, max-age=0')
      .json({
        buildId: getFrontendBuildIdForClient(),
      })
  })

  // 2. Bridge middleware for /codex-api/*
  app.use(bridge)

  // 3. Serve local images referenced in markdown (desktop parity for absolute image paths)
  app.get('/codex-local-image', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    const requestedPath = normalizeLocalImagePath(rawPath)
    if (!requestedPath || !isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'Expected absolute local file path.' })
      return
    }
    const localPath = await securityPolicy.resolveLocalPath(requestedPath)
    if (!localPath) {
      res.status(403).json({ error: 'Path is outside configured roots.' })
      return
    }

    const contentType = IMAGE_CONTENT_TYPES[extname(localPath).toLowerCase()]
    if (!contentType) {
      res.status(415).json({ error: 'Unsupported image type.' })
      return
    }

    res.type(contentType)
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.sendFile(localPath, { dotfiles: 'allow' }, (error) => {
      if (!error) return
      if (!res.headersSent) res.status(404).json({ error: 'Image file not found.' })
    })
  })

  // 4. Serve local files inline for direct file open.
  app.get('/codex-local-file', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    const requestedPath = normalizeLocalPath(rawPath)
    if (!requestedPath || !isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'Expected absolute local file path.' })
      return
    }
    const localPath = await securityPolicy.resolveLocalPath(requestedPath)
    if (!localPath) {
      res.status(403).json({ error: 'Path is outside configured roots.' })
      return
    }

    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', 'inline')
    res.sendFile(localPath, { dotfiles: 'allow' }, (error) => {
      if (!error) return
      if (!res.headersSent) res.status(404).json({ error: 'File not found.' })
    })
  })

  // 5. Return JSON directory listings for the integrated folder picker.
  app.get('/codex-local-directories', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    const showHidden = typeof req.query.showHidden === 'string'
      && ['1', 'true', 'yes', 'on'].includes(req.query.showHidden.toLowerCase())
    const requestedPath = normalizeLocalPath(rawPath)
    if (!requestedPath || !isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'Expected absolute local directory path.' })
      return
    }
    const localPath = await securityPolicy.resolveLocalPath(requestedPath)
    if (!localPath) {
      res.status(403).json({ error: 'Path is outside configured roots.' })
      return
    }

    try {
      const fileStat = await stat(localPath)
      if (!fileStat.isDirectory()) {
        res.status(400).json({ error: 'Expected directory path.' })
        return
      }
      const data = await getLocalDirectoryListing(localPath, { showHidden })
      res.status(200).json({ data })
    } catch {
      res.status(404).json({ error: 'Directory not found.' })
    }
  })

  // 6. Serve local files by path to preserve relative asset loading for HTML.
  app.get('/codex-local-browse/*path', async (req, res) => {
    const rawPath = readWildcardPathParam(req.params.path)
    const requestedPath = decodeBrowsePath(`/${rawPath}`)
    if (!requestedPath || !isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'Expected absolute local file path.' })
      return
    }
    const localPath = await securityPolicy.resolveLocalPath(requestedPath)
    const newProjectName = typeof req.query.newProjectName === 'string' ? req.query.newProjectName : ''
    if (!localPath) {
      res.status(403).json({ error: 'Path is outside configured roots.' })
      return
    }

    try {
      const fileStat = await stat(localPath)
      res.setHeader('Cache-Control', 'private, no-store')
      if (fileStat.isDirectory()) {
        const html = await createDirectoryListingHtml(localPath, { newProjectName })
        res.status(200).type('text/html; charset=utf-8').send(html)
        return
      }

      res.sendFile(localPath, { dotfiles: 'allow' }, (error) => {
        if (!error) return
        if (!res.headersSent) res.status(404).json({ error: 'File not found.' })
      })
    } catch {
      res.status(404).json({ error: 'File not found.' })
    }
  })

  // 7. Edit text-like local files.
  app.get('/codex-local-edit/*path', async (req, res) => {
    if (!securityPolicy.fileEditingEnabled) {
      res.status(403).json({ error: 'File editing is disabled by the active security policy.' })
      return
    }
    const rawPath = readWildcardPathParam(req.params.path)
    const requestedPath = decodeBrowsePath(`/${rawPath}`)
    if (!requestedPath || !isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'Expected absolute local file path.' })
      return
    }
    const localPath = await securityPolicy.resolveLocalPath(requestedPath)
    if (!localPath) {
      res.status(403).json({ error: 'Path is outside configured roots.' })
      return
    }
    try {
      const fileStat = await stat(localPath)
      if (!fileStat.isFile()) {
        res.status(400).json({ error: 'Expected file path.' })
        return
      }
      const html = await createTextEditorHtml(localPath)
      res.status(200).type('text/html; charset=utf-8').send(html)
    } catch {
      res.status(404).json({ error: 'File not found.' })
    }
  })

  app.put('/codex-local-edit/*path', express.text({ type: '*/*', limit: '10mb' }), async (req, res) => {
    if (!securityPolicy.fileEditingEnabled) {
      res.status(403).json({ error: 'File editing is disabled by the active security policy.' })
      return
    }
    const rawPath = readWildcardPathParam(req.params.path)
    const requestedPath = decodeBrowsePath(`/${rawPath}`)
    if (!requestedPath || !isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'Expected absolute local file path.' })
      return
    }
    const localPath = await securityPolicy.resolveLocalPath(requestedPath)
    if (!localPath) {
      res.status(403).json({ error: 'Path is outside configured roots.' })
      return
    }
    if (!(await isTextEditableFile(localPath))) {
      res.status(415).json({ error: 'Only text-like files are editable.' })
      return
    }
    const body = typeof req.body === 'string' ? req.body : ''
    try {
      await writeFile(localPath, body, 'utf8')
      res.status(200).json({ ok: true })
    } catch {
      res.status(404).json({ error: 'File not found.' })
    }
  })

  const hasFrontendAssets = existsSync(spaEntryFile)

  // 8. Static files from Vue build
  if (hasFrontendAssets) {
    app.get(['/', '/index.html'], (_req, res) => {
      res.setHeader('Cache-Control', FRONTEND_ENTRY_CACHE_CONTROL)
      res.sendFile(spaEntryFile, (error) => {
        if (!error) return
        if (!res.headersSent) {
          res.status(404).type('text/html; charset=utf-8').send(renderFrontendMissingHtml('Frontend entry file not found.'))
        }
      })
    })
    app.use(express.static(distDir, { index: false }))
  }

  // 9. SPA fallback
  app.use((req, res) => {
    if (shouldBypassSpaFallbackForStaticAsset(req.path)) {
      res
        .status(404)
        .setHeader('Cache-Control', 'private, no-store')
        .type('text/plain; charset=utf-8')
        .send('Frontend asset not found.')
      return
    }

    if (!hasFrontendAssets) {
      res
        .status(503)
        .setHeader('Cache-Control', FRONTEND_ENTRY_CACHE_CONTROL)
        .type('text/html; charset=utf-8')
        .send(
          renderFrontendMissingHtml('Codex web UI assets are missing.', [
            `Expected: ${spaEntryFile}`,
            'If running from source, build frontend assets with: pnpm run build:frontend',
            'If running with npx, clear the npx cache and reinstall codexapp.',
          ]),
        )
      return
    }

    res.setHeader('Cache-Control', FRONTEND_ENTRY_CACHE_CONTROL)
    res.sendFile(spaEntryFile, (error) => {
      if (!error) return
      if (!res.headersSent) {
        res.status(404).type('text/html; charset=utf-8').send(renderFrontendMissingHtml('Frontend entry file not found.'))
      }
    })
  })

  return {
    app,
    dispose: () => {
      ntfyLifecycle.dispose()
      bridge.dispose()
    },
    attachWebSocket: (server: HttpServer) => {
      const wss = new WebSocketServer({ noServer: true })

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        if (url.pathname !== '/codex-api/ws') {
          return
        }

        if (authSession && !authSession.isRequestAuthorized(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss.emit('connection', ws, req)
        })
      }
      server.on('upgrade', onUpgrade)

      wss.on('connection', (ws: WebSocket) => {
        ws.send(JSON.stringify({ method: 'ready', params: { ok: true }, atIso: new Date().toISOString() }))
        const unsubscribe = bridge.subscribeNotifications((notification) => {
          if (ws.readyState !== 1) return
          ws.send(JSON.stringify(notification))
        })

        ws.on('close', unsubscribe)
        ws.on('error', unsubscribe)
      })

      let websocketDisposed = false
      return () => {
        if (websocketDisposed) return
        websocketDisposed = true
        server.off('upgrade', onUpgrade)
        for (const client of wss.clients) client.terminate()
        wss.close(() => {})
      }
    },
  }
}
