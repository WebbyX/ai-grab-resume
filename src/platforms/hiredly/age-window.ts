// Ported from Nortia's internal Hiredly worker (src/shared/age-window.ts @ 623677a). Copied verbatim.

/**
 * The fetch window: how far back into a platform's application list the worker
 * is allowed to walk, per (tenant, platform).
 *
 * It governs FETCHING and nothing else. Narrowing the window never deletes a
 * resume that is already stored — a settings field that quietly destroyed data
 * would be exactly the irreversible action the wipe spends a typed confirmation
 * guarding against. Retention is a separate feature that does not exist yet.
 *
 * Lives in shared/ for the same reason login-gate.ts does: the worker computes
 * the cutoff, the portal validates the number an operator types and decides
 * whether the change invalidates the count-diff watermark, and the database
 * layer writes both halves in one statement. Three readers, one rule.
 */

/** The window a pair uses while `max_age_days` is NULL. The ONLY source of this
 *  number — the column is deliberately left without a database default, so a
 *  future Laravel migration cannot silently rewrite every existing row. */
export const DEFAULT_MAX_AGE_DAYS = 30

// 0 is rejected rather than read as "no limit": it reads just as naturally as
// "fetch nothing", and an input box that inverts its meaning on one mistyped
// character is a bad input box. 3650 is the way to say "effectively no limit",
// which keeps the whole axis monotonic — a bigger number always fetches more.
export const MIN_MAX_AGE_DAYS = 1
export const MAX_MAX_AGE_DAYS = 3650

const DAY_MS = 24 * 60 * 60_000

// The zone the window's days are counted in. Malaysia is UTC+8 all year and has
// no daylight saving, so a fixed offset is not a shortcut around a timezone
// library — it is the rule. Hiredly is a Malaysian board and this is the market
// every pair scrapes today.
//
// ⚠ JobStreet spans MY/SG/PH/ID. The day the first non-Malaysian pair runs, this
// constant has to become a per-platform column; until then one number is honest
// and a lookup table would be inventing a decision nobody has made.
const PLATFORM_OFFSET_MS = 8 * 60 * 60_000

/** Midnight of the day `at` falls on, in the platform's own zone. */
function startOfDay(at: Date): Date {
  const local = at.getTime() + PLATFORM_OFFSET_MS

  return new Date(local - (local % DAY_MS) - PLATFORM_OFFSET_MS)
}

/**
 * The instant an application must be no older than to be worth fetching.
 *
 * Whole days, counted back from the start of the day the run happens on: 1 is
 * today, 2 is today and yesterday, 30 is today and the 29 days before it. An
 * operator asked for "the last N days" and gets exactly N days — the window
 * used to be N×24h measured from the run's own clock plus a day of slack, which
 * meant a window of 1 quietly reached 48 hours back and the answer moved every
 * time the schedule drifted.
 *
 * The slack is gone with it. It existed to absorb the platform's timezone; the
 * boundary is now that timezone's own midnight, and adding a day on top would
 * be the same hidden day under a new name.
 */
export function cutoffFor(runAt: Date, maxAgeDays: number | null | undefined): Date {
  const days = maxAgeDays ?? DEFAULT_MAX_AGE_DAYS

  return new Date(startOfDay(runAt).getTime() - (days - 1) * DAY_MS)
}

const TIME_PART = /[T ]\d{2}:\d{2}/
// `+08` is as valid an ISO-8601 offset as `+08:00`, and treating it as no zone
// at all appends a second one — `…+08Z` — which parses to NaN and reads as "no
// date". Node cannot parse the two-digit form either, so it is padded here.
const EXPLICIT_ZONE = /(Z|[+-]\d{2}(:?\d{2})?)$/i
const SHORT_ZONE = /([+-]\d{2})$/

/**
 * Reads a platform's `appliedAt` into epoch milliseconds, or null when there is
 * nothing usable to read.
 *
 * 🔴 The timezone is the real hazard here, not clock drift. Hiredly sends a
 * naked `2026-08-03T10:00:00` with no zone, and `Date.parse` reads that as LOCAL
 * time — the worker runs in MY (UTC+8) while the platform most likely means UTC,
 * a systematic 8-hour error no buffer can cover. A naked date-time is therefore
 * read as UTC, deliberately biasing a borderline record towards "newer" and so
 * towards being INCLUDED: erring old silently misses resumes, erring new costs
 * one extra download. A date with no time at all is already UTC by specification
 * and is left alone.
 */
export function parseAppliedAt(value: string | null | undefined): number | null {
  if (!value) return null
  const s = value.trim()
  if (!s) return null
  // The short-zone padding is confined to strings that carry a time: a bare
  // `2026-08-03` ends in what looks exactly like a two-digit offset.
  const zoned = !TIME_PART.test(s)
    ? s
    : EXPLICIT_ZONE.test(s)
      ? s.replace(SHORT_ZONE, '$1:00')
      : s.replace(' ', 'T') + 'Z'
  const ms = Date.parse(zoned)
  return Number.isNaN(ms) ? null : ms
}
