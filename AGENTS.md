# AGENTS.md — Hull Desktop (dsh-hull-desktop)

A developer tool built around DeepSeek Harness (dsh). Work here follows these rules.

## Hard rules (non-negotiable)

1. **Never modify dsh.** No forking, patching, or replacing of official `@deepseek-ai/dsh` packages, their source, or the official web UI. dsh runs as an untouched child process.
2. **Never bundle or replace the official web UI.** Hull renders whatever dsh serves; a Hull release must never pin its own copy of the frontend.
3. **Features are additive layers.** Shell-native features live in the Electron main process. Anything that must run inside dsh goes through dsh's official extension points (`--patch` overlays, `dsh plugin add`, `dsh.client` UI plugins). Feature layers must be independently disableable.
4. **User data stays official.** Never read or rewrite `DSH_HOME` session/state files directly; use dsh's official surfaces (plugin APIs, storage services) or keep Hull-specific data in Hull-owned directories.
5. **Upgrades are atomic.** dsh upgrades stage into a new directory, swap atomically, and roll back if the new version fails to boot. Never mutate the running copy in place.

## Conventions

- Conventional Commits; English subjects.
- PRs over direct pushes to main; one PR per concern.
- Every non-trivial change updates README/AGENTS docs together.
- Tests accompany behavior changes.

## Status

Scaffolding phase: shell bootstrap, upgrade orchestration, and the task kanban are the first milestones (see README "Planned features").
