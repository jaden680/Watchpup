interface LoginItemHost {
  isPackaged: boolean
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
}

/** 설치된 macOS 앱만 로그인 시 자동 실행 대상으로 등록한다. */
export function ensureOpenAtLogin(host: LoginItemHost, platform = process.platform): boolean {
  if (platform !== 'darwin' || !host.isPackaged) return false
  host.setLoginItemSettings({ openAtLogin: true })
  return true
}
