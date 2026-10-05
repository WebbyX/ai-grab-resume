# Provenance

Code ported from Nortia's internal Hiredly worker. Ported files keep the source logic
unchanged; each starts with a one-line header naming its source path and commit.

| Kit file | Source (in the internal worker) | Commit | Change |
|---|---|---|---|
| `src/platforms/hiredly/types.ts` | `src/worker/adapters/types.ts` | `623677a` | none |
| `src/platforms/hiredly/hiredly.ts` | `src/worker/adapters/hiredly.ts` | `623677a` | import `'../http'` → `'./http'` |
| `src/platforms/hiredly/http.ts` | `src/worker/http.ts` | `623677a` | none |
| `src/platforms/hiredly/age-window.ts` | `src/shared/age-window.ts` | `623677a` | none |
| `src/platforms/hiredly/throttle.ts` | `src/worker/scrape.ts:30-32` (`throttle`) | `623677a` | extracted into its own file |

Written for the kit, following the same rules as Nortia's internal Hiredly worker:
`src/platforms/hiredly/sync.ts` reuses the stop rules of `scrape.ts`
(`EARLY_STOP = 5`, `OLD_STOP = 5`, `MAX_PAGES = 50`, closed states skipped,
download last) and the failure reading of `cycle.ts` `classify()`.

## Re-pulling

1. `git -C <internal worker repo> diff 623677a <new> -- src/worker/adapters src/worker/http.ts src/shared/age-window.ts src/worker/scrape.ts`
2. Copy the changed files over, re-apply the import change above, update the
   header line and this table, then run `npm test`.
