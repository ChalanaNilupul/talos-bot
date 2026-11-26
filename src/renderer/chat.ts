import {
  SHEET_HEIGHT,
  SHEET_WIDTH,
  type ChatEvent,
  type ChatMessage,
} from '../shared/types';
import { denyCard, hasCard } from './approval';

const sheet = document.getElementById('sheet') as HTMLElement;
const log = document.getElementById('log') as HTMLDivElement;
const composer = document.getElementById('composer') as HTMLFormElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendButton = document.getElementById('send') as HTMLButtonElement;

/* The window is sized in main; the panel only knows its own box inside it. */
sheet.style.width = `${SHEET_WIDTH}px`;
sheet.style.height = `${SHEET_HEIGHT}px`;

const INPUT_MAX_HEIGHT = 84;

let open = false;
let busy = false;
/** the bubble a streaming reply is being written into, or null between replies */
let live: HTMLDivElement | null = null;

/* ------------------------------------------------------------------ render */

/**
 * Every byte of chat text goes through textContent. Replies come from an agent
 * that will soon be able to run code, so treating its output as markup is not a
 * theoretical concern.
 */
const bubble = (kind: ChatMessage['role'] | 'error', text: string): HTMLDivElement => {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  log.append(el);
  return el;
};

const stickToBottom = () => {
  log.scrollTop = log.scrollHeight;
};

const setBusy = (next: boolean) => {
  busy = next;
  sendButton.disabled = next;
};

function drawHistory(messages: ChatMessage[]): void {
  log.replaceChildren();
  live = null;
  for (const message of messages) bubble(message.role, message.text);
  setBusy(false);
  stickToBottom();
}

function apply(event: ChatEvent): void {
  switch (event.kind) {
    case 'user':
      live = null;
      bubble('user', event.text);
      setBusy(true);
      break;
    case 'delta': {
      if (!live) live = bubble('talos', '');
      /* a delta can arrive before this window saw the 'user' event — reopening
         mid-reply lands here, and the send button must not invite a queue */
      setBusy(true);
      live.textContent += event.text;
      break;
    }
    case 'reply':
      if (live) live.textContent = event.text;
      else bubble('talos', event.text);
      live = null;
      setBusy(false);
      break;
    case 'error':
      live = null;
      bubble('error', event.text);
      setBusy(false);
      break;
  }
  stickToBottom();
}

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  sheet.hidden = !next;
  if (next) {
    stickToBottom();
    input.focus();
  }
}

/* ------------------------------------------------------------------- input */

const grow = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)}px`;
};

function submit(): void {
  const text = input.value.trim();
  if (!text || busy || !open) return;
  input.value = '';
  grow();
  /* Optimistic: without it, a second Enter before the round trip queues a
     message main is going to drop on the floor. */
  setBusy(true);
  window.talos.send(text);
  /* Clicking Send with the mouse would otherwise leave the caret in a button
     that is about to be disabled. */
  input.focus();
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

input.addEventListener('input', grow);

input.addEventListener('keydown', (event) => {
  /* An Enter that finishes an IME composition belongs to the composition, not
     to the composer. */
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

/* Window-wide: after a mouse click on Send the caret is no longer in the input,
   and Esc should still put the pet back to sleep. */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !open) return;
  event.preventDefault();
  /* An unanswered card takes the key first. Esc means "no" to it rather than
     "hide the panel", which would leave the agent blocked on a card nobody sees. */
  if (hasCard()) denyCard();
  else window.talos.closeSheet();
});

window.talos.onSheet(setOpen);
window.talos.onHistory(drawHistory);
window.talos.onChat(apply);

export const isOpen = () => open;
