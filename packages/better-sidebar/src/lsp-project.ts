/** Workspace language-project discovery used by sidebar LSP warm-up status. */
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'

/** Project configuration selected for one source file. */
export interface LspProjectInfo {
  server: 'clangd' | 'pyright' | 'typescript-language-server' | 'lsp'
  configPath: string | null
}

const CPP_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inc', '.inl', '.ipp', '.tpp'])
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'third_party'])

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Find a named file while walking from a source directory back to the workspace. */
async function findInAncestors(cwd: string, sourcePath: string, names: readonly string[]): Promise<string | null> {
  let dir = dirname(sourcePath)
  for (;;) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (await isFile(candidate)) return candidate
    }
    if (dir === cwd) return null
    const parent = dirname(dir)
    if (parent === dir || relative(cwd, parent).startsWith('..')) return null
    dir = parent
  }
}

/** Locate a compilation database in common build trees without an unbounded workspace crawl. */
async function findCompilationDatabase(cwd: string): Promise<string | null> {
  const preferred = [
    join(cwd, 'compile_commands.json'),
    join(cwd, 'build', 'compile_commands.json'),
    join(cwd, 'out', 'build', 'compile_commands.json'),
  ]
  for (const path of preferred) if (await isFile(path)) return path

  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 500) {
    const current = queue.shift()
    if (current === undefined) break
    visited += 1
    let entries: Dirent[]
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some(entry => entry.isFile() && entry.name === 'compile_commands.json')) {
      return join(current.dir, 'compile_commands.json')
    }
    if (current.depth >= 4) continue
    const directories = entries
      .filter(entry => entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.'))
      .sort((left, right) => {
        const rank = (name: string): number => /^(build|out|cmake-build)/i.test(name) ? 0 : 1
        return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name)
      })
    for (const entry of directories) queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
  }
  return null
}

/** Detect the language server and nearest project configuration for a source file. */
export async function detectLspProject(cwd: string, sourcePath: string): Promise<LspProjectInfo> {
  const extension = extname(sourcePath).toLowerCase()
  if (CPP_EXTENSIONS.has(extension)) {
    const ancestor = await findInAncestors(cwd, sourcePath, ['compile_commands.json'])
    return { server: 'clangd', configPath: ancestor ?? await findCompilationDatabase(cwd) }
  }
  if (extension === '.py' || extension === '.pyi') {
    return {
      server: 'pyright',
      configPath: await findInAncestors(cwd, sourcePath, ['pyrightconfig.json', 'pyproject.toml', 'setup.cfg']),
    }
  }
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    return {
      server: 'typescript-language-server',
      configPath: await findInAncestors(cwd, sourcePath, ['tsconfig.json', 'jsconfig.json']),
    }
  }
  return { server: 'lsp', configPath: null }
}
