import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { loadConfig } from '../src/config'
import { checkConnection, submitResume, type ToolDeps } from '../src/tools'
import { startFakeApi } from './helpers/fake-api'
import { fakeHiredly } from './helpers/fake-hiredly'
import { VALID_KEY } from './helpers/harness'

let api: Awaited<ReturnType<typeof startFakeApi>>
let workDir: string
let root: string
before(async () => {
  api = await startFakeApi()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-tools-')))
  workDir = join(root, 'inbox')
  const outside = join(root, 'outside')
  mkdirSync(workDir)
  mkdirSync(outside)
  writeFileSync(join(workDir, 'cv.pdf'), '%PDF-1.4 x')
  writeFileSync(join(workDir, 'notes.txt'), 'x')
  writeFileSync(join(outside, 'secret.pdf'), '%PDF-1.4 y')
  symlinkSync(join(outside, 'secret.pdf'), join(workDir, 'link.pdf'))
  symlinkSync(join(workDir, 'notes.txt'), join(workDir, 'fake.pdf'))
  symlinkSync(outside, join(workDir, 'outdir'))
  symlinkSync(workDir, join(root, 'inbox-link'))
  mkdirSync(join(workDir, 'sub'))
  writeFileSync(join(workDir, 'sub', 'cv.PDF'), '%PDF-1.4 z')
  mkdirSync(join(workDir, 'folder.pdf'))
  writeFileSync(join(root, 'inbox-evil.pdf'), '%PDF-1.4 prefix')
  writeFileSync(join(workDir, 'big.pdf'), '')
  truncateSync(join(workDir, 'big.pdf'), 10240 * 1024 + 1)
  writeFileSync(join(workDir, 'limit.pdf'), '')
  truncateSync(join(workDir, 'limit.pdf'), 10240 * 1024)
})
after(async () => {
  await api.close()
  rmSync(root, { recursive: true, force: true })
})

function deps(
  over: { secrets?: Record<string, string>; env?: Record<string, string>; newAdapter?: ToolDeps['newAdapter'] } = {}
): ToolDeps {
  const secrets = over.secrets ?? { nortia_api_key: VALID_KEY }
  return {
    config: loadConfig({ NORTIA_API_URL: api.url, NORTIA_WORK_DIR: workDir, ...(over.env ?? {}) }),
    getSecret: async (account) => secrets[account] ?? null,
    newAdapter: over.newAdapter ?? (() => fakeHiredly({ jobs: [], apps: {} }).adapter),
    log: () => {}
  }
}

const code = (res: object) => (res as { code?: string }).code
const base = { platform: 'hiredly', external_application_id: 'a1', external_job_title: 'Chef' }

test('submit_resume refuses files outside the work folder without calling Nortia', async () => {
  const before = api.requests.length
  for (const file_path of ['/etc/hosts', '../outside/secret.pdf', join(workDir, '..', 'outside', 'secret.pdf'), 'link.pdf']) {
    const res = await submitResume(deps(), { ...base, file_path })
    assert.equal(res.status, 'error')
    assert.equal(code(res), 'path_outside_work_dir', file_path)
  }
  assert.equal(api.requests.length, before)
})

test('submit_resume requires external_job_title and sends nothing without it', async () => {
  const before = api.requests.length
  for (const external_job_title of [undefined, '', '   ']) {
    const res = await submitResume(deps(), { ...base, external_job_title, file_path: 'cv.pdf' })
    assert.equal(code(res), 'missing_external_job_title')
  }
  assert.equal(api.requests.length, before)
})

test('submit_resume refuses other file types, missing files and folders', async () => {
  assert.equal(code(await submitResume(deps(), { ...base, file_path: 'notes.txt' })), 'unsupported_file_type')
  assert.equal(code(await submitResume(deps(), { ...base, file_path: 'fake.pdf' })), 'unsupported_file_type')
  assert.equal(code(await submitResume(deps(), { ...base, file_path: 'nope.pdf' })), 'file_not_found')
  assert.equal(code(await submitResume(deps(), { ...base, file_path: 'folder.pdf' })), 'file_not_found')
})

