export type WorkLinkKind = 'jira' | 'github' | 'slack' | 'notion' | 'figma' | 'web'

export interface WorkLink {
  id: string
  kind: WorkLinkKind
  title: string
  url: string
  host: string
}

export interface ReminderListRef {
  id: string
  name: string
  account: string
}

export interface WorkItem {
  id: string
  title: string
  notes: string
  listId: string
  listName: string
  account: string
  completed: boolean
  dueAt?: number
  createdAt?: number
  updatedAt?: number
  links: WorkLink[]
}

