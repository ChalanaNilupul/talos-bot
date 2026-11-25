import type { ChatMessage } from '../shared/types';

export interface AgentRequest {
  prompt: string;
  /** Everything said before this prompt, oldest first. */
  history: ChatMessage[];
  persona: string;
}

export interface AgentAdapter {
  readonly id: string;
  /** Streams partial text as it arrives and resolves with the whole reply. */
  send(request: AgentRequest, onDelta: (text: string) => void): Promise<string>;
}

export const PERSONA =
  'You are Talos, a small white automaton living in the corner of the screen. ' +
  'Be brief, warm and a little dry. Never invent file contents or command output.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * P1 ships the seam, not the brain. This answers locally so the panel, the
 * streaming and the pet's request-lifecycle states can all be exercised before
 * anything is allowed near the filesystem. P2 rebinds `agent` below to a
 * headless CLI adapter; nothing in the UI has to change.
 */
class LocalEcho implements AgentAdapter {
  readonly id = 'local-echo';

  async send(request: AgentRequest, onDelta: (text: string) => void): Promise<string> {
    const turns = request.history.length;
    const reply =
      `You said: "${request.prompt}"\n\n` +
      `This thread has ${turns} earlier turn${turns === 1 ? '' : 's'}. ` +
      `I have no tools yet — I cannot read your files or run anything. The agent arrives in P2.`;

    /* split on the whitespace so the streamed text rejoins exactly */
    for (const token of reply.split(/(\s+)/)) {
      await sleep(token.trim() === '' ? 10 : 44);
      onDelta(token);
    }
    return reply;
  }
}

export const agent: AgentAdapter = new LocalEcho();
