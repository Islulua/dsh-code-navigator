import { describe, expect, it } from 'vitest'
import { rankQuickOpenFiles } from '../src/quick-open.ts'

describe('Quick Open ranking', () => {
  const root = '/workspace/project'
  const files = [
    `${root}/src/client/navigation.ts`,
    `${root}/src/server/navigator.ts`,
    `${root}/docs/navigation.md`,
    `${root}/package.json`,
  ]

  it('prioritizes filename matches over directory-only matches', () => {
    expect(rankQuickOpenFiles(files, 'nav', root)).toEqual([
      `${root}/docs/navigation.md`,
      `${root}/src/server/navigator.ts`,
      `${root}/src/client/navigation.ts`,
    ])
  })

  it('supports ordered fuzzy characters and a result limit', () => {
    expect(rankQuickOpenFiles(files, 'srvnav', root, 1)).toEqual([
      `${root}/src/server/navigator.ts`,
    ])
  })
})
