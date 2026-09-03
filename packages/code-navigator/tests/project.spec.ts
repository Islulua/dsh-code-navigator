import { mkdtemp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { resolveConfig } from '../src/config.ts'
import { detectProject, findCompilationDatabase, type ProjectFileSystem } from '../src/project.ts'

function target(path: string): FsTarget {
  return { targetKey: path as FsTarget['targetKey'], displayPath: path }
}

const localFs: ProjectFileSystem = {
  async resolve(path, options) { return target(resolve(options?.cwd ?? '', path)) },
  processPath: value => value.displayPath,
  contains(parent, child) {
    const path = relative(parent.displayPath, child.displayPath)
    return path === '' || (!path.startsWith('..') && !isAbsolute(path))
  },
  async stat(value) {
    try {
      const info = await stat(value.displayPath)
      return { version: '' as never, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
    } catch (error) {
      if (error instanceof Error) return undefined
      throw error
    }
  },
  async listDir(value) {
    return await Promise.all((await readdir(value.displayPath, { withFileTypes: true })).map(async entry => ({
      name: entry.name,
      type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : 'other' as const,
      target: target(join(value.displayPath, entry.name)),
    })))
  },
}

const config = resolveConfig(undefined)

describe('project discovery', () => {
  it('prioritizes the conventional build compilation database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-navigator-'))
    await mkdir(join(root, 'build'), { recursive: true })
    await writeFile(join(root, 'build', 'compile_commands.json'), '[]')
    await writeFile(join(root, 'main.cpp'), 'int main() {}')
    await expect(findCompilationDatabase(localFs, root, config)).resolves.toBe(join(root, 'build', 'compile_commands.json'))
    await expect(detectProject(localFs, root, join(root, 'main.cpp'), config)).resolves.toEqual({ language: 'cpp', server: 'clangd', configPath: join(root, 'build', 'compile_commands.json') })
  })

  it('finds the nearest TypeScript project file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-navigator-'))
    await mkdir(join(root, 'packages', 'ui', 'src'), { recursive: true })
    await writeFile(join(root, 'packages', 'ui', 'tsconfig.json'), '{}')
    await writeFile(join(root, 'packages', 'ui', 'src', 'view.ts'), 'export {}')
    await expect(detectProject(localFs, root, join(root, 'packages', 'ui', 'src', 'view.ts'), config)).resolves.toEqual({ language: 'typescript', server: 'typescript-language-server', configPath: join(root, 'packages', 'ui', 'tsconfig.json') })
  })

  it('rejects source paths outside the workspace before configuration discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-navigator-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-code-navigator-outside-'))
    await writeFile(join(outside, 'secret.cpp'), 'int secret;')
    await expect(detectProject(localFs, root, join(outside, 'secret.cpp'), config)).rejects.toThrow('outside the workspace')
  })
})
