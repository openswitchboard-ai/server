import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    server: {
      deps: {
        // @openswitchboard/schema ships TS source; let vite-node transform it.
        inline: [/@openswitchboard\/schema/],
      },
    },
  },
});
