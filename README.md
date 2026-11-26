# Talos

An animated companion that lives in the corner of your desktop and helps with coding.
A VIXO product. Currently **P1** — the pet is alive, it has a chat panel, and it answers.
The answers are still a local echo: the real agent (and file/shell access) is P2.

Read [docs/SPEC.md](docs/SPEC.md) for the full plan and the reason each decision was made.

## Run it

```powershell
cd C:\Users\USER\Documents\personal\talos
npm install        # once
npm run dev        # builds src/ and launches Talos, relaunching on every file change
```

`npm run dev` keeps running. Press `Ctrl+C` in that terminal to stop it.

Other commands:

```powershell
npm run build      # one-off build into dist/
npm start          # run the built app without watching
npm run typecheck  # TypeScript only, no output
```

## What you should see

A small white robot floating in the bottom-right corner of the screen: a rounded
squircle shell, one dark visor, two pill eyes, and two detached hands that drift beside it.

- It **breathes**, **blinks** every few seconds, and its **hands lag behind** its movements.
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
| Colour / material | the `SHELL`, `HAND`, `VISOR`, `EYE` hex constants and the `shellMat`, `handMat`, `visorMat`, `eyeMat` materials near the top |
| Proportions | the numbers in each `RoundedBoxGeometry(w, h, d, segments, cornerRadius)` call — the shell is one pillow, the visor is a second one buried inside it |
| Where a part sits | the `.position.set(...)` lines |
| Add a part | create a mesh, `parent.add(mesh)`, then position it |
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
Still not exercised: dismissal by clicking elsewhere (`blur`), the IME guard on `Enter`, the
Clear conversation tray click, and the `error` bubble — `LocalEcho` has no failure path yet, so
nothing can raise one.

## Known limits

- Replies are a scripted echo. Real answers, tools and approvals are P2 — see the spec.
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
