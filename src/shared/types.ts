export const PET_WIDTH = 176;
export const PET_HEIGHT = 194;

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

export type ChatRole = "user" | "talos";

export interface ChatMessage {
  role: ChatRole;
  text: string;
}

/** One stream of events per reply, so the renderer never has to guess. */
export type ChatEvent =
  | { kind: "user"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "error"; text: string };

/** What the agent wants to do. `run` is never auto-approved, whatever the allowlist says. */
export type ToolKind = "read" | "write" | "run";

export type ApprovalDecision = "allow" | "deny" | "allow-folder";

/** How a request stopped being pending: a user choice, or the gate deciding on its own. */
export type ApprovalOutcome =
  | ApprovalDecision
  | "expired"
  | "tools-off"
  | "no-window";

export interface ToolRequest {
  id: string;
  kind: ToolKind;
  /** the exact path or the exact command, shown verbatim and never truncated here */
  target: string;
  cwd: string;
  /** multi-line preview: a diff for writes, empty for reads */
  preview: string;
  /** directory "allow-folder" would add; empty when the kind makes that meaningless */
  directory: string;
  /** epoch ms — the card counts down to this and the gate denies at it */
  expiresAt: number;
}

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
  /** A privileged action is waiting for a decision. */
  onApproval(cb: (request: ToolRequest) => void): void;
  onApprovalEnd(cb: (id: string, outcome: ApprovalOutcome) => void): void;
  decideApproval(id: string, decision: ApprovalDecision): void;
  /** Tray kill switch: false means every tool request is denied without asking. */
  onTools(cb: (enabled: boolean) => void): void;
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
  approvalRequest: "talos:approval-request",
  approvalEnd: "talos:approval-end",
  approvalDecision: "talos:approval-decision",
  toolsState: "talos:tools-state",
} as const;
