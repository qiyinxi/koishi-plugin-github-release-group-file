import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/service'

describe('user-facing file sizes', () => {
  it('formats the requested AUTO-MAS asset size', () => {
    expect(formatBytes(160903836)).toBe('153.45 MiB')
  })
})
