import type { Adapter, ScrapedApplication, ScrapedJob } from '../../src/platforms/hiredly/types'

export const PII = { name: 'Alice Tan', email: 'alice.tan@example.com', phone: '+60123456789' }

export function app(
  id: string,
  opts: { appliedAt?: string | null; state?: string | null; resume?: boolean; job?: string } = {}
): ScrapedApplication {
  return {
    externalApplicationId: id,
    candidateName: PII.name,
    candidateKey: id,
    candidateEmail: PII.email,
    candidatePhone: PII.phone,
    jobTitle: null,
    jobExternalId: opts.job ?? 'job-1',
    appliedAt: opts.appliedAt === undefined ? new Date().toISOString() : opts.appliedAt,
    resumeUrl: opts.resume === false ? null : `https://files.example.com/${id}.pdf`,
    state: opts.state ?? null
  }
}

export function job(id: string, title: string, active: boolean | null = true): ScrapedJob {
  return { jobExternalId: id, jobTitle: title, applicantCount: null, active }
}

/** Scriptable Hiredly adapter: fixed jobs and applications, paged by index, with call counters. */
export function fakeHiredly(spec: {
  jobs: ScrapedJob[]
  apps: Record<string, ScrapedApplication[]>
  pageSize?: number
  loginError?: string
  listError?: string
  downloadError?: (url: string) => string | undefined
}) {
  const stats = { logins: 0, listJobs: 0, pages: [] as string[], downloads: 0 }
  const pageSize = spec.pageSize ?? 20
  const adapter: Adapter = {
    platform: 'hiredly',
    hasApplicantCount: true,
    closedStates: new Set(['offered', 'rejected', 'blacklisted']),
    async login() {
      stats.logins++
      if (spec.loginError) throw new Error(spec.loginError)
    },
    async listJobs() {
      stats.listJobs++
      if (spec.listError) throw new Error(spec.listError)
      return spec.jobs
    },
    async listApplications(jobId, after) {
      const start = after ? Number(after) : 0
      stats.pages.push(`${jobId}@${start}`)
      const all = spec.apps[jobId] ?? []
      const slice = all.slice(start, start + pageSize)
      const next = start + pageSize < all.length ? String(start + pageSize) : null
      return { applications: slice, nextCursor: next, totalCount: all.length }
    },
    async downloadResume(url) {
      stats.downloads++
      const err = spec.downloadError?.(url)
      if (err) throw new Error(err)
      return Buffer.from('%PDF-1.4 fake resume ' + url)
    }
  }
  return { adapter, stats }
}
