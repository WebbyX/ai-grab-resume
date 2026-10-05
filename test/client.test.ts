import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { NortiaClient } from '../src/api/client'
import { KIT_VERSION } from '../src/version'
import { startFakeApi } from './helpers/fake-api'
import { VALID_KEY } from './helpers/harness'

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
after(() => api.close())

test('every request carries the key and the kit version, under /api/v1', async () => {
  const client = new NortiaClient(api.url + '/', VALID_KEY)
  await client.me()
  await client.lookup('hiredly', ['a'])
  await client.submitResume(
    { bytes: Buffer.from('%PDF-1'), name: 'r.pdf' },
    { platform: 'hiredly', external_application_id: 'a', external_job_title: 'Chef' }
  )
  await client.reportRun({
    run_id: crypto.randomUUID(),
    done: true,
    outcome: 'ok',
    counts: { submitted: 1, duplicates: 0, matched: 0, no_title_match: 1, ambiguous_title: 0, failed: 0 }
  })
  assert.deepEqual(
    api.requests.map((r) => r.path),
    ['/api/v1/me', '/api/v1/resumes/lookup', '/api/v1/resumes', '/api/v1/runs']
  )
  for (const r of api.requests) {
    assert.equal(r.headers['x-nortia-kit-version'], KIT_VERSION)
    assert.equal(r.headers.authorization, `Bearer ${VALID_KEY}`)
    assert.equal(r.headers.accept, 'application/json')
  }
})

test('submit sends the multipart fields the API expects, and 202/200 mean received/duplicate', async () => {
  const client = new NortiaClient(api.url, VALID_KEY)
  const meta = {
    platform: 'hiredly',
    external_application_id: 'app-77',
    external_job_title: 'Sous Chef',
    external_job_id: 'job-9',
    candidate_name: 'N',
    candidate_email: 'n@example.com',
    candidate_phone: '1',
    applied_at: '2026-10-01T00:00:00.000Z'
  }
  api.setTitleMatch('matched')
  const first = await client.submitResume({ bytes: Buffer.from('%PDF-1.4'), name: 'r.pdf' }, meta)
  const second = await client.submitResume({ bytes: Buffer.from('%PDF-1.4'), name: 'r.pdf' }, meta)
  api.setTitleMatch('no_title_match')
  assert.ok(first.ok && first.data.outcome === 'received' && first.data.titleMatch === 'matched')
  assert.ok(second.ok && second.data.outcome === 'duplicate')
  const sent = api.requests.filter((r) => r.path === '/api/v1/resumes').at(-1)!
  assert.deepEqual(sent.form, meta)
  assert.equal(sent.fileBytes, 8)
})

test('HTTP answers map to the kit status codes', async () => {
  const client = new NortiaClient(api.url, VALID_KEY)
  const cases: [number, string, Record<string, string>?][] = [
    [401, 'api_key_invalid'],
    [403, 'platform_unavailable'],
    [426, 'kit_outdated'],
    [429, 'rate_limited', { 'retry-after': '120' }],
    [500, 'error']
  ]
  for (const [status, code, headers] of cases) {
    api.setOverride(() => ({ status, headers }))
    const res = await client.me()
    assert.ok(!res.ok)
    assert.equal(res.code, code, `HTTP ${status}`)
    if (status === 429) assert.equal(res.retryAfterSeconds, 120)
  }
  api.setOverride(undefined)
})

test('an unreachable API is an error, not a crash', async () => {
  const res = await new NortiaClient('http://127.0.0.1:9', VALID_KEY).me()
  assert.ok(!res.ok && res.code === 'error' && res.detail.startsWith('network_'))
})
