import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Generous, because much of this suite spawns real processes.
    //
    // The scripts bica sends to a remote are tested by running them through an actual shell, the lock
    // is tested by racing actual processes, and the tunnel's cleanup by spawning one. Every one of
    // those takes however long the machine gives it, and the default five seconds is a budget that a
    // laptop running an editor, a language server and a second copy of this suite does not meet: ten
    // tests across six unrelated files failed that way in one run here, none of them for a reason to
    // do with the code. A test that takes twenty seconds to fail is a mild annoyance; a suite that
    // fails depending on what else is running teaches everybody to re-run rather than to look.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
