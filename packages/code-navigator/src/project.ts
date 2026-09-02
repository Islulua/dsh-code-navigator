/** Bounded workspace configuration discovery shared by every navigator UI. */
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'

/** Language-server selection and its nearest project configuration. */
export interface ProjectInfo {
  language: 'cpp' | 'python' | 'typescript' | null
  server: 'clangd' | 'pyright' | 'typescript-language-server' | null
  configPath: string | null
}

const CPP = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inc', '.inl', '.ipp', '.tpp'])
const TS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'third_party'])

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function ancestorFile(cwd: string, sourcePath: string, names: readonly string[]): Promise<string | null> {
  let current = dirname(sourcePath)
  for (;;) {
    for (const name of names) {
      const candidate = join(current, name)
      if (await isFile(candidate)) return candidate
    }
    if (current === cwd) return null
    const parent = dirname(current)
    if (parent === current || relative(cwd, parent).startsWith('..')) return null
    current = parent
  }
}

/** Find a C++ compilation database without an unbounded workspace crawl. */
export async function findCompilationDatabase(cwd: string): Promise<string | null> {
  for (const path of [join(cwd, 'compile_commands.json'), join(cwd, 'build', 'compile_commands.json'), join(cwd, 'out', 'build', 'compile_commands.json')]) {
    if (await isFile(path)) return path
  }
  const queue: Array<{ path: string; depth: number }> = [{ path: cwd, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 500) {
    const current = queue.shift()
    if (current === undefined) break
    visited += 1
    let entries: Dirent[]
    try { entries = await readdir(current.path, { withFileTypes: true }) } catch { continue }
    if (entries.some(entry => entry.isFile() && entry.name === 'compile_commands.json')) return join(current.path, 'compile_commands.json')
    if (current.depth === 4) continue
    const directories = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name))
      .sort((left, right) => (/^(build|out|cmake-build)/i.test(left.name) ? 0 : 1) - (/^(build|out|cmake-build)/i.test(right.name) ? 0 : 1) || left.name.localeCompare(right.name))
    for (const directory of directories) queue.push({ path: join(current.path, directory.name), depth: current.depth + 1 })
  }
  return null
}

/** Detect a source file's language server and project file. */
export async function detectProject(cwd: string, sourcePath: string): Promise<ProjectInfo> {
  const extension = extname(sourcePath).toLowerCase()
  if (CPP.has(extension)) return { language: 'cpp', server: 'clangd', configPath: await ancestorFile(cwd, sourcePath, ['compile_commands.json']) ?? await findCompilationDatabase(cwd) }
  if (extension === '.py' || extension === '.pyi') return { language: 'python', server: 'pyright', configPath: await ancestorFile(cwd, sourcePath, ['pyrightconfig.json', 'pyproject.toml', 'setup.cfg']) }
  if (TS.has(extension)) return { language: 'typescript', server: 'typescript-language-server', configPath: await ancestorFile(cwd, sourcePath, ['tsconfig.json', 'jsconfig.json']) }
  return { language: null, server: null, configPath: null }
}
