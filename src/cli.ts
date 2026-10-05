import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { loadConfig } from './config'
import { cliHiredlyMessage, withUpdateHint } from './messages'
import { HiredlyAdapter } from './platforms/hiredly/hiredly'
import { throttle } from './platforms/hiredly/throttle'
import type { Adapter } from './platforms/hiredly/types'
import { DEFAULT_MAX_NEW, HiredlyRun, type SyncDeps } from './run-state'
import { getSecret, isAccount, promptSecret, setSecret, type Account, type SecretDeps } from './secrets'
import { serve } from './server'
import { checkConnection, submitResume } from './tools'

export interface Io {
  stdin: Readable
  stdout: Writable
  stderr: Writable
}

export interface CliDeps extends SecretDeps {
  newAdapter: () => Adapter
  throttle: () => Promise<void>
  now: () => Date
}

export const defaultAdapter = (): Adapter => new HiredlyAdapter()
export { throttle as defaultThrottle }

const USAGE = `usage: nortia-ai-grab <command>
  serve                                   run the MCP server over stdio
  check                                   check the Nortia and Hiredly connection
  set-secret <account> [--stdin] [--for <email>]
                                          save nortia_api_key or hiredly_password to the keychain
  hiredly-sync [--max-new N] [--dry-run]  send new Hiredly resumes to Nortia
  submit <file> --application-id <id> --title <job title> [--platform hiredly]
         [--job-id <id>] [--name <n>] [--email <e>] [--phone <p>] [--applied-at <date>]`

const KEY_FORMAT = /^nrt_[A-Za-z0-9]{40}$/
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function main(argv: string[], io: Io, deps: CliDeps): Promise<number> {
  try {
    return await dispatch(argv, io, deps)
  } catch (err) {
    if ((err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) return usage(io)
    throw err
  }
}

async function dispatch(argv: string[], io: Io, deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv
  const print = (value: unknown) => io.stdout.write(JSON.stringify(value) + '\n')
  const log = (line: string) => io.stderr.write(`[nortia] ${line}\n`)
  const config = loadConfig(deps.env)
  const syncDeps = (allowEnv: boolean): SyncDeps => ({
    config,
    getSecret: (account: Account) => getSecret(account, { allowEnv }, deps),
    newAdapter: deps.newAdapter,
    throttle: deps.throttle,
    now: deps.now,
    log
  })

  switch (command) {
    case 'serve':
      await serve(
        syncDeps(false),
        {
          runner: deps.runner,
          platform: deps.platform,
          env: deps.env,
          apiUrl: config.apiUrl,
          home: homedir(),
          claudeDir: join(homedir(), '.claude')
        },
        { stdin: io.stdin, stdout: io.stdout }
      )
      return 0

    case 'check': {
      const result = await checkConnection(syncDeps(true))
      // why: the install prompt stops unless this says ok, so with an email configured Hiredly must sign in too.
      if ('hiredly' in result && config.hiredlyEmail && result.hiredly !== 'ok') {
        print({
          ...result,
          status: `hiredly_${result.hiredly}`,
          message: withUpdateHint(cliHiredlyMessage(result.workspace ?? '', result.hiredly), result.update_available)
        })
        return 1
      }
      print(result)
      return result.status === 'ok' ? 0 : 1
    }

    case 'set-secret':
      return setSecretCommand(rest, io, deps, print)

    case 'hiredly-sync': {
      const { values } = parseArgs({
        args: rest,
        options: { 'max-new': { type: 'string' }, 'dry-run': { type: 'boolean' } },
        strict: true
      })
      const maxNew = values['max-new'] === undefined ? DEFAULT_MAX_NEW : Number(values['max-new'])
      if (!Number.isInteger(maxNew) || maxNew < 1 || maxNew > 100) return usage(io)
      const run = new HiredlyRun(syncDeps(true))
      for (;;) {
        const result = await run.call({ maxNew, dryRun: values['dry-run'] === true })
        print(result)
        if (result.done) return result.status === 'ok' || result.status === 'partial' ? 0 : 1
      }
    }

    case 'submit': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
          'application-id': { type: 'string' },
          title: { type: 'string' },
          platform: { type: 'string', default: 'hiredly' },
          'job-id': { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          'applied-at': { type: 'string' }
        }
      })
      if (positionals.length !== 1 || !values['application-id']) return usage(io)
      const result = await submitResume(syncDeps(true), {
        file_path: positionals[0],
        platform: values.platform ?? 'hiredly',
        external_application_id: values['application-id'],
        external_job_title: values.title,
        external_job_id: values['job-id'],
        candidate_name: values.name,
        candidate_email: values.email,
        candidate_phone: values.phone,
        applied_at: values['applied-at']
      })
      print(result)
      return result.status === 'ok' ? 0 : 1
    }

    default:
      return usage(io)
  }
}

function usage(io: Io): number {
  io.stderr.write(USAGE + '\n')
  return 2
}

async function setSecretCommand(args: string[], io: Io, deps: CliDeps, print: (v: unknown) => void): Promise<number> {
  const account = args[0]
  if (!isAccount(account)) {
    print({ status: 'error', code: 'unknown_account' })
    return 2
  }
  const forAt = args.indexOf('--for')
  const email = forAt >= 0 ? args[forAt + 1] : undefined
  if (forAt >= 0 && !EMAIL_FORMAT.test(email ?? '')) {
    print({ status: 'error', code: 'invalid_email' })
    return 2
  }
  if (deps.platform !== 'darwin') {
    print({ status: 'error', code: 'not_supported_yet' })
    return 1
  }

  let value: string
  if (args.includes('--stdin')) {
    value = (await readAll(io.stdin)).replace(/\r?\n$/, '')
  } else {
    const answer = await promptSecret(dialogLabel(account, email), deps)
    if ('cancelled' in answer) {
      print({ status: 'cancelled' })
      return 1
    }
    if ('error' in answer) {
      print({ status: 'error', code: 'dialog_failed' })
      return 1
    }
    value = answer.value
  }

  if (value.length === 0) {
    print({ status: 'error', code: 'empty' })
    return 1
  }
  if (account === 'nortia_api_key' && !KEY_FORMAT.test(value)) {
    print({ status: 'error', code: 'invalid_key' })
    return 2
  }
  const saved = await setSecret(account, value, deps)
  if (saved === 'invalid_value') {
    print({ status: 'error', code: 'invalid_value' })
    return 2
  }
  if (saved === 'failed') {
    print({ status: 'error', code: 'keychain_write_failed' })
    return 1
  }
  print({ status: 'ok', account })
  return 0
}

export function dialogLabel(account: Account, email: string | undefined): string {
  if (account === 'nortia_api_key') return 'Enter your Nortia connector key.'
  return email
    ? `Enter the Hiredly password for ${email}. It is saved to your Mac keychain and never shown to the AI.`
    : 'Enter your Hiredly password.'
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
