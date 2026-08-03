// Regression test for the e2e 17.4 wedge: requestClose() sets closing=true,
// and the parent keeps MobileDrawer mounted while closed (it returns null
// instead of unmounting), so `closing` survived into the next open — the
// drawer rendered off-canvas (translate-x-[-100%]) with every close path
// short-circuited by the `closing` guard. Repro: open → Escape → re-open.
// Child panels are mocked at the module boundary so the test stays at the
// drawer's own behavior level.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { MobileDrawer } from './MobileDrawer'

vi.mock('../Upload/PaperUpload', () => ({ PaperUpload: () => null }))
vi.mock('../Sidebar/CorpusPanel', () => ({ CorpusPanel: () => null }))
vi.mock('../Sidebar/PersonaPanel', () => ({ PersonaPanel: () => null }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const baseProps = {
  open: true,
  onClose: vi.fn(),
  corpus: {
    papers: [],
    loading: false,
    uploading: false,
    error: null,
    upload: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn(),
  },
  enabledPersonas: {},
  activeTag: null,
  onTagFilter: vi.fn(),
}

/** Runs the 17.4 repro: open → Escape → exit timer → parent closes → re-open. */
function renderReopenedDrawer() {
  vi.useFakeTimers()
  const onClose = vi.fn()
  const props = { ...baseProps, onClose }
  const { rerender } = render(<MobileDrawer {...props} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  act(() => { vi.advanceTimersByTime(200) })
  expect(onClose).toHaveBeenCalledTimes(1)
  rerender(<MobileDrawer {...props} open={false} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  rerender(<MobileDrawer {...props} open={true} />)
  return onClose
}

describe('MobileDrawer', () => {
  it('re-opens on-canvas after an Escape close (not stuck in the closing state)', () => {
    renderReopenedDrawer()
    const dialog = screen.getByRole('dialog')
    // Exact-token check: `starting:translate-x-[-100%]` is always present;
    // the wedged bug put the bare `translate-x-[-100%]` token on the drawer.
    expect(dialog.classList.contains('translate-x-[-100%]')).toBe(false)
    expect(screen.getByRole('button', { name: 'Close drawer' })).toBeTruthy()
  })

  it('close paths still work after the re-open (no wedge)', () => {
    const onClose = renderReopenedDrawer()
    fireEvent.keyDown(document, { key: 'Escape' })
    act(() => { vi.advanceTimersByTime(200) })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
