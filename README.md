# Talos

An animated companion that lives in the corner of your desktop and helps with coding.
A VIXO product. **P2 stage 1** — the pet is alive, it chats, and the safety layer that will let it
touch your files is built and verified. The *brain* is still a local echo: it only reads, writes or
runs what you type after `/tool`, so there is nothing yet that could decide to do something on its
own. Wiring a real agent is the next stage.

Read [docs/SPEC.md](docs/SPEC.md) for the full plan and the reason each decision was made.

## Run it

```powershell
cd C:\Users\USER\Documents\personal\talos
npm install        # once
npm run dev        # builds src/ and launches Talos, relaunching on every file change
```

`npm run dev` keeps running. Press `Ctrl+C` in that terminal to stop it.

Settings and the transcript live in `%APPDATA%\Talos` — the same folder the installed app uses, so
`npm start` picks up exactly where the installed bot left off. That also means only one Talos can
run at a time: starting a second one prints a line saying so and exits, rather than failing silently.

Other commands:

```powershell
npm run build      # one-off build into dist/
npm start          # run the built app without watching
npm run typecheck  # TypeScript only, no output
```

## What you should see

A small armoured robot floating in the bottom-right corner of the screen: a white plate helmet
with a chamfered dark visor, two glowing LED eye panels and a red-lit mouth grille, ear fins — the
right one red with 侍 — a white globe for a body, panel-printed and banded with a black scarf, a red
reactor light in its chest plate, two plain hands floating at the sides with no arms, and a katana
hilt slung behind it. White, `#EF4136` and black are the only colours.

- It **breathes**, **blinks** every few seconds, and its **fins and hands lag behind** its movements.
- Its **eyes follow your cursor** when you come within about 400px.
- You can **click through it** — it does not block the desktop. Move your cursor near it and it becomes clickable.
- **Drag it** anywhere; it snaps to the nearest screen corner when you let go.
- **Click it** (press and release without moving) and a chat panel grows out of it. `Enter` sends,
  `Shift+Enter` is a newline, `Esc` puts the panel away. The same panel opens from anywhere with
  `Alt+Shift+Space`.
- While it replies, the transcript **streams in token by token** and the pet goes through
  `thinking` → `talking` → `happy`. The thread is written to disk after every turn, so restarting
  Talos keeps the conversation — the tray menu has **Clear conversation** when you want it gone.
- Leave it alone for 4 minutes and it **yawns**, then falls **asleep** at 5 minutes with little `z`s. Move the mouse to wake it.
- A **tray icon** has: show chat, clear conversation, dock position, autostart toggle, forced click-through, settings folder, quit.

## Changing the character

The robot is **built from geometry in code** — there is no model file and no image asset.
Everything about its look lives in [src/renderer/scene.ts](src/renderer/scene.ts).

| Want to change | Edit |
|---|---|
| Colour / material | the `PLATE`, `PLATE_DIM`, `STEEL`, `SCREEN`, `LED`, `CLOTH`, `RED`, `GRIP`, `SAYA` hex constants and the matching `*Mat` materials near the top. `RED` is `#EF4136` and it is deliberately used in only five places: the right fin, the crest ring, the hilt wrapping, the waterline and the alarm ring. |
| Proportions | the numbers in each `RoundedBoxGeometry(w, h, d, segments, cornerRadius)` call — a small `cornerRadius` keeps flat faces, which is what makes it read as bolted plates instead of an inflated shell |
| The body | `orb` is a plain `SphereGeometry` wearing `panelCanvas()` as both `map` and `roughnessMap`, so the printed seams are also polished grooves. Only two bands of it are ever visible — the helm, collar and waterline cover the rest — and the print is drawn for those bands. On a sphere, canvas x 64 is the front (not the middle) and a printed latitude at canvas `y` matches a real torus ring at `(0.5 − y/128) × 0.96`. The chest plate is a partial `SphereGeometry`, not a flat box, so it follows the curvature. The scarf is a `TorusGeometry` with `scale.set(1, 1, 0.55)`: a round-section torus is a rubber ring, a flattened one is cloth. |
| The hands | two `RoundedBoxGeometry` pills, no arms and no fingers, positioned in `render()` from `pose.antennaZ` / `antennaX` so they trail the head like the fins do. Anything with finger-shaped strands behind the body reads as a hand at this size — the old scarf tails were removed for exactly that reason. |
| Where a part sits | the `.position.set(...)` lines |
| Add a part | create a mesh, `parent.add(mesh)`, then position it |
| The 侍 mark | `glyphTexture()` draws it with the OS CJK font stack, so it needs a Japanese/Korean/Chinese face installed. A tofu box in the screenshot means no font — drop the glyph, don't ship one. |
| Pose and motion | the `render(pose)` function — it only ever reads the `Pose` object |
| Tray / app icon | `build/icon.png`, `build/tray-16.png`, `build/tray-32.png` are drawn from the same palette — redraw them after a restyle |

The behaviour side stays separate on purpose: [renderer.ts](src/renderer/renderer.ts) computes
*what the pet is doing* (gaze, blink, breathing, spring lag) and [scene.ts](src/renderer/scene.ts)
decides *what that looks like*. Swapping this robot for a downloaded `.glb` or a VRoid `.vrm`
character means rewriting scene.ts and leaving renderer.ts untouched.

