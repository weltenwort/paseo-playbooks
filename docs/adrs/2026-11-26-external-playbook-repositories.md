# External playbook repositories

## Status

Accepted

## Context

Playbooks live inside each project: the `default` repository (`.paseo/plugins/playbooks/`) and its opt-in
profiles (`2026-11-11-profiles.md`, `2026-11-11-profiles-per-project.md`). Using the same playbooks in several
repositories meant copying them. Users want to keep their playbooks in a repository of their own, versioned
with git and easy to set up on another machine.

## Decision

- **An external repository is a folder outside the projects, registered in the user config.** In
  `$PASEO_HOME/plugin-data/lerenn/paseo-playbooks/config.yaml`:
  `repositories: { <id>: { path: <folder> } }`. Each entry is a block, so later options (a ref, a git URL)
  can be added without changing the format.
  - The path is absolute, `~` or `~/…`, and it is resolved on the daemon host. Relative and `~user`
    paths are refused, in the config and in the RPC alike.
  - The id follows the profile rules (lowercase letters, digits, `-`, `_`; not `default`).
  - Malformed entries are left out with a diagnostic; they never block loading.
- **The user owns the clone.** The plugin reads the folder as it is on disk. It never clones, fetches or
  pulls. Setting up a machine means cloning the repository there and registering its path.
- **Same layout as the playbooks folder:** playbook YAML at the root, with its own `roles/`, `defaults/`,
  `scripts/` and, optionally, `sidekick/`. One repository per entry, with no `profiles/` inside.
- **Always active, in every project of the host.** There is no per-project switch.
  - Its playbooks go by `<id>:<playbook>`. As with profiles, a bare id still resolves when no other
    repository has it (`2026-11-11-profile-ids-in-refs-and-lookups.md`).
  - Each repository resolves roles, sub-playbooks and hand-offs only inside itself.
  - A project profile with the same id as an external repository is ignored, with a diagnostic.
- **Internal lookups prefer the exact id.** The panel's Start, hand-offs, fan-out children and pipeline
  refreshes resolve a playbook by its exact id first, as `2026-11-11-profiles.md` says internal lookups
  do. A default playbook's bare `deploy` therefore stays the default one when an external repository also
  has a `deploy`. A bare id typed by a user or an agent is still refused when it is ambiguous.
- **Reads of the project's git never match an external entry.** When a run's definition is read from
  origin or from the workspace checkout, an external playbook with the same id is not taken for the
  project's own.
- **Settings writes.** A change from the panel refuses to overwrite a user config that does not parse,
  and every write uses its own temporary file.
- **Agent tools depend on where the playbooks are.**
  - An agent in a workspace with playbooks of its own gets the full manager tools, as before.
  - An agent in a workspace whose only playbooks come from external repositories gets just
    `list_playbooks` and `start_playbook`, not the ~30 manager tools.
    - `start_playbook` hands each run it starts to a Playbook Manager that the plugin creates, with the
      full tools. The caller is never the manager.
    - A run started from the panel or the Run Playbook button reloads its manager's session at
      hand-off, which grants the full tools.
  - `restart_run` with `takeOver` needs playbooks of the workspace's own.
  - The starter files are written to a workspace that has no playbooks of its own, whatever the external
    repositories hold.
- **Project-level settings.** `reload_stale_sessions`, `warden.pr_checks` and `gates.on_behalf` are read
  from the project's `defaults/main.yaml` first. When it does not set one, the first external repository
  that does applies, in config order. The project's block wins as a whole: once it writes `warden` (even
  without `pr_checks`) or `gates`, no external repository fills that block in. An invalid defaults file
  also stops the lookup, so an explicit project setting is never mixed with another repository's.
- **Sidekick.** The order is: an active profile's `sidekick/`, then the project's playbooks folder, then the
  first external repository with one (config order). That repository's defaults then apply, as a
  profile's do.
- **Scripts.**
  - An external repository's script paths are stored absolute in the playbook.
  - When a run starts, its script folders are copied into `<data>/run-scripts/<runId>/<absolute path>` as
    a git checkout, so editing or pulling the clone does not change a live run. Each batch of a singleton
    gets its own copy too. `run.scripts.source` is `external`.
  - The copy lives as long as the run. It is kept when the run's worktree is removed and when a daemon
    restart cleans up orphaned copies.
  - `refresh_scripts` copies them again from the folder as it is now and needs no worktree. On an ended
    run it also re-reads a compatible definition.
  - A copy follows symlinks, so no copied script reaches back into the live clone. Each copy is checked
    before it replaces the previous one: if a script the run uses is missing or not executable, the refresh
    is refused and the run keeps its working copy.
  - Admission scripts run from the folder.
- **Run state.**
  - `Playbook.external = { root }` marks a playbook from an external repository.
  - `RunDefinition.source` gains `external`, with the clone's HEAD in `sha` (null when it is not a git
    checkout). An isolated run records it instead of `origin`.
  - The warden's `stale_definition` check skips these runs, because the project's origin says nothing
    about them.
  - No compatibility shape is kept for older versions. Downgrading past this version hides the runs started
    from external repositories, because an older store does not parse the new `source` value. They show
    again after an upgrade.
- **Agent tools.**
  - `validate_playbooks` includes the external repositories.
  - Given a folder that is laid out as a repository, `validate_playbooks` validates that folder alone. That
    is a registered repository's folder, or a folder with `roles/` at its root, and in either case no
    `.paseo/` playbooks folder. A YAML file at a project's root, such as `compose.yaml`, is not enough. It
    uses the id registered for that folder, or the folder's name. This lets an agent check edits in a clone before they are pushed.
- **RPCs and UI.**
  - `playbooks.list-repositories` lists the external repositories.
  - `playbooks.set-repository { id, path | null }` registers one or removes it. It refuses a folder
    that does not exist. Removing an entry never touches the folder.
  - The Profiles tab gains an "External repositories" section. It lists each repository with its folder,
    playbook count and problem, has a Remove button, and has a form to add one.
  - In the repository dropdowns, an external repository is a locked, checked row marked "external · always
    on". `ProfileInfo` gains `source` and `path`.

## Consequences

- One clone serves every project on a host. Each host needs its own clone and config entry; the config is
  per daemon host.
- The plugin never updates a clone, so changes reach new runs only after the user pulls them.
- Registering an external repository adds two tools to every agent of the host, not the whole manager
  toolset.
- A known race is left as is. When the panel starts an isolated playbook in an external-only workspace, it
  reserves the run for the Playbook Manager it creates. Another chat of that workspace that calls
  `start_playbook` with the same playbook and identical inputs before that manager does takes the run, and
  has only two tools to manage it. The race existed before; the reduced toolset makes its outcome worse.
- The user config of the machine running the tests no longer leaks into them: each test file gets its
  own `$PASEO_HOME`.
