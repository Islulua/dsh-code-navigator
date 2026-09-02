import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectLspProject } from '../src/lsp-project.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-project-'))
  roots.push(root)
  return root
}

describe('language project discovery', () => {
  it('finds the common build/compile_commands.json layout for a source file', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'build'), { recursive: true })
    await writeFile(join(root, 'build', 'compile_commands.json'), '[]')

    await expect(detectLspProject(root, join(root, 'src', 'main.cpp'))).resolves.toEqual({
      server: 'clangd',
      configPath: join(root, 'build', 'compile_commands.json'),
    })
  })

  it('prefers the nearest TypeScript project configuration', async () => {
    const root = await workspace()
    await mkdir(join(root, 'packages', 'app', 'src'), { recursive: true })
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(join(root, 'packages', 'app', 'tsconfig.json'), '{}')

    await expect(detectLspProject(root, join(root, 'packages', 'app', 'src', 'index.ts'))).resolves.toEqual({
      server: 'typescript-language-server',
      configPath: join(root, 'packages', 'app', 'tsconfig.json'),
    })
  })

  it('reports a Python workspace even when pyright uses automatic discovery', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })

    await expect(detectLspProject(root, join(root, 'src', 'main.py'))).resolves.toEqual({
      server: 'pyright',
      configPath: null,
    })
  })
})
