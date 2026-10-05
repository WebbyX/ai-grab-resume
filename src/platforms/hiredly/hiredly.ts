// Ported from Nortia's internal Hiredly worker (src/worker/adapters/hiredly.ts @ 623677a). Logic unchanged; only the import path of './http' differs.

import { getBuffer, postJson } from './http'
import type { Adapter, ScrapedApplication, ScrapedJob } from './types'

const GQL = 'https://my-api.hiredly.com/api/v3/graphql'
const SITE = 'https://employer.hiredly.com'
const PAGE_SIZE = 20

// `JobApplication.state`, verified against the live API on 2026-09-18: the six
// the employer console shows are `kiv`, `shortlisted`, `interview`, `offered`,
// `rejected` and `blacklisted`, plus `undecided` for an application nobody has
// touched. Only the three below are decisions against the person.
//
// `blacklisted` is the one value that account had no example of; it is included
// on the pattern the other five follow, and the refusal-list reading (see
// Adapter.closedStates) is what makes a wrong guess cost a download instead of
// a candidate.
const CLOSED_STATES: ReadonlySet<string> = new Set(['offered', 'rejected', 'blacklisted'])

// The password travels as a GraphQL variable, never interpolated into the query
// text, so no error path or debug print can carry it inside a query body.
const LOGIN = `mutation LoginEmployer($email: String!, $password: String!) {
  loginEmployer(input: { email: $email, password: $password }) { token }
}`

// Hiredly answers a missing or expired token with HTTP 200 and an `errors`
// array, not a 401. Reading the status alone would file a dead session as a
// GraphQL bug and never trigger the re-login below.
const DEAD_SESSION = /not logged in|unauthenticated|unauthori[sz]ed|invalid token|expired/i

// A red light, not a verdict on the credentials. A WAF interstitial and a login
// throttle both arrive as a perfectly ordinary 200, and reading either as "wrong
// password" files the pair under bad_credentials — the one state with no
// automatic recovery, needing a human on every affected tenant. They belong in
// blocked, which has the 1h→4h→24h brake and heals itself.
const THROTTLED = /too many|rate.?limit|throttl|try (again )?later|slow down|temporarily (locked|blocked|unavailable)/i

// The endpoint speaks GraphQL and nothing else, so a body that is not JSON is
// not the platform answering — it is something in front of it. Cloudflare's
// "Just a moment…" challenge is exactly this: HTTP 200, text/html, no `data`.
const NOT_JSON = 'HIREDLY_BLOCKED_NOT_JSON'

/**
 * Hiredly employer adapter. Auth is the platform's own `loginEmployer`
 * mutation against the same GraphQL endpoint the data comes from; the returned
 * Bearer token is held for the life of this instance and never persisted.
 * Resume files are public S3 URLs (no auth).
 */
export class HiredlyAdapter implements Adapter {
  readonly platform = 'hiredly' as const
  readonly hasApplicantCount = true
  readonly closedStates = CLOSED_STATES
  private token: string | null = null
  private email: string | null = null
  private password: string | null = null

  async login(email: string, password: string): Promise<void> {
    this.email = email
    this.password = password
    this.token = await this.authenticate()
  }

  private async authenticate(): Promise<string> {
    const { email, password } = this
    if (email === null || password === null) throw new Error('HIREDLY_NOT_PRIMED')

    const res = await postJson(GQL, { query: LOGIN, variables: { email, password } }, { origin: SITE })
    // A 401 on the login call itself is the platform rejecting these
    // credentials, which must never be read as "the session expired" — that
    // would put the pair back in the retry pool it exists to stay out of.
    if (res.status === 401) throw new Error('HIREDLY_LOGIN_REJECTED')
    if (res.status < 200 || res.status >= 300) throw new Error(`HIREDLY_HTTP_${res.status}`)
    if (res.body === null) throw new Error(`${NOT_JSON}: login answered with a non-JSON body`)

    const body = res.body as {
      data?: { loginEmployer?: { token?: unknown } | null }
      errors?: unknown
    } | null
    // Only what is left after the two above is a statement about the password.
    if (body?.errors) {
      const text = JSON.stringify(body.errors)
      if (THROTTLED.test(text)) throw new Error('HIREDLY_BLOCKED_THROTTLED: ' + text.slice(0, 200))
      throw new Error('HIREDLY_LOGIN_REJECTED')
    }

    const token = body?.data?.loginEmployer?.token
    if (typeof token !== 'string' || token.length === 0) throw new Error('HIREDLY_LOGIN_REJECTED')
    return token
  }

  /**
   * One graphql call, with exactly one re-login if the session died under it.
   * The retry is capped at one on purpose: a token can expire mid-run, but a
   * second rejection means the credentials or the platform changed, and a loop
   * here would hammer the login endpoint for the rest of the run.
   */
  private async query<T>(body: string): Promise<T> {
    try {
      return await this.send<T>(body)
    } catch (err) {
      if (!String(err).includes('NOT_LOGGED_IN')) throw err
      this.token = await this.authenticate()
      return this.send<T>(body)
    }
  }

