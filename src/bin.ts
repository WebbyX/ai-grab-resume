// why: checked before the bundle's other modules load, so an old Node gets a clear message instead of a syntax or API error.
if (Number(process.versions.node.split('.')[0]) < 20) {
  process.stderr.write(`nortia-ai-grab needs Node.js 20 or newer; this is ${process.version}.\n`)
  process.exit(1)
}

const { main, defaultAdapter, defaultThrottle } = await import('./cli')
const { execRunner } = await import('./secrets')

process.exitCode = await main(process.argv.slice(2), process, {
  runner: execRunner,
  platform: process.platform,
  env: process.env,
  newAdapter: defaultAdapter,
  throttle: defaultThrottle,
  now: () => new Date()
})

export {}
