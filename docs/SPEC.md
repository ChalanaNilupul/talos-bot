# VIXO Desktop Pet — Product Spec (v0 draft)

**Status:** P0, P1 and P2 stage 1 shipped; P2 stage 2 (Gemini CLI over ACP) wired and awaiting its live checklist
**Owner:** solo
**Target OS:** Windows 11 (x64) first; macOS/Linux later via Electron ports

---

## 1. What it is

An animated character that lives in the corner of the desktop, is always visible but never in the way, and acts as a personal coding agent: it can read and edit your project files, run commands, and watch your repo — with your approval at every privileged step.

It is **not** a chatbot in a window. The differentiator is that it is *present*: it watches your cursor, sleeps when you ignore it, celebrates when a build passes, and volunteers when you have been stuck on the same failing file for 40 minutes.

### Working name

Pronunciation-first, per VIXO naming convention. Candidates:

| Name | Why | Risk |
|---|---|---|
| **Talos** | Bronze automaton of Crete — literally the first "robot" in myth. TAY-loss. | Collides with Red Hat Talos + a crypto project |
| **Kip** | Short, unambiguous, friendly for a small creature. | Generic |
| **Nook** | "corner" is the whole product idea. | Reads as a reading app |

`vixo-pet` is used as the package placeholder below until a name is picked.

---

## 2. Locked decisions

| Concern | Decision | Revisit when |
|---|---|---|
| Shell/runtime | **Electron + TypeScript** | Bundle size becomes a real problem → port renderer to Tauri 2 |
| Agent brain | **Adapt an existing headless coding CLI as a subprocess** — landed as Gemini CLI over ACP, spawned with `--acp` and driven as the *agent* side of the protocol | You need custom tool semantics no CLI exposes |
| Animation | **Procedural 3D with three.js** — geometry built in code, no model file. (Revised: the plan was Rive, then a 3D character was wanted.) | You want a hand-art character → drop a rigged `.glb` or VRoid `.vrm` in and rewrite `scene.ts` |
| Brand | **New product under VIXO** | — |
| Packaging | `electron-builder`, NSIS installer | — |
| Secrets | Electron `safeStorage` (DPAPI-backed) | Never `.env` in the repo |

---

## 3. Architecture

