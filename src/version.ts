declare const __KIT_VERSION__: string | undefined
declare const __KIT_NAME__: string | undefined

// why: esbuild `define` injects these into dist/cli.js; tests run the TS sources where they do not exist.
export const KIT_VERSION: string = typeof __KIT_VERSION__ === 'string' ? __KIT_VERSION__ : '0.0.0'
export const KIT_NAME: string = typeof __KIT_NAME__ === 'string' ? __KIT_NAME__ : 'nortia-ai-grab'

export function isOlder(current: string, latest: string): boolean {
  const a = current.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x < y
  }
  return false
}
