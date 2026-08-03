// Render tests for DangerButton's confirm flow, including the plan-024
// failure state. Distinct from primitives.test.ts, which covers the
// runDangerConfirm helper in the node environment.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DangerButton } from './primitives'

afterEach(cleanup)

describe('DangerButton', () => {
  it('clicking the label reveals Confirm and Cancel', () => {
    render(<DangerButton label="Delete everything" onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('shows "Done" after a resolving confirm', async () => {
    render(<DangerButton label="Delete everything" onConfirm={() => Promise.resolve()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Done')).toBeTruthy()
    expect(screen.queryByText('Failed — try again')).toBeNull()
  })

  it('shows the failure state (not "Done") after a rejecting confirm', async () => {
    render(<DangerButton
      label="Delete everything"
      onConfirm={() => Promise.reject(new Error('boom'))}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Failed — try again')).toBeTruthy()
    expect(screen.queryByText('Done')).toBeNull()
    // Confirm stays available so the user can retry.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
  })
})
