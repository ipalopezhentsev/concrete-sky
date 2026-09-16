import { defineConfig } from "vite";

// Relative base so the build works from any static host or sub-path.
export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022" },
});
