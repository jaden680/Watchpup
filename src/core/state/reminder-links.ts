/**
 * 멘션 스레드 ↔ Reminder id 매핑 저장소 — mention.toWork(AI) 핸들러의 dedup(스레드 단위
 * 업데이트) 판정에 사용. StateStore와 동일한 단일 파일 JSON 영속 패턴.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ReminderLinkEntry {
  reminderId: string
  listId: string
}

/** channel:threadTs → dedup 키. 스레드 단위로 미리알림 1개에 매핑한다. */
export function reminderKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`
}

export class ReminderLinkStore {
  private map: Record<string, ReminderLinkEntry>
  constructor(private readonly path: string) {
    this.map = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, ReminderLinkEntry>)
      : {}
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.map), 'utf8')
  }
  get(key: string): ReminderLinkEntry | undefined {
    return this.map[key]
  }
  set(key: string, entry: ReminderLinkEntry): void {
    this.map[key] = entry
    this.persist()
  }
  delete(key: string): void {
    if (key in this.map) {
      delete this.map[key]
      this.persist()
    }
  }
}
