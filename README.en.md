[中文](README.md) | English

# Hull Desktop (`dsh-hull-desktop`)

**The developer tool that wraps DeepSeek Harness — without ever touching it.**

Hull is an open-source Electron desktop shell around the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It launches and supervises dsh as a child process, upgrades it in place through npm overlays, and renders the official web UI — so every official upgrade shows up automatically, with nothing forked, patched, or replaced.

Built for developers, Hull adds its own layer on top: a task kanban for planning work, native tray and notification integration, and plugin extensions through dsh's official extension points — all additive, all removable, none of it in dsh's way.

> **Status:** M1 shipped, M2 accepted, and the M1-refactor delivered (476+8+12 all green) — desktop shell, in-app dsh upgrade, Hull self-update, settings page + tray, and the shell-framework window (left Hull nav + embedded official UI) are all done and acceptance-tested; the M2 task kanban (B1~B5) plus the multi-agent registry + approval flow (dsh ACP integration) are complete; the M1-refactor moved settings/upgrade into in-shell right-side views for a unified interaction model (full upgrade-experience chain: live output box / progress / logging discipline).

> **AI workflow statement:** This project is developed with [ai-workflow-skills](https://github.com/phper666/ai-workflow-skills), a team AI R&D workflow skill suite — consensus docs → tri-role scanning → open-question closure → API contracts → technical design (graded) → implementation discipline (TDD/lint/Review/Semgrep) → delivery verification → change propagation → lesson deposit. Workflow artifacts live under `docs/` (spec/consensus, api/contracts, design/technical design, prd/requirements, prototype/, records/implementation records, lessons/).

## Design principles

- **Pure shell.** Hull never forks, patches, or replaces dsh or its web UI. Every official dsh release works in Hull the day it ships.
- **Two independent upgrade channels.** dsh upgrades via an in-app npm overlay (manual, atomic, rollback on failure); Hull itself ships as its own app update. Neither blocks the other.
- **Features are additive layers.** Shell-native features live in the Electron main process; anything that must run inside dsh goes through dsh's official plugin extension points (`--patch` overlays / bundles). A broken feature layer can always be disabled without touching dsh.
- **User data stays official.** Sessions, settings, and credentials live in `DSH_HOME` and are never re-implemented or rewritten by Hull.

## Feature status

### ✅ Shipped in M1 (accepted 2026-08-18)

- [x] Desktop shell: launch / supervise / restart the dsh child process (S1/S2)
- [x] Shell-framework window: left Hull nav + right embedded official web UI (S8)
- [x] In-app dsh upgrade: npm overlay, atomic swap, one-click rollback (S3/S4)
- [x] Hull self-update: independent upgrade channel (S5)
- [x] Settings page + system tray (S6)
- [x] Acceptance testing: 467 unit + 8 integration + 3 e2e all green (S7)

### ✅ Shipped in M2 (accepted 2026-08-21)

- [x] Task kanban: B1~B5 (data model / UI / execution engine / approval integration / export & import) + full e2e
- [x] Multi-agent registry + approval flow (dsh ACP integration)

### ✅ M1-refactor delivered (2026-08-22)

> M1 addendum (m1refactor, product refactor, kept in the M1 phase — no new phase number): unified in-shell interaction model — shell features moved into the main window's right-side content area.

- [x] Settings moved in-shell: standalone window → right-side full section (S6')
- [x] Upgrade merged into settings: dsh/Hull dual-channel confirm/progress/failure/rollback split into their own blocks (S3')
- [x] View mechanism 3 states: official/board/settings, nav highlight write-back (S8')
- [x] Nav menu: dsh web / task kanban / settings (no "upgrade" item, settings last)
- [x] Upgrade-experience chain: live output box (per-package npm output + autoscroll), honest staged progress, single-file dsh.log rotation, npm timeout 3000s + prefer-offline
- [x] Hull version shown + dsh web address click-to-open in browser + no auto-browser popup (--no-open)
- [x] Kanban click-ticket-detail + settings update-block visual unification

## Architecture

```
┌─ Hull (Electron main process) ─────────────────────────┐
│  tray · window · autostart · upgrade manager           │
│  spawn dsh child → loadURL → restart orchestration     │
│  ── M2 implementation layer ──                         │
│  · Execution engine: Scheduler single-flight + atomic  │
│    settlement section                                  │
│  · Approval flow: ApprovalManager + ProviderRegistry   │
│  · Export & import: KanbanTransfer                     │
│  (shell layer: kanban / export / execution control)    │
└──────────────────────┬─────────────────────────────────┘
                       │ child process (Node)
┌─ dsh (official npm packages, untouched) ───────────────┐
│  host plugins · API gateway · official web UI          │
│  └─ Hull's additive layer (optional plugins) ──────┐   │
└─────────────────────────────────────────────────────┘───┘
```

## Developer quick start

### Environment requirements

- **Node.js** `^22.19 || >=24` (CON-R007 bundles a standalone node)
- **macOS Apple Silicon** (M1 platform scope, M1 passed CON-R006); code is cross-platform friendly
- **npm** 9+

### First checkout

```bash
git clone <repo>
cd dsh-hull-desktop
npm install
npm run typecheck    # tsc check
npm test             # unit + integration (476+8 all green)
npm run dev          # tsc + electron . (launch the shell)
```

### Command matrix

| Command | Purpose |
|---|---|
| `npm run build` | tsc compile to dist/ |
| `npm run typecheck` | tsc --noEmit clean check |
| `npm test` | unit + integration |
| `npm run test:unit` | `tsc && node --test "dist/**/*.test.js"` |
| `npm run test:integration` | `tsc -p tsconfig.tests.json && node --test "dist-tests/**/*.test.js"` |
| `npm run test:e2e` | `tsc && playwright test` |
| `npm run dev` | launch the Electron shell (needs dsh installed or fake mode) |
| `npm run verify:acceptance` | acceptance script (`scripts/verify-acceptance.mjs`) |

### Directory structure

```
src/
├── main/          # Electron main-process orchestration (startup flow / single-instance / dual upgrade / kanban wiring)
├── preload/       # contextBridge allowlist bridge (window.hull/kanban/exec)
├── renderer/      # renderer layer (shell.html shell frame + kanban UI in vanilla JS; settings/upgrade in-shell)
├── window/        # main window / WebContentsView orchestration (shell-frame placeholder view mechanism)
├── tray/          # system tray controller
├── settings/      # settings persistence (settings.json schemaVersion=3)
├── kanban/        # kanban data layer (M2 B1/B5: boards.json + 18 IPC)
├── exec/          # execution engine (M2 B3/B4: Scheduler/StateMachine/ACPProvider/ApprovalManager)
├── updater/       # dsh upgrade (npm overlay + atomic staging/swap/rollback)
├── runtime/       # dsh child-process management (spawn / readiness probe / single-instance)
├── overlay/       # dsh overlay install flow
├── channel/       # main↔renderer IPC channels
├── log/           # logging (hull.log + dsh.log single-file rotation, unified in M1-refactor)
└── shared/        # shared types + errors + IPC channel allowlist

tests/
├── unit/          # (implicit: co-located src/**/*.test.ts, 476 cases)
├── integration/   # tests/integration/ (8 cases: realtime integration such as ReadinessProbe)
├── e2e/           # Playwright e2e (12 cases: cold-start/upgrade/install/settings/kanban)
└── fixtures/      # fake-dsh.js + fake-registry.js (isolate external dependencies)

docs/
├── spec/          # consensus docs (baselines + change logs L1/L2)
├── api/           # contracts (feishu-<story>-m<n>-api-contract.md)
├── design/        # technical design (frozen docs)
├── records/       # implementation / verification records (M*/S* naming)
└── lessons/       # lesson deposits
```

### Module in one line

- **main**: startup orchestration + IPC wiring + exit cleanup
- **preload**: allowlist bridge (sandbox-compatible, mounted only on shell pages)
- **renderer/shell.html**: shell frame (left nav + placeholder view mechanism + status area)
- **renderer/kanban.js**: kanban UI three views + drag & drop + details + approval modal
- **window/WindowManager**: main window + WebContentsView view switching
- **kanban/KanbanStore**: boards.json single-file atomic write + 16 IPC + keeps CON-R017
- **exec/ExecutionEngine**: execution-engine facade (Scheduler + Heartbeat + Convergence + VerifyGate)
- **exec/scheduler/Scheduler**: single-flight loop + atomic settlement section (CON-R023 parallelism ≤ 3)
- **exec/provider/ACPProvider**: dsh ACP child-process JSON-RPC client
- **exec/approval/ApprovalManager**: FIFO + deadlineAt main-process timer + 30s timeout deny

### Test discipline + e2e hooks

```
HULL_USER_DATA=/tmp/test-userdata  # isolated userData (CON-R002 spirit)
HULL_E2E=1                        # exposes the __hullTest hook (Playwright fallback)
FAKE_DSH_MODE=ready               # fake dsh enters ready state instantly, skips real download
HULL_REGISTRY=https://registry.npmjs.org
npm run test:e2e                  # all Playwright cases
```

### Development workflow

Driven by the team AI R&D workflow (ai-workflow-skills template) — consensus → tri-role scanning → open-question closure → contracts → grading → implementation pipeline (TDD/lint/Review/Semgrep) → delivery verification → change propagation → lesson deposit. See `docs/spec/共识-Hull桌面壳-M*.md`.

### Constraints

CON-R001~R005 red lines → never fork dsh / never rewrite DSH_HOME / two independent upgrade channels / shell features live in the main process / atomic upgrade staging→swap→rollback.

## License

[MIT](LICENSE)