```
┌──────────────────────────────── Electron main process ─────────────────────────────┐
│  OverlayManager      window geometry, alwaysOnTop, click-through, edge docking     │
│  StateBus            single source of truth for pet mood/activity; broadcasts IPC  │
│  AgentAdapter        spawn headless CLI, parse stream, normalise into events       │
│                      (P2 stage 2: gemini --acp, JSON-RPC over stdio, both ways)    │
│  ApprovalGate        every privileged action blocks here until user decides        │
│  AuditLog            append-only JSONL, one line per tool call + decision          │
│  Watchers            git status, active-file, test results, clipboard (opt-in)     │
│  MemoryStore         markdown notes under %APPDATA%/vixo-pet/memory + keyword idx  │
│  SecureStore         safeStorage wrapper for API keys                              │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                       │ ipcMain / ipcRenderer (contextIsolation on)
┌──────────────────────────────────────▼─────────────────────────────────────────────┐
│  Renderer (transparent 176x194 frameless window, 380x494 while the panel is open)   │
│    Scene3D           three.js WebGLRenderer in one <canvas>, fed by a Pose object   │
│    ChatSheet         rounded expanding panel that grows out of the pet              │
│    ApprovalCard      inline approve/deny UI rendered on the pet itself  (P2)        │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Hard rule:** renderer never touches `fs` or `child_process`. `nodeIntegration: false`, `contextIsolation: true`, one small `preload.ts` exposing a typed allowlist of IPC channels. The approval gate is worthless if the renderer can bypass it.

---

## 4. The overlay window (this is the whole trick)

```ts
new BrowserWindow({
  width: 176, height: 194,        // PET_WIDTH / PET_HEIGHT in src/shared/types.ts
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  hasShadow: false,
  resizable: false,          // transparent + resizable is buggy on Windows
  skipTaskbar: true,
  alwaysOnTop: true,
  focusable: false,          // never steal focus from the editor — see the rule below
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
})
win.setAlwaysOnTop(true, 'screen-saver')   // sits above the taskbar
win.setIgnoreMouseEvents(true, { forward: true })  // click-through, but hover still reaches us
```

Behaviour rules:

- **Click-through by default.** `forward: true` keeps `mousemove` reaching the page, so the renderer can detect pointer proximity and ask main to disable click-through only when you are actually about to interact with the pet. Proximity is measured in the main process: an ignored window receives no mouse events at all, so the renderer cannot discover it needs lifting.
- **Focusable on demand, not by default.** (Revised: the draft said `focusable: true`, which made the pet able to steal focus from the editor at any moment.) The window is created unfocusable and `setFocusable(true)` is called only inside `openSheet()`, with `setFocusable(false)` on the way back out.
- **Never steals focus.** Summon the chat panel with a global hotkey, not by the pet grabbing keyboard on its own. Shipped as `Alt+Shift+Space` rather than the drafted `alt+space`, because `Alt+Space` is Windows' system-menu key and is swallowed before any app sees it.
- **Dock candidates:** bottom-right above taskbar (default), right edge, top-right. Pet can be dragged and re-docked; it remembers.
- **Multi-monitor:** `screen.getAllDisplays()`, clamp the window fully inside one display after any DPI or resolution change (`screen.on('display-metrics-changed')`).
- **Autostart:** `app.setLoginItemSettings({ openAtLogin: true })`, off by default, one toggle in the tray menu.
- **The pet's corner, not the window's.** The chat panel grows the window, so window rect and pet rect are different objects. `petPosition()`/`setPetPosition()` are the only place the pet's corner is computed; docking, dragging, clamping and cursor proximity all go through it.

---

## 5. Pet behaviour state machine

States live in the main process (`StateBus`), animation reacts in the renderer. The renderer computes a `Pose` — `gazeX/gazeY`, `blink`, `breath`, `bob`, `lean`, spring lag offsets, `asleep`, `alarmed`, `thinking`, `glow` — and `scene.ts` turns that into transforms and emissive values. Nothing about behaviour depends on what the character is made of.

### Ambient (always running, no AI involved)

| State | Trigger | Notes |
|---|---|---|
| `breathe` | default | slow loop |
| `blink` | random, every 3–7s | the single cheapest "it's alive" win |
| `track_cursor` | pointer inside a 400px radius | pupils + head offset toward cursor, sampled ~30Hz |
| `fidget` | 60s no interaction | small variation so it never looks frozen |
| `yawn` → `sleep` | 5 min no interaction | reduces annoyance; wakes on proximity |
| `peek` | you mouse away from its corner | slides half out from behind the screen edge |
| `wander` | enabled + 2 min idle | walks along the taskbar with gravity on release |

### Reactive (driven by the agent)

| State | Trigger |
|---|---|
| `thinking` | request in flight, tokens streaming |
| `talking` | streaming text or TTS playing |
| `happy` | task succeeded, tests passed, build green |
| `confused` | tool error, command exited non-zero |
| `alarmed` | approval request pending (also pulses a badge) |
| `listening` | hotkey held / voice session open |

**Acceptance test for this section:** a stranger looking at a recording should say "that's watching me" within 10 seconds.

---

## 6. Agent adapter

The pet is the face; a real coding agent does the work.

**Adapter interface** (so swapping CLIs is a config change, not a rewrite):

```ts
interface AgentAdapter {
  run(req: { prompt: string; cwd: string; sessionId?: string }): AsyncIterable<AgentEvent>
  cancel(id: string): void
}

type AgentEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_call'; id: string; tool: string; args: unknown }   // -> ApprovalGate
  | { kind: 'tool_result'; id: string; ok: boolean; summary: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'done'; costUsd?: number }
  | { kind: 'error'; message: string }
```

**Planned at first: Codex CLI or Claude Code**, both of which have documented non-interactive modes
with streamed JSON lines — spawn, read stdout line by line, map into `AgentEvent`. **Aider** second,
because it is git-native and works with local models.

**What shipped instead, in P2 stage 2.** [src/main/gemini.ts](../src/main/gemini.ts) spawns
`node.exe %APPDATA%\npm\node_modules\@google\gemini-cli\bundle\gemini.js --acp -m <model>
--approval-mode default --policy <talos-policy.toml>` and talks ACP to it through
`@agentclientprotocol/sdk`. The direction of the tool traffic turned out to be the opposite of the
draft, which changed the design:

- ACP is not an output stream to parse. Each tool call is a **request from the agent to the client**
  (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`) that Talos must *answer*
  before the model proceeds. So the adapter does not normalise tool calls into `AgentEvent`s for the UI —
  it hands them to `ApprovalGate` and returns the decision. Enforcement lives where it was always going
  to live, and the renderer only ever sees text.
- Because of that, `send(request, ctx) => Promise<string>` from P1 stayed the seam unchanged. `ctx`
  carries `say(delta)` plus the same `tools` object `/tool` uses, so the model and the typed commands go
  through one path. The `AgentEvent` union above is what a *stream-parsing* adapter would need; if a
  second CLI is only usable that way, that is when the seam widens.
- Spawning `gemini.cmd` throws `EINVAL` on this Node, and `shell: true` would put the policy path
  through cmd.exe quoting, so the bundle is run with `node.exe` found on `PATH`. Handlers get a context
  object, so params are `ctx.params`; `Readable.toWeb()`/`Writable.toWeb()` need one assertion because
  Node's web-stream globals and the SDK's whatwg declarations are structurally incompatible.
- The connection outlives a turn, so the agent keeps its own context between messages. Anything that
  goes wrong drops it and the next message rebuilds it; a turn is raced against a 240 s timeout and the
  teardown tree-kills, because the CLI re-execs itself with a bigger heap.

**Shipped in P1, and narrower than the draft above.** [src/main/agent.ts](../src/main/agent.ts) defines
`send(request, onDelta) => Promise<string>` — one prompt in, a delta callback, the final text out. That is
deliberately the smallest seam the UI can be built against. `LocalEcho` is no longer the only thing behind
it: it is the fallback when the CLI is missing, and it keeps handling `/tool`, which is the only way to
raise an approval card before any folder has been granted.

**Personality lives above the adapter.** The adapter gets a task; a separate lightweight LLM call owns the pet's voice, so it can comment, joke, and react without a coding agent in the loop.

### Proactive coding-awareness features

These are why it's a *coding* pet and not a generic assistant:

- Reads `git status`/branch/dirty-count → tiny badge on the pet.
- Detects a failing test run from the command it just executed → offers a summary without being asked.
- "You've edited this file for 40 minutes and it still errors — want me to look?" (rate-limited, max 1 nudge per 30 min, fully disableable).
- Global hotkey to send the selected text/terminal error straight to the pet.

---

## 7. Security model

Non-negotiable, because this app has file and shell access and runs at login.

