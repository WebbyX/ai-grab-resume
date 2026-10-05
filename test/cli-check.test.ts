import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { after, before, test } from 'node:test'
import { main } from '../src/cli'
import { startFakeApi } from './helpers/fake-api'
import { app, fakeHiredly, job } from './helpers/fake-hiredly'
import { fakeRunner, runCli, VALID_KEY } from './helpers/harness'

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
after(() => api.close())

async function check(opts: { email?: string; password?: string; loginError?: string }) {
  const env: Record<string, string> = { NORTIA_API_URL: api.url, NORTIA_API_KEY: VALID_KEY }
  if (opts.email) env.HIREDLY_EMAIL = opts.email
  if (opts.password) env.HIREDLY_PASSWORD = opts.password
  const h = fakeHiredly({ jobs: [], apps: {}, loginError: opts.loginError })
  const res = await runCli(['check'], { deps: { env, newAdapter: () => h.adapter } })
  return { ...res, json: JSON.parse(res.stdout) }
}

test('CLI check is ok when Nortia answers and no Hiredly email is configured', async () => {
  const res = await check({})
  assert.equal(res.code, 0)
  assert.equal(res.json.status, 'ok')
  assert.equal(res.json.hiredly, 'not_configured')
})

test('CLI check is ok when Nortia answers and Hiredly signs in', async () => {
  const res = await check({ email: 'hr@acme.com', password: 'pw' })
  assert.equal(res.code, 0)
  assert.equal(res.json.status, 'ok')
  assert.equal(res.json.hiredly, 'ok')
})

test('CLI check fails with a hiredly_* status when the email is set but Hiredly is not usable', async () => {
  const cases: [Parameters<typeof check>[0], string, RegExp][] = [
    [{ email: 'hr@acme.com' }, 'hiredly_not_configured', /no Hiredly password is saved/],
    [{ email: 'hr@acme.com', password: 'pw', loginError: 'HIREDLY_LOGIN_REJECTED' }, 'hiredly_login_rejected', /rejected the saved password/],
    [{ email: 'hr@acme.com', password: 'pw', loginError: 'HIREDLY_BLOCKED_THROTTLED: too many' }, 'hiredly_blocked', /blocking sign-ins/],
    [{ email: 'hr@acme.com', password: 'pw', loginError: 'NETWORK_ENOTFOUND: x' }, 'hiredly_error', /could not be reached/]
  ]
  for (const [opts, status, message] of cases) {
    const res = await check(opts)
    assert.equal(res.code, 1, status)
    assert.equal(res.json.status, status)
    assert.match(res.json.message, /^Connected to the Nortia workspace "Acme Sdn Bhd", but /)
    assert.match(res.json.message, message)
    assert.doesNotMatch(res.json.message, /security|cmdkey/)
  }
})

test('the MCP check_connection keeps a Nortia-only status', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let out = ''
  stdout.on('data', (c) => (out += c))
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('a')] } })
  const fake = fakeRunner({ keychain: { nortia_api_key: VALID_KEY } })
  void main(['serve'], { stdin, stdout, stderr: new PassThrough() }, {
    runner: fake.runner,
    platform: 'darwin',
    env: { NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com', HIREDLY_PASSWORD: 'envpw', NORTIA_API_KEY: 'nrt_' + 'z'.repeat(40) },
    newAdapter: () => h.adapter,
    throttle: async () => {},
    now: () => new Date()
  })
  const request = (id: number, method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const onData = () => {
        for (const line of out.split('\n')) {
          if (!line) continue
          const msg = JSON.parse(line)
          if (msg.id === id) {
            stdout.off('data', onData)
            resolve(msg)
          }
        }
      }
      stdout.on('data', onData)
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  api.requests.length = 0
  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const cc = JSON.parse((await request(2, 'tools/call', { name: 'check_connection', arguments: {} })).result.content[0].text)
  assert.equal(cc.status, 'ok')
  assert.equal(cc.hiredly, 'not_configured', 'serve ignores HIREDLY_PASSWORD in env')
  const sync = JSON.parse((await request(3, 'tools/call', { name: 'hiredly_sync', arguments: {} })).result.content[0].text)
  assert.equal(sync.status, 'not_configured')
  assert.equal(h.stats.logins, 0)
  assert.ok(api.requests.every((r) => r.headers.authorization === `Bearer ${VALID_KEY}`), 'serve never uses NORTIA_API_KEY from env')
  assert.ok(!out.includes('envpw') && !out.includes(VALID_KEY))
  stdin.end()
})
