/**
 * Self-contained tsdown build for the standalone plugin repository.
 *
 * Mirrors @leetoners/dsh-ui-subagent-monitor's dual-output shape:
 *   - Node half  -> lib/index.js (ESM), loaded by the DSH host Loader.
 *   - Browser half -> lib/client.js (CJS closure), served by DSH at
 *     /plugins/<package-name>/client.js; the banner registers the factory
 *     with window.__ModuleLoader__ exactly like DSH's own client bundles.
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = 'dsh-subagent-pro'

/**
 * Platform modules the DSH web loader answers at runtime: they must stay external.
 *
 * Beyond the monitor set we additionally keep the conversation seat slot
 * (used by the new HUD-style toggle) external.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  // Host peer modules — referenced only via ambient types, never bundled.
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-shell',
]

const nodeHalf: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  clean: false,
  dts: false,
  fixedExtension: false,
}

const clientHalf: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  sourcemap: true,
  clean: false,
  dts: false,
  deps: {
    neverBundle: PLATFORM_MODULES,
    alwaysBundle: (id: string) => (PLATFORM_MODULES.includes(id) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([nodeHalf, clientHalf])
