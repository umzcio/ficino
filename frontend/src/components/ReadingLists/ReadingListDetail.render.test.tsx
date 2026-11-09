// A reading list's rationale comes from model output. The server returns text now, but a list stored before that
// (or another JSON type reaching the client) must not crash the overview or the chapter view.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ReadingListDetail } from './ReadingListDetail'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  getReadingList: vi.fn(),
  getFeed: vi.fn(),
  generateChapter: vi.fn(),
  reorderReadingList: vi.fn(),
  getFeedStatus: vi.fn(),
}))

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

const list = (rationales: unknown[]) => ({
  id: 'l1',
  name: 'A list',
  corpus_id: null,
  created_at: '2026-01-01T00:00:00Z',
  papers: rationales.map((rationale, i) => ({ id: `p${i}`, title: `Paper ${i}`, authors: ['A'], year: 2024, rationale })),
  chapters: rationales.map((_r, i) => ({
    id: `c${i}`, chapter_index: i, paper_ids: [`p${i}`], feed_id: `f${i}`, status: 'complete',
  })),
}) as unknown as Awaited<ReturnType<typeof api.getReadingList>>

const RATIONALES: unknown[] = [{ a: 1 }, [{}], 7, 'Read this first.', ['x', 'y'], true]

describe('ReadingListDetail with a mistyped stored rationale', () => {
  it('renders the overview without a React error', async () => {
    vi.mocked(api.getReadingList).mockResolvedValue(list(RATIONALES))
    render(<ReadingListDetail listId="l1" onBack={() => {}} />)
    expect(await screen.findByText('A list')).toBeTruthy()
    expect(screen.getAllByText('Paper 0').length).toBeGreaterThan(0)
    expect(screen.getByText('Read this first.')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
  })

  it.each([['an object', { a: 1 }], ['an array of objects', [{}]], ['a string', 'Why it is first.']])(
    'renders the chapter view when the rationale is %s', async (_l, rationale) => {
      vi.mocked(api.getReadingList).mockResolvedValue(list([rationale]))
      vi.mocked(api.getFeed).mockResolvedValue({ id: 'f0', posts: [] } as never)
      render(<ReadingListDetail listId="l1" onBack={() => {}} />)
      fireEvent.click(await screen.findByText('Read'))
      expect(await screen.findByText(/Chapter 1: Paper 0/)).toBeTruthy()
      if (typeof rationale === 'string') expect(screen.getByText(rationale)).toBeTruthy()
    })
})
