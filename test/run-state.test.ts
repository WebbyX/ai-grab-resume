import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { loadConfig } from '../src/config'
import { HiredlyRun, type SyncDeps } from '../src/run-state'
import { startFakeApi } from './helpers/fake-api'
import { app, fakeHiredly, job } from './helpers/fake-hiredly'
import { VALID_KEY } from './helpers/harness'

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
beforeEach(() => {
  api.requests.length = 0
  api.known.clear()
  api.setOverride(undefined)
})
after(() => api.close())

function setup(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `app-${i + 1}`)
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': ids.map((id) => app(id)) } })
  const clock = { now: Date.now() }
  const deps: SyncDeps = {
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => h.adapter,
    throttle: async () => {},
    now: () => new Date(clock.now),
    log: () => {}
  }
  return { run: new HiredlyRun(deps), hiredly: h, clock }
}

const reports = () => api.requests.filter((r) => r.path === '/api/v1/runs').map((r) => r.json)

test('a run of four calls reports every call under one run_id and ends on the fourth', async () => {
  const { run } = setup(4)
  const results = []
  for (let i = 0; i < 4; i++) results.push(await run.call({ maxNew: 1, dryRun: false }))

  assert.deepEqual(results.map((r) => r.done), [false, false, false, true])
  assert.deepEqual(results.map((r) => r.more), [true, true, true, false])
  assert.equal(results[0].message, 'Batch 1 sent (1 new resumes so far). Call hiredly_sync again.')
  assert.equal(
    results[3].message,
    'Sent 4 new resumes to Nortia. 0 matched a job; 4 are waiting in Nortia → AI Grab Resume → Resume inbox for you to assign.'
  )

  const sent = reports()
  assert.equal(sent.length, 4)
  assert.equal(new Set(sent.map((r) => r.run_id)).size, 1)
  assert.deepEqual(sent.map((r) => r.done), [false, false, false, true])
  assert.deepEqual(sent.map((r) => r.counts.submitted), [1, 2, 3, 4])
  assert.deepEqual(Object.keys(sent[3]).sort(), ['counts', 'done', 'outcome', 'run_id'])
  assert.equal(sent[3].outcome, 'ok')
})

test('the eighth call ends the run as partial even when more is waiting', async () => {
  const { run } = setup(12)
  let last
  for (let i = 0; i < 8; i++) last = await run.call({ maxNew: 1, dryRun: false })
  assert.equal(last!.done, true)
  assert.equal(last!.status, 'partial')
  assert.equal(last!.more, true)
  assert.equal(last!.submitted, 8)
  assert.equal(last!.message, 'Sent 8 new resumes; more are waiting and will come in on the next run.')
  const sent = reports()
  assert.equal(sent.length, 8)
  assert.equal(sent.at(-1).outcome, 'partial')
  assert.equal(sent.at(-1).done, true)
})

test('a call within ten minutes of the end replays the result without any request', async () => {
  const { run, hiredly, clock } = setup(2)
  const final = await run.call({ maxNew: 25, dryRun: false })
  assert.equal(final.done, true)
  const requestsBefore = api.requests.length
  const loginsBefore = hiredly.stats.logins

  clock.now += 9 * 60_000
  const replay = await run.call({ maxNew: 25, dryRun: false })
  assert.deepEqual(replay, { ...final, replayed: true })
  assert.equal(api.requests.length, requestsBefore)
  assert.equal(hiredly.stats.logins, loginsBefore)

  clock.now += 2 * 60_000
  const fresh = await run.call({ maxNew: 25, dryRun: false })
  assert.equal(fresh.replayed, undefined)
  assert.equal(fresh.submitted, 0)
  const ids = new Set(reports().map((r) => r.run_id))
  assert.equal(ids.size, 2)
})

test('a failing run report leaves the tool response unchanged', async () => {
  const healthy = setup(3)
  const ok = []
  for (let i = 0; i < 3; i++) ok.push(await healthy.run.call({ maxNew: 1, dryRun: false }))

  api.requests.length = 0
  api.known.clear()
  api.setOverride((r) => (r.path === '/api/v1/runs' ? { status: 500 } : undefined))
  const broken = setup(3)
  const withFailure = []
  for (let i = 0; i < 3; i++) withFailure.push(await broken.run.call({ maxNew: 1, dryRun: false }))

  assert.deepEqual(withFailure, ok)
  assert.equal(api.count('/api/v1/runs'), 3)
})

test('a dry run downloads, sends and reports nothing', async () => {
  const { run, hiredly } = setup(3)
  const res = await run.call({ maxNew: 25, dryRun: true })
  assert.equal(res.done, true)
  assert.equal(res.dry_run, true)
  assert.equal(res.would_submit, 3)
  assert.equal(res.submitted, 0)
  assert.equal(hiredly.stats.downloads, 0)
  assert.equal(api.count('/api/v1/resumes'), 0)
  assert.equal(api.count('/api/v1/runs'), 0)
})

