import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuildCompletionPoller, buildCompletionLine, parseAndroidBuildLog, parseXcodeBuildManifest, type BuildCompletion } from './completion-poller.js'

describe('IDE build completion', () => {
  it('Xcode manifest에서 성공·실패와 스킴 정보를 읽는다', () => {
    const events = parseXcodeBuildManifest({
      logs: {
        success: {
          uniqueIdentifier: 'success',
          title: 'Build ZigZag-Beta',
          'schemeIdentifier-containerName': 'ZigZag project',
          timeStartedRecording: 100,
          timeStoppedRecording: 110,
          primaryObservable: { highLevelStatus: 'W', totalNumberOfErrors: 0, totalNumberOfWarnings: 3 },
        },
        failed: {
          uniqueIdentifier: 'failed',
          title: 'Build Partners',
          timeStartedRecording: 200,
          timeStoppedRecording: 205,
          primaryObservable: { highLevelStatus: 'E', totalNumberOfErrors: 1, totalNumberOfWarnings: 0 },
        },
      },
    })

    expect(events).toEqual([
      expect.objectContaining({ id: 'xcode:success', title: 'ZigZag-Beta', project: 'ZigZag', result: 'success', durationMs: 10_000, warnings: 3 }),
      expect.objectContaining({ id: 'xcode:failed', title: 'Partners', result: 'failure', durationMs: 5_000, errors: 1 }),
    ])
    expect(buildCompletionLine(events[0])).toBe('ZigZag-Beta 빌드 끝! Xcode 확인하러 가자 👀')
  })

  it('Android Studio 로그에서 Gradle 시작과 성공·실패를 연결한다', () => {
    const success = parseAndroidBuildLog([
      '2026-07-15 10:00:00,000 [1] INFO - #GradleBuildInvoker - About to execute Gradle tasks: [:app:assemblePlaystoreBetaDebug]',
      '2026-07-15 10:00:00,100 [2] INFO - #GradleExecutionHelper - -Pandroid.injected.attribution.file.location=/Users/me/project/.gradle --stacktrace',
      '2026-07-15 10:02:03,000 [3] INFO - #GradleBuildInvoker - Gradle build finished in 2 m 3 s',
    ].join('\n'))

    expect(success.events[0]).toMatchObject({
      tool: 'android',
      title: ':app:assemblePlaystoreBetaDebug',
      project: '/Users/me/project',
      result: 'success',
      durationMs: 123_000,
      durationText: '2 m 3 s',
    })
    expect(buildCompletionLine(success.events[0])).toContain('Android Studio 확인하러 가자')

    const failed = parseAndroidBuildLog([
      '2026-07-15 11:00:00,000 [1] INFO - #GradleBuildInvoker - About to execute Gradle tasks: [:app:test]',
      '2026-07-15 11:00:01,000 [2] INFO - #GradleBuildInvoker - Gradle build failed in 1 s',
    ].join('\n'))
    expect(failed.events[0]).toMatchObject({ title: ':app:test', result: 'failure' })
  })

  it('활성화 시점의 로그는 기준점으로만 잡고 이후 완료분만 전달한다', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'watchpup-build-'))
    const manifestPath = join(homeDir, 'Library', 'Developer', 'Xcode', 'DerivedData', 'App-hash', 'Logs', 'Build', 'LogStoreManifest.plist')
    const androidLog = join(homeDir, 'Library', 'Logs', 'Google', 'AndroidStudio2026.1', 'idea.log')
    mkdirSync(join(manifestPath, '..'), { recursive: true })
    mkdirSync(join(androidLog, '..'), { recursive: true })
    writeFileSync(manifestPath, 'baseline')
    writeFileSync(androidLog, '기존 로그\n')
    const events: BuildCompletion[] = []
    let manifest: unknown = { logs: {} }
    const poller = new BuildCompletionPoller(
      () => ({ enabled: true, xcodeEnabled: true, androidEnabled: true }),
      (event) => { events.push(event) },
      { homeDir, manifestReader: async () => manifest },
    )

    await poller.pollNow()
    expect(events).toEqual([])

    const now = Date.now() + 1_000
    manifest = { logs: { next: {
      uniqueIdentifier: 'next', title: 'Build App', timeStartedRecording: (now - 10_000 - 978_307_200_000) / 1000,
      timeStoppedRecording: (now - 978_307_200_000) / 1000, primaryObservable: { highLevelStatus: 'S', totalNumberOfErrors: 0 },
    } } }
    appendFileSync(manifestPath, 'changed')
    appendFileSync(androidLog, [
      '2026-07-15 17:30:00,000 [1] INFO - #GradleBuildInvoker - About to execute Gradle tasks: [:app:assembleDebug]',
      '2099-07-15 17:30:05,000 [2] INFO - #GradleBuildInvoker - Gradle build finished in 5 s',
      '',
    ].join('\n'))
    await poller.pollNow()

    expect(events.map((event) => [event.tool, event.result, event.title])).toEqual([
      ['xcode', 'success', 'App'],
      ['android', 'success', ':app:assembleDebug'],
    ])
  })
})
