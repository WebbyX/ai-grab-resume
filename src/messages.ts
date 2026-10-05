export type Status =
  | 'ok'
  | 'partial'
  | 'login_rejected'
  | 'blocked'
  | 'not_configured'
  | 'kit_outdated'
  | 'api_key_invalid'
  | 'rate_limited'
  | 'error'

export type HiredlyCheck = 'ok' | 'login_rejected' | 'blocked' | 'not_configured' | 'error'

const CONNECT = 'Nortia → AI Grab Resume → Connect'

export const KIT_OUTDATED_MESSAGE = `This Nortia connector is out of date. Open ${CONNECT} and copy the update instructions into Claude.`
const UPDATE_AVAILABLE = `A newer Nortia connector is available — see ${CONNECT}.`

const FIXED: Record<Exclude<Status, 'ok' | 'partial' | 'error'>, string> = {
  login_rejected: `Hiredly rejected the saved password. Open ${CONNECT} and copy the "change Hiredly password" instructions into Claude.`,
  blocked: 'Hiredly blocked the sign-in for now (too many attempts or a captcha). Nothing to do — the next run will try again.',
  not_configured: `The Nortia connector is not fully set up. Open ${CONNECT} and generate new install instructions.`,
  kit_outdated: KIT_OUTDATED_MESSAGE,
  api_key_invalid: `Nortia no longer accepts this connector's key (it may have been revoked). Open ${CONNECT} and generate new install instructions. To remove Nortia from this computer instead, tell Claude: "Disconnect Nortia from this Mac".`,
  rate_limited: 'Nortia asked the connector to slow down. The next run will continue.'
}

export interface Tally {
  submitted: number
  matched: number
  failed: number
}

export function statusMessage(status: Status, tally: Tally, code?: string): string {
  if (status === 'error') return `Something went wrong (${code ?? 'unknown'}). The next run will try again; if it keeps happening, contact Nortia support.`
  if (status === 'partial') return `Sent ${tally.submitted} new resumes; more are waiting and will come in on the next run.`
  if (status === 'ok') {
    if (tally.submitted === 0 && tally.failed > 0) return `Could not send ${tally.failed} resumes to Nortia. They will be tried again on the next run.`
    const failed = tally.failed > 0 ? ` ${tally.failed} could not be sent and will be tried again on the next run.` : ''
    if (tally.submitted === 0) return 'No new resumes on Hiredly since the last run.'
    const waiting = tally.submitted - tally.matched
    return `Sent ${tally.submitted} new resumes to Nortia. ${tally.matched} matched a job; ${waiting} are waiting in Nortia → AI Grab Resume → Resume inbox for you to assign.${failed}`
  }
  return FIXED[status]
}

export function batchMessage(calls: number, submitted: number): string {
  return `Batch ${calls} sent (${submitted} new resumes so far). Call hiredly_sync again.`
}

export function dryRunMessage(wouldSubmit: number, more: boolean): string {
  return `Dry run: ${wouldSubmit}${more ? ' or more' : ''} new resumes would be sent to Nortia. Nothing was downloaded or sent.`
}

export function checkMessage(workspace: string, hiredly: HiredlyCheck): string {
  const connected = `Connected to the Nortia workspace "${workspace}".`
  if (hiredly === 'ok') return `${connected} Hiredly sign-in works.`
  if (hiredly === 'not_configured') return `${connected} Hiredly is not set up on this computer yet.`
  if (hiredly === 'error') return `${connected} Could not reach Hiredly right now; the next run will try again.`
  return `${connected} ${FIXED[hiredly]}`
}

const CLI_HIREDLY: Record<Exclude<HiredlyCheck, 'ok'>, string> = {
  not_configured: 'no Hiredly password is saved on this computer yet. Save it with the Hiredly password step of the install instructions, then check again.',
  login_rejected: 'Hiredly rejected the saved password for this email. Save the correct password again, then check again.',
  blocked: 'Hiredly is blocking sign-ins right now (too many attempts or a captcha). Wait a while, then check again.',
  error: 'Hiredly could not be reached right now. Check the internet connection, then check again.'
}

export function cliHiredlyMessage(workspace: string, hiredly: Exclude<HiredlyCheck, 'ok'>): string {
  return `Connected to the Nortia workspace "${workspace}", but ${CLI_HIREDLY[hiredly]}`
}

export function submitMessage(outcome: 'received' | 'duplicate'): string {
  return outcome === 'received' ? 'Sent to Nortia.' : 'Nortia already has this resume.'
}

export function withUpdateHint(message: string, updateAvailable: boolean): string {
  return updateAvailable ? `${message} ${UPDATE_AVAILABLE}` : message
}

