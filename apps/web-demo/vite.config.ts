import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // workspace 源码态：@yo-agent/* 经包 exports 已可解析；paths 插件兜底子路径别名（/core）。
  plugins: [tsconfigPaths({ projects: ['../../tsconfig.json'] })],
  server: { port: 5177 },
});
