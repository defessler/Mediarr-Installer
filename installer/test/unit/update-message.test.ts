import { describe, it, expect } from 'vitest'
import { splitTrailingUrl } from '../../src/shared/update-message.js'

describe('splitTrailingUrl', () => {
  it('returns a null url when there is no trailing URL', () => {
    expect(splitTrailingUrl('Update failed.')).toEqual({ text: 'Update failed.', url: null })
  })

  it('splits a trailing https URL off and drops the joining whitespace', () => {
    expect(splitTrailingUrl('Update manually from https://example.com/r')).toEqual({
      text: 'Update manually from',
      url: 'https://example.com/r',
    })
  })

  it('handles http as well as https', () => {
    expect(splitTrailingUrl('See http://x.io')).toEqual({ text: 'See', url: 'http://x.io' })
  })

  it('only matches a URL anchored at end-of-string (a mid-string URL stays in text)', () => {
    const r = splitTrailingUrl('visit https://a.com then retry')
    expect(r.url).toBeNull()
    expect(r.text).toBe('visit https://a.com then retry')
  })

  it('a message that is only a URL yields empty lead text', () => {
    expect(splitTrailingUrl('https://only.url/x')).toEqual({ text: '', url: 'https://only.url/x' })
  })
})
