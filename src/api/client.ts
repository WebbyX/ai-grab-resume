import { KIT_NAME, KIT_VERSION } from '../version'

export type ApiErrorCode = 'api_key_invalid' | 'platform_unavailable' | 'kit_outdated' | 'rate_limited' | 'error'

export type ApiResult<T> =
  | { ok: true; httpStatus: number; data: T }
  | { ok: false; code: ApiErrorCode; detail: string; retryAfterSeconds?: number }

export interface MeData {
  workspace: { name: string }
  key: { name: string; prefix: string }
  platforms: { code: string; name: string }[]
  kit: { latest_version: string; min_version: string }
  sync?: { full_window?: boolean }
}

export interface ResumeMeta {
  platform: string
  external_application_id: string
  external_job_title: string
  external_job_id?: string | null
  candidate_name?: string | null
  candidate_email?: string | null
  candidate_phone?: string | null
  applied_at?: string | null
}

export interface SubmitData {
  outcome: 'received' | 'duplicate'
  titleMatch: TitleMatch
}

export type TitleMatch = 'matched' | 'no_title_match' | 'ambiguous_title' | 'unknown'

export interface RunReport {
  run_id: string
  done: boolean
  outcome: 'ok' | 'partial' | 'login_rejected' | 'blocked' | 'not_configured' | 'rate_limited' | 'error'
  counts: {
    submitted: number
    duplicates: number
    matched: number
    no_title_match: number
    ambiguous_title: number
    failed: number
  }
}

const TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 120_000

/** Thin client for the Nortia `api/v1` key-authenticated routes; every call carries the key and the kit version. */
export class NortiaClient {
  private readonly base: string

  constructor(apiUrl: string, private readonly key: string) {
    this.base = apiUrl.replace(/\/+$/, '') + '/api/v1/'
  }

  me(): Promise<ApiResult<MeData>> {
    return this.request<MeData>('GET', 'me')
  }

  async lookup(platform: string, ids: string[]): Promise<ApiResult<Set<string>>> {
    const res = await this.request<{ known?: unknown }>('POST', 'resumes/lookup', {
      json: { platform, external_application_ids: ids }
    })
    if (!res.ok) return res
    const known = Array.isArray(res.data?.known) ? res.data.known.map(String) : []
    return { ok: true, httpStatus: res.httpStatus, data: new Set(known) }
  }

  async submitResume(file: { bytes: Uint8Array; name: string }, meta: ResumeMeta): Promise<ApiResult<SubmitData>> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(file.bytes)]), file.name)
    for (const [k, v] of Object.entries(meta)) {
      if (v !== null && v !== undefined && v !== '') form.append(k, String(v))
    }
    const res = await this.request<{ title_match?: unknown }>('POST', 'resumes', { form, timeoutMs: UPLOAD_TIMEOUT_MS })
    if (!res.ok) return res
    return {
      ok: true,
      httpStatus: res.httpStatus,
      data: {
        outcome: res.httpStatus === 202 ? 'received' : 'duplicate',
        titleMatch: readTitleMatch(res.data?.title_match)
      }
    }
  }

  reportRun(report: RunReport): Promise<ApiResult<unknown>> {
    return this.request('POST', 'runs', { json: report })
  }

  disconnect(): Promise<ApiResult<unknown>> {
    return this.request('POST', 'disconnect')
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: { json?: unknown; form?: FormData; timeoutMs?: number } = {}
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.key}`,
      'user-agent': `${KIT_NAME}/${KIT_VERSION}`,
      'x-nortia-kit-version': KIT_VERSION
    }
    let payload: string | FormData | undefined
    if (body.json !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body.json)
    } else if (body.form) {
      payload = body.form
    }

    let res: Response
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(body.timeoutMs ?? TIMEOUT_MS)
      })
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause
      return { ok: false, code: 'error', detail: `network_${(cause?.code ?? 'error').toLowerCase()}` }
    }

    const text = await res.text().catch(() => '')
    if (res.status === 401) return { ok: false, code: 'api_key_invalid', detail: 'http_401' }
    if (res.status === 403) return { ok: false, code: 'platform_unavailable', detail: 'http_403' }
    if (res.status === 426) return { ok: false, code: 'kit_outdated', detail: 'http_426' }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'))
      return {
        ok: false,
        code: 'rate_limited',
        detail: 'http_429',
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {})
      }
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, code: 'error', detail: `http_${res.status}` }

    let envelope: { status?: unknown; data?: unknown }
    try {
      envelope = JSON.parse(text) as { status?: unknown; data?: unknown }
    } catch {
      return { ok: false, code: 'error', detail: 'bad_response' }
    }
    if (envelope?.status !== true) return { ok: false, code: 'error', detail: 'bad_response' }
    return { ok: true, httpStatus: res.status, data: (envelope.data ?? {}) as T }
  }
}

function readTitleMatch(value: unknown): TitleMatch {
  if (value === 'matched' || value === 'no_title_match' || value === 'ambiguous_title') return value
  return 'unknown'
}
