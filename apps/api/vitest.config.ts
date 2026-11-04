import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })], // esbuild cannot emit decorator metadata
  test: { globalSetup: ['test/global-setup.ts'], testTimeout: 30_000, hookTimeout: 120_000, fileParallelism: false },
});
