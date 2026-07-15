import { describe, expect, it, vi } from 'vitest'
import { PANEL_TAB_STORAGE_KEY, normalizePanelTab, readPanelTab, writePanelTab } from './tab-state.js'

describe('panel tab state', () => {
  it('저장된 마지막 탭을 복원한다', () => {
    const storage = { getItem: vi.fn(() => 'work') }

    expect(readPanelTab(storage)).toBe('work')
    expect(storage.getItem).toHaveBeenCalledWith(PANEL_TAB_STORAGE_KEY)
  })

  it('알 수 없는 값이나 저장소 오류는 멘션 탭으로 안전하게 대체한다', () => {
    expect(normalizePanelTab('unknown')).toBe('mentions')
    expect(readPanelTab({ getItem: () => { throw new Error('blocked') } })).toBe('mentions')
  })

  it('유효한 탭만 저장한다', () => {
    const storage = { setItem: vi.fn() }

    expect(writePanelTab('agent', storage)).toBe(true)
    expect(writePanelTab('unknown', storage)).toBe(false)
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(storage.setItem).toHaveBeenCalledWith(PANEL_TAB_STORAGE_KEY, 'agent')
  })
})
