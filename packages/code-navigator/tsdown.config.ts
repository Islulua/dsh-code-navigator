import { defineConfig } from 'tsdown'

/** Build the host entry and the optional browser adapter independently. */
export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: 'esm', platform: 'node', target: 'node20', outDir: 'lib', clean: false, dts: false },
  {
    entry: { client: 'src/client.ts' }, format: 'cjs', platform: 'browser', target: 'es2023', outDir: 'lib', clean: false, dts: false,
    external: ['cordis'],
    // Only Cordis is supplied by DSH's browser module table. CodeMirror is
    // plugin-owned and must be embedded, otherwise the loader rejects its
    // runtime require before the optional sidebar adapter can activate.
    noExternal: (id: string) => (id === 'cordis' ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-code-navigator", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
])
