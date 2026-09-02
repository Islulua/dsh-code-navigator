import { defineConfig } from 'tsdown'

/** Build the host-only standalone navigator plugin. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'lib',
  clean: false,
  dts: false,
})
