export const PANEL_TAB_STORAGE_KEY = 'watchpup.panel.activeTab'

const PANEL_TABS = new Set(['mentions', 'agent', 'todos', 'work', 'digest', 'settings'])

export const PANEL_TAB_ORDER = Array.from(PANEL_TABS)

export function normalizePanelTab(value) {
  return typeof value === 'string' && PANEL_TABS.has(value) ? value : 'mentions'
}

// Cmd+1..9 단축키의 "키 → 탭 인덱스" 변환 (범위를 벗어나면 null)
export function keyToTabIndex(key, tabsLength) {
  if (typeof key !== 'string' || !/^[1-9]$/.test(key)) return null
  const index = Number(key) - 1
  return index < tabsLength ? index : null
}

// Cmd+[ / Cmd+] 탭 순환의 "다음 인덱스" 계산 (current가 범위 밖이면 0으로 방어)
export function cycleTabIndex(current, delta, len) {
  if (!Number.isInteger(len) || len <= 0) return 0
  const base = Number.isInteger(current) && current >= 0 && current < len ? current : 0
  return ((base + delta) % len + len) % len
}

export function readPanelTab(storage = globalThis.localStorage) {
  try {
    return normalizePanelTab(storage?.getItem(PANEL_TAB_STORAGE_KEY))
  } catch {
    return 'mentions'
  }
}

export function writePanelTab(value, storage = globalThis.localStorage) {
  if (normalizePanelTab(value) !== value) return false
  try {
    storage?.setItem(PANEL_TAB_STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}
