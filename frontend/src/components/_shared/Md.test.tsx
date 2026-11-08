import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Md } from './Md'
import { InlineMd } from '../Feed/_shared/InlineMd'

afterEach(cleanup)

// Md and InlineMd take model text; a non-string from stored data renders as text or nothing, never throws.
describe('Md with a non-string text', () => {
  const asProp = (v: unknown) => v as string
  it.each([['an object', { x: 1 }], ['an array', ['a']], ['null', null], ['undefined', undefined]])(
    'renders nothing for %s', (_l, v) => {
      const { container } = render(<div><Md text={asProp(v)} /><InlineMd text={asProp(v)} /></div>)
      expect(container.textContent).toBe('')
    })
  it('renders a number as text', () => {
    render(<Md text={asProp(7)} />)
    expect(screen.getByText('7')).toBeTruthy()
    cleanup()
    render(<InlineMd text={asProp(8)} />)
    expect(screen.getByText('8')).toBeTruthy()
  })
})
