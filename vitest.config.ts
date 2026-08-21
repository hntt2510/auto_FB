import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(process.cwd(), 'src/shared'), '@main': resolve(process.cwd(), 'src/main') } },
  test: { environment: 'node' }
});
