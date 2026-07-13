/**
 * 멘션 히스토리 저장소 — 스레드별 멘션 레코드를 디스크에 영속(재시작해도 유지).
 * 확인 여부(readAt)도 함께 보관. 멘션마다 파일 하나(`<id>.json`)로 저장해
 * 갱신 한 건에 전체를 다시 쓰지 않는다. Map을 감싸 set 시마다 해당 파일만 저장한다.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Mention } from '../types.js'

const MAX = 500 // 오래된 것부터 정리하는 상한

export class MentionStore {
  private map = new Map<string, Mention>()
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.migrateLegacyFile()
    for (const file of this.tryReaddir()) {
      if (!file.endsWith('.json')) continue
      try {
        const m = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Mention
        this.map.set(m.id, m)
      } catch {
        /* 손상된 파일은 건너뜀 */
      }
    }
  }

  private tryReaddir(): string[] {
    try {
      return readdirSync(this.dir)
    } catch {
      return []
    }
  }

  /** 구버전(단일 mentions.json 배열) 데이터를 폴더 형식으로 1회 이전 */
  private migrateLegacyFile(): void {
    const legacy = `${this.dir}.json`
    if (!existsSync(legacy)) return
    try {
      const arr = JSON.parse(readFileSync(legacy, 'utf8')) as Mention[]
      for (const m of arr) writeFileSync(this.filePath(m.id), JSON.stringify(m), 'utf8')
      renameSync(legacy, `${legacy}.bak`)
    } catch {
      /* 손상 시 무시 — 빈 상태로 시작 */
    }
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /** 상한 초과 시 오래된 것부터 메모리·디스크 모두에서 제거 */
  private prune(): void {
    if (this.map.size <= MAX) return
    const stale = [...this.map.values()].sort((a, b) => b.mentionedAt - a.mentionedAt).slice(MAX)
    for (const m of stale) {
      this.map.delete(m.id)
      try {
        unlinkSync(this.filePath(m.id))
      } catch {
        /* 이미 없으면 무시 */
      }
    }
  }

  get(id: string): Mention | undefined {
    return this.map.get(id)
  }
  set(id: string, m: Mention): void {
    this.map.set(id, m)
    writeFileSync(this.filePath(id), JSON.stringify(m), 'utf8')
    this.prune()
  }
  /** 최신순 전체 */
  all(): Mention[] {
    return [...this.map.values()].sort((a, b) => b.mentionedAt - a.mentionedAt)
  }
  /** 목록에서 제거 */
  remove(id: string): void {
    if (this.map.delete(id)) {
      try {
        unlinkSync(this.filePath(id))
      } catch {
        /* 이미 없으면 무시 */
      }
    }
  }
  /** 확인 처리(최초 1회 시각 기록). 이미 읽었으면 유지 */
  markRead(id: string): Mention | undefined {
    const m = this.map.get(id)
    if (m && !m.readAt) {
      m.readAt = Date.now()
      this.set(id, m)
    }
    return m
  }
  /** 안 읽은 개수 */
  unreadCount(): number {
    let n = 0
    for (const m of this.map.values()) if (!m.readAt) n++
    return n
  }
}
