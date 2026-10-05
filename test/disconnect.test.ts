import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, test } from 'node:test'
import { inspectDisconnect, runDisconnect, type DisconnectDeps } from '../src/disconnect'
import { DISCONNECT_CONFIRM_TEXT, statusMessage } from '../src/messages'
import { startFakeApi } from './helpers/fake-api'
import { fakeRunner, VALID_KEY } from './helpers/harness'

const OSASCRIPT = '/usr/bin/osascript'
const SECURITY = '/usr/bin/security'
const PREFIX = VALID_KEY.slice(0, 12)
const FULL_KEY = /nrt_[A-Za-z0-9]{40}/
const CONFIRMED = { code: 0, stdout: 'Disconnect\n' }
const SCHEDULE_PROMPT = 'Run the nortia hiredly_sync tool again and again until it returns done: true, then tell me its message.'
const STEP0 = ['echo', 'net_check', 'keychain_check', 'fake_sync', 'sleep'].map((t) => `mcp__nortia-step0__${t}`)
const NORTIA_RULES = ['mcp__nortia__hiredly_sync', 'mcp__nortia__check_connection', 'mcp__nortia__disconnect', 'mcp__nortia']
const KEPT_RULES = [...STEP0, 'mcp__nortiax', 'mcp__nortiax__tool', 'Bash(npm test)']
const SETTINGS = {
  model: 'opus',
  permissions: {
    allow: [STEP0[0], ...NORTIA_RULES.slice(0, 2), ...STEP0.slice(1), 'mcp__nortiax', 'mcp__nortiax__tool', ...NORTIA_RULES.slice(2), 'Bash(npm test)'],
    deny: ['mcp__nortia__submit_resume']
  },
  env: { A: '1' }
}
const LOCAL_SETTINGS = { permissions: { allow: ['mcp__nortia__hiredly_sync', 'Read(/x)'] } }

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
after(() => api.close())