To check that a change actually rendered:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/shot.ps1   # writes talos-shot.png
```

It finds the window by handle and captures exactly that rect — which matters because the pet can
end up on either monitor, and no browser tool can see a transparent always-on-top overlay.

## How the chat panel works

Four files, one direction of dependency:

| File | Owns |
|---|---|
| [src/main/agent.ts](src/main/agent.ts) | the `AgentAdapter` seam. Today it holds `LocalEcho`, which repeats your message back and counts the turns. It touches no files, no shell, no network. |
| [src/main/main.ts](src/main/main.ts) | the panel's *size and focus*: `openSheet` grows the window and makes it focusable, `closeSheet` shrinks it and hands focus back. Also owns the history — the renderer is a view. |
| [src/main/history.ts](src/main/history.ts) | that history on disk: `chat-history.json` in the app-data folder, rewritten after every turn, read back at startup, dropped by the tray's Clear conversation. |
| [src/renderer/chat.ts](src/renderer/chat.ts) | the panel's *contents*: history, the streaming bubble, the composer. Every byte of chat text goes in through `textContent`, never `innerHTML`. |

The window is bigger than the pet while the panel is open, so nothing may assume "window rect ==
pet rect". `petPosition()` / `setPetPosition()` in main.ts are the only place the pet's corner is
worked out; the canvas is pinned to the window's bottom-right in CSS.

Verified against a running build: click-to-open, typing, streaming, the disabled Send button,
`Esc`, `Alt+Shift+Space` from another app, history surviving a close/reopen, and history surviving
a killed process — the reply after the restart correctly said it had 2 earlier turns, so the loaded
thread is really being handed to the adapter and not just redisplayed.
Still not exercised: dismissal by clicking elsewhere (`blur`), the IME guard on `Enter`, and the
Clear conversation tray click. The `error` bubble is no longer unreachable — an expired approval
draws one, and that was seen on screen.

## How the approval gate works (P2, stage 1)

Nothing in the app reaches `fs` or `child_process` except through `Tools`, and every one of those
paths asks `ApprovalGate` first. The gate answers from four places, in this order: the tray kill
switch, the folder allowlist (never for `run`), a card you answer, or a 60 second timer.

| File | Owns |
|---|---|
| [src/main/gate.ts](src/main/gate.ts) | the decision. Deny by default, `run` is never auto-approved, symlinks are resolved before containment is compared, and a pending card is settled exactly once. |
| [src/main/tools.ts](src/main/tools.ts) | `read` / `write` / `run` and their caps: 200 KB in, 20 000 chars out, 60 s per command, and a real diff-style preview for a write that would overwrite something. |
| [src/main/audit.ts](src/main/audit.ts) | the append-only JSONL log in the app-data folder. One line per decision, one more per execution, sharing an `id`. |
| [src/renderer/approval.ts](src/renderer/approval.ts) | the card. Requests queue rather than overwrite, focus starts on **Deny**, and "Always allow this folder" disappears when there is no folder that means what it says. |

Try it without a model: `/tool write notes.txt`, `/tool read src/main/gate.ts`, `/tool run
Write-Output hi` in the chat box.

Verified against a running build:
- Allow → file written, and the two audit lines share one `id` with `ran: true`.
- Deny → nothing written. Pressing `Enter` on a fresh card lands on Deny, so a stray keypress
  refuses rather than grants.
- Always allow this folder → the grant is persisted, and the next write in that folder is silent
  (`source: "allowlist"`, same millisecond, no card).
- `run` inside an allowlisted folder still shows a card, with the folder button hidden.
- 60 s with no answer → `outcome: "expired", source: "timer"`, no file, and the panel says
  "Approval timed out — nothing ran."
- Kill switch off beats the allowlist: an allowlisted write is refused with `source: "kill-switch"`
  and no card. The overwrite preview (`-`/`+` with unchanged lines elided) was correct on that run.

Still not exercised: the tray *clicks* themselves (the checkbox and the Allowed-folders revoke),
and `cancelAll` on quit. All three funnel into the same `settle()` path that the four verified
outcomes above already use. The audit-line shape for auto-allowed actions was tightened after the
live run, so that one is code-verified only.

## Known limits

- Replies are a scripted echo. The gate, the tools and the audit log are real and in use, but no
  model is driving them yet — see *How the approval gate works* above and the spec.
- The character is procedural geometry, so it reads as a stylised robot rather than an organic creature. A hand-made model is the art swap described above.
- The window is created `focusable: false` so Talos can never steal focus from your editor; it flips to focusable only while the panel is open and back the instant it closes.
- Fullscreen games and presentations can end up behind Talos. The `screen-saver` always-on-top level is the cause; auto-demoting on fullscreen detection is a spec risk item, not yet done.
- WebGL draws into a transparent layered window. That works with GPU acceleration on this machine; if it ever renders blank, `app.disableHardwareAcceleration()` in [src/main/main.ts](src/main/main.ts) is the fallback.
- `ready-to-show` never fires for a page holding a WebGL canvas, so the window is shown synchronously after `loadFile`. Do not tidy that back into an event listener.
- Opening the panel next to a screen edge moves the *pet* instead of the panel, because the window has to fit. Docked bottom-right (the default) nothing moves.

## Layout

```
src/main/       overlay window, cursor loop, behaviour state machine, chat sheet, agent seam, tray, settings, history
src/preload/    the only surface the renderer can reach (contextIsolation + sandbox on)
src/renderer/   scene.ts = the character, renderer.ts = the behaviour that poses it, chat.ts = the panel
src/shared/     types, sizes and IPC channel names
scripts/        esbuild bundling, the watch/relaunch dev loop, window capture
build/          icons
docs/SPEC.md    the plan
```