const KEYS = 'Nortia → AI Grab Resume → Keys'
const STILL_TO_DO = 'add a still-to-do line'
const keyName = (prefix: string | null) => (prefix ? `the key ${prefix}…` : "this Mac's key")

export const DISCONNECT_CONFIRM_TEXT =
  "Disconnect Nortia from this Mac? This removes the Nortia connector, its saved key and Hiredly password, and the daily resume run. Nortia stops accepting this Mac's key."

export const DISCONNECT_PREVIEW_MESSAGE = [
  'Nothing has been changed yet. Show me the will_remove list as a short list of what disconnecting removes from this Mac.',
  'Then ask me "Disconnect Nortia from this Mac?" using your multiple-choice question tool (AskUserQuestion) with the options "Yes, disconnect this Mac", "Pause the daily run instead" and "No, keep it"; ask in plain text if that tool isn\'t available.',
  'If I choose "Yes, disconnect this Mac": tell me "A Mac confirmation box will appear — click Disconnect there to finish, or Cancel to keep Nortia." and call disconnect with confirm: true.',
  'If I choose "Pause the daily run instead": call update_scheduled_task with taskId nortia-hiredly and enabled false, then tell me: "The daily Nortia run is paused. To start it again, tell Claude: Resume Nortia."',
  'Anything else: tell me "Nothing was changed." and stop.'
].join(' ')

export const WILL_REMOVE = {
  key: (prefix: string | null) => `The Nortia key saved on this Mac${prefix ? ` (${prefix}…)` : ''}; Nortia stops accepting it`,
  hiredlyPassword: 'The Hiredly password saved on this Mac',
  folder: (path: string) => `The folder ${path}`,
  rules: (count: number, file: string) => `${count} Nortia permission ${count === 1 ? 'rule' : 'rules'} in ${file}`,
  task: 'The daily task nortia-hiredly in Claude Desktop',
  connector: 'The nortia connector registered in Claude'
}

export const DISCONNECT_MESSAGES = {
  cancelled: 'Tell me: "Nothing was changed — the disconnect was cancelled." Do not call disconnect again unless I ask.',
  confirm_unavailable: `Tell me: "The confirmation box could not be shown on this Mac, so nothing was changed. To remove Nortia anyway, open ${CONNECT} → Troubleshooting, click Copy Disconnect Instructions and paste them into Claude." Do not call disconnect again.`,
  not_supported_yet: 'Tell me: "Disconnecting this way works only on macOS for now. Nothing was changed."',
  disconnected: 'Nortia is removed from this Mac. Now do every entry of next_steps, in order.'
}

export const DISCONNECT_ISSUES = {
  unreachable: (prefix: string | null) =>
    `Nortia could not be reached, so ${keyName(prefix)} still works. Ask a Nortia admin to revoke it in ${KEYS}.`,
  no_address: (prefix: string | null) =>
    `This Mac's connector has no Nortia address, so ${keyName(prefix)} was not revoked. Ask a Nortia admin to revoke it in ${KEYS}.`,
  no_key: `No Nortia key was saved on this Mac, so Nortia was not told. If this Mac's key is still active in ${KEYS}, revoke it there.`,
  keychain: (what: 'Nortia key' | 'Hiredly password') => `Remove the saved ${what}: open Keychain Access, search for nortia-ai-grab and delete it.`,
  folder: (path: string) => `Delete the folder ${path}.`,
  rules: (file: string) => `Remove the Nortia rules from ${file}.`
}

export function disconnectNextSteps(settingsToEdit: string[]): string[] {
  return [
    `Call list_scheduled_tasks. If it lists the taskId nortia-hiredly, call delete_scheduled_task with taskId nortia-hiredly. If that is refused (for example because this conversation is that task's own run), ${STILL_TO_DO}: "Delete the nortia-hiredly task in Claude Desktop → Scheduled."`,
    `Run \`claude mcp remove nortia --scope user\` in the terminal. If the claude command is not found or it fails, ${STILL_TO_DO}: "Remove the Nortia connector: run claude mcp remove nortia --scope user in a terminal."`,
    ...settingsToEdit.map(
      (file) =>
        `Edit ${file}: remove from permissions.allow every rule that is exactly mcp__nortia or starts with mcp__nortia__, keeping everything else. If you can't, ${STILL_TO_DO}: "${DISCONNECT_ISSUES.rules(file)}"`
    ),
    'Then tell me "Nortia disconnected from this Mac." If the issues list has entries or you added still-to-do lines, follow it with "Still to do:" and each of them on its own line. End with "You can now delete the Nortia setup conversations in Claude." Do not call disconnect again.'
  ]
}
