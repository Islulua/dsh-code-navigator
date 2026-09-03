import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { resolveConfig } from '../src/config.ts'
import { commandFor, PersistentWorkspace, type NavigatorStatus } from '../src/persistent-server.ts'

describe('language-server launch', () => {
  const config = resolveConfig(undefined)

  it('passes the discovered compilation database directory to configured clangd', () => {
    const launch = commandFor({ language: 'cpp', server: 'clangd', configPath: '/workspace/build/compile_commands.json' }, config)
    expect(launch).toEqual({ command: 'clangd', args: [`--compile-commands-dir=${dirname('/workspace/build/compile_commands.json')}`, '--background-index'], external: true })
  })

  it('launches bundled Python and TypeScript servers through Node', () => {
    const pyright = commandFor({ language: 'python', server: 'pyright', configPath: null }, config)
    const typescript = commandFor({ language: 'typescript', server: 'typescript-language-server', configPath: null }, config)
    expect(pyright.command).toBe(process.execPath)
    expect(pyright.args[0]).toMatch(/pyright[/\\]langserver\.index\.js$/)
    expect(pyright.external).toBe(false)
    expect(typescript.command).toBe(process.execPath)
    expect(typescript.args[0]).toMatch(/typescript-language-server[/\\]lib[/\\]cli\.mjs$/)
    expect(typescript.args).toContain('--tsserver-path')
    expect(typescript.external).toBe(false)
  })

  it('publishes a failed phase when a configured native server is missing', async () => {
    const statuses: NavigatorStatus[] = []
    const root = { targetKey: '/workspace' as FsTarget['targetKey'], displayPath: '/workspace' }
    const workspace = new PersistentWorkspace(
      { target: root, canonicalPath: '/workspace', fileUrl: 'file:///workspace' },
      { language: 'cpp', server: 'clangd', configPath: null },
      {
        fs: {} as FileSystem,
        subprocess: {
          async resolveExecutable() { throw new Error('not found') },
          spawn() { throw new Error('spawn must not run') },
        },
        config,
      },
      status => { statuses.push(status) },
    )
    await expect(workspace.start()).rejects.toThrow('install it or configure its command')
    expect(statuses.at(-1)?.phase).toBe('failed')
  })
})
