import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getSecret, setSecret } from '../src/secrets'
import { fakeRunner, ROOT, runCli, spawnKit, VALID_KEY } from './helpers/harness'

const OSASCRIPT = '/usr/bin/osascript'

test('--stdin saves a well-formed key and prints only the ok line', async () => {
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'nortia_api_key', '--stdin'], { deps: { runner: fake.runner }, stdin: VALID_KEY + '\n' })
  assert.equal(res.code, 0)
  assert.equal(res.stdout, '{"status":"ok","account":"nortia_api_key"}\n')
  assert.equal(res.stderr, '')
  assert.equal(fake.keychain.nortia_api_key, VALID_KEY)
  assert.deepEqual(fake.calls[0].args, ['-i'])
  assert.ok(fake.calls[0].input!.startsWith('add-generic-password -U -s nortia-ai-grab -a nortia_api_key -w "'))
  assert.ok(fake.calls.every((c) => !c.args.join(' ').includes(VALID_KEY)), 'the value is never in argv')
})

test('awkward passwords survive the stdin quoting and read back unchanged', async () => {
  for (const value of [
    'a b"c\\d',
    '$(id) `id` ; rm -rf ~',
    'pässwörd 中文 ✓',
    '\\"\\"',
    "it's",
    '#lead',
    'a#b',
    'abc\\',
    '🔑 key',
    'x'.repeat(512)
  ]) {
    const fake = fakeRunner()
    const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: value })
    assert.equal(res.code, 0, value)
    assert.equal(fake.keychain.hiredly_password, value)
    const read = await getSecret('hiredly_password', { allowEnv: false }, { runner: fake.runner, platform: 'darwin', env: {} })
    assert.equal(read, value)
  }
})

test('a value over 512 bytes is refused before the keychain tool runs', async () => {
  for (const value of ['a'.repeat(513), '中'.repeat(171), 'a'.repeat(4000)]) {
    const fake = fakeRunner()
    const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: value })
    assert.equal(res.code, 2)
    assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'invalid_value' })
    assert.equal(fake.calls.length, 0)
  }
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: '中'.repeat(170) })
  assert.equal(res.code, 0)
})

test('control characters are refused before the keychain tool runs', async () => {
  for (const value of ['a\u0000b', 'a\tb', 'a\u001bb', 'a\u007fb', 'a\rb']) {
    const fake = fakeRunner()
    const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: value })
    assert.equal(res.code, 2, JSON.stringify(value))
    assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'invalid_value' })
    assert.equal(fake.calls.length, 0)
  }
})

test('reading the value back catches a write that silently did nothing', async () => {
  for (const fake of [fakeRunner({ silentNoop: true }), fakeRunner({ silentNoop: true, keychain: { hiredly_password: 'old' } })]) {
    const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: 'new-pw' })
    assert.equal(res.code, 1)
    assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'keychain_write_failed' })
    assert.ok(!(res.stdout + res.stderr).includes('new-pw'))
  }
})

test('the test-only keychain path is quoted in the -i command', async () => {
  const fake = fakeRunner()
  const path = '/tmp/a "b"\\c.keychain-db'
  await setSecret('hiredly_password', 'pw', { runner: fake.runner, platform: 'darwin', env: {}, keychain: path })
  const quote = (s: string) => '"' + s.replace(/[\\"]/g, (c) => '\\' + c) + '"'
  assert.ok(fake.calls[0].input!.endsWith(' ' + quote(path) + '\n'))
})

test('a value with a line break inside is refused', async () => {
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: 'one\ntwo' })
  assert.equal(res.code, 2)
  assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'invalid_value' })
  assert.equal(fake.calls.length, 0)
})

test('an account outside the allow list is refused before anything runs', async () => {
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'aws_key', '--stdin'], { deps: { runner: fake.runner }, stdin: 'x' })
  assert.equal(res.code, 2)
  assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'unknown_account' })
  assert.equal(fake.calls.length, 0)
})

test('a malformed Nortia key is refused and never echoed', async () => {
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'nortia_api_key', '--stdin'], { deps: { runner: fake.runner }, stdin: 'nrt_short' })
  assert.equal(res.code, 2)
  assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'invalid_key' })
  assert.ok(!(res.stdout + res.stderr).includes('nrt_short'))
  assert.equal(fake.calls.length, 0)
})

