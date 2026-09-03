import { defineConfig } from 'tsdown'

/** Build the host entry and the optional browser adapter independently. */
export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: 'esm', platform: 'node', target: 'node20', outDir: 'lib', clean: false, dts: false },
  {
    entry: { client: 'src/client.ts' }, format: 'cjs', platform: 'browser', target: 'es2023', outDir: 'lib', clean: false, dts: false,
    // The lightweight workbench owns its React/CodeMirror runtime. Only
    // Cordis comes from the DSH client module table, so it stays usable
    // when BetterSidebar (and its editor chunk) is absent.
    external: ['cordis'], noExternal: (id: string) => id === 'cordis' ? undefined : true,
    // React's browser development entry branches on this value. The DSH
    // module loader has no Node `process` global, so it must be replaced at
    // build time just as BetterSidebar does for its editor chunk.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-code-navigator", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
])
