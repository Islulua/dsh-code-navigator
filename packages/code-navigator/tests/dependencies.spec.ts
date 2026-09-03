import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { LanguageServerDependencies } from '../src/dependencies.ts'

describe('language-server dependency detection', () => {
  it('marks a missing system clangd unavailable without spawning it', async () => {
    let resolutions = 0
    const dependencies = new LanguageServerDependencies({
      async resolveExecutable(command) {
        resolutions += 1
        if (command === 'clangd') throw new Error('not found')
        return command
      },
      spawn() { throw new Error('dependency detection must not spawn a server') },
    }, resolveConfig(undefined))
    const project = { language: 'cpp', server: 'clangd', configPath: null } as const

    await expect(dependencies.check(project)).resolves.toMatchObject({
      server: 'clangd',
      available: false,
      source: 'system',
      message: 'clangd is unavailable; install it or configure its command',
    })
    await dependencies.check(project)
    expect(resolutions).toBe(1)
  })

  it('reports packaged servers independently of a missing clangd', async () => {
    const dependencies = new LanguageServerDependencies({
      async resolveExecutable(command) {
        if (command === 'clangd') throw new Error('not found')
        return command
      },
      spawn() { throw new Error('dependency detection must not spawn a server') },
    }, resolveConfig(undefined))

    const results = await dependencies.all()
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: 'clangd', available: false }),
      expect.objectContaining({ server: 'pyright', available: true, source: 'bundled' }),
      expect.objectContaining({ server: 'typescript-language-server', available: true, source: 'bundled' }),
    ]))
  })
})
