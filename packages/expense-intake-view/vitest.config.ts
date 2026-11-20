import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], test: { name: "expense-intake-view", environment: "jsdom", include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)", "app/**/*.{test,spec}.?(c|m)[jt]s?(x)"], setupFiles: ["./vitest.setup.ts"], restoreMocks: true } });
