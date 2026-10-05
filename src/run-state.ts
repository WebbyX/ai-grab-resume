import { randomUUID } from 'node:crypto'
import { NortiaClient, type RunReport } from './api/client'
import type { Config } from './config'
import {
  batchMessage,
  dryRunMessage,
  statusMessage,
  withUpdateHint,
  type Status
} from './messages'
import { cutoffFor } from './platforms/hiredly/age-window'
import {
  addCounts,
  classifyHiredlyError,
  emptyCounts,
  fromApiError,
  syncBatch,
  type Counts,
  type RunMemory
} from './platforms/hiredly/sync'
import type { Adapter } from './platforms/hiredly/types'
import type { Account } from './secrets'
import { isOlder, KIT_VERSION } from './version'

export const DEFAULT_MAX_NEW = 25
const MAX_CALLS = 8
const REPLAY_MS = 10 * 60_000
const IDLE_MS = 30 * 60_000

export interface SyncDeps {
  config: Config
  getSecret: (account: Account) => Promise<string | null>
  newAdapter: () => Adapter
  throttle: () => Promise<void>
  now: () => Date
  log: (line: string) => void
}

export interface SyncResponse extends Counts {
  done: boolean
  status: Status
  message: string
  more: boolean
  replayed?: true
  dry_run?: true
  would_submit?: number
}

interface Session {
  client: NortiaClient | null
  adapter: Adapter | null
  updateAvailable: boolean
  fullWindow: boolean
}

interface ActiveRun extends Session {
  runId: string
  calls: number
  lastCallAt: number
  totals: Counts
  memory: RunMemory
}

type Failure = { status: Status; code?: string }

function toOutcome(status: Status): RunReport['outcome'] | null {
  return status === 'kit_outdated' || status === 'api_key_invalid' ? null : status
}

/**
 * In-process state of the current `hiredly_sync` run (never written to disk). Each call
 * runs one batch; the run ends when Hiredly has nothing more, on any terminal status, or
 * on the 8th call. Every call is reported to Nortia, and a call within 10 minutes of the
 * end replays the final result instead of starting a fresh (empty) run. A run nobody has
 * called for 30 minutes is abandoned, so the next call starts over from the top.
 * When Nortia says the previous run did not finish ok, every batch of this run walks the whole fetch window.
 */
export class HiredlyRun {
  private active: ActiveRun | null = null
  private doneAt = 0
  private lastResult: SyncResponse | null = null

  constructor(private readonly deps: SyncDeps) {}

  async call(opts: { maxNew: number; dryRun: boolean }): Promise<SyncResponse> {
    if (opts.dryRun) return this.dryRun(opts.maxNew)

    const now = this.deps.now().getTime()
    if (this.lastResult && now - this.doneAt < REPLAY_MS) return { ...this.lastResult, replayed: true }
    if (this.active && now - this.active.lastCallAt > IDLE_MS) this.active = null

    const run = (this.active ??= {
      runId: randomUUID(),
      calls: 0,
      lastCallAt: now,
      totals: emptyCounts(),
      memory: { handled: new Set(), finishedJobs: new Set() },
      client: null,
      adapter: null,
      updateAvailable: false,
      fullWindow: false
    })
    run.calls++
    run.lastCallAt = now

    let status: Status
    let code: string | undefined
    let more = false
    const failure = await this.prepare(run)
    if (failure) {
      status = failure.status
      code = failure.code
    } else {
      const batch = await syncBatch(run.adapter!, run.client!, run.memory, {
        maxNew: opts.maxNew,
        dryRun: false,
        cutoff: cutoffFor(this.deps.now(), this.deps.config.maxAgeDays),
        fullWindow: run.fullWindow,
        throttle: this.deps.throttle,
        log: this.deps.log
      })
      addCounts(run.totals, batch.counts)
      status = batch.status
      code = batch.code
      more = batch.more
    }
    run.lastCallAt = this.deps.now().getTime()

    if (status !== 'ok') more = false
    const done = !more || run.calls >= MAX_CALLS
    if (more && done) status = 'partial'

    const message = done ? statusMessage(status, run.totals, code) : batchMessage(run.calls, run.totals.submitted)
    const response: SyncResponse = {
      done,
      status,
      message: withUpdateHint(message, run.updateAvailable),
      ...run.totals,
      more
    }

    const outcome = toOutcome(status)
    if (outcome && run.client) await this.report(run, done, outcome)

    if (done) {
      this.doneAt = this.deps.now().getTime()
      this.lastResult = response
      this.active = null
    }
    return response
  }

