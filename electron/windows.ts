import { app, BrowserWindow, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PRELOAD = join(__dirname, 'preload.js')

/**
 * renderer 정적 파일 경로 해석.
 * 개발: dist/electron/main.js 기준 상대경로(../../renderer)로 프로젝트 루트/renderer.
 * 패키징(asar): 위 상대경로가 존재하지 않을 수 있어 app.getAppPath() 기준으로 보정.
 */
function rendererPath(...segments: string[]): string {
  const devPath = join(__dirname, '..', '..', 'renderer', ...segments)
  if (existsSync(devPath)) return devPath
  return join(app.getAppPath(), 'renderer', ...segments)
}

export function createPetWindow(alwaysOnTop = true): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  // 펫만 있는 컴팩트한 기본 크기. 말풍선이 뜨면 renderer가 pet.resize로 창을 위로 늘린다.
  const win = new BrowserWindow({
    width: 340,
    height: 170,
    x: workAreaSize.width - 370,
    y: workAreaSize.height - 210,
    frame: false,
    transparent: true,
    alwaysOnTop,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    // macOS NSWindowStyleMaskNonactivatingPanel: 펫 클릭은 Watchpup 앱 자체를
    // 활성화하지 않는다. 실제 패널 포커스는 더블클릭 IPC에서만 요청한다.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    focusable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(rendererPath('pet', 'index.html')).catch(() => {
    /* renderer/pet은 B5에서 생성 — 그 전까지는 404 무시 */
  })
  // 기본 click-through, 펫 몸통 hover 시 renderer가 setMouseIgnore(false)로 해제
  win.setIgnoreMouseEvents(true, { forward: true })
  return win
}

export interface SavedBounds {
  x?: number
  y?: number
  width: number
  height: number
}


/** 마스터-디테일 패널 창(목록 + 스레드 + watchpup 한 창). 저장된 크기 있으면 복원. */
export function createPanelWindow(saved?: SavedBounds): BrowserWindow {
  const win = new BrowserWindow({
    width: saved?.width ?? 1060,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 680,
    minHeight: 480,
    frame: false,
    transparent: false,
    // 펫만 항상 맨앞. 패널은 일반 창처럼 — 다른 앱 포커스 시 뒤로.
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  win.loadFile(rendererPath('panel', 'index.html')).catch(() => {
    /* renderer/panel은 B6에서 생성 — 그 전까지는 404 무시 */
  })
  return win
}
