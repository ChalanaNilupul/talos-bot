import type { ApprovalOutcome, ToolRequest } from '../shared/types';

const card = document.getElementById('approval') as HTMLElement;
const headEl = document.getElementById('approval-head') as HTMLParagraphElement;
const targetEl = document.getElementById('approval-target') as HTMLPreElement;
const previewEl = document.getElementById('approval-preview') as HTMLPreElement;
const cwdEl = document.getElementById('approval-cwd') as HTMLParagraphElement;
const allowBtn = document.getElementById('approval-allow') as HTMLButtonElement;
const folderBtn = document.getElementById('approval-folder') as HTMLButtonElement;
const denyBtn = document.getElementById('approval-deny') as HTMLButtonElement;
const clockEl = document.getElementById('approval-clock') as HTMLParagraphElement;

const VERB: Record<ToolRequest['kind'], string> = {
  read: 'Talos wants to read',
  write: 'Talos wants to write',
  run: 'Talos wants to run',
};

/**
 * A reply can ask for two things before the first card is answered, so the requests
 * queue rather than overwrite — silently dropping the second would leave the agent
 * waiting on a card nobody saw.
 */
const queue: ToolRequest[] = [];
let current: ToolRequest | null = null;
let ticker = 0;

function render(request: ToolRequest): void {
  headEl.textContent = VERB[request.kind];
  /* The command and the path are the whole point of the card: they are shown exactly
     as they will be executed, never summarised. */
  targetEl.textContent = request.kind === 'run' ? request.target : request.target;
  cwdEl.textContent = request.kind === 'run' ? `in ${request.cwd}` : `folder ${request.directory}`;
  previewEl.hidden = request.preview === '';
  previewEl.textContent = request.preview;
  /* "always allow" a folder for a command would mean "always allow any command run
     from this folder", so the option only exists where it means what it says. */
  folderBtn.hidden = request.directory === '';
  card.hidden = false;
  /* Caret on the safe answer: a stray Enter denies instead of granting, and Tab
     forward is the only way to press Allow. */
  denyBtn.focus();
  tick();
}

function tick(): void {
  if (!current) return;
  const left = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
  clockEl.textContent = left > 0 ? `${left}s to answer — no answer means no` : 'time up';
}

function advance(): void {
  const next = queue.shift();
  if (next) {
    current = next;
    render(next);
  } else {
    current = null;
    card.hidden = true;
    targetEl.textContent = '';
    previewEl.textContent = '';
  }
}

function decide(decision: 'allow' | 'deny' | 'allow-folder'): void {
  if (!current) return;
  window.talos.decideApproval(current.id, decision);
}

allowBtn.addEventListener('click', () => decide('allow'));
folderBtn.addEventListener('click', () => decide('allow-folder'));
denyBtn.addEventListener('click', () => decide('deny'));

window.talos.onApproval((request) => {
  if (current) queue.push(request);
  else {
    current = request;
    render(request);
  }
});

window.talos.onApprovalEnd((id, outcome) => {
  if (!current || current.id !== id) {
    /* A card can be answered while it is still in the queue (expiry, kill switch). */
    const at = queue.findIndex((r) => r.id === id);
    if (at >= 0) queue.splice(at, 1);
    return;
  }
  bubbleOutcome(outcome);
  advance();
});

function bubbleOutcome(outcome: ApprovalOutcome): void {
  const log = document.getElementById('log');
  if (!log || outcome === 'allow' || outcome === 'deny') return;
  const line = document.createElement('div');
  line.className = 'msg error';
  line.textContent =
    outcome === 'expired' ? 'Approval timed out — nothing ran.' : 'Tools are off — nothing ran.';
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

if (!ticker) ticker = window.setInterval(tick, 250);

/** Esc closes the sheet, but a card takes the key first: deny, then stay open. */
export const hasCard = () => current !== null;
export const denyCard = () => decide('deny');
