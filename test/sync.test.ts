import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { NortiaClient } from '../src/api/client'
import { loadConfig } from '../src/config'
import { MAX_RESUME_BYTES, syncBatch, type BatchOptions } from '../src/platforms/hiredly/sync'
import { HiredlyRun, type SyncDeps } from '../src/run-state'
import { startFakeApi } from './helpers/fake-api'
import { app, fakeHiredly, job, PII } from './helpers/fake-hiredly'
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

const OLD = '2020-01-01T00:00:00'
const opts = (over: Partial<BatchOptions> = {}): BatchOptions => ({
  maxNew: 25,
  dryRun: false,
  cutoff: new Date(Date.now() - 30 * 86_400_000),
  fullWindow: false,
  throttle: async () => {},
  log: () => {},
  ...over
})
const memory = () => ({ handled: new Set<string>(), finishedJobs: new Set<string>() })
const client = () => new NortiaClient(api.url, VALID_KEY)

function runDeps(adapter: ReturnType<typeof fakeHiredly>['adapter']): SyncDeps {
  return {
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => adapter,
    throttle: async () => {},
    now: () => new Date(),
    log: () => {}
  }
}

test('out-of-window applications are skipped and five in a row end the job', async () => {
  const apps = [app('n1'), app('n2'), ...['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map((id) => app(id, { appliedAt: OLD })), app('n3')]
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': apps } })
  const res = await syncBatch(h.adapter, client(), memory(), opts())
  assert.equal(res.counts.submitted, 2)
  assert.equal(res.counts.skipped_out_of_window, 5)
  assert.equal(h.stats.downloads, 2)
  assert.equal(res.more, false)
})

test('applications the employer already closed are skipped without a download', async () => {
  const apps = [app('c1', { state: 'rejected' }), app('n1'), app('c2', { state: 'offered' }), app('k1', { state: 'kiv' })]
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': apps } })
  const res = await syncBatch(h.adapter, client(), memory(), opts())
  assert.equal(res.counts.skipped_closed, 2)
  assert.equal(res.counts.submitted, 2)
  assert.equal(h.stats.downloads, 2)
})

test('five known applications in a row stop the job; a new one in between resets the count', async () => {
  for (const id of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']) api.known.add(id)
  const stopped = fakeHiredly({
    jobs: [job('job-1', 'Chef')],
    apps: { 'job-1': ['k1', 'k2', 'k3', 'k4', 'k5', 'n1'].map((id) => app(id)) }
  })
  const res = await syncBatch(stopped.adapter, client(), memory(), opts())
  assert.equal(res.counts.submitted, 0)
  assert.equal(stopped.stats.downloads, 0)

  const reset = fakeHiredly({
    jobs: [job('job-1', 'Chef')],
    apps: { 'job-1': ['k1', 'k2', 'k3', 'k4', 'n2', 'k6', 'k7', 'k8', 'k9', 'n3'].map((id) => app(id)) }
  })
  const res2 = await syncBatch(reset.adapter, client(), memory(), opts())
  assert.equal(res2.counts.submitted, 2)
})

test('max_new caps a batch and says there is more', async () => {
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': ['a', 'b', 'c', 'd', 'e'].map((id) => app(id)) } })
  const res = await syncBatch(h.adapter, client(), memory(), opts({ maxNew: 2 }))
  assert.equal(res.counts.submitted, 2)
  assert.equal(res.more, true)
  assert.equal(h.stats.downloads, 2)
})

test('inactive jobs and applications without a resume are skipped', async () => {
  const h = fakeHiredly({
    jobs: [job('job-1', 'Chef'), job('job-2', 'Closed role', false)],
    apps: { 'job-1': [app('r1', { resume: false }), app('n1')], 'job-2': [app('x1', { job: 'job-2' })] }
  })
  const res = await syncBatch(h.adapter, client(), memory(), opts())
  assert.equal(res.counts.skipped_no_resume, 1)
  assert.equal(res.counts.submitted, 1)
  assert.ok(h.stats.pages.every((p) => p.startsWith('job-1')))
})

test('every submitted resume carries the platform job title and id', async () => {
  const h = fakeHiredly({
    jobs: [job('job-1', 'Head Chef'), job('job-2', 'Barista')],
    apps: { 'job-1': [app('a1')], 'job-2': [app('b1', { job: 'job-2' }), app('b2', { job: 'job-2' })] }
  })
  await syncBatch(h.adapter, client(), memory(), opts())
  const sent = api.requests.filter((r) => r.path === '/api/v1/resumes')
  assert.equal(sent.length, 3)
  assert.deepEqual(
    sent.map((r) => [r.form?.external_job_title, r.form?.external_job_id, r.form?.platform]),
    [
      ['Head Chef', 'job-1', 'hiredly'],
      ['Barista', 'job-2', 'hiredly'],
      ['Barista', 'job-2', 'hiredly']
    ]
  )
})

test('a download that fails is counted and the batch goes on', async () => {
  const h = fakeHiredly({
    jobs: [job('job-1', 'Chef')],
    apps: { 'job-1': [app('a'), app('b')] },
    downloadError: (url) => (url.includes('/a.') ? 'HIREDLY_RESUME_HTTP_404' : undefined)
  })
  const res = await syncBatch(h.adapter, client(), memory(), opts())
  assert.equal(res.status, 'ok')
  assert.equal(res.counts.failed, 1)
  assert.equal(res.counts.submitted, 1)
})

test('a blocked sign-in ends the run at once and is not retried', async () => {
  for (const loginError of ['HIREDLY_BLOCKED_THROTTLED: too many attempts', 'HIREDLY_HTTP_403']) {
    const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('a')] }, loginError })
    const res = await new HiredlyRun(runDeps(h.adapter)).call({ maxNew: 25, dryRun: false })
    assert.equal(res.status, 'blocked', loginError)
    assert.equal(res.done, true)
    assert.equal(h.stats.logins, 1)
    assert.equal(h.stats.listJobs, 0)
  }
})

