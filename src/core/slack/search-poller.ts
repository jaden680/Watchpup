/**
 * User Token 기반 멘션 감지원.
 * `search.messages`로 "내가 멘션된 메시지"를 주기적으로 폴링한다 — 봇을 채널에
 * 초대하지 않아도 내가 접근 가능한 모든 채널/DM의 @나 멘션을 잡는다(수십 초 지연).
 * 중복 처리는 엔진(state.seen)이 걸러주므로 매 폴링에서 같은 매치를 다시 넘겨도 안전.
 */
import type { WebClient } from '@slack/web-api'
import { logger } from '../observability/logger.js'

export interface RawMention {
  channel: string
  threadTs: string
  messageTs: string
  authorId: string
  text: string
  /** 검색 결과는 thread_ts를 안 주므로 threadTs가 추정치일 수 있음 → 엔진이 진짜 root를 해석 */
  needsRootResolve?: boolean
  /** 나를 직접 @멘션(또는 유저그룹 멘션)한 것인지 — true면 기존 스레드라도 다시 알림 */
  direct?: boolean
  /** 수동 가져오기처럼 호출자가 미리 정한 저장 ID */
  requestId?: string
  /** 사용자가 붙여넣은 원본 링크를 그대로 보존 */
  permalink?: string
}

interface SearchMatch {
  channel?: { id?: string }
  ts?: string
  thread_ts?: string
  user?: string
  text?: string
}

export class SearchPoller {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly client: WebClient,
    private readonly myUserId: string,
    private readonly intervalSec: number,
    private readonly onMention: (raw: RawMention) => void,
    /**
     * 추가 검색어(예: 내가 속한 유저그룹 핸들 `@ios-team`). 참조를 유지하므로
     * 호출부가 나중에(usergroups 비동기 조회 후) 이 배열에 push하면 다음 폴링부터 반영된다.
     * 단, Slack 검색 인덱싱이 `<!subteam^GID>` 멘션을 항상 잡아준다는 보장은 없다(best-effort).
     */
    private readonly extraQueries: string[] = [],
  ) {}

  start(): void {
    if (this.timer) return
    void this.poll() // 즉시 1회
    this.timer = setInterval(() => void this.poll(), Math.max(15, this.intervalSec) * 1000)
    logger.info('SearchPoller 시작', { intervalSec: this.intervalSec })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async poll(): Promise<void> {
    await this.runQuery(`<@${this.myUserId}>`, false)
    for (const q of this.extraQueries) {
      await this.runQuery(q, true)
    }
  }

  private async runQuery(query: string, forceRootResolve: boolean): Promise<void> {
    try {
      const res = (await this.client.search.messages({
        query,
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 20,
      })) as { messages?: { matches?: SearchMatch[] } }
      const matches = res.messages?.matches ?? []
      for (const mm of matches) {
        const channel = mm.channel?.id
        const ts = mm.ts
        if (!channel || !ts) continue
        if (mm.user === this.myUserId) continue // 내가 보낸 메시지 제외
        this.onMention({
          channel,
          threadTs: mm.thread_ts || ts,
          messageTs: ts,
          authorId: mm.user || '',
          text: mm.text || '',
          // search.messages는 thread_ts를 주지 않음 → 엔진이 replies로 진짜 root 해석
          needsRootResolve: forceRootResolve || !mm.thread_ts,
          direct: true, // 검색으로 잡힌 건 나(또는 내 그룹) 직접 멘션
        })
      }
    } catch (err) {
      const e = err as { data?: { error?: string } }
      logger.warn('search.messages 폴링 실패', { query, err: e?.data?.error || String(err) })
    }
  }
}
