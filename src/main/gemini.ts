import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type ClientConnection,
  type PermissionOption,
  type RequestPermissionOutcome,
  type RequestPermissionResponse,
  type SessionUpdate,
  type ToolCallUpdate,
  type ToolKind as AcpToolKind
} from '@agentclientprotocol/sdk';
import type { ToolKind } from '../shared/types';
import type { AgentAdapter, AgentContext, AgentRequest } from './agent';
import { auditExecuted, type ApprovalGate, type GateVerdict } from './gate';
import { settings } from './settings';

const MODEL = 'gemini-3.5-flash-lite';
/** A granted permission stops being reusable well before the next message could need it. */
const GRANT_TTL_MS = 30_000;
/** Long enough for a real edit turn, short enough that a wedged child cannot hold the pet hostage. */
const TURN_TIMEOUT_MS = 240_000;

function findNode(): string | null {
  /* process.execPath is electron.exe here, and the CLI bundle is a plain Node script. */
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBundle(): string | null {
  if (!process.env.APPDATA) return null;
  const candidate = path.join(
    process.env.APPDATA,
    'npm',
    'node_modules',
    '@google',
    'gemini-cli',
    'bundle',
    'gemini.js'
  );
  return fs.existsSync(candidate) ? candidate : null;
}

interface Launcher {
  node: string;
  bundle: string;
}

/**
 * `spawn`ing `gemini.cmd` directly throws EINVAL on this Node, and `shell: true` would
 * put the policy path through cmd.exe quoting. Running the bundle with node.exe avoids
 * both.
 */
export function geminiLauncher(): Launcher | null {
  const node = findNode();
  const bundle = findBundle();
  return node && bundle ? { node, bundle } : null;
}

/**
 * Written fresh on every start rather than kept in the repo: the CLI only loads
 * policies from `~/.gemini/policies` (its workspace tier is disabled upstream), so a
 * Talos-owned file passed with `--policy` is what keeps this from touching the user's
 * own Gemini setup.
 */
function writePolicy(dir: string): string {
  const toml = [
    '[[rule]]',
    'toolName = "run_shell_command"',
    'decision = "deny"',
    'priority = 999',
    'denyMessage = "Talos has not been given permission to run commands."',
    '',
    '[[rule]]',
    'toolName = ["google_web_search", "web_fetch"]',
    'decision = "ask_user"',
    'priority = 900',
    ''
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'talos-policy.toml');
  fs.writeFileSync(file, toml);
  return file;
}

interface Grant {
  verdict: GateVerdict;
  expiresAt: number;
}

interface Session {
  id: string;
  cwd: string;
  fresh: boolean;
}

/**
 * Drives `gemini --acp` as a child process and answers its protocol calls with the
 * approval cards Talos already owns. The connection outlives a single message so the
 * agent keeps its own context between turns; anything that goes wrong drops it and
 * the next message rebuilds it.
 */
export class GeminiCli implements AgentAdapter {
  readonly id = 'gemini-cli';

  private child: ChildProcessWithoutNullStreams | null = null;
  private conn: ClientConnection | null = null;
  private session: Session | null = null;
  /** The context of the turn in flight — handlers are registered once, turns are not. */
  private active: AgentContext | null = null;
  private streamed = '';
  private grants = new Map<string, Grant>();

  private policy: string | null = null;
  private readonly clientApp = client({ name: 'talos' })
    .onRequest(methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
    .onRequest(methods.client.fs.readTextFile, (ctx) => this.onRead(ctx.params))
    .onRequest(methods.client.fs.writeTextFile, (ctx) => this.onWrite(ctx.params))
    .onNotification(methods.client.session.update, (ctx) => this.onUpdate(ctx.params.update));

  /* The folder is resolved lazily: at module scope app.setName() has not run yet, so
     asking for userData there would return Electron's default path. */
  constructor(
    private gate: ApprovalGate,
    private policyDir: () => string
  ) {}

  static available(): boolean {
    return geminiLauncher() !== null;
  }

  async send(request: AgentRequest, ctx: AgentContext): Promise<string> {
    /* With no granted folder the working directory is home, and an agent that reads some
       files without asking should not be turned loose there. `/tool` is how a folder gets
       granted in the first place, so it stays reachable even now. */
    if (settings().allowedDirs.length === 0) {
      const note =
        'Nothing is allowed yet, so I will not start the agent — it would be working loose in your home folder. ' +
        'Send /tool read <a file in the folder you want> and answer the card with "Allow folder".';
      ctx.say(note);
      return note;
    }

    this.active = ctx;
    this.streamed = '';
    try {
      const session = await this.ensureSession(request);
      return await this.prompt(session, request);
    } finally {
      this.active = null;
      this.grants.clear();
    }
  }

  /** Called from `before-quit` so a child cannot outlive the pet. */
  stop(): void {
    this.teardown();
  }

  /* ------------------------------------------------------------- the connection */

  private async ensureSession(request: AgentRequest): Promise<Session> {
    const cwd = request.cwd;
    if (this.session && this.conn && this.session.cwd === cwd && this.child?.exitCode === null) {
      return { ...this.session, fresh: false };
    }
    this.teardown();

    const launcher = geminiLauncher();
    if (!launcher) throw new Error('Gemini CLI is not installed (looked for %APPDATA%\\npm\\node_modules\\@google\\gemini-cli).');

    const policy = (this.policy ??= writePolicy(this.policyDir()));
    const child = spawn(launcher.node, [launcher.bundle, '--acp', '-m', MODEL, '--approval-mode', 'default', '--policy', policy], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.on('error', (err) => console.error('[gemini] child error:', err.message));

    /* Node's own web-stream globals and the whatwg declarations the SDK was built
       against are structurally incompatible, so the pair is asserted once here. */
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as Parameters<typeof ndJsonStream>[0],
      Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1]
    );
    const conn = this.clientApp.connect(stream);
    this.conn = conn;
    conn.closed.then(() => this.teardown()).catch(() => this.teardown());

    const agent = conn.agent;
    await agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    });

    const created = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    this.session = { id: created.sessionId, cwd, fresh: true };
    return this.session;
  }

  private async prompt(session: Session, request: AgentRequest): Promise<string> {
    const agent = this.conn?.agent;
    if (!agent) throw new Error('the Gemini connection closed mid-message');

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini did not answer within ${TURN_TIMEOUT_MS / 1000}s.`)), TURN_TIMEOUT_MS);
    });

    const text = session.fresh ? seed(request) : request.prompt;
    const inFlight = agent.request(methods.agent.session.prompt, { sessionId: session.id, prompt: [{ type: 'text', text }] });
    /* If the timer wins, the request still rejects later; nobody is awaiting it by then. */
    inFlight.catch(() => {});
    try {
      const done = await Promise.race([inFlight, timeout]);
      /* Nothing left to replay: the live session now holds this exchange. */
      if (this.session) this.session.fresh = false;
      return this.streamed || (done.stopReason === 'end_turn' ? '' : `Gemini ended the turn: ${done.stopReason}.`);
    } catch (err) {
      this.teardown();
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private teardown(): void {
    const child = this.child;
    this.child = null;
    this.conn?.close();
    this.conn = null;
    this.session = null;
    if (child?.pid) {
      /* The CLI re-execs itself with a larger heap, so the pid we hold may have children. */
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill('SIGKILL'));
    }
  }

  /* ------------------------------------------------------ inbound protocol calls */

  private async onPermission(params: { toolCall: ToolCallUpdate; options: PermissionOption[] }): Promise<RequestPermissionResponse> {
    const call = params.toolCall;
    /* Neither of these touches the machine, so they get the card-free pass the gate
       would only spend on something that can change state. */
    if (call.kind === 'think' || call.kind === 'switch_mode') return { outcome: prefer(params.options, true) };

    const kind = toToolKind(call.kind);
    const target = describe(call);
    const cwd = this.session?.cwd ?? '';
    const verdict = await this.gate.request({
      kind,
      target,
      cwd,
      /* A command can do anything its folder can, so `run` never gets an allowlist pass. */
      directory: kind === 'run' ? '' : path.dirname(path.resolve(cwd, target)),
      preview: preview(call)
    });

    if (verdict.ok) this.grants.set(key(kind, target, cwd), { verdict, expiresAt: Date.now() + GRANT_TTL_MS });
    return { outcome: prefer(params.options, verdict.ok, verdict.outcome === 'allow-folder') };
  }

  private async onRead(params: { path: string; line?: number | null; limit?: number | null }) {
    const ctx = this.active;
    if (!ctx) throw RequestError.internalError(undefined, 'Talos is not listening for this session');
    const cwd = this.session?.cwd ?? '';
    const abs = path.resolve(cwd, params.path);
    /* Agents read a file to decide whether they are about to overwrite it. Answering that
       inside the working folder straight away saves a card nobody can usefully approve,
       and the retry loop that follows when they get a refusal instead. */
    if (!path.relative(cwd, abs).startsWith('..') && !fs.existsSync(abs)) {
      throw RequestError.internalError(undefined, `${abs} does not exist`);
    }
    const result = await ctx.tools.read(params.path, cwd);
    if (!result.ok) throw RequestError.internalError(undefined, result.text);
    return { content: slice(result.text, params.line, params.limit) };
  }

  /**
   * A write normally arrives right after a `session/request_permission` the user already
   * answered, so asking a second time would mean two cards for one edit. The grant is
   * what makes that safe: no bytes reach disk without a recorded yes for that path.
   */
  private async onWrite(params: { path: string; content: string }) {
    const ctx = this.active;
    if (!ctx) throw RequestError.internalError(undefined, 'Talos is not listening for this session');
    const cwd = this.session?.cwd ?? '';

    const grant = this.takeGrant('write', params.path, cwd);
    if (grant) {
      try {
        const abs = path.resolve(cwd, params.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, params.content);
        auditExecuted(grant, `${abs} (${params.content.length} chars written)`);
        return {};
      } catch (err) {
        auditExecuted(grant, params.path, err instanceof Error ? err.message : String(err));
        throw RequestError.internalError(undefined, err instanceof Error ? err.message : String(err));
      }
    }

    const result = await ctx.tools.write(params.path, params.content, cwd);
    if (!result.ok) throw RequestError.internalError(undefined, result.text);
    return {};
  }

  private onUpdate(update: SessionUpdate): void {
    if (update.sessionUpdate !== 'agent_message_chunk') return;
    const text = update.content.type === 'text' ? update.content.text : '';
    if (!text) return;
    this.streamed += text;
    this.active?.say(text);
  }

  private takeGrant(kind: ToolKind, target: string, cwd: string): GateVerdict | null {
    const entry = this.grants.get(key(kind, target, cwd));
    if (!entry) return null;
    this.grants.delete(key(kind, target, cwd));
    return entry.expiresAt > Date.now() ? entry.verdict : null;
  }
}

/* ---------------------------------------------------------------------- helpers */

function toToolKind(kind: AcpToolKind | undefined | null): ToolKind {
  if (kind === 'read' || kind === 'search') return 'read';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'write';
  /* execute, fetch, other and anything newer all get the strictest treatment. */
  return 'run';
}

function describe(call: ToolCallUpdate): string {
  const raw = call.rawInput as Record<string, unknown> | undefined;
  const fromRaw = raw ? [raw.path, raw.file_path, raw.absolute_path, raw.directory, raw.command] : [];
  return (
    fromRaw.find((v): v is string => typeof v === 'string' && v.length > 0) ??
    call.locations?.[0]?.path ??
    call.title ??
    ''
  );
}

function preview(call: ToolCallUpdate): string {
  if (call.kind === 'execute') return '';
  const raw = call.rawInput as { content?: unknown } | undefined;
  return typeof raw?.content === 'string' ? raw.content.slice(0, 4000) : '';
}

function prefer(options: PermissionOption[], allowed: boolean, always = false): RequestPermissionOutcome {
  const wanted = allowed
    ? always
      ? ['allow_always', 'allow_once']
      : ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind);
    if (match) return { outcome: 'selected', optionId: match.optionId };
  }
  /* Nothing recognisable: cancelling is the ACP way of saying no. */
  return { outcome: 'cancelled' };
}

function key(kind: ToolKind, target: string, cwd: string): string {
  return `${kind}:${path.resolve(cwd, target)}`;
}

function slice(text: string, line?: number | null, limit?: number | null): string {
  if (!line && !limit) return text;
  const lines = text.split('\n');
  const from = Math.max(1, line ?? 1) - 1;
  return lines.slice(from, limit ? from + limit : undefined).join('\n');
}

/**
 * The CLI has its own system prompt, so the persona travels as the first message
 * instead. History is replayed only when a session had to be rebuilt; while one is
 * alive the agent remembers the conversation itself.
 */
function seed(request: AgentRequest): string {
  const prior = request.history.slice(-12);
  const transcript = prior
    .map((m) => `${m.role === 'user' ? 'User' : 'Talos'}: ${m.text}`)
    .join('\n');
  return [
    request.persona,
    transcript ? `Earlier in this conversation:\n${transcript}` : '',
    `You are working in ${request.cwd}. Everything you read or write is shown to the user for approval first.`,
    `First user message: ${request.prompt}`
  ]
    .filter(Boolean)
    .join('\n\n');
}
