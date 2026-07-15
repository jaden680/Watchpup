export interface ActivatablePanel {
  isVisible(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function focusVisiblePanel(panel: ActivatablePanel | null): boolean {
  if (!panel || !panel.isVisible()) return false
  if (panel.isMinimized()) panel.restore()
  panel.show()
  panel.focus()
  return true
}
