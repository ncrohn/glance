import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Node 25+ defines its own localStorage global, a stub without
    // --localstorage-file, which hides jsdom's in the DOM tests.
    execArgv: ["--no-webstorage"],
  },
});
