import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('distribution manifests', () => {
  it('keeps the registry metadata aligned with the npm package', async () => {
    const directory = new URL('../', import.meta.url)
    const packageJson = JSON.parse(await readFile(new URL('package.json', directory), 'utf8')) as { version: string; dsh?: { bundle?: { patch?: string } } }
    const registry = JSON.parse(await readFile(new URL('dsh.plugin.json', directory), 'utf8')) as { version: string; main: string }
    expect(registry.version).toBe(packageJson.version)
    expect(registry.main).toBe('./lib/index.mjs')
    expect(packageJson.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})
