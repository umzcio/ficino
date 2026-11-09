// Summary and synthesis messages come from model output. The server keeps only string fields now, but a row stored
// before that (or an offline-cached copy) can carry any JSON type, and a message that throws while rendering would
// unmount the whole app. These render PaperChat and GroupChatView with such messages and expect no throw.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { PaperChat } from './PaperChat'
import { GroupChatView } from './GroupChatView'
import * as api from '../../lib/api'
import * as cache from '../../lib/offline-cache'

vi.mock('../../lib/api', () => ({
  getPaperSummary: vi.fn(),
  getPaperSummaryStatus: vi.fn(),
  getGroupChat: vi.fn(),
  isNotFoundError: vi.fn(() => false),
  getApiErrorDetail: vi.fn((_e: unknown, fallback: string) => fallback),
}))
vi.mock('../../lib/offline-cache', () => ({
  cachePaperSummary: vi.fn(() => Promise.resolve()),
  getCachedPaperSummary: vi.fn(() => Promise.resolve(null)),
  cacheGroupChat: vi.fn(() => Promise.resolve()),
  getCachedGroupChat: vi.fn(() => Promise.resolve(null)),
}))

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

const MISTYPED: Record<string, unknown>[] = [
  { role: 'paper', type: {}, content: 'object type' },
  { role: 'paper', type: '__proto__', content: 'proto type' },
  { role: 'paper', type: 'constructor', content: 'constructor type' },
  { role: 'paper', type: 'toString', paper_ref: { a: 1 }, content: 'object ref' },
  { role: 'paper', type: 'intro', paper_ref: [{}], content: 'array ref' },
  { role: 'paper', type: ['x'], paper_ref: 7, content: 'number ref' },
  { role: { a: 1 }, type: ['x'], content: 'object role' },
  { role: 'synthesis', type: '__proto__', content: 'synthesis proto' },
  { role: 'synthesis', type: 'hasOwnProperty', content: 'synthesis own' },
  { role: 'synthesis', type: 'gap', content: { a: 1 } },
  { role: 'paper', type: 'tldr', content: 'the tldr' },
]

const summary = (messages: unknown[]) => ({
  paper_id: 'p1', title: 'A paper', authors: [], messages, status: 'complete',
}) as unknown as Awaited<ReturnType<typeof api.getPaperSummary>>

const group = (messages: unknown[]) => ({
  id: 'g1', name: 'A group', papers: { p1: 'A paper' }, messages, status: 'complete',
}) as unknown as Awaited<ReturnType<typeof api.getGroupChat>>

describe('PaperChat with mistyped stored messages', () => {
  it('renders every message without a React error', async () => {
    vi.mocked(api.getPaperSummary).mockResolvedValue(summary(MISTYPED))
    render(<PaperChat paperId="p1" onBack={() => {}} />)
    expect(await screen.findByText('End of summary')).toBeTruthy()
    for (const text of ['object type', 'proto type', 'constructor type', 'object ref', 'array ref', 'the tldr']) {
      expect(screen.getByText(text)).toBeTruthy()
    }
  })

  it('renders an offline-cached summary with the same values', async () => {
    vi.mocked(api.getPaperSummary).mockRejectedValue(new Error('offline'))
    vi.mocked(cache.getCachedPaperSummary).mockResolvedValue(summary(MISTYPED) as never)
    render(<PaperChat paperId="p1" onBack={() => {}} />)
    expect(await screen.findByText('End of summary')).toBeTruthy()
    expect(screen.getByText('proto type')).toBeTruthy()
  })

  it('still labels known types', async () => {
    vi.mocked(api.getPaperSummary).mockResolvedValue(summary([{ role: 'paper', type: 'methods', content: 'm' }]))
    render(<PaperChat paperId="p1" onBack={() => {}} />)
    expect(await screen.findByText('Methodology')).toBeTruthy()
  })
})

describe('GroupChatView with mistyped stored messages', () => {
  it('renders every message without a React error', async () => {
    vi.mocked(api.getGroupChat).mockResolvedValue(group(MISTYPED))
    render(<GroupChatView groupId="g1" onBack={() => {}} />)
    expect(await screen.findByText('End of synthesis')).toBeTruthy()
    for (const text of ['object type', 'proto type', 'object ref', 'array ref', 'object role', 'synthesis proto', 'synthesis own']) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    // A non-text paper_ref falls back to the generic label; a number shows as its text.
    expect(screen.getAllByText('Paper').length).toBeGreaterThan(0)
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('renders an offline-cached synthesis with the same values', async () => {
    vi.mocked(api.getGroupChat).mockRejectedValue(new Error('offline'))
    vi.mocked(cache.getCachedGroupChat).mockResolvedValue(group(MISTYPED) as never)
    render(<GroupChatView groupId="g1" onBack={() => {}} />)
    expect(await screen.findByText('End of synthesis')).toBeTruthy()
    expect(screen.getByText('synthesis proto')).toBeTruthy()
  })

  it('still labels known synthesis types', async () => {
    vi.mocked(api.getGroupChat).mockResolvedValue(group([{ role: 'synthesis', type: 'contradiction', content: 'c' }]))
    render(<GroupChatView groupId="g1" onBack={() => {}} />)
    expect(await screen.findByText('Tension')).toBeTruthy()
  })
})