test('submit_resume resolves the work folder and paths through symlinks before comparing', async () => {
  const viaLink = (wd: string) => ({ ...deps(), config: loadConfig({ NORTIA_API_URL: api.url, NORTIA_WORK_DIR: wd }) })
  const cases: [string, string, string][] = [
    [join(root, 'inbox-link'), 'sub/cv.PDF', 'ok'],
    [join(root, 'inbox-link'), 'outdir/secret.pdf', 'path_outside_work_dir'],
    [workDir, '../inbox-evil.pdf', 'path_outside_work_dir'],
    [workDir, join(root, 'inbox-evil.pdf'), 'path_outside_work_dir'],
    [workDir, '', 'path_outside_work_dir'],
    [workDir, '.', 'path_outside_work_dir'],
    [join(root, 'missing'), 'cv.pdf', 'path_outside_work_dir']
  ]
  for (const [wd, file_path, want] of cases) {
    const res = await submitResume(viaLink(wd), { ...base, external_application_id: `link-${file_path}`, file_path })
    if (want === 'ok') assert.equal(res.status, 'ok', file_path)
    else assert.equal(code(res), want, `${wd} ${file_path}`)
  }
})

test('submit_resume refuses files over 10 MB before reading them', async () => {
  const before = api.requests.length
  assert.equal(code(await submitResume(deps(), { ...base, file_path: 'big.pdf' })), 'file_too_large')
  assert.equal(api.requests.length, before)
  const atLimit = await submitResume(deps(), { ...base, external_application_id: 'limit', file_path: 'limit.pdf' })
  assert.equal(atLimit.status, 'ok')
})

test('submit_resume sends a file from the work folder', async () => {
  const res = await submitResume(deps(), { ...base, external_application_id: 'tool-1', file_path: 'cv.pdf' })
  assert.equal(res.status, 'ok')
  assert.equal((res as { outcome?: string }).outcome, 'received')
  assert.equal(api.requests.at(-1)!.form?.external_job_title, 'Chef')
})

test('check_connection without a Nortia key is not_configured and makes no request', async () => {
  const before = api.requests.length
  const res = await checkConnection(deps({ secrets: {} }))
  assert.equal(res.status, 'not_configured')
  assert.equal(api.requests.length, before)
})

test('check_connection reports the workspace and the Hiredly sign-in', async () => {
  const withHiredly = { env: { HIREDLY_EMAIL: 'hr@acme.com' }, secrets: { nortia_api_key: VALID_KEY, hiredly_password: 'pw' } }
  const ok = await checkConnection(deps(withHiredly))
  assert.equal(ok.status, 'ok')
  assert.equal((ok as { hiredly?: string }).hiredly, 'ok')
  assert.equal((ok as { workspace?: string }).workspace, 'Acme Sdn Bhd')

  const rejected = await checkConnection(
    deps({ ...withHiredly, newAdapter: () => fakeHiredly({ jobs: [], apps: {}, loginError: 'HIREDLY_LOGIN_REJECTED' }).adapter })
  )
  assert.equal(rejected.status, 'ok')
  assert.equal((rejected as { hiredly?: string }).hiredly, 'login_rejected')
  assert.match(rejected.message, /Hiredly rejected the saved password/)

  const noEmail = await checkConnection(deps())
  assert.equal((noEmail as { hiredly?: string }).hiredly, 'not_configured')
})

test('check_connection maps a 426 to kit_outdated with the update sentence', async () => {
  api.setOverride(() => ({ status: 426 }))
  const res = await checkConnection(deps())
  api.setOverride(undefined)
  assert.equal(res.status, 'kit_outdated')
  assert.equal(
    res.message,
    'This Nortia connector is out of date. Open Nortia → AI Grab Resume → Connect and copy the update instructions into Claude.'
  )
})

test('check_connection adds the update hint when a newer kit exists', async () => {
  const newer = await startFakeApi({ latest: '9.9.9' })
  const res = await checkConnection({ ...deps(), config: loadConfig({ NORTIA_API_URL: newer.url }) })
  await newer.close()
  assert.equal((res as { update_available?: boolean }).update_available, true)
  assert.ok(res.message.endsWith('A newer Nortia connector is available — see Nortia → AI Grab Resume → Connect.'))
})
