// Test-only preload: replaces child_process.execFile so a spawned kit process talks to a
// fake keychain and dialog instead of /usr/bin/security and /usr/bin/osascript.
import cp from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const store = JSON.parse(process.env.FAKE_KEYCHAIN ?? '{}')
const ADD = /^add-generic-password -U -s \S+ -a (\S+) -w "((?:[^"\\]|\\.)*)"/

function passwordLine(value) {
  return /^[\x20-\x7e]*$/.test(value) && !/["\\]/.test(value)
    ? `password: "${value}"\n`
    : `password: 0x${Buffer.from(value, 'utf8').toString('hex').toUpperCase()}  "..."\n`
}

cp.execFile = function fakeExecFile(file, args, opts, cb) {
  if (typeof opts === 'function') cb = opts
  const fail = (code, stderr) => cb(Object.assign(new Error(stderr), { code }), '', stderr)
  return {
    stdin: {
      end(input = '') {
        if (process.env.FAKE_EXEC_LOG) appendFileSync(process.env.FAKE_EXEC_LOG, JSON.stringify({ file, args, input }) + '\n')
        if (file === '/usr/bin/security' && args[0] === 'find-generic-password') {
          const account = args[args.indexOf('-a') + 1]
          if (account in store) cb(null, '', passwordLine(store[account]))
          else fail(44, 'The specified item could not be found in the keychain.')
        } else if (file === '/usr/bin/security' && args[0] === 'delete-generic-password') {
          const account = args[args.indexOf('-a') + 1]
          if (account in store) {
            delete store[account]
            cb(null, '', '')
          } else fail(44, 'The specified item could not be found in the keychain.')
        } else if (file === '/usr/bin/security' && args[0] === '-i') {
          const m = ADD.exec(String(input))
          if (m) store[m[1]] = m[2].replace(/\\(.)/g, '$1')
          if (m) cb(null, '', '')
          else fail(1, 'returned 1')
        } else if (file === '/usr/bin/osascript') {
          cb(null, (process.env.FAKE_DIALOG ?? '') + '\n', '')
        } else {
          fail(127, `unexpected exec ${file}`)
        }
      }
    }
  }
}
syncBuiltinESMExports()
