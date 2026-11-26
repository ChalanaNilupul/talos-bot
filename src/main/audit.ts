import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalOutcome, ToolKind } from '../shared/types';

export type AuditSource = 'user' | 'allowlist' | 'timer' | 'kill-switch' | 'no-window';

export interface AuditEntry {
  ts: string;
  id: string;
  kind: ToolKind;
  target: string;
  cwd: string;
  outcome: ApprovalOutcome;
  /** who actually made the call — an audit line that does not say this is useless */
  source: AuditSource;
  /** set only after the action ran, so a granted-but-failed action is still visible */
  ran?: boolean;
  error?: string;
}

export function auditDir(): string {
  return path.join(app.getPath('userData'), 'audit');
}

/** One file per day, appended to and never rewritten. */
function fileFor(today: string): string {
  return path.join(auditDir(), `${today}.jsonl`);
}

export function audit(entry: AuditEntry): void {
  const file = fileFor(new Date().toISOString().slice(0, 10));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (err) {
    /* A failed audit write must not be swallowed: it is the only record that the
       app touched the machine, and the user is entitled to know it is missing. */
    console.error('[talos] AUDIT WRITE FAILED — privileged actions are not being logged:', err);
  }
}
