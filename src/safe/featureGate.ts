const DISABLED_ROUTE_PREFIXES = [
  '/codex-api/composio/',
  '/codex-api/telegram/',
  '/codex-api/free-mode/',
  '/codex-api/openrouter-proxy/',
  '/codex-api/custom-proxy/',
  '/codex-api/zen-proxy/',
  '/codex-api/skills/install',
  '/codex-api/skills/add',
  '/codex-api/skills/sync',
  '/codex-api/skills-hub/search',
  '/codex-api/skills-hub/install',
  '/codex-api/skills-hub/uninstall',
  '/codex-api/skills-sync/',
]

const CONTROLLED_THREAD_ROUTE_METHODS = new Map<string, ReadonlySet<string>>([
  ['/codex-api/thread-goal-set', new Set(['POST'])],
  ['/codex-api/thread-goal-clear', new Set(['POST'])],
  ['/codex-api/thread-stop-and-archive', new Set(['POST'])],
  ['/codex-api/thread-queue-state', new Set(['GET', 'PUT', 'PATCH', 'POST'])],
  ['/codex-api/thread-queue-receipt', new Set(['GET'])],
  ['/codex-api/thread-runtime-state', new Set(['GET'])],
  ['/codex-api/thread-runtime-states', new Set(['POST'])],
  ['/codex-api/thread-runtime-interrupt', new Set(['POST'])],
  ['/codex-api/thread-summary', new Set(['GET'])],
])

const CONTROLLED_THREAD_ROUTE_PREFIXES = [
  '/codex-api/thread-goal-',
  '/codex-api/thread-stop-',
  '/codex-api/thread-queue-',
  '/codex-api/thread-runtime-',
  '/codex-api/thread-summary',
]

const ALLOWED_RPC_METHODS = new Set([
  'account/rateLimits/read',
  'app/list',
  'collaborationMode/list',
  'config/batchWrite',
  'config/read',
  'generate-thread-title',
  'mcpServerStatus/list',
  'model/list',
  'plugin/list',
  'plugin/read',
  'setDefaultModel',
  'skills/list',
  'thread/fork',
  'thread/goal/get',
  'thread/list',
  'thread/name/set',
  'thread/read',
  'thread/resume',
  'thread/rollback',
  'thread/start',
  'thread/start-turn',
  'turn/interrupt',
  'turn/start',
])

export function isDisabledRoute(method: string, pathname: string): boolean {
  if (DISABLED_ROUTE_PREFIXES.some((prefix) => (
    pathname === prefix.replace(/\/$/u, '') || pathname.startsWith(prefix)
  ))) return true

  if (!CONTROLLED_THREAD_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return false
  }
  return !CONTROLLED_THREAD_ROUTE_METHODS.get(pathname)?.has(method.toUpperCase())
}

export function isAllowedRpcMethod(method: string): boolean {
  return ALLOWED_RPC_METHODS.has(method)
}
