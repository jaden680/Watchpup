export interface StartupAccessConfig {
  enableBot: boolean
  enableUserSearch: boolean
  followThreads: boolean
  naggingEnabled: boolean
  slackNewsEnabled: boolean
}

export interface StartupSlackSecrets {
  bot: boolean
  app: boolean
  user: boolean
}

/** 시작 직후 실제로 동작할 Slack 백그라운드 기능에 필요한 비밀값만 고른다. */
export function startupSlackSecrets(config: StartupAccessConfig): StartupSlackSecrets {
  return {
    bot: config.enableBot,
    app: config.enableBot,
    user: config.enableUserSearch
      || config.followThreads
      || (config.naggingEnabled && config.slackNewsEnabled),
  }
}
