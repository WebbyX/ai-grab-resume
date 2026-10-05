import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { inspectDisconnect, runDisconnect, type DisconnectDeps } from './disconnect'
import { DEFAULT_MAX_NEW, HiredlyRun, type SyncDeps } from './run-state'
import { checkConnection, submitResume } from './tools'
import { KIT_VERSION } from './version'

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

export const TOOL_DESCRIPTIONS = {
  check_connection:
    'Check that this computer can reach the Nortia workspace and sign in to Hiredly. Returns a status and a message to tell the user.',
  submit_resume:
    'Send one resume file from the Nortia work folder to the Nortia resume inbox. external_job_title is required: the job title exactly as the hiring platform shows it.',
  hiredly_sync:
    'Fetch new resumes from Hiredly and send them to Nortia, one batch per call. Call repeatedly until the result has done: true, then tell the user its message. Do not run any other command.',
  disconnect:
    'Remove Nortia from this computer and revoke its Nortia key. Call it without confirm first: that only lists what would be removed and changes nothing; then follow its message. confirm: true shows a confirmation box on the user\'s screen and changes nothing unless the user clicks Disconnect there.'
} as const

export const SERVER_INSTRUCTIONS =
  'Nortia sends new Hiredly resumes from this computer to the user\'s Nortia workspace. If the user asks to stop, disconnect, remove or uninstall Nortia on this computer, call the disconnect tool without confirm first and follow its result exactly, instead of deleting Nortia\'s files, saved passwords or settings yourself. If the user asks to resume Nortia after pausing it, call update_scheduled_task with taskId nortia-hiredly and enabled true.'

/** Runs the MCP server over stdio. Only protocol frames go to stdout; diagnostics go to stderr. */
export async function serve(
  deps: SyncDeps,
  disconnectDeps: DisconnectDeps,
  io: { stdin: Readable; stdout: Writable }
): Promise<void> {
  const run = new HiredlyRun(deps)
  const server = new McpServer({ name: 'nortia', version: KIT_VERSION }, { instructions: SERVER_INSTRUCTIONS })

  server.registerTool(
    'check_connection',
    { description: TOOL_DESCRIPTIONS.check_connection },
    async () => text(await checkConnection(deps))
  )

  server.registerTool(
    'submit_resume',
    {
      description: TOOL_DESCRIPTIONS.submit_resume,
      inputSchema: {
        file_path: z.string().min(1).max(1024),
        platform: z.string().min(1).max(50),
        external_application_id: z.string().min(1).max(255),
        external_job_title: z.string().max(255).optional(),
        external_job_id: z.string().max(255).optional(),
        candidate_name: z.string().max(255).optional(),
        candidate_email: z.string().max(255).optional(),
        candidate_phone: z.string().max(255).optional(),
        applied_at: z.string().max(64).optional()
      }
    },
    async (args) => text(await submitResume(deps, args))
  )

  server.registerTool(
    'hiredly_sync',
    {
      description: TOOL_DESCRIPTIONS.hiredly_sync,
      inputSchema: {
        max_new: z.number().int().min(1).max(100).default(DEFAULT_MAX_NEW),
        dry_run: z.boolean().default(false)
      }
    },
    async ({ max_new, dry_run }) => text(await run.call({ maxNew: max_new, dryRun: dry_run }))
  )

  server.registerTool(
    'disconnect',
    {
      description: TOOL_DESCRIPTIONS.disconnect,
      inputSchema: { confirm: z.boolean().default(false) },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ confirm }) => text(await (confirm ? runDisconnect(disconnectDeps) : inspectDisconnect(disconnectDeps)))
  )

  await server.connect(new StdioServerTransport(io.stdin, io.stdout))
  deps.log(`MCP server ${KIT_VERSION} ready (node ${process.version})`)
}
