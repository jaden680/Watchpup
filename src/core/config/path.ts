import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveWatchpupConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return env.WATCHPUP_CONFIG || join(home, '.watchpup', 'watchpup.config.yaml')
}