1. **Allowlist-first paths.** Only directories you explicitly add are writable. Everything else read-only or denied.
2. **Approval gate blocks execution.** No shell command and no write outside the allowlist runs before a decision. Default is deny. Approvals expire after 60s.
3. **Approval UI is the pet.** `alarmed` state + an inline card: exact command, cwd, and diff preview for writes. Approve / deny / always-allow-this-folder.
4. **Audit log.** `%APPDATA%/vixo-pet/audit/YYYY-MM-DD.jsonl` — timestamp, event, args, decision, decision source. Append-only.
5. **Secrets.** `safeStorage.encryptString`; check `isEncryptionAvailable()` and fail loudly rather than falling back to plaintext. *(Outstanding: the Gemini key is inherited from the ambient environment instead. The adapter never reads or logs it, but it should be encrypted at rest and passed to the child only.)*
6. **Renderer isolation.** `contextIsolation: true`, no `nodeIntegration`, CSP in the HTML, `shell.openExternal` behind an https-only allowlist.
7. **"Help mode" kill switch** in the tray: disables all tools instantly, leaves the pet and chat running.
8. **Policy before prompt.** Stage 2 denies `run_shell_command` in the CLI's own policy engine rather than answering "no" to a card, because a global deny removes the tool from the model's context — it cannot be talked into asking for something it was never given. The `--policy` file is generated into the app-data folder, never `~/.gemini`, so Talos does not change the user's own CLI runs.
9. **The gate covers what Talos can see.** Reads and writes that arrive as ACP requests are gated; a child process with a filesystem handle can also touch disk on its own, inside its `cwd` and within whatever the CLI's own workspace rules allow. Containment is therefore cwd + policy + gate, and the gate is the *decision* layer, not the sandbox.

---

## 8. Milestones

### P0 — It lives on the desktop (no AI) — shipped
Transparent overlay, click-through, drag + dock, eye tracking, `breathe`/`blink`/`sleep` on a procedural 3D character, tray icon, autostart toggle, single-monitor then multi-monitor clamp.
**Done when:** you leave it running a full workday and never feel the urge to close it.

### P1 — It thinks and shows — shipped, with the brain left out
Streaming chat panel, states bound to request lifecycle (`thinking`/`talking`/`happy`/`confused`), global hotkey, personality prompt. Optionally the art swap: a rigged `.glb` or VRoid `.vrm` replacing the procedural robot — not done, the procedural bot stayed.
**Done when:** the animation tells you what it is doing before you read any text.

What actually landed, and where it differs from the draft:

- The panel grows out of the pet's corner; the window resizes around it while the pet stays put.
- Replies come from `LocalEcho` behind the `AgentAdapter` seam, so nothing in P1 can read a file or run a command. `PERSONA` in [src/main/agent.ts](../src/main/agent.ts) is the prompt that P2 will hand to a real model.
- Hotkey is `Alt+Shift+Space`, not `alt+space` (Windows owns that one).
- History lives in the main process, capped at 40 messages, and is written to `chat-history.json` in the app-data folder after every turn — a restart keeps the thread and the adapter is given it as context. The tray's Clear conversation drops it. Recall across *old* conversations, summarising it, and searching it are still P3's memory store.
- One data folder for both builds. `app.setName('Talos')` runs before anything asks for a path, because in dev Electron's app path is `dist/` — which has no `package.json` — and the process would otherwise call itself "Electron" and keep its settings and transcript in `%APPDATA%\Electron`, apart from the installed app. Sharing the folder shares the single-instance lock too, so a second launch now prints why it exited.
- Version is `0.1.0`, matching the milestone; the installer is `out/Talos-Setup-0.1.0.exe`.
- Not yet verified by hand: dismissal on losing focus, the IME guard on `Enter`, the tray's Clear conversation (the menu is only reachable by a real click on the tray icon), and the error bubble (no adapter failure path exists to trigger it).

### P2 — It has hands
`AgentAdapter` + first CLI adapter, allowlist UI, `ApprovalGate` with the inline approval card, audit log, git badge.
**Done when:** it fixes a real failing test in a real repo, and you can name every file it touched.

Delivered in three stages, because "it has hands" is the part that can hurt you:

**Stage 1 — shipped and verified by hand.** `gate.ts` / `tools.ts` / `audit.ts` / `approval.ts`, plus the
tray kill switch and the folder allowlist. Verified: allow, deny, `Enter` lands on Deny, always-allow
this folder → silent next write, `run` in an allowlisted folder still cards, 60 s expiry, kill switch
beats the allowlist. The unread click paths (tray checkbox, folder revoke, `cancelAll` on quit) are
unexercised but funnel into the same `settle()`.

