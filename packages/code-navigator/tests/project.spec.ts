import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectProject, findCompilationDatabase } from '../src/project.ts'

describe('project discovery', () => {
  it('prioritizes the conventional build compilation database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-navigator-'))
    await mkdir(join(root, 'build'), { recursive: true })
    await writeFile(join(root, 'build', 'compile_commands.json'), '[]')
    await writeFile(join(root, 'main.cpp'), 'int main() {}')
    await expect(findCompilationDatabase(root)).resolves.toBe(join(root, 'build', 'compile_commands.json'))
    await expect(detectProject(root, join(root, 'main.cpp'))).resolves.toEqual({ language: 'cpp', server: 'clangd', configPath: join(root, 'build', 'compile_commands.json') })
  })

  it('finds the nearest TypeScript project file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-navigator-'))
    await mkdir(join(root, 'packages', 'ui', 'src'), { recursive: true })
    await writeFile(join(root, 'packages', 'ui', 'tsconfig.json'), '{}')
    await writeFile(join(root, 'packages', 'ui', 'src', 'view.ts'), 'export {}')
    await expect(detectProject(root, join(root, 'packages', 'ui', 'src', 'view.ts'))).resolves.toEqual({ language: 'typescript', server: 'typescript-language-server', configPath: join(root, 'packages', 'ui', 'tsconfig.json') })
  })
})
