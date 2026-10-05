import type { ApiErrorCode, NortiaClient, ResumeMeta } from '../../api/client'
import { parseAppliedAt } from './age-window'
import type { Adapter, ScrapedApplication, ScrapedJob } from './types'

export const PLATFORM = 'hiredly'
export const MAX_RESUME_BYTES = 10240 * 1024

// Same stop rules as Nortia's internal Hiredly worker (scrape.ts): consecutive known or out-of-window rows end a job.
const EARLY_STOP = 5
const OLD_STOP = 5
const MAX_PAGES = 50

export interface Counts {
  submitted: number
  duplicates: number
  matched: number
  no_title_match: number
  ambiguous_title: number
  failed: number
  skipped_closed: number
  skipped_out_of_window: number
  skipped_no_resume: number
}

export function emptyCounts(): Counts {
  return {
    submitted: 0,
    duplicates: 0,
    matched: 0,
    no_title_match: 0,
    ambiguous_title: 0,
    failed: 0,
    skipped_closed: 0,
    skipped_out_of_window: 0,
    skipped_no_resume: 0
  }
}

export function addCounts(into: Counts, from: Counts): void {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += from[k]
}

/** What one run has already decided on, so a later batch neither redoes nor mis-tallies it. */
export interface RunMemory {
  handled: Set<string>
  finishedJobs: Set<string>
}

export type BatchStatus = 'ok' | 'login_rejected' | 'blocked' | 'kit_outdated' | 'api_key_invalid' | 'rate_limited' | 'error'

export interface BatchOutcome {
  status: BatchStatus
  code?: string
  more: boolean
  counts: Counts
  wouldSubmit: number
}

export interface BatchOptions {
  maxNew: number
  dryRun: boolean
  cutoff: Date
  fullWindow: boolean
  throttle: () => Promise<void>
  log: (line: string) => void
}

export function fromApiError(code: ApiErrorCode, detail: string): { status: BatchStatus; code?: string } {
  if (code === 'platform_unavailable') return { status: 'error', code: 'platform_unavailable' }
  if (code === 'error') return { status: 'error', code: detail }
  return { status: code }
}

export function classifyHiredlyError(err: unknown): { status: BatchStatus; code?: string } {
  const msg = String(err instanceof Error ? err.message : err)
  if (/LOGIN_REJECTED/.test(msg)) return { status: 'login_rejected' }
  if (/HTTP_403|HTTP_429|\b403\b|\b429\b|challenge|captcha|forbidden|blocked/i.test(msg)) return { status: 'blocked' }
  if (/NOT_LOGGED_IN/.test(msg)) return { status: 'error', code: 'hiredly_signed_out' }
  if (/^NETWORK_|HTTP_5\d\d/.test(msg)) return { status: 'error', code: 'hiredly_unreachable' }
  return { status: 'error', code: 'hiredly_error' }
}

/**
 * One batch of a Hiredly sync: walk active jobs newest-first, skip what is out of the
 * fetch window, closed, already in Nortia or handled earlier in this run, and send at
 * most `maxNew` new resumes straight from memory. Stops early (`more: true`) when the
 * cap is reached, and immediately on any Nortia answer other than a per-resume failure.
 * With fullWindow, known rows never end a job early; only the fetch window does.
 */
export async function syncBatch(
  adapter: Adapter,
  api: NortiaClient,
  memory: RunMemory,
  opts: BatchOptions
): Promise<BatchOutcome> {
  const counts = emptyCounts()
  let wouldSubmit = 0
  let processed = 0
  const end = (status: BatchStatus, more: boolean, code?: string): BatchOutcome => ({
    status,
    more,
    counts,
    wouldSubmit,
    ...(code === undefined ? {} : { code })
  })

  try {
    const jobs = (await adapter.listJobs()).filter((job) => job.active !== false)

    for (const job of jobs) {
      if (memory.finishedJobs.has(job.jobExternalId)) continue
      let cursor: string | null = null
      let known = 0
      let tooOld = 0

      pages: for (let p = 0; p < MAX_PAGES; p++) {
        const page = await adapter.listApplications(job.jobExternalId, cursor)
        let knownIds = new Set<string>()
        if (page.applications.length > 0) {
          const res = await api.lookup(
            PLATFORM,
            page.applications.map((a) => a.externalApplicationId)
          )
          if (!res.ok) {
            const s = fromApiError(res.code, res.detail)
            return end(s.status, false, s.code)
          }
          knownIds = res.data
        }

        for (const app of page.applications) {
          const id = app.externalApplicationId
          if (memory.handled.has(id)) {
            known = 0
            continue
          }

          const at = parseAppliedAt(app.appliedAt)
          if (at !== null) {
            if (at < opts.cutoff.getTime()) {
              memory.handled.add(id)
              counts.skipped_out_of_window++
              if (++tooOld >= OLD_STOP) break pages
              continue
            }
            tooOld = 0
          }

          if (app.state !== null && adapter.closedStates.has(app.state)) {
            memory.handled.add(id)
            counts.skipped_closed++
            continue
          }

          if (knownIds.has(id)) {
            if (!opts.fullWindow && ++known >= EARLY_STOP) break pages
            continue
          }
          known = 0

          if (!app.resumeUrl) {
            memory.handled.add(id)
            counts.skipped_no_resume++
            continue
          }

          if (processed >= opts.maxNew) return end('ok', true)
          processed++
          if (opts.dryRun) {
            wouldSubmit++
            continue
          }
          memory.handled.add(id)

          let bytes: Buffer
          try {
            await opts.throttle()
            bytes = await adapter.downloadResume(app.resumeUrl)
          } catch (err) {
            if (/NOT_LOGGED_IN|BLOCKED/.test(String(err))) throw err
            opts.log(`resume download failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
            counts.failed++
            continue
          }

          if (bytes.length > MAX_RESUME_BYTES) {
            opts.log('resume skipped: file_too_large')
            counts.failed++
            continue
          }

          const res = await api.submitResume({ bytes, name: fileNameFor(app) }, metaFor(job, app))
          if (!res.ok) {
            if (res.code === 'error' && !res.detail.startsWith('network_')) {
              opts.log(`resume submit failed: ${res.detail}`)
              counts.failed++
              continue
            }
            const s = fromApiError(res.code, res.detail)
            return end(s.status, false, s.code)
          }
          if (res.data.outcome === 'duplicate') {
            counts.duplicates++
            continue
          }
          counts.submitted++
          if (res.data.titleMatch === 'matched') counts.matched++
          else if (res.data.titleMatch === 'no_title_match') counts.no_title_match++
          else if (res.data.titleMatch === 'ambiguous_title') counts.ambiguous_title++
        }

        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      memory.finishedJobs.add(job.jobExternalId)
    }
    return end('ok', false)
  } catch (err) {
    opts.log(`hiredly: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    const s = classifyHiredlyError(err)
    return end(s.status, false, s.code)
  }
}

function metaFor(job: ScrapedJob, app: ScrapedApplication): ResumeMeta {
  const at = parseAppliedAt(app.appliedAt)
  return {
    platform: PLATFORM,
    external_application_id: app.externalApplicationId,
    external_job_title: job.jobTitle,
    external_job_id: job.jobExternalId,
    candidate_name: app.candidateName,
    candidate_email: app.candidateEmail,
    candidate_phone: app.candidatePhone,
    applied_at: at === null ? null : new Date(at).toISOString()
  }
}

function fileNameFor(app: ScrapedApplication): string {
  const ext = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(app.resumeUrl ?? '')?.[1]?.toLowerCase() ?? 'pdf'
  return `hiredly-${app.externalApplicationId.replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`
}
