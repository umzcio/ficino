// Post media is loaded only from the API's own paths: a figure from the relative /figures/... path the server signs
// (prefixed with the API base here), audio from the API base's /media/... path the server returns. Anything else (an
// absolute or protocol-relative URL, a stored value of another type) is ignored.
import { describe, it, expect } from 'vitest'
import { API_BASE, apiMediaSrc, figureSrc, withSafeAudio } from './mediaUrl'

describe('figureSrc', () => {
  it('prefixes the API base onto the server-signed relative path', () => {
    expect(API_BASE).toBe('/ficino/api')
    expect(figureSrc('/figures/p/f?token=t')).toBe('/ficino/api/figures/p/f?token=t')
  })

  it.each([
    ['an https URL', 'https://example.invalid/x.png'],
    ['an http URL', 'http://example.invalid/x.png'],
    ['a protocol-relative URL', '//example.invalid/x.png'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['another API path', '/media/feeds/x/audio/post_0.mp3'],
    ['a backslash', '/figures/\\example.invalid/x.png'],
    ['a dot-dot segment', '/figures/../../x.png'],
    ['an encoded dot-dot segment', '/figures/%2e%2e/x.png'],
    ['an empty string', ''],
    ['a number', 5],
    ['an object', { url: '/figures/a' }],
    ['null', null],
    ['undefined', undefined],
  ])('ignores %s', (_label, value) => {
    expect(figureSrc(value)).toBe('')
  })
})

describe('apiMediaSrc', () => {
  it('passes the server-built /media/ URL under the API base', () => {
    const url = '/ficino/api/media/feeds/abc/audio/post_0.mp3?token=t'
    expect(apiMediaSrc(url)).toBe(url)
  })

  it.each([
    ['an https URL', 'https://example.invalid/x.mp3'],
    ['a protocol-relative URL', '//example.invalid/x.mp3'],
    ['a bare /media/ path outside the API base', '/media/feeds/abc/audio/post_0.mp3'],
    ['a figure path', '/ficino/api/figures/p/f?token=t'],
    ['a dot-dot segment', '/ficino/api/media/../../x.mp3'],
    ['a backslash', '/ficino/api/media/\\x.mp3'],
    ['a number', 1],
    ['null', null],
  ])('ignores %s', (_label, value) => {
    expect(apiMediaSrc(value)).toBeNull()
  })
})

describe('withSafeAudio', () => {
  it('drops an external audio_url and keeps an API one; the post is otherwise unchanged', () => {
    const ok = { id: 1, content: 'a', audio_url: '/ficino/api/media/feeds/f/audio/post_0.mp3?token=t' }
    const bad = { id: 2, content: 'b', audio_url: 'https://example.invalid/x.mp3' }
    const [a, b] = withSafeAudio([ok, bad] as never[])
    expect(a).toBe(ok)
    expect(b).toEqual({ id: 2, content: 'b', audio_url: null })
  })
})
