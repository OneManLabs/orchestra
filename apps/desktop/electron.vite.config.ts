import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const productionCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function productionCspPlugin(): Plugin {
  return {
    name: 'fleet-production-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (context.server) return html;
        return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${productionCsp}" />`);
      }
    }
  };
}

export default defineConfig({
  main: {
    // Codex Micro preferences and layout constants are runtime values from the
    // source-only shared workspace package, so they must travel with the app.
    plugins: [externalizeDepsPlugin({ exclude: ['@fleet/shared'] })],
    // LaunchServices starts macOS apps with `/` as cwd. A CommonJS main entry
    // lets Electron resolve its built-in module without the ESM loader relying
    // on the launch-time working directory.
    build: {
      outDir: 'out/main',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed Electron preload scripts are loaded by Electron's restricted
    // CommonJS loader. Electron cannot execute an ESM `import` here even when
    // the surrounding package uses `type: module`.
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    publicDir: '../../public',
    plugins: [react(), productionCspPlugin()],
    build: { outDir: 'out/renderer' },
    resolve: { alias: { '@renderer': new URL('./src/renderer', import.meta.url).pathname } }
  }
});
