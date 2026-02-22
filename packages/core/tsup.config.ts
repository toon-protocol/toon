import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/nip34/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
});
