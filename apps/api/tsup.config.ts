import { defineConfig } from 'tsup';

// Bundles the API and inlines the workspace packages (@herp/*), which ship as
// TypeScript source. tsup switches to SWC because emitDecoratorMetadata is on,
// which Nest's dependency injection needs.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@herp\//],
});
