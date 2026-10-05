import { spawn } from 'node:child_process'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { main, type CliDeps } from '../../src/cli'
import type { Runner } from '../../src/secrets'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const FAKE_EXEC = fileURLToPath(new URL('./fake-exec.mjs', import.meta.url))
export const VALID_KEY = 'nrt_' + 'A1b2C3d4E5'.repeat(4)

export interface RunnerCall {
  file: string
  args: string[]
  input?: string
}

const ADD = /^add-generic-password -U -s \S+ -a (\S+) -w "((?:[^"\\]|\\.)*)"/

/** In-process fake for /usr/bin/security (including `-i` on stdin) and /usr/bin/osascript. */
export function fakeRunner(
  opts: {
    keychain?: Record<string, string>
    dialog?: { code: number; stdout?: string; stderr?: string }
    writeFails?: boolean
    silentNoop?: boolean
    /** Extra copies of an item, each needing its own delete. */
    copies?: Record<string, number>
    deleteFails?: boolean
  } = {}
) {
  const calls: RunnerCall[] = []
  const keychain = { ...(opts.keychain ?? {}) }
  const copies = { ...(opts.copies ?? {}) }
  const runner: Runner = async (file, args, input) => {
    calls.push({ file, args, input })
    if (file === '/usr/bin/security' && args[0] === 'find-generic-password') {
      const account = args[args.indexOf('-a') + 1]
      if (!(account in keychain)) return { code: 44, stdout: '', stderr: 'not found' }
      const value = keychain[account]
      const line = /^[\x20-\x7e]*$/.test(value) && !/["\\]/.test(value)
        ? `password: "${value}"`
        : `password: 0x${Buffer.from(value, 'utf8').toString('hex').toUpperCase()}  "..."`
      return { code: 0, stdout: '', stderr: line + '\n' }
    }
    if (file === '/usr/bin/security' && args[0] === 'delete-generic-password') {
      const account = args[args.indexOf('-a') + 1]
      if (!(account in keychain)) return { code: 44, stdout: '', stderr: 'not found' }
      if (opts.deleteFails) return { code: 1, stdout: '', stderr: 'delete failed' }
      if ((copies[account] ?? 0) > 0) copies[account]--
      else delete keychain[account]
      return { code: 0, stdout: '', stderr: '' }
    }
    if (file === '/usr/bin/security' && args[0] === '-i') {
      if (opts.silentNoop) return { code: 0, stdout: '', stderr: '' }
      const m = ADD.exec(input ?? '')
      if (opts.writeFails || !m) return { code: 1, stdout: '', stderr: 'add-generic-password: returned 1' }
      keychain[m[1]] = m[2].replace(/\\(.)/g, '$1')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (file === '/usr/bin/osascript') return { stdout: '', stderr: '', ...(opts.dialog ?? { code: 0, stdout: '' }) }
    return { code: 127, stdout: '', stderr: 'unexpected' }
  }
  return { runner, calls, keychain }
}

export async function runCli(argv: string[], opts: { deps?: Partial<CliDeps>; stdin?: string } = {}) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (c) => (out += c))
  stderr.on('data', (c) => (err += c))
  const deps: CliDeps = {
    runner: fakeRunner().runner,
    platform: 'darwin',
    env: {},
    newAdapter: () => {
      throw new Error('no adapter in this test')
    },
    throttle: async () => {},
    now: () => new Date(),
    ...opts.deps
  }
  const code = await main(argv, { stdin: Readable.from([opts.stdin ?? '']), stdout, stderr }, deps)
  return { code, stdout: out, stderr: err }
}

/** Spawns the kit (TS sources via tsx, or the built dist) with the fake keychain preloaded. */
export function spawnKit(
  entry: 'src' | 'dist',
  args: string[],
  env: Record<string, string>,
  stdin?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const nodeArgs = entry === 'src' ? ['--import', 'tsx', '--import', FAKE_EXEC, 'src/bin.ts'] : ['--import', FAKE_EXEC, 'dist/cli.js']
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

/** Minimal MCP stdio client: spawns `serve`, performs the handshake, and sends requests. */
export function startServe(entry: 'src' | 'dist', env: Record<string, string>) {
  const nodeArgs = entry === 'src' ? ['--import', 'tsx', '--import', FAKE_EXEC, 'src/bin.ts'] : ['--import', FAKE_EXEC, 'dist/cli.js']
  const child = spawn(process.execPath, [...nodeArgs, 'serve'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }
  })
  const stdoutLines: string[] = []
  let buf = ''
  let stderr = ''
  const waiters = new Map<number, (msg: any) => void>()
  child.stderr.on('data', (c) => (stderr += c))
  child.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      stdoutLines.push(line)
      try {
        const msg = JSON.parse(line)
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg)
      } catch {
        // non-JSON stdout is asserted on by the test
      }
    }
  })
  let nextId = 1
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 15_000)
      waiters.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  return {
    async init() {
      const res = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'kit-test', version: '0' }
      })
      notify('notifications/initialized')
      return res
    },
    request,
    stdoutLines,
    get stderr() {
      return stderr
    },
    stop: () =>
      new Promise<void>((r) => {
        child.on('close', () => r())
        child.stdin.end()
        child.kill()
      })
  }
}
