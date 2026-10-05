import { randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { NortiaClient } from './api/client'
import {
  DISCONNECT_CONFIRM_TEXT,
  DISCONNECT_ISSUES,
  DISCONNECT_MESSAGES,
  DISCONNECT_PREVIEW_MESSAGE,
  disconnectNextSteps,
  WILL_REMOVE
} from './messages'
import { confirmDialog, deleteSecret, getSecret, hasSecret, type SecretDeps } from './secrets'

export interface DisconnectDeps extends SecretDeps {
  apiUrl: string | null
  home: string
  claudeDir: string
  /** Reads a settings file; only tests replace it, to rewrite the file between the read and the write. */
  readText?: (path: string) => Promise<string>
}

export type NortiaOutcome = 'revoked' | 'already_revoked' | 'unreachable' | 'no_key' | 'not_configured'

const TASK = 'nortia-hiredly'
const SETTINGS = ['settings.json', 'settings.local.json']
const KEY_FORMAT = /^nrt_[A-Za-z0-9]{40}$/
const PREFIX_LENGTH = 12

const isNortiaRule = (rule: unknown) => typeof rule === 'string' && (rule === 'mcp__nortia' || rule.startsWith('mcp__nortia__'))

const prefixOf = (key: string | null) => (key && KEY_FORMAT.test(key) ? key.slice(0, PREFIX_LENGTH) : null)

const notSupported = () => ({ status: 'not_supported_yet' as const, done: true, message: DISCONNECT_MESSAGES.not_supported_yet })

/** Lists what a disconnect would remove from this Mac. Reads only: no API call, no file or keychain change. */
export async function inspectDisconnect(deps: DisconnectDeps) {
  if (deps.platform !== 'darwin') return notSupported()
  const willRemove: string[] = []

  const key = await getSecret('nortia_api_key', { allowEnv: false }, deps)
  const keyPrefix = prefixOf(key)
  if (key) willRemove.push(WILL_REMOVE.key(keyPrefix))
  if (await hasSecret('hiredly_password', deps)) willRemove.push(WILL_REMOVE.hiredlyPassword)
  const folder = join(deps.home, '.nortia')
  if ((await entry(folder)) !== null) willRemove.push(WILL_REMOVE.folder(tilde(deps, folder)))
  willRemove.push(WILL_REMOVE.task)
  for (const name of SETTINGS) {
    const file = join(deps.claudeDir, name)
    const raw = await readFile(file, 'utf8').catch(() => null)
    const count = raw === null ? 0 : (withoutNortiaRules(raw)?.rules.length ?? 0)
    if (count > 0) willRemove.push(WILL_REMOVE.rules(count, tilde(deps, file)))
  }
  willRemove.push(WILL_REMOVE.connector)

  return { status: 'preview' as const, done: false, message: DISCONNECT_PREVIEW_MESSAGE, key_prefix: keyPrefix, will_remove: willRemove }
}

/**
 * Disconnects this Mac after the user clicks Disconnect in a native dialog the model cannot answer: revokes the key on
 * Nortia (reading it before the keychain is cleared), deletes both keychain items, ~/.nortia, the schedule's SKILL.md
 * folder and the Nortia allow rules. Each step runs even if an earlier one failed; what failed comes back as issues.
 */
export async function runDisconnect(deps: DisconnectDeps) {
  if (deps.platform !== 'darwin') return notSupported()
  const answer = await confirmDialog(DISCONNECT_CONFIRM_TEXT, deps)
  if (answer !== 'confirmed') {
    const status = answer === 'cancelled' ? 'cancelled' : 'confirm_unavailable'
    return { status, done: true, message: DISCONNECT_MESSAGES[status] }
  }

  const removed: string[] = []
  const issues: string[] = []

  const key = await getSecret('nortia_api_key', { allowEnv: false }, deps)
  const keyPrefix = prefixOf(key)
  const nortia = await revoke(deps, key)
  if (nortia === 'unreachable') issues.push(DISCONNECT_ISSUES.unreachable(keyPrefix))
  if (nortia === 'not_configured') issues.push(DISCONNECT_ISSUES.no_address(keyPrefix))
  if (nortia === 'no_key') issues.push(DISCONNECT_ISSUES.no_key)

  for (const [account, what] of [
    ['nortia_api_key', 'Nortia key'],
    ['hiredly_password', 'Hiredly password']
  ] as const) {
    const result = await deleteSecret(account, deps)
    if (result === 'deleted') removed.push(`keychain:${account}`)
    if (result === 'failed') issues.push(DISCONNECT_ISSUES.keychain(what))
  }

  const folder = join(deps.home, '.nortia')
  const taskDir = join(deps.claudeDir, 'scheduled-tasks', TASK)
  for (const path of [folder, ...((await isOurTask(taskDir)) ? [taskDir] : [])]) {
    const result = await removeEntry(path)
    if (result === 'removed') removed.push(tilde(deps, path))
    if (result === 'failed') issues.push(DISCONNECT_ISSUES.folder(tilde(deps, path)))
  }

  const removedRules: string[] = []
  const settingsToEdit: string[] = []
  for (const name of SETTINGS) {
    const file = join(deps.claudeDir, name)
    const result = await editSettings(deps, file)
    if (result === 'failed') settingsToEdit.push(tilde(deps, file))
    else removedRules.push(...result)
  }

  return {
    status: 'disconnected' as const,
    done: true,
    message: DISCONNECT_MESSAGES.disconnected,
    nortia,
    key_prefix: keyPrefix,
    removed,
    removed_rules: removedRules,
    issues,
    next_steps: disconnectNextSteps(settingsToEdit)
  }
}

async function revoke(deps: DisconnectDeps, key: string | null): Promise<NortiaOutcome> {
  if (!key) return 'no_key'
  if (!deps.apiUrl) return 'not_configured'
  const res = await new NortiaClient(deps.apiUrl, key).disconnect()
  if (res.ok) return 'revoked'
  return res.code === 'api_key_invalid' ? 'already_revoked' : 'unreachable'
}

async function entry(path: string) {
  try {
    return await lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// why: lstat, so a symlinked ~/.nortia loses only the link and never the folder it points at.
async function removeEntry(path: string): Promise<'removed' | 'absent' | 'failed'> {
  try {
    const info = await entry(path)
    if (info === null) return 'absent'
    await rm(path, { recursive: info.isDirectory(), force: true })
    return 'removed'
  } catch {
    return 'failed'
  }
}

async function isOurTask(dir: string): Promise<boolean> {
  try {
    if (!(await entry(dir))?.isDirectory()) return false
    return (await readFile(join(dir, 'SKILL.md'), 'utf8')).includes('hiredly_sync')
  } catch {
    return false
  }
}

function withoutNortiaRules(raw: string): { text: string; rules: string[] } | null {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const allow: unknown = data?.permissions?.allow
  if (!Array.isArray(allow)) return { text: raw, rules: [] }
  const rules = allow.filter(isNortiaRule) as string[]
  data.permissions.allow = allow.filter((rule) => !isNortiaRule(rule))
  const indent = /^([ \t]+)\S/m.exec(raw)?.[1] ?? ''
  return { text: JSON.stringify(data, null, indent) + (raw.endsWith('\n') ? '\n' : ''), rules }
}

/** Removes the Nortia allow rules from one settings file. Leaves unparsable JSON alone; rereads just before writing and starts over once if another program changed the file meanwhile. */
async function editSettings(deps: DisconnectDeps, file: string): Promise<string[] | 'failed'> {
  const read = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
  try {
    if ((await entry(file)) === null) return []
    const target = await realpath(file)
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await read(target)
      const edit = withoutNortiaRules(raw)
      if (edit === null) return 'failed'
      if (edit.rules.length === 0) return []
      if ((await read(target)) !== raw) continue
      await writeAtomically(target, edit.text)
      return edit.rules
    }
  } catch {
    return 'failed'
  }
  return 'failed'
}

async function writeAtomically(target: string, text: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  const mode = (await stat(target)).mode & 0o777
  try {
    await writeFile(tmp, text, { flag: 'wx', mode })
    await chmod(tmp, mode)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

function tilde(deps: DisconnectDeps, path: string): string {
  return path.startsWith(deps.home + sep) ? '~' + path.slice(deps.home.length) : path
}
