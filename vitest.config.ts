import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Agent worktrees live under .claude/worktrees and carry their own copy of
    // the suite. Collecting those runs another branch's tests against this
    // one's dependencies, which fails for reasons that have nothing to do with
    // the code under test.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    server: {
      deps: {
        // @openswitchboard/schema ships TS source; let vite-node transform it.
        inline: [/@openswitchboard\/schema/],
      },
    },
  },
});
