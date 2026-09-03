/** Bounded project discovery through the active DSH filesystem provider. */
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { posix, win32 } from 'node:path'
import type { ResolvedCodeNavigatorConfig } from './config.ts'

/** Language-server selection and its nearest project configuration. */
export interface ProjectInfo {
  language: 'cpp' | 'python' | 'typescript' | null
  server: 'clangd' | 'pyright' | 'typescript-language-server' | null
  configPath: string | null
}

/** Filesystem operations required by project discovery. */
export type ProjectFileSystem = Pick<FileSystem, 'resolve' | 'processPath' | 'contains' | 'stat' | 'listDir'>

const CPP = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inc', '.inl', '.ipp', '.tpp'])
const TS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'third_party'])

function pathApi(path: string): typeof posix {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') ? win32 : posix
}

async function isFile(fs: ProjectFileSystem, root: FsTarget, path: string): Promise<boolean> {
  try {
    const target = await fs.resolve(path)
    return fs.contains(root, target) && (await fs.stat(target))?.type === 'file'
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

async function workspaceTargets(fs: ProjectFileSystem, cwd: string, sourcePath: string): Promise<{ root: FsTarget; sourcePath: string; rootPath: string }> {
  const root = await fs.resolve(cwd)
  const source = await fs.resolve(sourcePath, { cwd })
  if (!fs.contains(root, source)) throw new Error('source path resolves outside the workspace')
  return { root, sourcePath: fs.processPath(source), rootPath: fs.processPath(root) }
}

async function ancestorFile(fs: ProjectFileSystem, root: FsTarget, rootPath: string, sourcePath: string, names: readonly string[]): Promise<string | null> {
  const paths = pathApi(sourcePath)
  let current = paths.dirname(sourcePath)
  for (;;) {
    for (const name of names) {
      const candidate = paths.join(current, name)
      if (await isFile(fs, root, candidate)) return candidate
    }
    if (current === rootPath) return null
    const parent = paths.dirname(current)
    if (parent === current || paths.relative(rootPath, parent).startsWith('..')) return null
    current = parent
  }
}

/** Find a C++ compilation database without leaving the selected workspace. */
export async function findCompilationDatabase(fs: ProjectFileSystem, cwd: string, config: ResolvedCodeNavigatorConfig): Promise<string | null> {
  const root = await fs.resolve(cwd)
  const rootPath = fs.processPath(root)
  const paths = pathApi(rootPath)
  for (const path of [paths.join(rootPath, 'compile_commands.json'), paths.join(rootPath, 'build', 'compile_commands.json'), paths.join(rootPath, 'out', 'build', 'compile_commands.json')]) {
    if (await isFile(fs, root, path)) return path
  }
  const queue: Array<{ target: FsTarget; depth: number }> = [{ target: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < config.projectSearchDirectoryLimit) {
    const current = queue.shift()
    if (current === undefined) break
    visited += 1
    let entries
    try {
      entries = await fs.listDir(current.target)
    } catch (error) {
      if (error instanceof Error) continue
      throw error
    }
    const database = entries.find(entry => entry.type === 'file' && entry.name === 'compile_commands.json')
    if (database !== undefined) return fs.processPath(database.target)
    if (current.depth === config.projectSearchDepth) continue
    const directories = entries.filter(entry => entry.type === 'directory' && !entry.name.startsWith('.') && !SKIP.has(entry.name))
      .sort((left, right) => (/^(build|out|cmake-build)/i.test(left.name) ? 0 : 1) - (/^(build|out|cmake-build)/i.test(right.name) ? 0 : 1) || left.name.localeCompare(right.name))
    for (const directory of directories) queue.push({ target: directory.target, depth: current.depth + 1 })
  }
  return null
}

/** Detect a source file's language server and nearest project file. */
export async function detectProject(fs: ProjectFileSystem, cwd: string, source: string, config: ResolvedCodeNavigatorConfig): Promise<ProjectInfo> {
  const { root, sourcePath, rootPath } = await workspaceTargets(fs, cwd, source)
  const extension = pathApi(sourcePath).extname(sourcePath).toLowerCase()
  if (CPP.has(extension)) return { language: 'cpp', server: 'clangd', configPath: await ancestorFile(fs, root, rootPath, sourcePath, ['compile_commands.json']) ?? await findCompilationDatabase(fs, cwd, config) }
  if (extension === '.py' || extension === '.pyi') return { language: 'python', server: 'pyright', configPath: await ancestorFile(fs, root, rootPath, sourcePath, ['pyrightconfig.json', 'pyproject.toml', 'setup.cfg']) }
  if (TS.has(extension)) return { language: 'typescript', server: 'typescript-language-server', configPath: await ancestorFile(fs, root, rootPath, sourcePath, ['tsconfig.json', 'jsconfig.json']) }
  return { language: null, server: null, configPath: null }
}