  private async dryRun(maxNew: number): Promise<SyncResponse> {
    const session: Session = { client: null, adapter: null, updateAvailable: false, fullWindow: false }
    const failure = await this.prepare(session)
    const counts = emptyCounts()
    let status: Status
    let code: string | undefined
    let more = false
    let wouldSubmit = 0
    if (failure) {
      status = failure.status
      code = failure.code
    } else {
      const batch = await syncBatch(session.adapter!, session.client!, { handled: new Set(), finishedJobs: new Set() }, {
        maxNew,
        dryRun: true,
        cutoff: cutoffFor(this.deps.now(), this.deps.config.maxAgeDays),
        fullWindow: session.fullWindow,
        throttle: this.deps.throttle,
        log: this.deps.log
      })
      addCounts(counts, batch.counts)
      status = batch.status
      code = batch.code
      more = batch.more
      wouldSubmit = batch.wouldSubmit
    }
    const message = status === 'ok' ? dryRunMessage(wouldSubmit, more) : statusMessage(status, counts, code)
    return {
      done: true,
      status,
      message: withUpdateHint(message, session.updateAvailable),
      ...counts,
      more,
      dry_run: true,
      would_submit: wouldSubmit
    }
  }

  private async prepare(session: Session): Promise<Failure | null> {
    if (session.client && session.adapter) return null
    const { config } = this.deps
    try {
      if (!session.client) {
        if (!config.apiUrl) return { status: 'not_configured' }
        const key = await this.deps.getSecret('nortia_api_key')
        if (!key) return { status: 'not_configured' }
        session.client = new NortiaClient(config.apiUrl, key)
        const me = await session.client.me()
        if (!me.ok) return fromApiError(me.code, me.detail)
        session.updateAvailable = isOlder(KIT_VERSION, me.data.kit?.latest_version ?? KIT_VERSION)
        session.fullWindow = me.data.sync?.full_window === true
        if (session.fullWindow) this.deps.log('previous run did not finish cleanly; this run walks the whole fetch window')
      }
      if (!config.hiredlyEmail) return { status: 'not_configured' }
      const password = await this.deps.getSecret('hiredly_password')
      if (!password) return { status: 'not_configured' }
      const adapter = this.deps.newAdapter()
      try {
        await adapter.login(config.hiredlyEmail, password)
      } catch (err) {
        this.deps.log(`hiredly login: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
        return classifyHiredlyError(err)
      }
      session.adapter = adapter
      return null
    } catch (err) {
      return { status: 'error', code: String(err instanceof Error ? err.message : err) === 'not_supported_yet' ? 'not_supported_yet' : 'setup_failed' }
    }
  }

  private async report(run: ActiveRun, done: boolean, outcome: RunReport['outcome']): Promise<void> {
    const t = run.totals
    const report: RunReport = {
      run_id: run.runId,
      done,
      outcome,
      counts: {
        submitted: t.submitted,
        duplicates: t.duplicates,
        matched: t.matched,
        no_title_match: t.no_title_match,
        ambiguous_title: t.ambiguous_title,
        failed: t.failed
      }
    }
    try {
      const res = await run.client!.reportRun(report)
      if (!res.ok) this.deps.log(`run report not recorded: ${res.code} ${res.detail}`)
    } catch (err) {
      this.deps.log(`run report failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    }
  }
}
