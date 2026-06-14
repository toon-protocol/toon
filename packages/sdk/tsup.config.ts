import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/swap.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
});
