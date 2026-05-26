import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vitest/config';

// 源码里既有 `@/x.ts` 也有 `./x.js`(实际指向 .ts)的导入，
// 这个 pre 解析器把相对 .js 导入映射回存在的 .ts 文件，供 vitest 解析。
const jsToTsResolver = {
  name: 'js-to-ts-resolver',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (importer && source.startsWith('.') && source.endsWith('.js')) {
      const candidate = path.resolve(path.dirname(importer), source.replace(/\.js$/, '.ts'));
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [jsToTsResolver],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
