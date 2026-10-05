import { execFile } from 'node:child_process'

export const SERVICE = 'nortia-ai-grab'
export const ACCOUNTS = ['nortia_api_key', 'hiredly_password'] as const
export type Account = (typeof ACCOUNTS)[number]

const ENV_NAMES: Record<Account, string> = {
  nortia_api_key: 'NORTIA_API_KEY',
  hiredly_password: 'HIREDLY_PASSWORD'
}

const SECURITY = '/usr/bin/security'
const OSASCRIPT = '/usr/bin/osascript'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}
export type Runner = (file: string, args: string[], input?: string) => Promise<RunResult>

export const execRunner: Runner = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    child.stdin?.end(input ?? '')
  })

export interface SecretDeps {
  runner: Runner
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** A keychain file to use instead of the default keychain; only the opt-in keychain test sets it. */
  keychain?: string
}

export function isAccount(value: string | undefined): value is Account {
  return (ACCOUNTS as readonly string[]).includes(value ?? '')
}

function assertSupported(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') throw new Error('not_supported_yet')
}

export async function getSecret(account: Account, opts: { allowEnv: boolean }, deps: SecretDeps): Promise<string | null> {
  if (opts.allowEnv) {
    const fromEnv = deps.env[ENV_NAMES[account]]
    if (fromEnv) return fromEnv
  }
  assertSupported(deps.platform)
  const args = ['find-generic-password', '-s', SERVICE, '-a', account, '-g']
  const res = await deps.runner(SECURITY, deps.keychain ? [...args, deps.keychain] : args)
  if (res.code !== 0) return null
  const value = readPasswordLine(res.stderr)
  return value ? value : null
}

// why: `-w` prints a value with any non-ASCII byte as bare hex, indistinguishable from a hex-looking
// password; `-g` marks that case with a 0x prefix, and otherwise quotes the value verbatim.
function readPasswordLine(stderr: string): string | null {
  const m = /^password: (?:0x([0-9A-Fa-f]*)\s.*|"(.*)")$/m.exec(stderr)
  if (!m) return null
  return m[1] !== undefined ? Buffer.from(m[1], 'hex').toString('utf8') : m[2]
}

export type SetResult = 'ok' | 'invalid_value' | 'failed'

const MAX_VALUE_BYTES = 512
const MAX_COMMAND_BYTES = 3072
const CONTROL = /[\x00-\x1f\x7f]/
const quote = (s: string) => '"' + s.replace(/[\\"]/g, (c) => '\\' + c) + '"'

/** Writes through `security -i` on stdin (never argv). -i splits lines at 4095 bytes and reads NUL as end of line, so long or control-character values are refused; the write is confirmed by reading it back. */
export async function setSecret(account: Account, value: string, deps: SecretDeps): Promise<SetResult> {
  assertSupported(deps.platform)
  if (CONTROL.test(value) || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return 'invalid_value'
  if (deps.keychain !== undefined && CONTROL.test(deps.keychain)) return 'invalid_value'
  const command = `add-generic-password -U -s ${SERVICE} -a ${account} -w ${quote(value)}${deps.keychain ? ' ' + quote(deps.keychain) : ''}\n`
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return 'invalid_value'
  const res = await deps.runner(SECURITY, ['-i'], command)
  if (res.code !== 0) return 'failed'
  return (await getSecret(account, { allowEnv: false }, deps)) === value ? 'ok' : 'failed'
}

export type DeleteResult = 'deleted' | 'not_found' | 'failed'

const DELETE_ATTEMPTS = 5

/** Deletes every copy of the item (the keychain can hold duplicates): repeats until the tool answers not found, at most five times, and counts as done only when a final lookup also answers not found (exit 44). */
export async function deleteSecret(account: Account, deps: SecretDeps): Promise<DeleteResult> {
  assertSupported(deps.platform)
  let deleted = false
  for (let i = 0; i < DELETE_ATTEMPTS; i++) {
    const res = await deps.runner(SECURITY, itemArgs('delete-generic-password', account, deps))
    if (res.code !== 0) break
    deleted = true
  }
  if ((await lookup(account, deps)) !== 44) return 'failed'
  return deleted ? 'deleted' : 'not_found'
}

export async function hasSecret(account: Account, deps: SecretDeps): Promise<boolean> {
  assertSupported(deps.platform)
  return (await lookup(account, deps)) === 0
}

async function lookup(account: Account, deps: SecretDeps): Promise<number> {
  return (await deps.runner(SECURITY, itemArgs('find-generic-password', account, deps))).code
}

function itemArgs(command: string, account: Account, deps: SecretDeps): string[] {
  const args = [command, '-s', SERVICE, '-a', account]
  return deps.keychain ? [...args, deps.keychain] : args
}

const CONFIRM = [
  'on run argv',
  'set r to display dialog (item 1 of argv) with title "Nortia" buttons {"Cancel", "Disconnect"} default button "Cancel" cancel button "Cancel" giving up after 120',
  'if gave up of r then return "gave up"',
  'return button returned of r',
  'end run'
]

export type ConfirmResult = 'confirmed' | 'cancelled' | 'error'

export async function confirmDialog(message: string, deps: SecretDeps): Promise<ConfirmResult> {
  assertSupported(deps.platform)
  const res = await deps.runner(OSASCRIPT, [...CONFIRM.flatMap((line) => ['-e', line]), message])
  if (res.code === 0) {
    const answer = res.stdout.trim()
    if (answer === 'Disconnect') return 'confirmed'
    if (answer === 'gave up') return 'cancelled'
    return 'error'
  }
  if (res.stderr.includes('-128')) return 'cancelled'
  return 'error'
}

// why: the label travels as an osascript argv item, so an email can never break out of the AppleScript source.
const DIALOG = [
  'on run argv',
  'set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "Nortia" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"',
  'return text returned of r',
  'end run'
]

export type PromptResult = { value: string } | { cancelled: true } | { error: true }

export async function promptSecret(label: string, deps: SecretDeps): Promise<PromptResult> {
  assertSupported(deps.platform)
  const res = await deps.runner(OSASCRIPT, [...DIALOG.flatMap((line) => ['-e', line]), label])
  if (res.code === 0) return { value: res.stdout.replace(/\r?\n$/, '') }
  if (res.stderr.includes('-128')) return { cancelled: true }
  return { error: true }
}
