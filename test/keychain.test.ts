import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execRunner, getSecret, setSecret, type SecretDeps } from '../src/secrets'

const skip =
  process.env.KIT_KEYCHAIN_TEST !== '1' || process.platform !== 'darwin'
    ? 'opt-in: KIT_KEYCHAIN_TEST=1 on macOS (uses a throwaway keychain file, never the login keychain)'
    : false

const ACCOUNTS = ['nortia_api_key', 'hiredly_password']

function loginSnapshot() {
  return ACCOUNTS.map((account) => {
    try {
      const stdout = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'nortia-ai-grab', '-a', account, join(homedir(), 'Library/Keychains/login.keychain-db')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      return { code: 0, stdout }
    } catch (err) {
      return { code: (err as { status?: number }).status ?? 1, stdout: String((err as { stdout?: string }).stdout ?? '') }
    }
  })
}

test('real /usr/bin/security round-trip on a throwaway keychain', { skip }, async () => {
  const before = loginSnapshot()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit keychain ')))
  const keychain = join(dir, 't.keychain-db')
  execFileSync('/usr/bin/security', ['create-keychain', '-p', 'throwaway', keychain])
  assert.ok(existsSync(keychain))
  try {
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'throwaway', keychain])
    const deps: SecretDeps = { runner: execRunner, platform: 'darwin', env: {}, keychain }
    const values = [
      'a b"c\\d',
      '$(id)',
      'pässwörd 中文',
      '\\"\\"',
      'deadbeef',
      ' lead and trail ',
      "it's `id`",
      '#lead',
      'abc\\',
      '🔑',
      'x'.repeat(512)
    ]
    for (const value of values) {
      assert.equal(await setSecret('hiredly_password', value, deps), 'ok', value)
      assert.equal(await getSecret('hiredly_password', { allowEnv: false }, deps), value)
    }
    assert.equal(await setSecret('hiredly_password', 'a\nb', deps), 'invalid_value')
    assert.equal(await setSecret('hiredly_password', 'x'.repeat(513), deps), 'invalid_value')
    const where = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'nortia-ai-grab', '-a', 'hiredly_password', keychain], { encoding: 'utf8' })
    assert.ok(where.includes(`keychain: "${keychain}"`))
    assert.deepEqual(loginSnapshot(), before, 'nothing was written to the login keychain')
  } finally {
    execFileSync('/usr/bin/security', ['delete-keychain', keychain])
    rmSync(dir, { recursive: true, force: true })
  }
})
