[中文](README.md) | English

# Hull Desktop (`dsh-hull-desktop`)

**The developer tool that wraps DeepSeek Harness — without ever touching it.**

Hull is an open-source Electron desktop shell around the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It launches and supervises dsh as a child process, upgrades it in place through npm overlays, and renders the official web UI — so every official upgrade shows up automatically, with nothing forked, patched, or replaced.

Built for developers, Hull adds its own layer on top: a task kanban for planning work, native tray and notification integration, and plugin extensions through dsh's official extension points — all additive, all removable, none of it in dsh's way.

> **Status:** early scaffolding. The shell, upgrade orchestration, and kanban are under active design.

> **AI workflow statement:** This project is developed with [ai-workflow-skills](https://github.com/phper666/ai-workflow-skills), a team AI R&D workflow skill suite — consensus docs → tri-role scanning → open-question closure → API contracts → technical design (graded) → implementation discipline (TDD/lint/Review/Semgrep) → delivery verification → change propagation → lesson deposit. Workflow artifacts live under `docs/` (spec/consensus, api/contracts, design/technical design, prd/requirements, prototype/, records/implementation records, lessons/).

## Design principles

- **Pure shell.** Hull never forks, patches, or replaces dsh or its web UI. Every official dsh release works in Hull the day it ships.
- **Two independent upgrade channels.** dsh upgrades via an in-app npm overlay (manual, atomic, rollback on failure); Hull itself ships as its own app update. Neither blocks the other.
- **Features are additive layers.** Shell-native features live in the Electron main process; anything that must run inside dsh goes through dsh's official plugin extension points (`--patch` overlays / bundles). A broken feature layer can always be disabled without touching dsh.
- **User data stays official.** Sessions, settings, and credentials live in `DSH_HOME` and are never re-implemented or rewritten by Hull.

## Planned features

- [ ] Desktop shell: launch / supervise / restart the dsh child process
- [ ] In-app dsh upgrade: npm overlay, atomic swap, one-click rollback
- [ ] Task kanban: plan and track development work, optionally with the agent
- [ ] Native integration: tray, notifications, autostart, shortcuts
- [ ] Plugin extensions through dsh's official extension points (host-side and UI-side)

## Architecture

```
┌─ Hull (Electron main process) ────────────────────┐
│  tray · window · autostart · upgrade manager      │
│  spawn dsh child → loadURL → restart orchestration│
└──────────────────────┬────────────────────────────┘
                       │ child process (Node)
┌─ dsh (official npm packages, untouched) ──────────┐
│  host plugins · API gateway · official web UI     │
│  └─ Hull's additive layer (optional plugins) ──┐  │
└─────────────────────────────────────────────────┘─┘
```

## License

[MIT](LICENSE)