/** A throwaway home holding everything an install leaves behind; never the real one. */
function makeHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-disconnect-')))
  const home = join(root, 'home')
  const claudeDir = join(home, '.claude')
  assert.ok(!homedir().startsWith(root) && !root.startsWith(join(homedir(), '.claude')), `unsafe test home ${root}`)
  mkdirSync(join(home, '.nortia', 'inbox'), { recursive: true })
  writeFileSync(join(home, '.nortia', 'inbox', 'r.pdf'), '%PDF-1.4')
  const task = join(claudeDir, 'scheduled-tasks', 'nortia-hiredly')
  mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'SKILL.md'), `---\nname: nortia-hiredly\n---\n\n${SCHEDULE_PROMPT}\n`)
  mkdirSync(join(claudeDir, 'scheduled-tasks', 'other'))
  writeFileSync(join(claudeDir, 'scheduled-tasks', 'other', 'SKILL.md'), 'Something else.\n')
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(SETTINGS, null, 4) + '\n')
  writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify(LOCAL_SETTINGS, null, 2))
  return { root, home, claudeDir, task, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function treeHash(dir: string): string {
  const lines: string[] = []
  const walk = (path: string) => {
    const info = lstatSync(path)
    const rel = relative(dir, path)
    if (info.isSymbolicLink()) lines.push(`l ${rel} -> ${readlinkSync(path)}`)
    else if (info.isDirectory()) {
      lines.push(`d ${rel} ${info.mode}`)
      for (const name of readdirSync(path).sort()) walk(join(path, name))
    } else lines.push(`f ${rel} ${info.mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
  }
  walk(dir)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

const keychain = () => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })

function depsFor(home: ReturnType<typeof makeHome>, runner: DisconnectDeps['runner'], over: Partial<DisconnectDeps> = {}): DisconnectDeps {
  return { runner, platform: 'darwin', env: {}, apiUrl: api.url, home: home.home, claudeDir: home.claudeDir, ...over }
}

function disconnected(out: Awaited<ReturnType<typeof runDisconnect>>) {
  assert.equal(out.status, 'disconnected')
  return out as Extract<typeof out, { status: 'disconnected' }>
}

const allowOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')).permissions.allow as string[]

test('the preview reads only: no API call, no keychain change, no file change', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: keychain() })
    const before = treeHash(t.root)
    api.requests.length = 0
    const out = await inspectDisconnect(depsFor(t, fake.runner))
    assert.equal(treeHash(t.root), before)
    assert.equal(api.requests.length, 0)
    assert.ok(fake.calls.length > 0 && fake.calls.every((c) => c.file === SECURITY && c.args[0] === 'find-generic-password'))
    assert.deepEqual(fake.keychain, keychain())

    assert.equal(out.status, 'preview')
    assert.deepEqual(out.will_remove, [
      `The Nortia key saved on this Mac (${PREFIX}…); Nortia stops accepting it`,
      'The Hiredly password saved on this Mac',
      'The folder ~/.nortia',
      'The daily task nortia-hiredly in Claude Desktop',
      '4 Nortia permission rules in ~/.claude/settings.json',
      '1 Nortia permission rule in ~/.claude/settings.local.json',
      'The nortia connector registered in Claude'
    ])
    for (const part of [
      'AskUserQuestion',
      '"Disconnect Nortia from this Mac?"',
      '"Yes, disconnect this Mac"',
      '"Pause the daily run instead"',
      '"No, keep it"',
      'confirm: true',
      'update_scheduled_task with taskId nortia-hiredly and enabled false',
      'Resume Nortia',
      '"Nothing was changed."'
    ]) {
      assert.ok(out.message.includes(part), `missing: ${part}`)
    }
    assert.doesNotMatch(JSON.stringify(out), FULL_KEY)
  } finally {
    t.cleanup()
  }
})

test('Cancel, a timed-out box or a box that cannot open changes nothing', async () => {
  const cases: [NonNullable<Parameters<typeof fakeRunner>[0]>['dialog'], string][] = [
    [{ code: 1, stderr: 'execution error: User canceled. (-128)' }, 'cancelled'],
    [{ code: 0, stdout: 'gave up\n' }, 'cancelled'],
    [{ code: 1, stderr: 'execution error: Not authorized to send Apple events. (-1743)' }, 'confirm_unavailable'],
    [{ code: 0, stdout: 'Cancel\n' }, 'confirm_unavailable'],
    [undefined, 'confirm_unavailable']
  ]
  for (const [dialog, status] of cases) {
    const t = makeHome()
    try {
      const fake = fakeRunner({ keychain: keychain(), ...(dialog ? { dialog } : {}) })
      const before = treeHash(t.root)
      api.requests.length = 0
      const out = await runDisconnect(depsFor(t, fake.runner))
      assert.equal(out.status, status, JSON.stringify(dialog))
      assert.equal(treeHash(t.root), before)
      assert.equal(api.requests.length, 0)
      assert.deepEqual(fake.keychain, keychain())
      assert.deepEqual(fake.calls.map((c) => c.file), [OSASCRIPT], 'nothing but the box runs')
      assert.ok(out.message.includes('nothing was changed') || out.message.includes('Nothing was changed'))
    } finally {
      t.cleanup()
    }
  }
})

test('Disconnect revokes the key with the key itself, then clears this Mac', async () => {
  const t = makeHome()
  const custom = join(t.root, 'custom-inbox')
  mkdirSync(custom)
  writeFileSync(join(custom, 'keep.pdf'), '%PDF')
  try {
    const fake = fakeRunner({ keychain: keychain(), dialog: CONFIRMED })
    api.requests.length = 0
    const out = disconnected(await runDisconnect(depsFor(t, fake.runner, { env: { NORTIA_WORK_DIR: custom } })))
    assert.ok(existsSync(join(custom, 'keep.pdf')), 'a custom work folder is never deleted')

    const dialog = fake.calls[0]
    assert.equal(dialog.file, OSASCRIPT, 'the box comes before anything else')
    assert.equal(dialog.args.at(-1), DISCONNECT_CONFIRM_TEXT)
    const script = dialog.args.filter((_, i) => dialog.args[i - 1] === '-e').join('\n')
    assert.ok(script.includes('buttons {"Cancel", "Disconnect"} default button "Cancel"'))
    assert.ok(script.includes('giving up after 120'))
    assert.ok(!script.includes('Nortia from this Mac'), 'the text travels as argv, not inside the script')

    assert.equal(api.requests.length, 1)
    assert.equal(api.requests[0].method, 'POST')
    assert.equal(api.requests[0].path, '/api/v1/disconnect')
    assert.equal(api.requests[0].headers.authorization, `Bearer ${VALID_KEY}`)

    assert.equal(out.status, 'disconnected')
    assert.equal(out.nortia, 'revoked')
    assert.equal(out.key_prefix, PREFIX)
    assert.deepEqual(out.issues, [])
    assert.deepEqual(out.removed, [
      'keychain:nortia_api_key',
      'keychain:hiredly_password',
      '~/.nortia',
      '~/.claude/scheduled-tasks/nortia-hiredly'
    ])
    assert.deepEqual([...out.removed_rules].sort(), [...NORTIA_RULES, 'mcp__nortia__hiredly_sync'].sort())
    assert.deepEqual(fake.keychain, {})
    assert.ok(!existsSync(join(t.home, '.nortia')))
    assert.ok(!existsSync(t.task))
    assert.ok(existsSync(join(t.claudeDir, 'scheduled-tasks', 'other', 'SKILL.md')))

    const settings = readFileSync(join(t.claudeDir, 'settings.json'), 'utf8')
    assert.deepEqual(JSON.parse(settings), {
      ...SETTINGS,
      permissions: { ...SETTINGS.permissions, allow: [STEP0[0], ...STEP0.slice(1), 'mcp__nortiax', 'mcp__nortiax__tool', 'Bash(npm test)'] }
    })
    assert.deepEqual(allowOf(join(t.claudeDir, 'settings.json')).sort(), [...KEPT_RULES].sort())
    assert.ok(settings.includes('\n    "model"') && settings.endsWith('}\n'), 'four-space indent and the final newline stay')
    const local = readFileSync(join(t.claudeDir, 'settings.local.json'), 'utf8')
    assert.equal(local, JSON.stringify({ permissions: { allow: ['Read(/x)'] } }, null, 2))
    assert.deepEqual(
      readdirSync(t.claudeDir).filter((f) => f.endsWith('.tmp')),
      [],
      'no temporary file is left behind'
    )

    const steps = out.next_steps.join('\n')
    for (const part of [
      'list_scheduled_tasks',
      'delete_scheduled_task with taskId nortia-hiredly',
      'claude mcp remove nortia --scope user',
      '"Nortia disconnected from this Mac."',
      '"Still to do:"',
      '"You can now delete the Nortia setup conversations in Claude."',
      'Do not call disconnect again.'
    ]) {
      assert.ok(steps.includes(part), `missing: ${part}`)
    }
    assert.ok(!steps.includes('Edit '), 'no settings file is left for Claude to edit')
    assert.doesNotMatch(JSON.stringify(out), FULL_KEY)
  } finally {
    t.cleanup()
  }
})

test('a key Nortia already revoked still clears this Mac', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: keychain(), dialog: CONFIRMED })
    api.setOverride((r) => (r.path === '/api/v1/disconnect' ? { status: 401, body: { status: false, message: 'Unauthenticated.' } } : undefined))
    const out = disconnected(await runDisconnect(depsFor(t, fake.runner)))
    assert.equal(out.nortia, 'already_revoked')
    assert.deepEqual(out.issues, [])
    assert.deepEqual(fake.keychain, {})
    assert.ok(!existsSync(join(t.home, '.nortia')))
  } finally {
    api.setOverride(undefined)
    t.cleanup()
  }
})

test('when Nortia cannot be reached, this Mac is still cleared and the key prefix is listed for an admin', async () => {
  const failures: [string, Parameters<typeof api.setOverride>[0], string?][] = [
    ['500', () => ({ status: 500 })],
    ['404', () => ({ status: 404 })],
    ['429', () => ({ status: 429 })],
    ['dropped', () => ({ status: 0, destroy: true })],
    ['no server', undefined, 'http://127.0.0.1:9']
  ]
  for (const [name, override, url] of failures) {
    const t = makeHome()
    try {
      const fake = fakeRunner({ keychain: keychain(), dialog: CONFIRMED })
      api.setOverride(override)
      const out = disconnected(await runDisconnect(depsFor(t, fake.runner, url ? { apiUrl: url } : {})))
      assert.equal(out.nortia, 'unreachable', name)
      assert.equal(out.issues.length, 1)
      assert.ok(out.issues[0].includes(`${PREFIX}…`) && out.issues[0].includes('Nortia → AI Grab Resume → Keys'), out.issues[0])
      assert.deepEqual(fake.keychain, {})
      assert.ok(!existsSync(join(t.home, '.nortia')))
      assert.ok(!existsSync(t.task))
      assert.doesNotMatch(JSON.stringify(out), FULL_KEY)
    } finally {
      api.setOverride(undefined)
      t.cleanup()
    }
  }
})

test('with no saved key Nortia is not called, and the rest is still cleared', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: { hiredly_password: 'pw' }, dialog: CONFIRMED })
    api.requests.length = 0
    const out = disconnected(await runDisconnect(depsFor(t, fake.runner)))
    assert.equal(out.nortia, 'no_key')
    assert.equal(out.key_prefix, null)
    assert.equal(api.requests.length, 0)
    assert.equal(out.issues.length, 1)
    assert.match(out.issues[0], /No Nortia key was saved/)
    assert.deepEqual(out.removed.slice(0, 1), ['keychain:hiredly_password'])
    assert.deepEqual(fake.keychain, {})
  } finally {
    t.cleanup()
  }
})

test('without a Nortia address the key is listed for an admin to revoke', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: keychain(), dialog: CONFIRMED })
    api.requests.length = 0
    const out = disconnected(await runDisconnect(depsFor(t, fake.runner, { apiUrl: null })))
    assert.equal(out.nortia, 'not_configured')
    assert.equal(api.requests.length, 0)
    assert.ok(out.issues[0].includes(`${PREFIX}…`))
    assert.deepEqual(fake.keychain, {})
  } finally {
    t.cleanup()
  }
})

test('every copy of a keychain item is deleted', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: keychain(), copies: { nortia_api_key: 1, hiredly_password: 2 }, dialog: CONFIRMED })
    const out = disconnected(await runDisconnect(depsFor(t, fake.runner)))
    assert.deepEqual(fake.keychain, {})
    assert.deepEqual(out.issues, [])
    const deletes = (account: string) => fake.calls.filter((c) => c.args[0] === 'delete-generic-password' && c.args.includes(account)).length
    assert.equal(deletes('nortia_api_key'), 3)
    assert.equal(deletes('hiredly_password'), 4)
  } finally {
    t.cleanup()
  }
})

test('a keychain item that will not delete is reported, and the rest still runs', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: keychain(), deleteFails: true, dialog: CONFIRMED })
    const out = disconnected(await runDisconnect(depsFor(t, fake.runner)))
    assert.equal(out.nortia, 'revoked')
    assert.deepEqual(out.issues, [
      'Remove the saved Nortia key: open Keychain Access, search for nortia-ai-grab and delete it.',
      'Remove the saved Hiredly password: open Keychain Access, search for nortia-ai-grab and delete it.'
    ])
    assert.ok(!existsSync(join(t.home, '.nortia')))
    assert.deepEqual(allowOf(join(t.claudeDir, 'settings.json')).sort(), [...KEPT_RULES].sort())
  } finally {
    t.cleanup()
  }
})

test('a symlinked ~/.nortia loses only the link', async () => {
  const t = makeHome()
  try {
    const real = join(t.root, 'elsewhere')
    mkdirSync(real)
    writeFileSync(join(real, 'keep.txt'), 'keep')
    rmSync(join(t.home, '.nortia'), { recursive: true })
    symlinkSync(real, join(t.home, '.nortia'))
    const out = disconnected(await runDisconnect(depsFor(t, fakeRunner({ keychain: keychain(), dialog: CONFIRMED }).runner)))
    assert.ok(out.removed.includes('~/.nortia'))
    assert.ok(!existsSync(join(t.home, '.nortia')) && !lstatSafe(join(t.home, '.nortia')))
    assert.equal(readFileSync(join(real, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    t.cleanup()
  }
})

test('a nortia-hiredly task folder that is not the Nortia one is left alone', async () => {
  for (const variant of ['other content', 'symlinked folder'] as const) {
    const t = makeHome()
    try {
      if (variant === 'other content') {
        writeFileSync(join(t.task, 'SKILL.md'), 'A task the user wrote themselves.\n')
      } else {
        const real = join(t.root, 'real-task')
        mkdirSync(real)
        writeFileSync(join(real, 'SKILL.md'), SCHEDULE_PROMPT)
        rmSync(t.task, { recursive: true })
        symlinkSync(real, t.task)
      }
      const before = treeHash(join(t.claudeDir, 'scheduled-tasks'))
      const out = disconnected(await runDisconnect(depsFor(t, fakeRunner({ keychain: keychain(), dialog: CONFIRMED }).runner)))
      assert.ok(!out.removed.includes('~/.claude/scheduled-tasks/nortia-hiredly'), variant)
      assert.equal(treeHash(join(t.claudeDir, 'scheduled-tasks')), before, variant)
    } finally {
      t.cleanup()
    }
  }
})

test('settings that are not valid JSON are left byte for byte, and Claude is asked to edit them', async () => {
  const t = makeHome()
  try {
    const broken = '{\n  "permissions": { "allow": ["mcp__nortia__hiredly_sync", ] }\n'
    writeFileSync(join(t.claudeDir, 'settings.json'), broken)
    const out = disconnected(await runDisconnect(depsFor(t, fakeRunner({ keychain: keychain(), dialog: CONFIRMED }).runner)))
    assert.equal(readFileSync(join(t.claudeDir, 'settings.json'), 'utf8'), broken)
    assert.ok(out.next_steps.some((s) => s.startsWith('Edit ~/.claude/settings.json:') && s.includes('starts with mcp__nortia__')))
    assert.deepEqual(out.removed_rules, ['mcp__nortia__hiredly_sync'], 'the other settings file is still cleaned')
    const last = out.next_steps.at(-1)!
    assert.ok(last.includes('"Nortia disconnected from this Mac."'))
  } finally {
    t.cleanup()
  }
})

test('settings rewritten by another program mid-edit are read again once, keeping that change', async () => {
  const t = makeHome()
  try {
    const file = join(t.claudeDir, 'settings.json')
    let reads = 0
    const readText = async (path: string) => {
      const raw = readFileSync(path, 'utf8')
      if (path === file && ++reads === 1) {
        const data = JSON.parse(raw)
        data.permissions.allow.push('Bash(ls)')
        writeFileSync(path, JSON.stringify(data, null, 4) + '\n')
      }
      return raw
    }
    const out = disconnected(await runDisconnect(depsFor(t, fakeRunner({ keychain: keychain(), dialog: CONFIRMED }).runner, { readText })))
    assert.ok(reads >= 3)
    assert.deepEqual(allowOf(file).sort(), [...KEPT_RULES, 'Bash(ls)'].sort())
    assert.ok(!out.next_steps.some((s) => s.startsWith('Edit ')))
  } finally {
    t.cleanup()
  }
})

test('settings that keep changing are not overwritten; Claude is asked to edit them', async () => {
  const t = makeHome()
  try {
    const file = join(t.claudeDir, 'settings.json')
    let n = 0
    const readText = async (path: string) => {
      const raw = readFileSync(path, 'utf8')
      if (path === file) {
        const data = JSON.parse(raw)
        data.env.N = String(++n)
        writeFileSync(path, JSON.stringify(data, null, 4) + '\n')
      }
      return raw
    }
    const out = disconnected(await runDisconnect(depsFor(t, fakeRunner({ keychain: keychain(), dialog: CONFIRMED }).runner, { readText })))
    assert.ok(allowOf(file).includes('mcp__nortia__hiredly_sync'), 'the kit did not write its own copy')
    assert.ok(out.next_steps.some((s) => s.startsWith('Edit ~/.claude/settings.json:')))
  } finally {
    t.cleanup()
  }
})

test('a symlinked settings.json is edited where it points, and stays a link', async () => {
  const t = makeHome()
  try {
    const dotfiles = join(t.root, 'dotfiles')
    mkdirSync(dotfiles)
    const link = join(t.claudeDir, 'settings.json')
    writeFileSync(join(dotfiles, 'settings.json'), readFileSync(link))
    rmSync(link)
    symlinkSync(join(dotfiles, 'settings.json'), link)
    await runDisconnect(depsFor(t, fakeRunner({ keychain: keychain(), dialog: CONFIRMED }).runner))
    assert.ok(lstatSync(link).isSymbolicLink())
    assert.deepEqual(allowOf(join(dotfiles, 'settings.json')).sort(), [...KEPT_RULES].sort())
  } finally {
    t.cleanup()
  }
})

test('Windows is not supported yet and nothing runs', async () => {
  const t = makeHome()
  try {
    const fake = fakeRunner({ keychain: keychain(), dialog: CONFIRMED })
    const before = treeHash(t.root)
    for (const fn of [inspectDisconnect, runDisconnect]) {
      const out = await fn(depsFor(t, fake.runner, { platform: 'win32' }))
      assert.equal(out.status, 'not_supported_yet')
    }
    assert.equal(fake.calls.length, 0)
    assert.equal(treeHash(t.root), before)
  } finally {
    t.cleanup()
  }
})

test('a revoked key tells the user how to remove Nortia from the computer', () => {
  assert.ok(
    statusMessage('api_key_invalid', { submitted: 0, matched: 0, failed: 0 }).endsWith(
      'To remove Nortia from this computer instead, tell Claude: "Disconnect Nortia from this Mac".'
    )
  )
})

function lstatSafe(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
