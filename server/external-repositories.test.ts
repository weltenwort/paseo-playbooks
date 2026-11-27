import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findEntry, findInternal } from "../shared/repos";
import type { Run } from "../shared/types";
import { expandHome, readExternalRepositories, setExternalRepository, userConfigFile } from "./config";
import { chooseDefinition, resolveForNewRun } from "./fresh";
import { gatesOnBehalfSetting, hasPlaybooks, playbookAccess, listExternalRepositories, loadPlaybooks, loadRepositoryFolder, loadSidekick, projectProfiles } from "./loader";
import { Runtime } from "./runtime";
import { createStarter } from "./starter";
import { RunStore } from "./store";
import { externalStartTools } from "./tools";
import { staleDefinitionCandidate } from "./warden";

const BASE = ".paseo/plugins/playbooks";
const temps: string[] = [];
const runtimes: Runtime[] = [];
let savedHome: string | undefined;

async function tempDir(prefix = "external-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

const ROLE = (title: string) => `title: ${title}\nreadonly: true\n`;
const PLAYBOOK = (role: string) => `steps:\n  - id: a\n    role: { name: ${role}, prompt: go }\n`;
const SCRIPTED = `title: Check\nsteps:\n  - id: check\n    script: { run: check.sh }\n`;

/** An external repository: `deploy` (role `coder`, its own), `check` (a script step). */
async function repository(extra: Record<string, string> = {}): Promise<string> {
  const dir = await tempDir("external-repo-");
  await put(dir, {
    "deploy.yaml": PLAYBOOK("coder"),
    "check.yaml": SCRIPTED,
    "roles/coder/role.yaml": ROLE("External coder"),
    "roles/coder/instructions.md": "external coder instructions",
    "scripts/check.sh": "#!/bin/sh\necho '{\"summary\": \"v1\"}'\n",
    ...extra,
  });
  await chmod(path.join(dir, "scripts/check.sh"), 0o755);
  return dir;
}

/** A project workspace with a default repository: `deploy` and `review` (role `coder`). */
async function workspace(extra: Record<string, string> = {}): Promise<string> {
  const dir = await tempDir("external-ws-");
  await put(dir, {
    [`${BASE}/deploy.yaml`]: PLAYBOOK("coder"),
    [`${BASE}/review.yaml`]: PLAYBOOK("coder"),
    [`${BASE}/roles/coder/role.yaml`]: ROLE("Default coder"),
    [`${BASE}/roles/coder/instructions.md`]: "default coder instructions",
    ...extra,
  });
  return dir;
}

async function writeConfig(text: string): Promise<void> {
  await mkdir(path.dirname(userConfigFile()), { recursive: true });
  await writeFile(userConfigFile(), text);
}

const ids = (result: Awaited<ReturnType<typeof loadPlaybooks>>) => result.entries.map((entry) => entry.id).sort();

beforeEach(async () => {
  savedHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = await tempDir("external-home-");
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  if (savedHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedHome;
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external repositories: config", () => {
  it("reads `repositories` in order, expands ~ and drops malformed entries with a note", async () => {
    await writeConfig(["repositories:", "  mine: { path: ~/src/pb }", "  Bad: { path: /x }", "  default: { path: /y }", "  nopath: {}", "  abs: { path: /opt/pb }"].join("\n"));
    const { repositories, problems } = await readExternalRepositories();
    expect(repositories).toEqual([
      { id: "mine", path: "~/src/pb", resolved: path.join(homedir(), "src/pb") },
      { id: "abs", path: "/opt/pb", resolved: "/opt/pb" },
    ]);
    expect(problems.join("\n")).toMatch(/repositories\.Bad: .*lowercase/);
    expect(problems.join("\n")).toMatch(/repositories\.default: .*own repository/);
    expect(problems.join("\n")).toMatch(/repositories\.nopath: needs a `path`/);
    expect(expandHome("~")).toBe(homedir());
  });

  it("refuses relative and ~user paths, and never overwrites a config that does not parse", async () => {
    await writeConfig("repositories:\n  rel: { path: ./playbooks }\n  other: { path: ~bob/pb }\n");
    const { repositories, problems } = await readExternalRepositories();
    expect(repositories).toEqual([]);
    expect(problems.join("\n")).toMatch(/rel\.path: .*absolute path/);
    expect(problems.join("\n")).toMatch(/other\.path: .*~user are not supported/);
    await writeConfig("repositories: [unclosed\n");
    await expect(setExternalRepository("mine", "~/pb")).rejects.toThrow(/not valid YAML/);
    expect(await readFile(userConfigFile(), "utf8")).toBe("repositories: [unclosed\n");
  });

  it("adds and removes an entry, keeping the rest of the config", async () => {
    await writeConfig("profiles:\n  projects:\n    p: { active: [louis] }\n");
    await setExternalRepository("mine", "~/pb");
    await setExternalRepository("other", "/opt/other");
    expect((await readExternalRepositories()).repositories.map((repo) => repo.id)).toEqual(["mine", "other"]);
    await setExternalRepository("mine", null);
    await setExternalRepository("other", null);
    const text = await readFile(userConfigFile(), "utf8");
    expect(text).not.toMatch(/repositories/);
    expect(text).toMatch(/louis/);
  });
});

describe("external repositories: loading", () => {
  it("loads an external repository in every workspace, qualified, with its own roles and absolute script paths", async () => {
    const repo = await repository();
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const result = await loadPlaybooks(await workspace());
    expect(ids(result)).toEqual(["deploy", "mine:check", "mine:deploy", "review"]);
    const deploy = result.entries.find((entry) => entry.id === "mine:deploy")!;
    expect(deploy).toMatchObject({ repo: "mine", errors: [] });
    expect(deploy.playbook!.external).toEqual({ root: repo });
    expect(Object.values(deploy.playbook!.roles)[0]!.instructions).toBe("external coder instructions");
    expect(result.entries.find((entry) => entry.id === "mine:check")!.playbook!.steps[0]!.script).toBe(path.join(repo, "scripts/check.sh"));
    expect(result.profiles.find((profile) => profile.id === "mine")).toMatchObject({ source: "external", active: true, playbooks: 2, path: repo });
    // A bare id is ambiguous only when two repositories have it.
    expect(findEntry(result.entries, "check")).toMatchObject({ entry: { id: "mine:check" } });
    expect(findEntry(result.entries, "deploy")).toHaveProperty("error");
    // Also in a folder that has no playbooks of its own.
    expect(ids(await loadPlaybooks(await tempDir()))).toEqual(["mine:check", "mine:deploy"]);
  });

  it("keeps a default playbook's bare id for internal lookups when an external repository shares it", async () => {
    await writeConfig(`repositories:\n  mine: { path: ${await repository()} }\n`);
    const result = await loadPlaybooks(await workspace());
    // The panel's Start and hand-offs send the entry's own id: the default deploy, not an ambiguity error.
    expect(findInternal(result.entries, "deploy")).toMatchObject({ entry: { id: "deploy", repo: "default" } });
    expect(findInternal(result.entries, "mine:deploy")).toMatchObject({ entry: { id: "mine:deploy" } });
    // A bare id stored before its playbook was namespaced still resolves to the one entry.
    expect(findInternal(result.entries, "check")).toMatchObject({ entry: { id: "mine:check" } });
  });

  it("reports a missing folder without failing the load", async () => {
    await writeConfig("repositories:\n  gone: { path: /nonexistent/playbooks-repo }\n");
    const result = await loadPlaybooks(await workspace());
    expect(ids(result)).toEqual(["deploy", "review"]);
    expect(result.diagnostics.join("\n")).toMatch(/external repository `gone`: folder \/nonexistent\/playbooks-repo not found/);
    expect(result.profiles.find((profile) => profile.id === "gone")!.errors[0]).toMatch(/not found/);
  });

  it("ignores a project profile named like an external repository", async () => {
    const repo = await repository();
    await writeConfig(`repositories:\n  louis: { path: ${repo} }\n`);
    const dir = await workspace({ [`${BASE}/profiles/louis/personal.yaml`]: PLAYBOOK("coder"), [`${BASE}/profiles/louis/roles/coder/role.yaml`]: ROLE("x"), [`${BASE}/profiles/louis/roles/coder/instructions.md`]: "x" });
    const result = await loadPlaybooks(dir, { activeProfiles: ["louis"] });
    expect(ids(result)).toEqual(["deploy", "louis:check", "louis:deploy", "review"]);
    expect(result.diagnostics.join("\n")).toMatch(/profiles\/louis: ignored, an external repository/);
    const offered = await projectProfiles(dir, "p");
    expect(offered.profiles.map((profile) => `${profile.id}/${profile.source}`)).toEqual(["default/workspace", "louis/external"]);
  });

  it("gives agents of a workspace with only external playbooks list_playbooks and start_playbook, not the manager tools", async () => {
    const empty = await tempDir();
    const own = await workspace();
    expect(await playbookAccess(empty)).toBe("none");
    expect(await playbookAccess(own)).toBe("own");
    await writeConfig(`repositories:\n  mine: { path: ${await repository()} }\n`);
    expect(await playbookAccess(empty)).toBe("external");
    expect(await playbookAccess(own)).toBe("own");
    const runtime = new Runtime(new RunStore(path.join(await tempDir(), "runs")), { autoStartAgents: false });
    runtimes.push(runtime);
    expect(externalStartTools(runtime).map((tool) => tool.name)).toEqual(["list_playbooks", "start_playbook"]);
  });

  it("makes every workspace a playbooks workspace", async () => {
    const empty = await tempDir();
    expect(await hasPlaybooks(empty)).toBe(false);
    await writeConfig(`repositories:\n  mine: { path: ${await repository()} }\n`);
    expect(await hasPlaybooks(empty)).toBe(true);
    // The starter still goes into a workspace whose own folder has no playbook.
    expect(await createStarter(empty)).not.toHaveLength(0);
  });

  it("lists the repositories with their state", async () => {
    const repo = await repository();
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n  gone: { path: /nonexistent/x }\n  BAD: { path: /x }\n`);
    const listed = await listExternalRepositories();
    expect(listed.repositories.map((entry) => [entry.id, entry.playbooks, entry.problem === null])).toEqual([["mine", 2, true], ["gone", 0, false]]);
    expect(listed.problems).toHaveLength(1);
  });

  it("is where project-level settings come from when the project does not set them", async () => {
    const repo = await repository({ "defaults/main.yaml": "gates: { on_behalf: deny }\n" });
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    expect(await gatesOnBehalfSetting(await workspace())).toBe("deny");
    expect(await gatesOnBehalfSetting(await workspace({ [`${BASE}/defaults/main.yaml`]: "gates: { on_behalf: allow }\n" }))).toBe("allow");
  });
});

describe("external repositories: Sidekick", () => {
  it("supplies the Sidekick when the project has none, and yields to the project's", async () => {
    const repo = await repository({ "sidekick/instructions.md": "external sidekick" });
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const alone = await loadSidekick(await workspace());
    expect(alone).toMatchObject({ configured: true, profile: "mine", instructions: "external sidekick", errors: [] });
    const own = await loadSidekick(await workspace({ [`${BASE}/sidekick/instructions.md`]: "project sidekick" }));
    expect(own).toMatchObject({ configured: true, profile: null, instructions: "project sidekick" });
    expect(own.warnings.join("\n")).toMatch(/external repository `mine` is ignored/);
  });

  it("ignores the Sidekick and playbooks of a profile named like an external repository", async () => {
    const repo = await repository({ "sidekick/instructions.md": "external sidekick" });
    await writeConfig(`repositories:\n  ops: { path: ${repo} }\n`);
    const dir = await tempDir();
    await put(dir, { [`${BASE}/profiles/ops/sidekick/instructions.md`]: "profile sidekick", [`${BASE}/profiles/ops/x.yaml`]: PLAYBOOK("coder") });
    expect(await loadSidekick(dir, { activeProfiles: ["ops"] })).toMatchObject({ profile: "ops", instructions: "external sidekick" });
    expect(await playbookAccess(dir)).toBe("external");
  });
});

describe("external repositories: runs", () => {
  it("record their definition as external, and the warden does not call it stale", async () => {
    const repo = await repository();
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const loaded = await loadPlaybooks(await workspace());
    const playbook = loaded.entries.find((entry) => entry.id === "mine:deploy")!.playbook!;
    const chosen = await chooseDefinition({ projectId: "p", playbook, worktreeDir: "/nonexistent", baseRef: "origin/main", baseSha: "abc", fetchError: null });
    expect(chosen.definition).toMatchObject({ source: "external", ref: null, sha: null, warning: null });
    // Even pinned at a commit the project's origin is not at, it is not reported.
    const run = { definition: { ...chosen.definition, sha: "abc" }, createdAt: "2026-01-01T00:00:00Z", status: "running", gates: {}, steps: {} } as unknown as Run;
    expect(staleDefinitionCandidate(run, "def", 0, Date.now(), "report")).toEqual([]);
    const resolved = await resolveForNewRun(await workspace(), loaded);
    expect(resolved.find((item) => item.entry.id === "mine:deploy")!.source).toBe("external");
  });

  it("run their scripts from a copy taken at start, so editing the repository does not change a live run", async () => {
    const repo = await repository();
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const dir = await workspace();
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "mine:check")!.playbook!;
    const store = new RunStore(path.join(await tempDir(), "runs"));
    await store.init();
    const refreshed = { agent: { id: "m", status: "idle", provider: "claude", model: null, archivedAt: null } };
    const paseo = { agents: { ref: () => ({ refresh: async () => refreshed, send: async () => undefined, reload: async () => undefined }) }, workspaces: { ref: () => ({ refresh: async () => ({ id: "ws", projectId: "p", workspaceDirectory: dir }) }) } };
    const runtime = new Runtime(store, { autoStartAgents: false });
    runtimes.push(runtime);
    await runtime.attach(paseo as never);
    // The repository changes before the first check runs: the copy taken at start still says v1.
    const started = runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "mine:check", {}, { playbook });
    const run = await started;
    await writeFile(path.join(repo, "scripts/check.sh"), "#!/bin/sh\necho '{\"summary\": \"v2\"}'\n");
    expect(store.get(run.id)!.scripts).toMatchObject({ source: "external" });
    // The copy was taken before the edit and is what the step runs: it still says v1.
    const copy = path.join(store.get(run.id)!.scripts!.dir, repo, "scripts/check.sh");
    expect(await readFile(copy, "utf8")).toMatch(/v1/);
    const end = Date.now() + 5000;
    while (store.get(run.id)!.steps.check!.status !== "completed" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get(run.id)!.steps.check!.attempts[0]!.report!.summary).toBe("v1");
    // A daemon restart's sweep of orphaned copies keeps it: the run has no worktree, but the copy is its own.
    await runtime.sweepWorktrees();
    expect(existsSync(copy)).toBe(true);
  });
});

describe("external repositories: refresh_scripts", () => {
  it("copies the repository's scripts again, from its folder as it is now", async () => {
    const repo = await repository({ "poll.yaml": "title: Poll\nsteps:\n  - id: wait\n    script: { run: poll.sh, poll: 1m }\n" , "scripts/poll.sh": "#!/bin/sh\nexit 75\n" });
    await chmod(path.join(repo, "scripts/poll.sh"), 0o755);
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const dir = await workspace();
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "mine:poll")!.playbook!;
    const store = new RunStore(path.join(await tempDir(), "runs"));
    await store.init();
    const refreshed = { agent: { id: "m", status: "idle", provider: "claude", model: null, archivedAt: null } };
    const paseo = { agents: { ref: () => ({ refresh: async () => refreshed, send: async () => undefined, reload: async () => undefined }) }, workspaces: { ref: () => ({ refresh: async () => ({ id: "ws", projectId: "p", workspaceDirectory: dir }) }) } };
    const runtime = new Runtime(store, { autoStartAgents: false });
    runtimes.push(runtime);
    await runtime.attach(paseo as never);
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "mine:poll", {}, { playbook });
    const copy = path.join(store.get(run.id)!.scripts!.dir, repo, "scripts/poll.sh");
    expect(await readFile(copy, "utf8")).toMatch(/exit 75/);
    await writeFile(path.join(repo, "scripts/poll.sh"), "#!/bin/sh\nexit 0\n");
    const result = await runtime.refreshScripts(run.id, "test", "me");
    expect(result).toMatchObject({ source: "external", changed: true, definition: "pinned" });
    expect(await readFile(copy, "utf8")).toMatch(/exit 0/);
    expect(store.get(run.id)!.history.some((entry) => entry.type === "scripts_refreshed")).toBe(true);
    // A refresh that would lose a script is refused, and the run keeps its working copy.
    await rm(path.join(repo, "scripts/poll.sh"));
    await expect(runtime.refreshScripts(run.id, "test", "me")).rejects.toThrow(/scripts\/poll\.sh is missing or not executable/);
    expect(await readFile(copy, "utf8")).toMatch(/exit 0/);
  });

  it("copies the target of a symlinked script, not the link", async () => {
    const repo = await repository();
    const outside = await tempDir();
    await put(outside, { "real.sh": "#!/bin/sh\necho '{\"summary\": \"linked\"}'\n" });
    await chmod(path.join(outside, "real.sh"), 0o755);
    await rm(path.join(repo, "scripts/check.sh"));
    await symlink(path.join(outside, "real.sh"), path.join(repo, "scripts/check.sh"));
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const dir = await workspace();
    const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "mine:check")!.playbook!;
    const store = new RunStore(path.join(await tempDir(), "runs"));
    await store.init();
    const refreshed = { agent: { id: "m", status: "idle", provider: "claude", model: null, archivedAt: null } };
    const paseo = { agents: { ref: () => ({ refresh: async () => refreshed, send: async () => undefined, reload: async () => undefined }) }, workspaces: { ref: () => ({ refresh: async () => ({ id: "ws", projectId: "p", workspaceDirectory: dir }) }) } };
    const runtime = new Runtime(store, { autoStartAgents: false });
    runtimes.push(runtime);
    await runtime.attach(paseo as never);
    const run = await runtime.startPlaybook({ id: "m", workspaceId: "ws", cwd: "/" }, "mine:check", {}, { playbook });
    const copy = path.join(store.get(run.id)!.scripts!.dir, repo, "scripts/check.sh");
    expect((await lstat(copy)).isSymbolicLink()).toBe(false);
  });
});

describe("external repositories: validate a clone", () => {
  it("loads a folder laid out as a repository on its own, under its registered id", async () => {
    const repo = await repository();
    await writeConfig(`repositories:\n  mine: { path: ${repo} }\n`);
    const loaded = (await loadRepositoryFolder(repo))!;
    expect(loaded.entries.map((entry) => entry.id).sort()).toEqual(["mine:check", "mine:deploy"]);
    expect(await loadRepositoryFolder(await workspace())).toBeNull();
    // A project with a YAML file at its root and no playbooks folder is not a repository.
    const project = await tempDir();
    await put(project, { "compose.yaml": "services: {}\n" });
    expect(await loadRepositoryFolder(project)).toBeNull();
    const clone = await repository();
    const other = (await loadRepositoryFolder(clone))!;
    // An unregistered clone goes by its folder's name, made a valid id.
    expect(new Set(other.entries.map((entry) => entry.repo))).toEqual(new Set([path.basename(clone).toLowerCase().replace(/[^a-z0-9_-]/g, "-")]));
  });
});
