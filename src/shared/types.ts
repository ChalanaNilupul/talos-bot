export const PET_WIDTH = 200;
export const PET_HEIGHT = 220;

/**
 * The chat panel grows out of the pet, so the overlay window becomes bigger than
 * the pet itself: the sheet occupies the top-left, the pet stays bottom-right.
 */
export const SHEET_WIDTH = 380;
export const SHEET_HEIGHT = 300;

/** Ambient states are driven by cursor/idle activity. Reactive states arrive from the agent in P1+. */
export type PetState =
  | "idle"
  | "tracking"
  | "fidget"
  | "yawn"
  | "sleep"
  | "dragging"
  | "thinking"
  | "talking"
  | "happy"
  | "confused"
  | "alarmed";

export type DockSide =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"
  | "bottom"
  | "top";

/** Cursor position in pet-relative pixels, plus distance to the pet's centre. */
export interface CursorInfo {
  x: number;
  y: number;
  distance: number;
}

export type ChatRole = 'user' | 'talos';

export interface ChatMessage {
  role: ChatRole;
  text: string;
}

/** One stream of events per reply, so the renderer never has to guess. */
export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'reply'; text: string }
  | { kind: 'error'; text: string };

export interface TalosApi {
  onCursor(cb: (info: CursorInfo) => void): void;
  onState(cb: (state: PetState) => void): void;
  pointerInside(): void;
  pointerLeft(): void;
  dragStart(): void;
  dragEnd(): void;
  /** Main owns the sheet: it has to resize and focus the window. */
  onSheet(cb: (open: boolean) => void): void;
  /** Sent once on load, and again if the renderer reloads mid-conversation. */
  onHistory(cb: (messages: ChatMessage[]) => void): void;
  onChat(cb: (event: ChatEvent) => void): void;
  openSheet(): void;
  closeSheet(): void;
  send(text: string): void;
}

declare global {
  interface Window {
    talos: TalosApi;
  }
}

export const CH = {
  cursor: "talos:cursor",
  state: "talos:state",
  pointerInside: "talos:pointer-inside",
  pointerLeft: "talos:pointer-left",
  dragStart: "talos:drag-start",
  dragEnd: "talos:drag-end",
  sheetOpen: "talos:sheet-open",
  sheetClose: "talos:sheet-close",
  sheetState: "talos:sheet-state",
  chatHistory: "talos:chat-history",
  chatEvent: "talos:chat-event",
  chatSend: "talos:chat-send",
} as const;
