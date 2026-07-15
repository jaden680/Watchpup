import { describe, expect, it, vi } from 'vitest'
import { focusVisiblePanel, type ActivatablePanel } from './panel-activation.js'

function panel({ visible = true, minimized = false } = {}): ActivatablePanel {
  return {
    isVisible: vi.fn(() => visible),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
}

describe('panel activation', () => {
  it('앱이 다시 활성화되면 열려 있는 패널을 앞으로 가져온다', () => {
    const target = panel()

    expect(focusVisiblePanel(target)).toBe(true)
    expect(target.show).toHaveBeenCalledOnce()
    expect(target.focus).toHaveBeenCalledOnce()
  })

  it('최소화된 패널은 복원한 뒤 포커스한다', () => {
    const target = panel({ minimized: true })

    focusVisiblePanel(target)

    expect(target.restore).toHaveBeenCalledOnce()
    expect(target.focus).toHaveBeenCalledOnce()
  })

  it('숨긴 패널은 앱 전환만으로 다시 열지 않는다', () => {
    const target = panel({ visible: false })

    expect(focusVisiblePanel(target)).toBe(false)
    expect(target.show).not.toHaveBeenCalled()
    expect(target.focus).not.toHaveBeenCalled()
  })
})
