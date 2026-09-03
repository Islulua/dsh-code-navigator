/** File ranking for the standalone workbench's Quick Open palette. */

function normalized(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase()
}

function fuzzyScore(value: string, query: string): number | null {
  let score = 0
  let cursor = 0
  let previous = -2
  for (const character of query) {
    const found = value.indexOf(character, cursor)
    if (found < 0) return null
    score += found === previous + 1 ? 1 : 4 + found - cursor
    previous = found
    cursor = found + 1
  }
  return score
}

/** Rank workspace file paths using filename-first fuzzy matching. */
export function rankQuickOpenFiles(files: readonly string[], query: string, workspace: string, limit = 100): readonly string[] {
  const needle = normalized(query.trim())
  const root = normalized(workspace).replace(/\/$/, '')
  return files.map(path => {
    const value = normalized(path)
    const relative = value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value
    const name = relative.slice(relative.lastIndexOf('/') + 1)
    if (needle === '') return { path, score: 0, relative }
    const filenameScore = fuzzyScore(name, needle)
    const pathScore = fuzzyScore(relative, needle)
    const score = filenameScore === null ? pathScore === null ? null : 100 + pathScore : filenameScore
    return { path, score, relative }
  }).filter((entry): entry is { path: string; score: number; relative: string } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.relative.length - right.relative.length || left.relative.localeCompare(right.relative))
    .slice(0, limit)
    .map(entry => entry.path)
}
