import type { ChatMessage } from '../shared/types';
import type { Tools } from './tools';

export interface AgentRequest {
  prompt: string;
  /** Everything said before this prompt, oldest first. */
  history: ChatMessage[];
  persona: string;
  /** Where a relative path or command is resolved. Main owns it; the adapter never picks. */
  cwd: string;
}

export interface AgentContext {
  tools: Tools;
  /** Stream one chunk of the reply. Called as many times as the adapter likes. */
  say(text: string): void;
}

export interface AgentAdapter {
  readonly id: string;
  send(request: AgentRequest, ctx: AgentContext): Promise<string>;
}

export const PERSONA =
  'You are Talos, a small armoured automaton living in the corner of the screen. ' +
  'Be brief, warm and a little dry. Never invent file contents or command output.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TOOL_COMMAND = /^\/tool\s+(read|write|run)\s+(.*)$/is;

/**
 * P2 still ships the seam, not the brain. LocalEcho cannot decide anything on its
 * own, but `/tool read|write|run` hands a real request to the gate, so the approval
 * card, the allowlist and the audit log can all be exercised before a model exists
 * to be trusted with them.
 */
class LocalEcho implements AgentAdapter {
  readonly id = 'local-echo';

  async send(request: AgentRequest, ctx: AgentContext): Promise<string> {
    const match = TOOL_COMMAND.exec(request.prompt);
    if (match) return this.runTool(match[1]!.toLowerCase(), match[2]!.trim(), request, ctx);

    const turns = request.history.length;
    return this.stream(
      `You said: "${request.prompt}"\n\n` +
        `This thread has ${turns} earlier turn${turns === 1 ? '' : 's'}. I have a gate but no brain yet: ` +
        `I can only do what you type as /tool read <path>, /tool write <path> or /tool run <command>.`,
      ctx
    );
  }

  private async runTool(
    verb: string,
    argument: string,
    request: AgentRequest,
    ctx: AgentContext
  ): Promise<string> {
    ctx.say(`…asking you first.\n\n`);
    if (!argument) return this.stream('`/tool` needs an argument.', ctx);

    if (verb === 'read') {
      const result = await ctx.tools.read(argument, request.cwd);
      return this.stream(result.ok ? result.text : result.text, ctx);
    }
    if (verb === 'write') {
      const result = await ctx.tools.write(argument, `written by Talos at ${new Date().toISOString()}\n`, request.cwd);
      return this.stream(result.text, ctx);
    }
    if (verb === 'run') {
      const result = await ctx.tools.run(argument, request.cwd);
      return this.stream(result.text, ctx);
    }
    return this.stream(`Unknown tool "${verb}". Use read, write or run.`, ctx);
  }

  /** Typed out slowly so the panel still streams and the pet still animates. */
  private async stream(reply: string, ctx: AgentContext): Promise<string> {
    for (const token of reply.split(/(\s+)/)) {
      await sleep(token.trim() === '' ? 10 : 44);
      ctx.say(token);
    }
    return reply;
  }
}

export const agent: AgentAdapter = new LocalEcho();
