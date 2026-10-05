// Ported from Nortia's internal Hiredly worker (src/worker/http.ts @ 623677a). Copied verbatim.

// The worker's only outbound HTTP client.
//
// ANTI-DETECTION CONTRACT — the header set below is load-bearing, not
// decoration. Until this round every platform request was fired from a real
// Chrome browser context, which supplied user-agent, origin, referer and a
// Chrome TLS fingerprint for free. Node's fetch supplies none of that: the
// default user-agent is undici's, and origin/referer simply do not exist —
// which is the first thing a bot filter looks at. Stripping these back to a
// bare fetch would silently weaken the scraper's posture with a green test
// suite. Same class of rule as scrape.ts's throttle().

// Chrome on Windows x64: the most common desktop signature there is, so it
// blends into ordinary employer-portal traffic rather than standing out.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// No request may hang a run indefinitely. undici's own timeouts are 300s each,
// which is longer than a whole scrape cycle should ever stall on one call.
const TIMEOUT_MS = 30_000

export function browserHeaders(origin: string): Record<string, string> {
  return {
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    origin,
    referer: origin.endsWith('/') ? origin : origin + '/'
  }
}

export interface RequestOptions {
  /** The site a browser would be sitting on when it fires this request. */
  origin: string
  authorization?: string
}

export interface JsonResponse {
  status: number
  /** Parsed body, or null when the platform answered with something that is not JSON. */
  body: unknown
}

export async function postJson(
  url: string,
  payload: unknown,
  opts: RequestOptions
): Promise<JsonResponse> {
  const res = await send(url, {
    method: 'POST',
    headers: {
      ...browserHeaders(opts.origin),
      'content-type': 'application/json',
      ...(opts.authorization ? { authorization: opts.authorization } : {})
    },
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as unknown }
  } catch {
    return { status: res.status, body: null }
  }
}

export async function getBuffer(
  url: string,
  opts: RequestOptions
): Promise<{ status: number; buffer: Buffer }> {
  const res = await send(url, { headers: browserHeaders(opts.origin) })
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }
}

/**
 * Node's fetch collapses every transport failure into the same opaque
 * "TypeError: fetch failed", while the errno that cycle.ts's classify() reads
 * to tell a transient blip from a fatal bug sits one level down in `cause`.
 * Lifting it into the message is what keeps a dropped connection a retry
 * instead of a run-ending fault.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    throw new Error(`NETWORK_${cause?.code ?? 'ERROR'}: ${cause?.message ?? String(err)}`)
  }
}
