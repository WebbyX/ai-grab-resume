// Ported from Nortia's internal Hiredly worker (src/worker/adapters/types.ts @ 623677a). Copied verbatim.

export interface ScrapedJob {
  jobExternalId: string
  jobTitle: string
  /** Total applicants shown by the platform, if it exposes a count (spec §4.5-1). */
  applicantCount: number | null
  /** The platform's own open/closed flag, or null when it does not publish one. */
  active: boolean | null
}

export interface ScrapedApplication {
  externalApplicationId: string
  candidateName: string | null
  candidateKey: string | null // spec §4 L2: candidate_id → email → phone → name
  /** Raw platform metadata, kept alongside the normalized L2 key. Null when the platform withholds it. */
  candidateEmail: string | null
  candidatePhone: string | null
  jobTitle: string | null
  jobExternalId: string
  appliedAt: string | null // ISO8601, platform timezone preserved
  /** Absolute URL to the resume file, or null when the candidate attached none. */
  resumeUrl: string | null
  /** The employer's own decision on this application, as the platform names it, or null when it publishes none. */
  state: string | null
}

export interface Adapter {
  readonly platform: 'hiredly' | 'seek'
  /** Spec §4.5-1: whether jobApplications carry a usable applicant count. */
  readonly hasApplicantCount: boolean

  /**
   * The states this platform uses for applications the employer has already
   * decided against, so there is nothing left for us to screen.
   *
   * A REFUSAL list and never an allow list. A value nobody has seen before —
   * a new state, a renamed one, a null — means "fetch it", so the way this set
   * goes wrong is one wasted download rather than a real applicant who never
   * appears anywhere and whom nobody knows to look for.
   */
  readonly closedStates: ReadonlySet<string>

  /**
   * Authenticate this adapter instance for one run. The instance is created per
   * run and thrown away with it, so whatever the platform hands back lives in
   * memory only and is never written to the database.
   */
  login(email: string, password: string): Promise<void>

  listJobs(): Promise<ScrapedJob[]>

  /**
   * Applications for one job, newest-first. `after` is an opaque cursor for
   * pagination; return the next cursor (or null when exhausted) so the pipeline
   * can early-stop (spec §4.5-2) without over-fetching.
   */
  listApplications(
    jobExternalId: string,
    after: string | null
  ): Promise<{ applications: ScrapedApplication[]; nextCursor: string | null; totalCount: number }>

  /** Download a resume to a Buffer using whatever auth the URL needs. */
  downloadResume(resumeUrl: string): Promise<Buffer>
}