**Stage 2 — Gemini CLI over ACP, wired, awaiting the live run.** The adapter exists, typechecks, builds,
and drove a real turn in a standalone harness; the cards have not been seen in the panel yet. The
checklist is the *Not yet verified* list in the README. Deliberately narrow: shell denied by policy, one
card per intent via a 30 s single-use grant, refuses to start when nothing is allowlisted.

**Stage 3 — the outstanding P2 items.** Shell behind its own approval tier, the key in `safeStorage`, a
model whose quota is not 20 requests/day, the git badge, and the *fix a real failing test* acceptance
test the stage-2 model cannot pass without a shell.

### P3 — It remembers
Markdown memory store + retrieval, session history restored on restart, proactive nudges, watch-folder awareness.
**Done when:** it references something from last week correctly without you re-explaining.

### P4 — It talks, and ships
Windows STT + push-to-talk, Edge TTS voice, animation polish, `electron-builder` NSIS installer, settings window, crash reporting.

---

## 9. Repo layout

```
talos/
├─ electron-builder.yml
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ main/        main.ts (overlay + state machine + chat sheet + tray), agent.ts (AgentAdapter seam),
│  │               history.ts (transcript on disk), settings.ts
│  │               └─ P2 adds: ApprovalGate, AuditLog, Watchers  ·  P3 adds: MemoryStore, SecureStore
│  ├─ preload/     typed IPC bridge (the ONLY renderer surface), one fixed channel per method
│  ├─ renderer/    scene.ts (character), renderer.ts (behaviour + input), chat.ts (ChatSheet), styles.css
│  │               └─ P2 adds: ApprovalCard
│  └─ shared/      types.ts — PetState, ChatEvent, the sizes, and every IPC channel name
├─ build/          icons
└─ scripts/        build.mjs, dev.mjs, shot.ps1
```

---

## 10. Prerequisites (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --quiet"
npm install -g electron-builder
# the app itself
npm install
npm run dev
```

Plus the adapter actually wired in: `npm install -g @google/gemini-cli` and a Gemini API key. Talos runs
without either — `LocalEcho` answers, `/tool` works, the gate is still exercised — so the app is never
mute because a CLI is missing.

No art tooling is needed for the procedural character. If you later want a modelled one: VRoid Studio (free, exports `.vrm`) or Blender for `.glb`.

---

## 11. Known risks

| Risk | Mitigation |
|---|---|
| Windows DPI scaling moves/crops the transparent window | listen to `display-metrics-changed`, re-clamp on every event; test 100/125/150% early in P0 |
| `alwaysOnTop: 'screen-saver'` covers fullscreen games/presentations | auto-demote to `pop-up-menu` when a fullscreen window is detected |
| Transparent Electron window eats 200–300MB idle | the render loop drops to ~12Hz while sleeping; measured at 4 Electron processes |
| Headless CLI output format changes and breaks the parser | adapter owns all parsing, golden-file fixtures per CLI version |
| ACP version churn in Gemini CLI (v1 protocol, 0.71.1 here) — `session/new`, permission shapes or the fs proxy shift | the adapter is the only file that knows the protocol; `gate.ts` and the UI are unchanged by it, and `GeminiCli.available()` degrades to `LocalEcho` rather than a silent pet |
| Free-tier quota (20 requests/day per model) makes the pet look broken | the pinned model is chosen for quota, and a rate-limited turn surfaces as an error bubble rather than a hang: the turn is raced against a timeout, not awaited |
| It becomes annoying → you stop using it | every ambient behaviour has an off switch; `sleep` by default after 5 min |
| WebGL renders blank inside a transparent layered window on some GPU/driver combos | verified working with GPU acceleration here; `app.disableHardwareAcceleration()` is the fallback, and `scripts/shot.ps1` catches it in CI-less development |
