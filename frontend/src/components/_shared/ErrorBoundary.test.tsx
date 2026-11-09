// A render error must stay inside the boundary that wraps it: the placeholder replaces only the failing subtree,
// siblings keep rendering, and the subtree comes back on "Try again" or when the boundary's resetKey changes.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

let shouldThrow = true
function Flaky({ text }: { text: string }) {
  if (shouldThrow) throw new Error('render failed')
  return <p>{text}</p>
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  shouldThrow = true
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
})

describe('ErrorBoundary', () => {
  it('shows an alert placeholder for the failing subtree and keeps its siblings', () => {
    render(
      <div>
        <p>sibling</p>
        <ErrorBoundary label="post">
          <Flaky text="child" />
        </ErrorBoundary>
      </div>,
    )
    expect(screen.getByText('sibling')).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/couldn.t be displayed/i)
    expect(screen.queryByText('child')).toBeNull()
  })

  it('logs the error to the console', () => {
    render(
      <ErrorBoundary label="post">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    const logged = errorSpy.mock.calls.some((args: unknown[]) =>
      args.some((a: unknown) => a instanceof Error && a.message === 'render failed'),
    )
    expect(logged).toBe(true)
  })

  it('renders the children again after "Try again" once they stop throwing', () => {
    render(
      <ErrorBoundary label="post">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(screen.getByText('child')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('resets when resetKey changes', () => {
    const { rerender } = render(
      <ErrorBoundary label="view" resetKey="a">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    shouldThrow = false
    rerender(
      <ErrorBoundary label="view" resetKey="b">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('child')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays on the placeholder while resetKey is unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary label="view" resetKey="a">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    shouldThrow = false
    rerender(
      <ErrorBoundary label="view" resetKey="a">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('page variant offers a reload as well as a retry', () => {
    render(
      <ErrorBoundary label="app" variant="page">
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })

  it('uses a custom fallback when given one', () => {
    render(
      <ErrorBoundary label="post" fallback={({ reset }) => <button onClick={reset}>custom</button>}>
        <Flaky text="child" />
      </ErrorBoundary>,
    )
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'custom' }))
    expect(screen.getByText('child')).toBeTruthy()
  })
})
