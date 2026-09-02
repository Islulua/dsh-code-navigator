import { defineConfig } from 'tsdown'

/** Build the host entry and the optional browser adapter independently. */
export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: 'esm', platform: 'node', target: 'node20', outDir: 'lib', clean: false, dts: false },
  {
    entry: { client: 'src/client.ts' }, format: 'cjs', platform: 'browser', target: 'es2023', outDir: 'lib', clean: false, dts: false,
    external: ['cordis'],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-code-navigator", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
])
