import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MAX_AGE_DAYS, MAX_MAX_AGE_DAYS, MIN_MAX_AGE_DAYS } from './platforms/hiredly/age-window'

export interface Config {
  apiUrl: string | null
  workDir: string
  hiredlyEmail: string | null
  maxAgeDays: number
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const days = Number(env.HIREDLY_MAX_AGE_DAYS)
  return {
    apiUrl: env.NORTIA_API_URL?.trim() || null,
    workDir: env.NORTIA_WORK_DIR?.trim() || join(homedir(), '.nortia', 'inbox'),
    hiredlyEmail: env.HIREDLY_EMAIL?.trim() || null,
    maxAgeDays:
      Number.isInteger(days) && days >= MIN_MAX_AGE_DAYS && days <= MAX_MAX_AGE_DAYS ? days : DEFAULT_MAX_AGE_DAYS
  }
}