test('an empty value is refused', async () => {
  const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { stdin: '\n' })
  assert.equal(res.code, 1)
  assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'empty' })
})

test('the password dialog gets the email as an argv item, never inside the script', async () => {
  const email = 'hr"; do shell script "touch /tmp/x@acme.com.my'
  const fake = fakeRunner({ dialog: { code: 0, stdout: 'S3cret-pw\n' } })
  const bad = await runCli(['set-secret', 'hiredly_password', '--for', email], { deps: { runner: fake.runner } })
  assert.equal(bad.code, 2, 'a value that is not an email is refused')

  const quoted = 'o"neil@acme.com.my'
  const res = await runCli(['set-secret', 'hiredly_password', '--for', quoted], { deps: { runner: fake.runner } })
  assert.equal(res.code, 0)
  assert.equal(res.stdout, '{"status":"ok","account":"hiredly_password"}\n')
  const dialog = fake.calls.find((c) => c.file === OSASCRIPT)!
  const script = dialog.args.filter((_, i) => dialog.args[i - 1] === '-e').join('\n')
  assert.ok(!script.includes('acme.com.my'))
  assert.equal(
    dialog.args.at(-1),
    `Enter the Hiredly password for ${quoted}. It is saved to your Mac keychain and never shown to the AI.`
  )
  assert.ok(!dialog.args.at(-1)!.includes('hiredly_password'))
  assert.equal(fake.keychain.hiredly_password, 'S3cret-pw')
  assert.ok(!(res.stdout + res.stderr).includes('S3cret-pw'))
})

test('without --for the dialog asks plainly', async () => {
  const fake = fakeRunner({ dialog: { code: 0, stdout: 'pw\n' } })
  await runCli(['set-secret', 'hiredly_password'], { deps: { runner: fake.runner } })
  assert.equal(fake.calls.find((c) => c.file === OSASCRIPT)!.args.at(-1), 'Enter your Hiredly password.')
})

test('Cancel saves nothing', async () => {
  const fake = fakeRunner({ dialog: { code: 1, stderr: 'execution error: User canceled. (-128)' } })
  const res = await runCli(['set-secret', 'hiredly_password'], { deps: { runner: fake.runner } })
  assert.equal(res.code, 1)
  assert.equal(res.stdout, '{"status":"cancelled"}\n')
  assert.equal(fake.calls.filter((c) => c.args[0] === 'add-generic-password').length, 0)
})

test('a failed keychain write reports a code, not the value', async () => {
  const fake = fakeRunner({ writeFails: true })
  const res = await runCli(['set-secret', 'nortia_api_key', '--stdin'], { deps: { runner: fake.runner }, stdin: VALID_KEY })
  assert.equal(res.code, 1)
  assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'keychain_write_failed' })
  assert.ok(!(res.stdout + res.stderr).includes('nrt_'))
})

test('Windows is not supported yet', async () => {
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'nortia_api_key', '--stdin'], { deps: { runner: fake.runner, platform: 'win32' }, stdin: VALID_KEY })
  assert.equal(res.code, 1)
  assert.deepEqual(JSON.parse(res.stdout), { status: 'error', code: 'not_supported_yet' })
  assert.equal(fake.calls.length, 0)
})

for (const entry of ['src', 'dist'] as const) {
  const skip = entry === 'dist' && !existsSync(join(ROOT, 'dist/cli.js')) ? 'dist/cli.js not built' : false
  test(`${entry}: piping a key into set-secret leaks it nowhere`, { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-'))
    try {
      const log = join(dir, 'exec.log')
      const res = await spawnKit(entry, ['set-secret', 'nortia_api_key', '--stdin'], { FAKE_EXEC_LOG: log }, VALID_KEY + '\n')
      assert.equal(res.code, 0, res.stderr)
      assert.equal(res.stdout, '{"status":"ok","account":"nortia_api_key"}\n')
      assert.equal((res.stdout + res.stderr).split('nrt_').length - 1, 0)
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.ok(calls.some((c) => c.input.includes(VALID_KEY)), 'the value reached the (fake) keychain via stdin')
      assert.ok(calls.every((c) => !c.args.join(' ').includes(VALID_KEY)), 'the value is never in argv')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
