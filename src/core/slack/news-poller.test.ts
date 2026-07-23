import { describe, expect, it, vi } from 'vitest'
import { SLACK_NEWS_POLL_INTERVAL_SEC, SlackNewsPoller, slackNewsSubscriptions } from './news-poller.js'

describe('slackNewsSubscriptions', () => {
  it('채널과 키워드를 정리하고 중복을 제거한다', () => {
    expect(slackNewsSubscriptions(['#all_random', 'all_random', ' all_전사공지 '], ['iOS', 'ios', '신규 소식'])).toEqual([
      { key: 'channel:all_random', label: '#all_random', query: 'in:all_random' },
      { key: 'channel:all_전사공지', label: '#all_전사공지', query: 'in:all_전사공지' },
      { key: 'keyword:ios', label: '키워드 “iOS”', query: '"iOS"' },
      { key: 'keyword:신규 소식', label: '키워드 “신규 소식”', query: '"신규 소식"' },
    ])
  })
})

describe('SlackNewsPoller', () => {
  it('구독 채널과 키워드는 최소 20분 간격으로 확인한다', () => {
    expect(SLACK_NEWS_POLL_INTERVAL_SEC).toBe(20 * 60)
  })

  it('첫 조회는 기준점만 저장하고 이후 새 루트 메시지만 전달한다', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({ messages: { matches: [{ channel: { id: 'C1', name: 'all_random' }, ts: '100.000001', text: '기존 글', permalink: 'https://slack/old' }] } })
      .mockResolvedValueOnce({ messages: { matches: [
        { channel: { id: 'C1', name: 'all_random' }, ts: '103.000001', user: 'U2', text: '*새 소식*\n보러 오세요', permalink: 'https://slack/new' },
        { channel: { id: 'C1', name: 'all_random' }, ts: '102.000001', thread_ts: '100.000001', user: 'U2', text: '답글', permalink: 'https://slack/reply' },
        { channel: { id: 'C1', name: 'all_random' }, ts: '101.000001', user: 'ME', text: '내 글', permalink: 'https://slack/mine' },
      ] } })
    const cursor = new Map<string, string>()
    const onNews = vi.fn()
    const poller = new SlackNewsPoller(
      { search: { messages: search } } as never,
      120,
      () => ({ enabled: true, channels: ['all_random'], keywords: [], myUserId: 'ME' }),
      (key) => cursor.get(key),
      (key, ts) => { cursor.set(key, ts) },
      onNews,
    )

    await poller.pollNow()
    expect(onNews).not.toHaveBeenCalled()
    expect(cursor.get('channel:all_random')).toBe('100.000001')

    await poller.pollNow()
    expect(onNews).toHaveBeenCalledOnce()
    expect(onNews).toHaveBeenCalledWith(expect.objectContaining({
      id: 'C1:103.000001',
      channelName: 'all_random',
      text: '새 소식\n보러 오세요',
      permalink: 'https://slack/new',
    }))
    expect(cursor.get('channel:all_random')).toBe('103.000001')
  })

  it('런타임에 다시 추가한 구독은 과거 글을 알리지 않고 새 기준점부터 시작한다', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({ messages: { matches: [{ channel: { id: 'C1' }, ts: '100', text: '처음', permalink: 'https://slack/100' }] } })
      .mockResolvedValueOnce({ messages: { matches: [{ channel: { id: 'C1' }, ts: '200', text: '구독 해제 중 글', permalink: 'https://slack/200' }] } })
    const cursor = new Map<string, string>()
    const config = { enabled: true, channels: ['all_random'], keywords: [] as string[] }
    const onNews = vi.fn()
    const poller = new SlackNewsPoller(
      { search: { messages: search } } as never,
      120,
      () => config,
      (key) => cursor.get(key),
      (key, ts) => { cursor.set(key, ts) },
      onNews,
    )

    await poller.pollNow()
    config.channels = []
    await poller.pollNow()
    config.channels = ['all_random']
    await poller.pollNow()

    expect(onNews).not.toHaveBeenCalled()
    expect(cursor.get('channel:all_random')).toBe('200')
  })
})
