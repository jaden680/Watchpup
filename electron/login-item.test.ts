import { describe, expect, it, vi } from 'vitest'
import { ensureOpenAtLogin } from './login-item.js'

describe('ensureOpenAtLogin', () => {
  it('패키징된 macOS 앱을 로그인 항목으로 등록한다', () => {
    const setLoginItemSettings = vi.fn()

    expect(ensureOpenAtLogin({ isPackaged: true, setLoginItemSettings }, 'darwin')).toBe(true)
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  it('개발 실행과 다른 플랫폼에서는 로그인 항목을 변경하지 않는다', () => {
    const setLoginItemSettings = vi.fn()

    expect(ensureOpenAtLogin({ isPackaged: false, setLoginItemSettings }, 'darwin')).toBe(false)
    expect(ensureOpenAtLogin({ isPackaged: true, setLoginItemSettings }, 'linux')).toBe(false)
    expect(setLoginItemSettings).not.toHaveBeenCalled()
  })
})
