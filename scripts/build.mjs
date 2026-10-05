import { build } from 'esbuild'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outfile = join(root, 'dist', 'cli.js')
const workDir = realpathSync(tmpdir())

const result = await build({
  entryPoints: [join(root, 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __KIT_VERSION__: JSON.stringify(pkg.version),
    __KIT_NAME__: JSON.stringify(pkg.name)
  },
  // why: esbuild switches to Yarn PnP resolution when any ancestor of its working
  // directory holds a .pnp.cjs (one sits in this Mac's home dir); a working dir
  // outside $HOME keeps plain node_modules resolution from the entry file.
  absWorkingDir: workDir,
  metafile: true,
  write: false,
  logLevel: 'warning'
})

// why: esbuild names modules by their path relative to the working dir, which would bake this
// machine's directory layout into the published file; stripping the prefix makes them root-relative.
const prefix = relative(workDir, root) + '/'
if (!prefix.startsWith('../')) throw new Error(`build: run this from a checkout outside ${workDir}`)
const code = result.outputFiles[0].text.replaceAll(prefix, '')
mkdirSync(dirname(outfile), { recursive: true })
writeFileSync(outfile, code + thirdPartyNotices(Object.keys(result.metafile.inputs)))
chmodSync(outfile, 0o755)

/** Reproduces the license text of every npm package that ended up inside the bundle, as their licenses require. */
function thirdPartyNotices(inputs) {
  const dirs = new Set()
  for (const input of inputs) {
    const abs = resolve(workDir, input)
    const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(abs)
    if (m) dirs.add(m[1])
  }
  const sections = [...dirs].sort().map((dir) => {
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const file = readdirSync(dir).find((f) => /^(license|licence|copying)(\.|$)/i.test(f))
    const text = file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${meta.license}`
    return `${meta.name}@${meta.version} (${meta.license})\n\n${text}`
  })
  const body = sections.join('\n\n----------------------------------------\n\n').replaceAll('*/', '* /')
  return `\n/*! Third-party notices: open-source packages bundled into this file.\n\n${body}\n*/\n`
}
