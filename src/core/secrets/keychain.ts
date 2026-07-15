/**
 * macOS Keychain 시크릿 저장소.
 * 하나의 책임: 시크릿 get/set/delete/has.
 *
 * 1순위: @napi-rs/keyring (Security.framework, prebuilt, 동기 Entry API)
 *   - `security -w <val>`가 argv로 노출(ps)되는 문제를 회피 (리서치 §3 반영).
 * 폴백(읽기): `security` CLI → env (macOS 아님/CI).
 */
import { execFileSync } from 'node:child_process'
import { logger } from '../observability/logger.js'

const DEFAULT_SERVICE = process.env.WATCHPUP_KEYCHAIN_SERVICE || 'watchpup'
function allowEnvFallback(): boolean {
  return process.platform !== 'darwin' || process.env.WATCHPUP_SECRETS_ENV === '1'
}

/** @napi-rs/keyring Entry (지연 로드; 미설치 시 null) */
type KeyringEntry = { getPassword(): string; setPassword(v: string): void; deletePassword(): boolean }
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry }

let keyringMod: KeyringModule | null | undefined
async function getKeyring(): Promise<KeyringModule | null> {
  if (keyringMod !== undefined) return keyringMod
  try {
    keyringMod = (await import('@napi-rs/keyring')) as unknown as KeyringModule
  } catch {
    keyringMod = null
    logger.warn('@napi-rs/keyring 로드 실패 — security CLI/env 폴백 사용')
  }
  return keyringMod
}

function envKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export class Keychain {
  constructor(private readonly service: string = DEFAULT_SERVICE) {}

  private envFallback(key: string): string | null {
    if (!allowEnvFallback()) return null
    return process.env[`WATCHPUP_SECRET_${envKey(key)}`] || process.env[envKey(key)] || null
  }

  async get(key: string): Promise<string | null> {
    const kr = await getKeyring()
    if (kr) {
      try {
        const v = new kr.Entry(this.service, key).getPassword()
        if (v != null && v !== '') return v
      } catch {
        /* 없음 → 폴백 */
      }
    }
    if (process.platform === 'darwin') {
      try {
        const out = execFileSync(
          'security',
          ['find-generic-password', '-a', key, '-s', this.service, '-w'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).replace(/\n$/, '')
        if (out) return out
      } catch {
        /* 없음 → 폴백 */
      }
    }
    return this.envFallback(key)
  }

  async set(key: string, value: string): Promise<void> {
    const kr = await getKeyring()
    if (kr) {
      new kr.Entry(this.service, key).setPassword(value)
      logger.info('keychain set', { key })
      return
    }
    if (process.platform === 'darwin') {
      // 폴백: -w는 argv 노출 위험 — keyring 미가용 시에만.
      execFileSync('security', [
        'add-generic-password',
        '-a',
        key,
        '-s',
        this.service,
        '-w',
        value,
        '-U',
      ])
      logger.info('keychain set (security cli fallback)', { key })
      return
    }
    throw new Error('시크릿 저장 불가: macOS Keychain이 없고 keyring도 로드되지 않았습니다.')
  }

  async delete(key: string): Promise<void> {
    const kr = await getKeyring()
    if (kr) {
      try {
        new kr.Entry(this.service, key).deletePassword()
      } catch {
        /* 없으면 무시 */
      }
      return
    }
    if (process.platform === 'darwin') {
      try {
        execFileSync('security', ['delete-generic-password', '-a', key, '-s', this.service], {
          stdio: 'ignore',
        })
      } catch {
        /* 무시 */
      }
    }
  }

  async has(key: string): Promise<boolean> {
    // 값(-w)을 복호화하지 않고 항목 메타데이터만 조회한다. 설정 화면의
    // 저장 여부 표시 때문에 Keychain 접근 허용 창이 뜨는 일을 피한다.
    if (process.platform === 'darwin') {
      try {
        execFileSync('/usr/bin/security', [
          'find-generic-password',
          '-a', key,
          '-s', this.service,
        ], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    }
    return (await this.get(key)) != null
  }

  async getMany(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const v = await this.get(k)
      if (v != null) out[k] = v
    }
    return out
  }
}

/** 표준 시크릿 키 이름 */
export const SecretKeys = {
  slackBotToken: 'SLACK_BOT_TOKEN',
  slackAppToken: 'SLACK_APP_TOKEN',
  slackUserToken: 'SLACK_USER_TOKEN',
} as const

export const keychain = new Keychain()
