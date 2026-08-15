import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildStoredProjectZip(entries: Array<{ path: string; data: string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const data = Buffer.from(entry.data, 'utf8')
    const checksum = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    localParts.push(local, data)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralParts.push(central)
    localOffset += local.length + data.length
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50, 0)
  footer.writeUInt16LE(entries.length, 8)
  footer.writeUInt16LE(entries.length, 10)
  footer.writeUInt32LE(centralSize, 12)
  footer.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, footer])
}

it('serializes project import rollback windows across independent processes', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-process-lock-'))
  const destinationParent = join(codexHome, 'destination')
  const zipPath = join(codexHome, 'project.zip')
  await mkdir(destinationParent)
  await writeFile(zipPath, buildStoredProjectZip([
    { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'process-lock' }) },
    {
      path: '.codex-project/chats/sessions/source.jsonl',
      data: `${JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } })}\n`,
    },
  ]))
  const runWorker = (workerId: string): Promise<{ status: number | null; output: string }> => new Promise((resolve) => {
    const child = spawn('pnpm', [
      'vitest', 'run', 'src/server/projectImportProcessWorker.test.ts', '--maxWorkers=1',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_MOBILE_PROJECT_IMPORT_WORKER_ID: workerId,
        CODEX_MOBILE_PROJECT_IMPORT_PARENT: destinationParent,
        CODEX_MOBILE_PROJECT_IMPORT_ZIP: zipPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('close', (status) => resolve({ status, output }))
  })

  try {
    const workers = await Promise.all([runWorker('a'), runWorker('b')])
    for (const worker of workers) expect(worker.status, worker.output).toBe(0)
    await expect(stat(join(codexHome, 'project-import-overlap'))).rejects.toMatchObject({ code: 'ENOENT' })
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    await expect(stat(stateDbPath)).resolves.toBeDefined()
    expect(spawnSync('sqlite3', [stateDbPath, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'threads'; SELECT count(*) FROM threads;"], {
      encoding: 'utf8',
    }).stdout.trim().split('\n')).toEqual(['1', '0'])
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
}, 70_000)
