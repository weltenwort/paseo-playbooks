/**
 * Every test file gets its own empty `$PASEO_HOME`, so the user config of the machine running the tests (its external
 * playbook repositories, profiles, quota limits) never leaks into them. A test that needs a config writes one there.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pb-test-home-"));
