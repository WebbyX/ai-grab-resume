import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, test } from 'node:test'
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from '../src/server'
import { startFakeApi } from './helpers/fake-api'
import { ROOT, spawnKit, startServe, VALID_KEY } from './helpers/harness'

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
after(() => api.close())

test('tool descriptions and messages never mention the keychain tools', () => {
  for (const text of Object.values(TOOL_DESCRIPTIONS)) assert.doesNotMatch(text, /security|cmdkey/i)
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/messages.ts'), 'utf8'), /security|cmdkey/)
  assert.match(TOOL_DESCRIPTIONS.hiredly_sync, /done: true/)
  assert.match(SERVER_INSTRUCTIONS, /disconnect/)
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /security|cmdkey/i)
})

/** A throwaway HOME for spawned servers, so a disconnect tool call can never reach the real one. */
function tmpHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-serve-')))
  assert.ok(!homedir().startsWith(root))
  return root
}

function treeHash(dir: string): string {
  const lines: string[] = []
  const walk = (path: string) => {
    const info = lstatSync(path)
    lines.push(`${relative(dir, path)} ${info.mode} ${info.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''}`)
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(dir)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

for (const entry of ['src', 'dist'] as const) {
  const skip = entry === 'dist' && !existsSync(join(ROOT, 'dist/cli.js')) ? 'dist/cli.js not built' : false

  test(`${entry}: serve lists four tools and ignores secrets in env; stdout is protocol only`, { skip }, async () => {
    api.requests.length = 0
    const home = tmpHome()
    const env = { HOME: home, NORTIA_API_URL: api.url, NORTIA_API_KEY: VALID_KEY, HIREDLY_PASSWORD: 'pw', FAKE_KEYCHAIN: '{}' }
    const server = startServe(entry, env)
    try {
      const init = await server.init()
      assert.equal(init.result.instructions, SERVER_INSTRUCTIONS)
      const list = await server.request('tools/list')
      const tools = list.result.tools as { name: string; description: string; annotations?: Record<string, boolean> }[]
      assert.deepEqual(tools.map((t) => t.name).sort(), ['check_connection', 'disconnect', 'hiredly_sync', 'submit_resume'])
      assert.match(tools.find((t) => t.name === 'hiredly_sync')!.description, /done: true/)
      const disconnect = tools.find((t) => t.name === 'disconnect')!
      assert.equal(disconnect.annotations?.destructiveHint, true)
      assert.equal(disconnect.annotations?.openWorldHint, true)

      const call = await server.request('tools/call', { name: 'check_connection', arguments: {} })
      const result = JSON.parse(call.result.content[0].text)
      assert.equal(result.status, 'not_configured')
      assert.equal(api.requests.length, 0, 'serve must not use NORTIA_API_KEY from env')

      const sync = await server.request('tools/call', { name: 'hiredly_sync', arguments: {} })
      const syncResult = JSON.parse(sync.result.content[0].text)
      assert.equal(syncResult.status, 'not_configured')
      assert.equal(syncResult.done, true)
    } finally {
      await server.stop()
      rmSync(home, { recursive: true, force: true })
    }
    assert.ok(server.stdoutLines.length >= 4)
    for (const line of server.stdoutLines.filter((l) => l.length > 0)) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0', `non-protocol stdout: ${line}`)
    }
    assert.ok(!server.stderr.includes(VALID_KEY))
  })

  test(`${entry}: the disconnect preview from serve reads the spawned HOME only and changes nothing`, { skip }, async (t) => {
    api.requests.length = 0
    const home = tmpHome()
    t.after(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.nortia', 'inbox'), { recursive: true })
    mkdirSync(join(home, '.claude', 'scheduled-tasks', 'nortia-hiredly'), { recursive: true })
    writeFileSync(join(home, '.claude', 'scheduled-tasks', 'nortia-hiredly', 'SKILL.md'), 'Run the nortia hiredly_sync tool.')
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__nortia__hiredly_sync'] } }, null, 2))
    const before = treeHash(home)
    const server = startServe(entry, {
      HOME: home,
      NORTIA_API_URL: api.url,
      FAKE_KEYCHAIN: JSON.stringify({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })
    })
    try {
      await server.init()
      const call = await server.request('tools/call', { name: 'disconnect', arguments: {} })
      const result = JSON.parse(call.result.content[0].text)
      assert.equal(result.status, 'preview')
      assert.ok(result.will_remove.includes('The folder ~/.nortia'), JSON.stringify(result.will_remove))
      assert.ok(result.will_remove.includes('1 Nortia permission rule in ~/.claude/settings.json'))
      assert.ok(!JSON.stringify(result).includes(VALID_KEY))
    } finally {
      await server.stop()
    }
    assert.equal(treeHash(home), before)
    assert.equal(api.requests.length, 0)
    for (const line of server.stdoutLines.filter((l) => l.length > 0)) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0', `non-protocol stdout: ${line}`)
    }
  })

  test(`${entry}: the check CLI may use the env key`, { skip }, async () => {
    api.requests.length = 0
    const res = await spawnKit(entry, ['check'], { NORTIA_API_URL: api.url, NORTIA_API_KEY: VALID_KEY, FAKE_KEYCHAIN: '{}' })
    assert.equal(res.code, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.status, 'ok')
    assert.equal(out.workspace, 'Acme Sdn Bhd')
    assert.equal(api.count('/api/v1/me'), 1)
    assert.ok(!(res.stdout + res.stderr).includes(VALID_KEY))
  })
}

test('an unknown command prints usage to stderr and exits 2', async () => {
  const res = await spawnKit('src', ['nope'], {})
  assert.equal(res.code, 2)
  assert.equal(res.stdout, '')
  assert.match(res.stderr, /^usage: nortia-ai-grab/)
})
