export interface ActivatablePanel {
  isVisible(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface ActivationPolicyApp {
  setActivationPolicy(policy: 'regular' | 'accessory'): void
}

export function setPanelSwitcherVisibility(
  app: ActivationPolicyApp,
  visible: boolean,
  platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  app.setActivationPolicy(visible ? 'regular' : 'accessory')
  return true
}

export function focusVisiblePanel(panel: ActivatablePanel | null): boolean {
  if (!panel || !panel.isVisible()) return false
  if (panel.isMinimized()) panel.restore()
  panel.show()
  panel.focus()
  return true
}
