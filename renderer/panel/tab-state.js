export const PANEL_TAB_STORAGE_KEY = 'watchpup.panel.activeTab'

const PANEL_TABS = new Set(['mentions', 'agent', 'todos', 'work', 'digest', 'settings'])

export function normalizePanelTab(value) {
  return typeof value === 'string' && PANEL_TABS.has(value) ? value : 'mentions'
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