test('a revoked key ends the run without a report', async () => {
  api.setOverride((r) => (r.path === '/api/v1/me' ? { status: 401 } : undefined))
  const { run, hiredly } = setup(2)
  const res = await run.call({ maxNew: 25, dryRun: false })
  assert.equal(res.status, 'api_key_invalid')
  assert.equal(res.done, true)
  assert.equal(hiredly.stats.logins, 0)
  assert.equal(api.count('/api/v1/runs'), 0)
})

test('a run nobody called for over 30 minutes is dropped; the next call starts fresh', async () => {
  const spec = {
    jobs: [job('job-1', 'Chef'), job('job-2', 'Cook')],
    apps: { 'job-1': [app('j1-a')], 'job-2': ['j2-a', 'j2-b', 'j2-c'].map((id) => app(id, { job: 'job-2' })) }
  }
  const h = fakeHiredly(spec)
  const clock = { now: Date.now() }
  const run = new HiredlyRun({
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => h.adapter,
    throttle: async () => {},
    now: () => new Date(clock.now),
    log: () => {}
  })
  const first = await run.call({ maxNew: 2, dryRun: false })
  assert.equal(first.done, false)

  clock.now += 24 * 3_600_000
  spec.apps['job-1'].unshift(app('j1-new'))
  let last
  for (let i = 0; i < 8; i++) {
    last = await run.call({ maxNew: 25, dryRun: false })
    if (last.done) break
  }
  const sent = api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id)
  assert.ok(sent.includes('j1-new'))
  assert.equal(last!.done, true)
  assert.equal(new Set(reports().map((r) => r.run_id)).size, 2)
  assert.equal(h.stats.logins, 2)
})

test('a call 29 minutes after the last one still continues the same run', async () => {
  const { run, clock } = setup(3)
  await run.call({ maxNew: 1, dryRun: false })
  clock.now += 29 * 60_000
  await run.call({ maxNew: 1, dryRun: false })
  assert.equal(new Set(reports().map((r) => r.run_id)).size, 1)
})

test('rate limiting on lookup ends the run and is reported as rate_limited', async () => {
  api.setOverride((r) => (r.path === '/api/v1/resumes/lookup' ? { status: 429, headers: { 'retry-after': '60' } } : undefined))
  const { run } = setup(1)
  const res = await run.call({ maxNew: 25, dryRun: false })
  assert.equal(res.status, 'rate_limited')
  assert.equal(res.done, true)
  assert.deepEqual(reports().map((r) => r.outcome), ['rate_limited'])
})

test('rows already in Nortia before the run still count toward the early stop across batches', async () => {
  const h = fakeHiredly({
    jobs: [job('job-1', 'Chef')],
    apps: { 'job-1': ['n1', 'n2', 'n3', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'old-new'].map((id) => app(id)) }
  })
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) api.known.add(k)
  const run = new HiredlyRun({
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => h.adapter,
    throttle: async () => {},
    now: () => new Date(),
    log: () => {}
  })
  for (let i = 0; i < 8; i++) if ((await run.call({ maxNew: 2, dryRun: false })).done) break
  assert.deepEqual(
    api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id),
    ['n1', 'n2', 'n3']
  )
})

test('a resume sent earlier in the run does not merge the known rows around it into an early stop', async () => {
  const h = fakeHiredly({
    jobs: [job('job-1', 'Chef')],
    apps: { 'job-1': ['k1', 'k2', 'n1', 'k3', 'k4', 'k5', 'n2'].map((id) => app(id)) }
  })
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) api.known.add(k)
  const run = new HiredlyRun({
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => h.adapter,
    throttle: async () => {},
    now: () => new Date(),
    log: () => {}
  })
  for (let i = 0; i < 8; i++) if ((await run.call({ maxNew: 1, dryRun: false })).done) break
  assert.deepEqual(
    api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id),
    ['n1', 'n2']
  )
})

test('idle time counts from the end of the previous call', async () => {
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': ['a', 'b', 'c'].map((id) => app(id)) } })
  const clock = { now: Date.now() }
  const run = new HiredlyRun({
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => h.adapter,
    throttle: async () => {
      clock.now += 31 * 60_000
    },
    now: () => new Date(clock.now),
    log: () => {}
  })
  const first = await run.call({ maxNew: 1, dryRun: false })
  assert.equal(first.more, true)
  clock.now += 60_000
  await run.call({ maxNew: 1, dryRun: false })
  const sent = reports()
  assert.equal(sent.length, 2)
  assert.equal(new Set(sent.map((r) => r.run_id)).size, 1)
})