  private async send<T>(body: string): Promise<T> {
    if (!this.token) throw new Error('HIREDLY_NOT_PRIMED')
    const res = await postJson(
      GQL,
      { query: body },
      { origin: SITE, authorization: `Bearer ${this.token}` }
    )
    // 401 is a dead session; 403 is Hiredly pushing back and must reach the
    // circuit breaker as its own string, or classify() reads it as logged_out
    // and the worker keeps hammering a platform that is blocking it. A 403 is
    // not the only shape that takes, though — a WAF that answers 200 with an
    // HTML challenge has to reach the breaker by the same route, or the worker
    // walks back into it every cycle for as long as the block lasts.
    if (res.status === 401) throw new Error('HIREDLY_NOT_LOGGED_IN')
    if (res.status < 200 || res.status >= 300) throw new Error(`HIREDLY_HTTP_${res.status}`)
    if (res.body === null) throw new Error(`${NOT_JSON}: graphql answered with a non-JSON body`)

    const json = res.body as { data?: T; errors?: unknown } | null
    if (json?.errors) {
      const text = JSON.stringify(json.errors)
      if (DEAD_SESSION.test(text)) throw new Error('HIREDLY_NOT_LOGGED_IN')
      if (THROTTLED.test(text)) throw new Error('HIREDLY_BLOCKED_THROTTLED: ' + text.slice(0, 200))
      throw new Error('HIREDLY_GQL_ERROR: ' + text.slice(0, 200))
    }
    if (!json?.data) throw new Error('HIREDLY_GQL_NO_DATA')
    return json.data
  }

  /**
   * `totalCount` on the job node is the same number `jobApplicationsUnified`
   * reports on its first page — verified 2026-09-18 against all 51 jobs of the
   * test employer account, every one identical. Taking it here is what lets a
   * job nobody has claimed be counted for the Jobs picker without a second call
   * per job per round.
   */
  async listJobs(): Promise<ScrapedJob[]> {
    const data = await this.query<{
      jobs: { edges: { node: { id: string; title: string; active: boolean; totalCount: number | null } }[] }
    }>(`{ jobs { edges { node { id title active totalCount } } } }`)
    return data.jobs.edges.map((e) => ({
      jobExternalId: e.node.id,
      jobTitle: e.node.title,
      applicantCount: e.node.totalCount ?? null,
      active: e.node.active
    }))
  }

  async listApplications(
    jobExternalId: string,
    after: string | null
  ): Promise<{ applications: ScrapedApplication[]; nextCursor: string | null; totalCount: number }> {
    const body = `{
      jobApplicationsUnified(trackIds: [], jobId: ${JSON.stringify(jobExternalId)}, first: ${PAGE_SIZE}, after: ${JSON.stringify(after ?? '')}, sort: {by: "appliedAt", direction: "desc"}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges { node {
          id appliedAt state
          user { id name email mobileNumber resume }
        } }
      }
    }`
    const data = await this.query<{
      jobApplicationsUnified: {
        totalCount: number
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        edges: {
          node: {
            id: string
            appliedAt: string | null
            state: string | null
            user: {
              id: string | null
              name: string | null
              email: string | null
              mobileNumber: string | null
              resume: string | null
            } | null
          }
        }[]
      }
    }>(body)

    const conn = data.jobApplicationsUnified
    const applications: ScrapedApplication[] = conn.edges.map((e) => {
      const u = e.node.user
      return {
        externalApplicationId: e.node.id,
        candidateName: u?.name ?? null,
        candidateKey: u?.id || normalizeKey(u?.email) || normalizeKey(u?.mobileNumber) || normalizeKey(u?.name),
        candidateEmail: u?.email ?? null,
        candidatePhone: u?.mobileNumber ?? null,
        jobTitle: null,
        jobExternalId,
        appliedAt: e.node.appliedAt,
        resumeUrl: absolutize(u?.resume ?? null),
        state: e.node.state ?? null
      }
    })
    return {
      applications,
      nextCursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
      totalCount: conn.totalCount
    }
  }

  async downloadResume(resumeUrl: string): Promise<Buffer> {
    // Public S3 object — no auth needed, but the browser-like headers are what
    // keep it from looking like a scripted fetch.
    const res = await getBuffer(resumeUrl, { origin: SITE })
    if (res.status < 200 || res.status >= 300) throw new Error(`HIREDLY_RESUME_HTTP_${res.status}`)
    assertIsAFile(res.buffer)
    return res.buffer
  }
}

// What a resume can legitimately start with. Anything else is only rejected if
// it also looks like markup, so a plain-text CV still gets through.
const FILE_MAGIC = ['%PDF-', 'PK\x03\x04', '\xD0\xCF\x11\xE0', '{\\rtf']
const MARKUP = /<!doctype|<html/i

/**
 * 🔴 A WAF interstitial arrives as HTTP 200 with an HTML body. Stored blindly it
 * is hashed, given a `.pdf` name, PUT into a bucket shared with the whole
 * product and recorded as a pending resume — a fake CV waiting for a human to
 * open. Worse, it is stable: L3 dedups every later challenge page against the
 * first, so a wholly blocked run stores one piece of rubbish and finishes as
 * `completed` with the circuit breaker never once tripping.
 *
 * The string carries BLOCKED, which classify() already reads as a block, so the
 * run ends in `blocked` and the breaker brakes.
 */
function assertIsAFile(buf: Buffer): void {
  const head = buf.subarray(0, 512).toString('latin1')
  if (FILE_MAGIC.some((magic) => head.startsWith(magic))) return
  if (MARKUP.test(head)) throw new Error('HIREDLY_BLOCKED_NOT_A_FILE')
}

function absolutize(url: string | null): string | null {
  if (!url) return null
  return url.startsWith('//') ? 'https:' + url : url
}

function normalizeKey(v: string | null | undefined): string | null {
  if (!v) return null
  const s = v.trim().toLowerCase()
  return s.length ? s : null
}
