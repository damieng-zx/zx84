import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import viteCompression from 'vite-plugin-compression';

// (buildTimePlugin removed — logo is static HTML)

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

/// <reference types="vitest/config" />

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    solidPlugin(),
    ...(mode === 'production' ? [
      viteCompression({ algorithm: 'gzip', threshold: 1024 }),
      viteCompression({ algorithm: 'brotliCompress', threshold: 1024, ext: '.br' }),
    ] : []),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    // HMR disabled — saves require a manual browser refresh. The SZX snapshot
    // saved on `beforeunload` (see saveRefreshState) makes that refresh resume the
    // machine where it left off.
    hmr: false,
    headers: {
      // Required for SharedArrayBuffer (AudioWorklet ring buffer)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    environment: 'node',
    // Vite leaks file handles on shutdown (~3 per source file imported, no
    // stack traces — internal to Vite's transform pipeline, not our code).
    // forceExit kills the process after teardownTimeout; 500 ms is long
    // enough for clean shutdowns to win, short enough that the leaked-handle
    // case doesn't stall the run by 10 s.
    forceExit: true,
    teardownTimeout: 500,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/display/renderer.ts'],
    },
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      plugins: [
      ],
    },
    assetsInlineLimit: 4096,
    cssCodeSplit: false,
    sourcemap: false,
  },
}));
