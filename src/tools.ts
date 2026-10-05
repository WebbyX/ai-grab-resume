import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { NortiaClient } from './api/client'
import type { Config } from './config'
import { checkMessage, statusMessage, submitMessage, withUpdateHint, type HiredlyCheck, type Status } from './messages'
import { classifyHiredlyError, fromApiError, MAX_RESUME_BYTES } from './platforms/hiredly/sync'
import type { Adapter } from './platforms/hiredly/types'
import type { Account } from './secrets'
import { isOlder, KIT_VERSION } from './version'

export interface ToolDeps {
  config: Config
  getSecret: (account: Account) => Promise<string | null>
  newAdapter: () => Adapter
  log: (line: string) => void
}

const NO_TALLY = { submitted: 0, matched: 0, failed: 0 }

function failure(status: Status, code?: string) {
  return { status, message: statusMessage(status, NO_TALLY, code), ...(code ? { code } : {}) }
}

async function readSecret(deps: ToolDeps, account: Account): Promise<string | null | 'not_supported_yet'> {
  try {
    return await deps.getSecret(account)
  } catch (err) {
    if (String(err instanceof Error ? err.message : err) === 'not_supported_yet') return 'not_supported_yet'
    throw err
  }
}

async function clientFor(deps: ToolDeps): Promise<NortiaClient | { status: Status; code?: string }> {
  if (!deps.config.apiUrl) return { status: 'not_configured' }
  const key = await readSecret(deps, 'nortia_api_key')
  if (key === 'not_supported_yet') return { status: 'error', code: 'not_supported_yet' }
  if (!key) return { status: 'not_configured' }
  return new NortiaClient(deps.config.apiUrl, key)
}

export async function checkConnection(deps: ToolDeps) {
  const client = await clientFor(deps)
  if (!(client instanceof NortiaClient)) return failure(client.status, client.code)

  const me = await client.me()
  if (!me.ok) {
    const s = fromApiError(me.code, me.detail)
    return failure(s.status, s.code)
  }

  const latest = me.data.kit?.latest_version ?? KIT_VERSION
  const updateAvailable = isOlder(KIT_VERSION, latest)
  const hiredly = await checkHiredly(deps)
  return {
    status: 'ok' as const,
    message: withUpdateHint(checkMessage(me.data.workspace?.name ?? '', hiredly), updateAvailable),
    workspace: me.data.workspace?.name ?? null,
    key_prefix: me.data.key?.prefix ?? null,
    kit_version: KIT_VERSION,
    latest_kit_version: latest,
    update_available: updateAvailable,
    hiredly
  }
}

async function checkHiredly(deps: ToolDeps): Promise<HiredlyCheck> {
  if (!deps.config.hiredlyEmail) return 'not_configured'
  const password = await readSecret(deps, 'hiredly_password')
  if (!password || password === 'not_supported_yet') return 'not_configured'
  try {
    await deps.newAdapter().login(deps.config.hiredlyEmail, password)
    return 'ok'
  } catch (err) {
    deps.log(`hiredly login: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    const s = classifyHiredlyError(err).status
    return s === 'login_rejected' || s === 'blocked' ? s : 'error'
  }
}

export interface SubmitArgs {
  file_path: string
  platform: string
  external_application_id: string
  external_job_title?: string
  external_job_id?: string
  candidate_name?: string
  candidate_email?: string
  candidate_phone?: string
  applied_at?: string
}

const FILE_TYPES = new Set(['.pdf', '.docx', '.jpg', '.jpeg', '.png', '.webp'])

const SUBMIT_ERRORS = {
  missing_external_job_title: 'external_job_title is required: the job title exactly as the platform shows it.',
  path_outside_work_dir: 'The file must be inside the Nortia work folder.',
  file_not_found: 'The file does not exist.',
  unsupported_file_type: 'Only pdf, docx, jpg, jpeg, png and webp files can be sent.',
  file_too_large: 'The file is larger than 10 MB, which Nortia does not accept.'
} as const

function submitError(code: keyof typeof SUBMIT_ERRORS) {
  return { status: 'error' as const, code, message: SUBMIT_ERRORS[code] }
}

export async function submitResume(deps: ToolDeps, args: SubmitArgs) {
  const title = args.external_job_title?.trim()
  if (!title) return submitError('missing_external_job_title')

  let workDir: string
  try {
    workDir = await realpath(deps.config.workDir)
  } catch {
    return submitError('path_outside_work_dir')
  }
  let file: string
  try {
    file = await realpath(resolve(deps.config.workDir, args.file_path))
  } catch {
    return submitError('file_not_found')
  }
  if (!file.startsWith(workDir + sep)) return submitError('path_outside_work_dir')
  if (!FILE_TYPES.has(extname(file).toLowerCase())) return submitError('unsupported_file_type')
  const info = await stat(file)
  if (!info.isFile()) return submitError('file_not_found')
  if (info.size > MAX_RESUME_BYTES) return submitError('file_too_large')

  const client = await clientFor(deps)
  if (!(client instanceof NortiaClient)) return failure(client.status, client.code)

  const bytes = await readFile(file)
  const res = await client.submitResume(
    { bytes, name: file.slice(file.lastIndexOf(sep) + 1) },
    {
      platform: args.platform,
      external_application_id: args.external_application_id,
      external_job_title: title,
      external_job_id: args.external_job_id,
      candidate_name: args.candidate_name,
      candidate_email: args.candidate_email,
      candidate_phone: args.candidate_phone,
      applied_at: args.applied_at
    }
  )
  if (!res.ok) {
    const s = fromApiError(res.code, res.detail)
    return {
      ...failure(s.status, s.code),
      ...(res.retryAfterSeconds ? { retry_after_seconds: res.retryAfterSeconds } : {})
    }
  }
  return {
    status: 'ok' as const,
    message: submitMessage(res.data.outcome),
    outcome: res.data.outcome,
    title_match: res.data.titleMatch
  }
}
