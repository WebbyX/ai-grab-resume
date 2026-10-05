import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NortiaClient } from '../src/api/client'
import { loadConfig } from '../src/config'
import { syncBatch, type BatchOptions } from '../src/platforms/hiredly/sync'
import { HiredlyRun, type SyncDeps } from '../src/run-state'
import { startFakeApi } from './helpers/fake-api'
import { app, fakeHiredly, job } from './helpers/fake-hiredly'
import { VALID_KEY } from './helpers/harness'

type FakeApi = Awaited<ReturnType<typeof startFakeApi>>

const OLD = '2020-01-01T00:00:00'
const memory = () => ({ handled: new Set<string>(), finishedJobs: new Set<string>() })
const opts = (fullWindow: boolean): BatchOptions => ({
  maxNew: 25,
  dryRun: false,
  cutoff: new Date(Date.now() - 30 * 86_400_000),
  fullWindow,
  throttle: async () => {},
  log: () => {}
})
const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)
const sentIds = (api: FakeApi) => api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id)

function newRun(api: FakeApi, adapter: ReturnType<typeof fakeHiredly>['adapter']): HiredlyRun {
  const deps: SyncDeps = {
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => adapter,
    throttle: async () => {},
    now: () => new Date(),
    log: () => {}
  }
  return new HiredlyRun(deps)
}

test('a full-window batch walks past known rows to the new ones below them', async () => {
  const api = await startFakeApi()
  try {
    for (const id of ids('k', 1, 6)) api.known.add(id)
    const h = fakeHiredly({
      jobs: [job('job-1', 'Chef')],
      apps: { 'job-1': ['n1', 'n2', 'n3', ...ids('k', 1, 6), 'old-new'].map((id) => app(id)) }
    })
    await syncBatch(h.adapter, new NortiaClient(api.url, VALID_KEY), memory(), opts(true))
    assert.deepEqual(sentIds(api), ['n1', 'n2', 'n3', 'old-new'])
    assert.equal(h.stats.downloads, 4)
  } finally {
    await api.close()
  }
})

test('a full-window batch still ends a job on five out-of-window rows', async () => {
  const api = await startFakeApi()
  try {
    for (const id of ids('k', 1, 6)) api.known.add(id)
    const h = fakeHiredly({
      jobs: [job('job-1', 'Chef')],
      apps: {
        'job-1': [...ids('k', 1, 6).map((id) => app(id)), ...ids('o', 1, 6).map((id) => app(id, { appliedAt: OLD })), app('n-after')]
      }
    })
    const res = await syncBatch(h.adapter, new NortiaClient(api.url, VALID_KEY), memory(), opts(true))
    assert.deepEqual(sentIds(api), [])
    assert.equal(res.counts.skipped_out_of_window, 5)
  } finally {
    await api.close()
  }
})

test('when Nortia asks for the full window, every batch of the run walks past known rows', async () => {
  const api = await startFakeApi({ sync: { full_window: true } })
  try {
    for (const id of ids('k', 1, 12)) api.known.add(id)
    const h = fakeHiredly({
      jobs: [job('job-1', 'Chef')],
      apps: { 'job-1': ['n1', ...ids('k', 1, 6), 'n2', ...ids('k', 7, 12), 'n3'].map((id) => app(id)) }
    })
    const run = newRun(api, h.adapter)
    let res
    let calls = 0
    do {
      res = await run.call({ maxNew: 1, dryRun: false })
      calls++
    } while (!res.done && calls < 10)
    assert.equal(res.done, true)
    assert.deepEqual(sentIds(api), ['n1', 'n2', 'n3'])
    assert.equal(api.count('/api/v1/me'), 1)
    const runIds = api.requests.filter((r) => r.path === '/api/v1/runs').map((r) => r.json.run_id)
    assert.equal(runIds.length, calls)
    assert.equal(new Set(runIds).size, 1)
  } finally {
    await api.close()
  }
})

test('anything but a literal full_window true keeps the early stop', async () => {
  for (const sync of [undefined, { full_window: false }, { full_window: 'true' }, {}, null]) {
    const api = await startFakeApi({ sync })
    try {
      for (const id of ids('k', 1, 5)) api.known.add(id)
      const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': ['n1', ...ids('k', 1, 5), 'n2'].map((id) => app(id)) } })
      const res = await newRun(api, h.adapter).call({ maxNew: 25, dryRun: false })
      assert.equal(res.done, true, JSON.stringify(sync))
      assert.deepEqual(sentIds(api), ['n1'], JSON.stringify(sync))
    } finally {
      await api.close()
    }
  }
})

test('a dry run honours the full window without downloading anything', async () => {
  const api = await startFakeApi({ sync: { full_window: true } })
  try {
    for (const id of ids('k', 1, 6)) api.known.add(id)
    const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [...ids('k', 1, 6), 'n1'].map((id) => app(id)) } })
    const res = await newRun(api, h.adapter).call({ maxNew: 25, dryRun: true })
    assert.equal(res.would_submit, 1)
    assert.equal(h.stats.downloads, 0)
  } finally {
    await api.close()
  }
})
