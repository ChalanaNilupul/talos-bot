import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ApprovalGate, auditExecuted } from './gate';

const MAX_READ_BYTES = 200_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;
const PREVIEW_LINES = 24;

export interface ToolResult {
  ok: boolean;
  /** what the agent gets back: content, output, or the reason it was refused */
  text: string;
}

/** Absolute, with `..` collapsed. Null bytes are rejected before anything touches a syscall. */
function toAbsolute(raw: string, cwd: string): string {
  if (raw.includes('\0')) throw new Error('path contains a null byte');
  return path.resolve(cwd, raw);
}

/**
 * Not a real diff — the common head and tail are trimmed and what is left is shown
 * with -/+. It is a preview for a human to read before deciding, so exact line
 * numbers matter less than never hiding a changed line inside the elision.
 */
function diffPreview(oldText: string, newText: string): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const lines: string[] = [];
  if (head) lines.push(`  … ${head} unchanged line${head === 1 ? '' : 's'} …`);
  for (const l of removed.slice(0, PREVIEW_LINES)) lines.push(`- ${l}`);
  if (removed.length > PREVIEW_LINES) lines.push(`- … ${removed.length - PREVIEW_LINES} more removed`);
  for (const l of added.slice(0, PREVIEW_LINES)) lines.push(`+ ${l}`);
  if (added.length > PREVIEW_LINES) lines.push(`+ … ${added.length - PREVIEW_LINES} more added`);
  if (tail) lines.push(`  … ${tail} unchanged line${tail === 1 ? '' : 's'} …`);
  return lines.join('\n');
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated` : text;
}

/**
 * The only place that touches fs or spawns anything. Each method asks the gate first
 * and returns a refusal string instead of throwing, so a denied action reads as an
 * ordinary reply rather than a crash the agent has to guess about.
 */
export class Tools {
  constructor(private gate: ApprovalGate) {}

  async read(rawPath: string, cwd: string): Promise<ToolResult> {
    const abs = toAbsolute(rawPath, cwd);
    const verdict = await this.gate.request({ kind: 'read', target: abs, cwd, directory: path.dirname(abs) });
    if (!verdict.ok) return refused(verdict);
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_READ_BYTES) {
        auditExecuted(verdict, `${abs} (refused: too large)`);
        return { ok: false, text: `Refused: ${abs} is ${stat.size} bytes, over the ${MAX_READ_BYTES} byte read limit.` };
      }
      const text = fs.readFileSync(abs, 'utf8');
      auditExecuted(verdict, `${abs} (${text.length} chars)`);
      return { ok: true, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditExecuted(verdict, abs, message);
      return { ok: false, text: `Could not read ${abs}: ${message}` };
    }
  }

  async write(rawPath: string, content: string, cwd: string): Promise<ToolResult> {
    const abs = toAbsolute(rawPath, cwd);
    let oldText = '';
    let exists = false;
    try {
      oldText = fs.readFileSync(abs, 'utf8');
      exists = true;
    } catch {
      /* a new file is the normal case, not an error */
    }
    const verdict = await this.gate.request({
      kind: 'write',
      target: abs,
      cwd,
      directory: path.dirname(abs),
      preview: exists ? diffPreview(oldText, content) : `new file, ${content.split('\n').length} lines\n${clip(content)}`,
    });
    if (!verdict.ok) return refused(verdict);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      auditExecuted(verdict, `${abs} (${content.length} chars written)`);
      return { ok: true, text: exists ? `Updated ${abs}.` : `Created ${abs}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditExecuted(verdict, abs, message);
      return { ok: false, text: `Could not write ${abs}: ${message}` };
    }
  }

  async run(command: string, cwd: string): Promise<ToolResult> {
    /* No directory is offered: "always allow this folder" would mean "always allow any
       command run from this folder", which is not a thing the user is agreeing to. */
    const verdict = await this.gate.request({ kind: 'run', target: command, cwd, directory: '' });
    if (!verdict.ok) return refused(verdict);
    const output = await execute(command, cwd);
    auditExecuted(verdict, `${command} -> exit ${output.code}`, output.error);
    if (output.error) return { ok: false, text: output.error };
    return { ok: output.code === 0, text: `exit ${output.code}\n${clip(output.stdout)}${output.stderr ? `\n--- stderr ---\n${clip(output.stderr)}` : ''}` };
  }
}

function refused(verdict: { outcome: string; source: string }): ToolResult {
  const why =
    verdict.source === 'kill-switch'
      ? 'tools are switched off in the tray menu'
      : verdict.outcome === 'expired'
        ? 'nobody answered within 60 seconds'
        : verdict.outcome === 'no-window'
          ? 'there was no window to ask in'
          : 'you denied it';
  return { ok: false, text: `Not allowed: ${why}.` };
}

interface Executed {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

function execute(command: string, cwd: string): Promise<Executed> {
  return new Promise((resolve) => {
    /* PowerShell rather than cmd: it is what this machine is driven with, and the
       command string the user approves is the string that runs. */
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: Executed) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(result);
    };
    const killer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout, stderr, error: `Timed out after ${RUN_TIMEOUT_MS / 1000}s and was killed.` });
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => done({ code: -1, stdout, stderr, error: err.message }));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}
