import { describe, expect, it, vi } from 'vitest'
import {
  PANEL_TAB_STORAGE_KEY,
  normalizePanelTab,
  readPanelTab,
  writePanelTab,
  keyToTabIndex,
  cycleTabIndex,
} from './tab-state.js'

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

  it('숫자 키를 탭 인덱스로 변환한다', () => {
    expect(keyToTabIndex('1', 6)).toBe(0)
    expect(keyToTabIndex('6', 6)).toBe(5)
  })

  it('범위를 벗어나거나 숫자가 아닌 키는 무시한다', () => {
    expect(keyToTabIndex('7', 6)).toBe(null)
    expect(keyToTabIndex('0', 6)).toBe(null)
    expect(keyToTabIndex('a', 6)).toBe(null)
  })

  it('Cmd+[ / Cmd+] 탭 순환 인덱스를 계산한다', () => {
    expect(cycleTabIndex(0, 1, 6)).toBe(1)
    expect(cycleTabIndex(5, 1, 6)).toBe(0) // 마지막에서 다음 → 처음으로 순환
    expect(cycleTabIndex(0, -1, 6)).toBe(5) // 처음에서 이전 → 마지막으로 순환
    expect(cycleTabIndex(3, -1, 6)).toBe(2)
  })

  it('현재 인덱스가 범위 밖(-1 등)이면 0으로 방어한다', () => {
    expect(cycleTabIndex(-1, 1, 6)).toBe(1)
    expect(cycleTabIndex(-1, -1, 6)).toBe(5)
    expect(cycleTabIndex(99, 1, 6)).toBe(1)
    expect(cycleTabIndex(NaN, 1, 6)).toBe(1)
  })

  it('len이 0이거나 유효하지 않으면 0을 반환한다', () => {
    expect(cycleTabIndex(0, 1, 0)).toBe(0)
    expect(cycleTabIndex(0, 1, -3)).toBe(0)
  })
})
