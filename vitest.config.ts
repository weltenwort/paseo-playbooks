import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // isolated-home: the user config of the machine running the tests never applies to them.
    setupFiles: ["./test/isolated-home.ts", "./test/legacy-workspace-lookup.ts"],
    // Every test that uses a RunStore checks, on each mutation, that the event reducers rebuild the state the mutators made (ADR 2026-11-12-event-core).
    env: { PLAYBOOKS_EVENT_PARITY: "throw" },
  },
});
