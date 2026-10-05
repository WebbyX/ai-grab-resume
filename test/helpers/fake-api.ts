import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  json?: any
  form?: Record<string, string>
  fileBytes?: number
}

export type Override = (
  req: Recorded
) => { status: number; body?: unknown; headers?: Record<string, string>; destroy?: boolean } | undefined

/** In-memory stand-in for the Nortia api/v1 routes, recording every request it sees. */
export async function startFakeApi(opts: { latest?: string; sync?: unknown } = {}) {
  const requests: Recorded[] = []
  const known = new Set<string>()
  let override: Override | undefined
  let titleMatch = 'no_title_match'

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks)
    const rec: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers }
    const type = String(req.headers['content-type'] ?? '')
    if (type.startsWith('application/json')) rec.json = JSON.parse(raw.toString('utf8'))
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'content-type': type } }).formData()
      rec.form = {}
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') rec.form[k] = v
        else rec.fileBytes = v.size
      }
    }
    requests.push(rec)

    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    const forced = override?.(rec)
    if (forced?.destroy) return req.socket.destroy()
    if (forced) return send(forced.status, forced.body ?? { status: false, message: 'forced' }, forced.headers)

    if (rec.method === 'GET' && rec.path === '/api/v1/me') {
      return send(200, {
        status: true,
        data: {
          workspace: { name: 'Acme Sdn Bhd' },
          key: { name: 'Claude · Hiredly', prefix: 'nrt_abcdefgh' },
          platforms: [{ code: 'hiredly', name: 'Hiredly' }],
          kit: { latest_version: opts.latest ?? '0.0.0', min_version: '0.0.0' },
          ...(opts.sync === undefined ? {} : { sync: opts.sync })
        }
      })
    }
    if (rec.method === 'POST' && rec.path === '/api/v1/resumes/lookup') {
      const ids: string[] = rec.json.external_application_ids
      return send(200, { status: true, data: { known: ids.filter((id) => known.has(id)) } })
    }
    if (rec.method === 'POST' && rec.path === '/api/v1/resumes') {
      const id = rec.form?.external_application_id ?? ''
      if (known.has(id)) return send(200, { status: true, message: 'Duplicate.', data: { title_match: titleMatch } })
      known.add(id)
      return send(202, { status: true, message: 'Received.', data: { title_match: titleMatch } })
    }
    if (rec.method === 'POST' && rec.path === '/api/v1/runs') {
      return send(200, { status: true, message: 'Recorded.', data: { recorded: true } })
    }
    if (rec.method === 'POST' && rec.path === '/api/v1/disconnect') {
      return send(200, { status: true, message: 'Disconnected.', data: { prefix: 'nrt_abcdefgh' } })
    }
    send(404, { status: false, message: 'Not found.' })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    known,
    setOverride(fn: Override | undefined) {
      override = fn
    },
    setTitleMatch(value: string) {
      titleMatch = value
    },
    count(path: string) {
      return requests.filter((r) => r.path === path).length
    },
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}
