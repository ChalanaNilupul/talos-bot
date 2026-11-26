import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ChatEvent,
  type ChatMessage,
  type CursorInfo,
  type PetState,
  type TalosApi,
  type ToolRequest,
} from '../shared/types';

/* Every method is bound to one fixed channel name: the renderer can never pick
   the channel it sends to, so it cannot reach an IPC listener it has no
   business talking to. */
const api: TalosApi = {
  onCursor: (cb) => {
    ipcRenderer.on(CH.cursor, (_event, info: CursorInfo) => cb(info));
  },
  onState: (cb) => {
    ipcRenderer.on(CH.state, (_event, next: PetState) => cb(next));
  },
  pointerInside: () => ipcRenderer.send(CH.pointerInside),
  pointerLeft: () => ipcRenderer.send(CH.pointerLeft),
  dragStart: () => ipcRenderer.send(CH.dragStart),
  dragEnd: () => ipcRenderer.send(CH.dragEnd),
  onSheet: (cb) => {
    ipcRenderer.on(CH.sheetState, (_event, open: boolean) => cb(open));
  },
  onHistory: (cb) => {
    ipcRenderer.on(CH.chatHistory, (_event, messages: ChatMessage[]) => cb(messages));
  },
  onChat: (cb) => {
    ipcRenderer.on(CH.chatEvent, (_event, event: ChatEvent) => cb(event));
  },
  openSheet: () => ipcRenderer.send(CH.sheetOpen),
  closeSheet: () => ipcRenderer.send(CH.sheetClose),
  send: (text) => ipcRenderer.send(CH.chatSend, text),
  onApproval: (cb) => {
    ipcRenderer.on(CH.approvalRequest, (_event, request: ToolRequest) => cb(request));
  },
  onApprovalEnd: (cb) => {
    ipcRenderer.on(CH.approvalEnd, (_event, id: string, outcome: ApprovalOutcome) => cb(id, outcome));
  },
  decideApproval: (id, decision: ApprovalDecision) => ipcRenderer.send(CH.approvalDecision, { id, decision }),
  onTools: (cb) => {
    ipcRenderer.on(CH.toolsState, (_event, enabled: boolean) => cb(enabled));
  }
};

contextBridge.exposeInMainWorld('talos', api);