test('a rejected password ends the run and is reported as login_rejected', async () => {
  const h = fakeHiredly({ jobs: [], apps: {}, loginError: 'HIREDLY_LOGIN_REJECTED' })
  const res = await new HiredlyRun(runDeps(h.adapter)).call({ maxNew: 25, dryRun: false })
  assert.equal(res.status, 'login_rejected')
  assert.equal(res.done, true)
  assert.match(res.message, /^Hiredly rejected the saved password\./)
  const report = api.requests.find((r) => r.path === '/api/v1/runs')!
  assert.equal(report.json.outcome, 'login_rejected')
  assert.equal(report.json.done, true)
})

test('a 426 stops the run immediately and nothing is reported', async () => {
  api.setOverride((r) => (r.path === '/api/v1/resumes' ? { status: 426 } : undefined))
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('a'), app('b'), app('c')] } })
  const res = await new HiredlyRun(runDeps(h.adapter)).call({ maxNew: 25, dryRun: false })
  assert.equal(res.status, 'kit_outdated')
  assert.equal(res.done, true)
  assert.equal(h.stats.downloads, 1)
  assert.equal(api.count('/api/v1/resumes'), 1)
  assert.equal(api.count('/api/v1/runs'), 0)
  assert.equal(
    res.message,
    'This Nortia connector is out of date. Open Nortia → AI Grab Resume → Connect and copy the update instructions into Claude.'
  )
})

test('the tool response carries counts only, never candidate details', async () => {
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('a'), app('b', { resume: false })] } })
  const res = await new HiredlyRun(runDeps(h.adapter)).call({ maxNew: 25, dryRun: false })
  const text = JSON.stringify(res)
  for (const value of [PII.name, PII.email, PII.phone, 'files.example.com', 'hr@acme.com']) {
    assert.ok(!text.includes(value), value)
  }
  assert.deepEqual(Object.keys(res).sort(), [
    'ambiguous_title', 'done', 'duplicates', 'failed', 'matched', 'message', 'more', 'no_title_match',
    'skipped_closed', 'skipped_no_resume', 'skipped_out_of_window', 'status', 'submitted'
  ])
})

test('later batches pick up after the earlier ones without losing or recounting anything', async () => {
  const apps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => app(id))
  apps.splice(2, 0, app('closed', { state: 'rejected' }), app('nofile', { resume: false }))
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': apps } })
  const run = new HiredlyRun(runDeps(h.adapter))
  const results = []
  for (let i = 0; i < 5; i++) {
    const res = await run.call({ maxNew: 3, dryRun: false })
    results.push(res)
    if (res.done) break
  }
  assert.deepEqual(results.map((r) => r.done), [false, false, true])
  const last = results.at(-1)!
  assert.equal(last.submitted, 7)
  assert.equal(last.skipped_closed, 1)
  assert.equal(last.skipped_no_resume, 1)
  assert.equal(h.stats.downloads, 7)
  assert.equal(h.stats.logins, 1)
})

test('Nortia unreachable mid-batch ends the run at once instead of downloading the rest', async () => {
  api.setOverride((r) => (r.path === '/api/v1/resumes' ? { status: 0, destroy: true } : undefined))
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('a'), app('b'), app('c')] } })
  const res = await new HiredlyRun(runDeps(h.adapter)).call({ maxNew: 25, dryRun: false })
  assert.equal(res.status, 'error')
  assert.equal(res.done, true)
  assert.equal(h.stats.downloads, 1)
  assert.match(res.message, /^Something went wrong \(network_/)
})

test('a 5xx on one resume is a per-resume failure; all failing says so plainly', async () => {
  api.setOverride((r) => (r.path === '/api/v1/resumes' ? { status: 500 } : undefined))
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('a'), app('b')] } })
  const res = await new HiredlyRun(runDeps(h.adapter)).call({ maxNew: 25, dryRun: false })
  assert.equal(res.status, 'ok')
  assert.equal(res.failed, 2)
  assert.equal(res.message, 'Could not send 2 resumes to Nortia. They will be tried again on the next run.')
  const report = api.requests.find((r) => r.path === '/api/v1/runs')!
  assert.equal(report.json.outcome, 'ok')
  assert.equal(report.json.counts.failed, 2)
})

test('a downloaded file over 10 MB is counted as failed and never sent', async () => {
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('big'), app('small')] } })
  const download = h.adapter.downloadResume.bind(h.adapter)
  h.adapter.downloadResume = async (url) => (url.includes('/big.') ? Buffer.alloc(MAX_RESUME_BYTES + 1, 0x25) : download(url))
  const res = await syncBatch(h.adapter, client(), memory(), opts())
  assert.equal(res.counts.failed, 1)
  assert.equal(res.counts.submitted, 1)
  assert.deepEqual(
    api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id),
    ['small']
  )
})
