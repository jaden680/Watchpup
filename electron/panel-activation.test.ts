import { describe, expect, it, vi } from 'vitest'
import {
  focusVisiblePanel,
  setPanelSwitcherVisibility,
  type ActivatablePanel,
  type ActivationPolicyApp,
} from './panel-activation.js'

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
  it('macOS 패널이 열리면 Cmd+Tab 대상으로 전환한다', () => {
    const app: ActivationPolicyApp = { setActivationPolicy: vi.fn() }

    expect(setPanelSwitcherVisibility(app, true, 'darwin')).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular')
  })

  it('macOS 패널을 숨기면 펫 전용 보조 앱으로 돌아간다', () => {
    const app: ActivationPolicyApp = { setActivationPolicy: vi.fn() }

    setPanelSwitcherVisibility(app, false, 'darwin')

    expect(app.setActivationPolicy).toHaveBeenCalledWith('accessory')
  })

  it('macOS가 아니면 활성화 정책을 바꾸지 않는다', () => {
    const app: ActivationPolicyApp = { setActivationPolicy: vi.fn() }

    expect(setPanelSwitcherVisibility(app, true, 'win32')).toBe(false)
    expect(app.setActivationPolicy).not.toHaveBeenCalled()
  })

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
