export const CMD = {
  activityList: 'activity.list',
  mentionsList: 'mentions.list',
  mentionGet: 'mention.get',
  mentionRead: 'mention.read',
  threadImport: 'thread.import',
  todoToggle: 'todo.toggle',
  replyApprove: 'reply.approve',
  replyCopy: 'reply.copy',
  chatSend: 'chat.send',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  modelCatalogGet: 'model.catalog.get',
  modelCatalogRefresh: 'model.catalog.refresh',
  tokensGet: 'tokens.get',
  tokensSet: 'tokens.set',
  playbooksList: 'playbooks.list',
  playbookUpsert: 'playbook.upsert',
  playbookDelete: 'playbook.delete',
  actionRun: 'action.run',
  reactionSet: 'reaction.set',
  workLists: 'work.lists',
  workItems: 'work.items',
  workListSelect: 'work.list.select',
  workReminderCreate: 'work.reminder.create',
  workReminderSubtaskAdd: 'work.reminder.subtask.add',
  workReminderTitleUpdate: 'work.reminder.title.update',
  workReminderNoteUpdate: 'work.reminder.note.update',
  workReminderComplete: 'work.reminder.complete',
  workReminderLinkAdd: 'work.reminder.link.add',
  workItemTouch: 'work.item.touch',
  workLinkStatus: 'work.link.status',
  workLinkAction: 'work.link.action',
  workRemindersOpen: 'work.reminders.open',
} as const

export const EVT = {
  activitySessions: 'activity.sessions',
  pet: 'pet.state',
  mentionNew: 'mention.new',
  mentionReady: 'mention.ready',
  chatStream: 'chat.stream',
  badge: 'badge.update',
  bubble: 'pet.bubble',
  chatBubble: 'pet.chat',
  petTheme: 'pet.theme',
  petImages: 'pet.images',
  petCodex: 'pet.codex',
  petSize: 'pet.size',
  bubbleSize: 'bubble.size',
  hudSize: 'hud.size',
  hudAlignment: 'hud.alignment',
  hudVisibility: 'hud.visibility',
  actionStream: 'action.stream',
  actionDone: 'action.done',
} as const

export interface ChatSendArgs {
  mentionId: string
  text: string
}

export interface ThreadImportResult {
  id: string
  existing: boolean
}

export interface TodoToggleArgs {
  mentionId: string
  index: number
}

export interface ReactionSetArgs {
  mentionId: string
  messageTs: string
  name: string
  active: boolean
}

/** 액션(워크플로우) 정의 — src/core/config/schema.ts playbookSchema와 동일 형태 */
export interface Playbook {
  id: string
  name: string
  when: string
  steps: string
  write: boolean
  enabled: boolean
}

export interface ActionRunArgs {
  mentionId: string
  playbookId: string
  extra?: string
}

export interface SettingsPatch {
  mySlackUserId?: string
  followThreads?: boolean
  enableBot?: boolean
  enableUserSearch?: boolean
  searchIntervalSec?: number
  ingestMaxAgeDays?: number
  petTheme?: string
  petAlwaysOnTop?: boolean
  petSizePercent?: number
  bubbleSizePercent?: number
  hudSizePercent?: number
  hudAlignment?: 'left' | 'right'
  showActivityHud?: boolean
  naggingEnabled?: boolean
  naggingMinMinutes?: number
  naggingMaxMinutes?: number
  petImageDir?: string
  petCodexDir?: string
  persona?: string
  bubbleStyle?: 'status' | 'summary' | 'witty'
  obsidian?: {
    enabled?: boolean
    vaultPath?: string
    folder?: string
  }
  model?: string
  reminderTaskSortOrder?: 'manual' | 'dueDateThenTitle' | 'createdNewest' | 'updatedNewest' | 'titleAscending'
  reminderTaskManualOrder?: string[]
  showCompletedReminders?: boolean
}

/** 저장할 토큰(빈 문자열/undefined는 무시 = 기존 유지). 값은 Keychain에만 저장. */
export interface TokensPatch {
  botToken?: string
  appToken?: string
  userToken?: string
}

/** 토큰 존재 여부만 노출(값 노출 금지) */
export interface TokensStatus {
  bot: boolean
  app: boolean
  user: boolean
}
