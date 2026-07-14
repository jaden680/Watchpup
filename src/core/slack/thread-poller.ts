/**
 * User Token 기반 스레드 후속 폴링.
 * search.messages는 "@나"를 재멘션하지 않은 후속 답글은 잡지 못한다. 봇이 없는(user-search
 * 전용) 채널에서도 내가 멘션됐던 스레드의 새 답글을 놓치지 않도록 conversations.replies로
 * 추적 중인 스레드들을 주기적으로 훑는다. 중복/스레드 root 판단은 엔진(handleMention)이 처리.
 */
import type { WebClient } from '@slack/web-api'
import type { RawMention } from './search-poller.js'
import { logger } from '../observability/logger.js'
import { compareSlackTs, latestSlackTs } from './timestamp.js'

export interface RepliesMessage {
  ts?: string
  user?: string
  bot_id?: string
  text?: string
}

export function selectLatestHumanFollowup(
  messages: RepliesMessage[],
  cursor: string | undefined,
  mySlackUserId: string,
): { followup?: RepliesMessage; maxTs?: string } {
  const fresh = messages.filter((msg) =>
    !!msg.ts && (!cursor || compareSlackTs(msg.ts, cursor) > 0),
  )
  const followup = fresh
    .filter((msg) => !!msg.user && !msg.bot_id && msg.user !== mySlackUserId)
    .reduce<RepliesMessage | undefined>((latest, msg) =>
      !latest?.ts || compareSlackTs(msg.ts!, latest.ts) > 0 ? msg : latest,
    undefined)
  return { followup, maxTs: latestSlackTs([cursor, ...fresh.map((msg) => msg.ts)]) }
}

export class ThreadFollowPoller {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly client: WebClient,
    private readonly listThreads: () => Array<{ channel: string; threadTs: string }>,
    private readonly getCursor: (channel: string, threadTs: string) => string | undefined,
    private readonly setCursor: (channel: string, threadTs: string, ts: string) => void,
    private readonly mySlackUserId: string,
    private readonly intervalSec: number,
    private readonly onFollowup: (raw: RawMention) => void,
  ) {}

  start(): void {
    if (this.timer) return
    void this.poll() // 즉시 1회
    this.timer = setInterval(() => void this.poll(), Math.max(15, this.intervalSec) * 1000)
    logger.info('ThreadFollowPoller 시작', { intervalSec: this.intervalSec })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async poll(): Promise<void> {
    for (const { channel, threadTs } of this.listThreads()) {
      await this.pollThread(channel, threadTs)
    }
  }

  private async pollThread(channel: string, threadTs: string): Promise<void> {
    const cursor = this.getCursor(channel, threadTs)
    try {
      const res = (await this.client.conversations.replies({
        channel,
        ts: threadTs,
        oldest: cursor || threadTs,
        inclusive: false,
        limit: 30,
      })) as { messages?: RepliesMessage[] }
      const messages = res.messages ?? []
      const { followup, maxTs } = selectLatestHumanFollowup(messages, cursor, this.mySlackUserId)
      // 한 번의 폴링에서 같은 스레드의 답글은 최신 메시지 하나로 합친다.
      // 분석 시 스레드 전체를 다시 읽으므로 중간 답글의 맥락도 함께 반영된다.
      if (followup?.ts && followup.user) {
        this.onFollowup({
          channel,
          threadTs,
          messageTs: followup.ts,
          authorId: followup.user,
          text: followup.text || '',
        })
      }
      if (maxTs && maxTs !== cursor) this.setCursor(channel, threadTs, maxTs)
    } catch (err) {
      logger.warn('스레드 후속 폴링 실패', { channel, threadTs, err: String(err) })
    }
  }
}
