// Ported from Nortia's internal Hiredly worker (src/worker/scrape.ts:30-32 @ 623677a). Logic unchanged.

export function throttle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000))
}
