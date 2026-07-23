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


/** 저장된 좌표(창 좌상단)가 현재 연결된 디스플레이 중 어느 곳에도 속하지 않으면 오프스크린으로 판단. */
function isOnScreen(x: number, y: number): boolean {
  return screen.getAllDisplays().some(({ bounds }) =>
    x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height
  )
}

/** 마스터-디테일 패널 창(목록 + 스레드 + watchpup 한 창). 저장된 크기 있으면 복원. */
export function createPanelWindow(saved?: SavedBounds): BrowserWindow {
  // 저장된 좌표가 오프스크린(분리된 모니터 등)이면 버리고 Electron 기본(주 디스플레이 중앙)에 맡긴다.
  const savedPosValid = saved?.x !== undefined && saved?.y !== undefined && isOnScreen(saved.x, saved.y)
  const win = new BrowserWindow({
    width: saved?.width ?? 1060,
    height: saved?.height ?? 800,
    x: savedPosValid ? saved!.x : undefined,
    y: savedPosValid ? saved!.y : undefined,
    minWidth: 680,
    minHeight: 480,
    frame: false,
    transparent: false,
    // 펫만 항상 맨앞. 패널은 일반 창처럼 — 다른 앱 포커스 시 뒤로.
    alwaysOnTop: false,
    resizable: true,
    // 상세 패널은 macOS Cmd+Tab으로 다시 돌아올 수 있는 일반 창으로 다룬다.
    skipTaskbar: false,
    show: false,
    // 펫은 macOS 비활성 패널이므로, 펫에서 연 창의 첫 클릭이 창 활성화에만
    // 소비되지 않고 실제 컨트롤에도 전달되게 한다.
    acceptFirstMouse: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  // 모든 Space(가상 데스크톱)에 소속시켜, 어느 Space에서 펫을 눌러도 패널이
  // 현재 Space에 뜨게 한다(원래 만들어진 Space로 전환되는 문제 방지). 펫과 동일.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.loadFile(rendererPath('panel', 'index.html')).catch(() => {
    /* renderer/panel은 B6에서 생성 — 그 전까지는 404 무시 */
  })
  return win
}
