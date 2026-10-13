import { defineConfig } from "vitest/config";
import path from "path";

// 与 tsconfig paths 对齐 —— "@/" → 项目根
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
