import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDecision, ApprovalOutcome, ToolKind, ToolRequest } from '../shared/types';
import { audit, type AuditSource } from './audit';
import { persist, settings } from './settings';

export const APPROVAL_TTL_MS = 60_000;

export interface GateVerdict {
  ok: boolean;
  kind: ToolKind;
  outcome: ApprovalOutcome;
  source: AuditSource;
  /** the audit line's id, so the tool can append what actually happened */
  id: string;
}

export interface GateWiring {
  /** Show the card. Returning false means there was nowhere to show it, which denies. */
  show(request: ToolRequest): boolean;
  hide(id: string, outcome: ApprovalOutcome): void;
}

interface Pending {
  request: ToolRequest;
  resolve: (verdict: GateVerdict) => void;
  timer: NodeJS.Timeout;
}

/**
 * Every privileged action blocks here. Deny is the default on every branch, and the
 * only routes to a yes are a user click inside the TTL or a folder granted earlier.
 */
export class ApprovalGate {
  private pending = new Map<string, Pending>();

  constructor(private wiring: GateWiring) {}

  get waiting(): number {
    return this.pending.size;
  }

  /**
   * Symlinks are resolved before comparing, so an allowed folder cannot be used as a
   * doorway out of itself. A file that does not exist yet is judged by its parent.
   */
  private inside(dir: string): boolean {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      try {
        real = path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
      } catch {
        return false;
      }
    }
    for (const allowed of settings().allowedDirs) {
      let base: string;
      try {
        base = fs.realpathSync(allowed);
      } catch {
        base = allowed;
      }
      const rel = path.relative(base, real);
      if (rel === '' || (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    }
    return false;
  }

  addAllowedDir(dir: string): void {
    const current = settings();
    if (current.allowedDirs.includes(dir)) return;
    current.allowedDirs = [...current.allowedDirs, dir];
    persist();
  }

  async request(input: {
    kind: ToolKind;
    target: string;
    cwd: string;
    directory: string;
    preview?: string;
  }): Promise<GateVerdict> {
    if (!settings().toolsEnabled) {
      return this.record(input, 'tools-off', 'kill-switch', false);
    }
    /* A command can do anything its cwd can, so the allowlist never covers `run`. */
    if (input.kind !== 'run' && this.inside(input.directory)) {
      return this.record(input, 'allow', 'allowlist', true);
    }

    const request: ToolRequest = {
      id: randomUUID(),
      kind: input.kind,
      target: input.target,
      cwd: input.cwd,
      preview: input.preview ?? '',
      directory: input.directory,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    };

    return new Promise<GateVerdict>((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, 'expired', 'timer'), APPROVAL_TTL_MS);
      this.pending.set(request.id, { request, resolve, timer });
      if (!this.wiring.show(request)) this.settle(request.id, 'no-window', 'no-window');
    });
  }

  decide(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (decision === 'allow-folder') this.addAllowedDir(entry.request.directory);
    this.settle(id, decision, 'user');
  }

  /** Used by the tray kill switch and on quit, so nothing is left waiting forever. */
  cancelAll(outcome: ApprovalOutcome, source: AuditSource): void {
    for (const id of [...this.pending.keys()]) this.settle(id, outcome, source);
  }

  private settle(id: string, outcome: ApprovalOutcome, source: AuditSource): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.wiring.hide(id, outcome);
    const ok = outcome === 'allow' || outcome === 'allow-folder';
    const verdict = this.record(
      { kind: entry.request.kind, target: entry.request.target, cwd: entry.request.cwd },
      outcome,
      source,
      ok,
      entry.request.id
    );
    entry.resolve(verdict);
  }

  private record(
    input: { kind: ToolKind; target: string; cwd: string },
    outcome: ApprovalOutcome,
    source: AuditSource,
    ok: boolean,
    id: string = randomUUID()
  ): GateVerdict {
    /* Listed field by field rather than spread: the auto-allow caller hands over the
       whole request, and a preview must not leak into a log line that the card path
       would not also write. */
    audit({
      ts: new Date().toISOString(),
      id,
      kind: input.kind,
      target: input.target,
      cwd: input.cwd,
      outcome,
      source,
      ran: false
    });
    return { ok, kind: input.kind, outcome, source, id };
  }
}

/**
 * Written after the action, not instead of the decision line — a granted write that
 * then failed must not look like it succeeded.
 */
export function auditExecuted(verdict: GateVerdict, target: string, error?: string): void {
  audit({
    ts: new Date().toISOString(),
    id: verdict.id,
    kind: verdict.kind,
    target,
    cwd: '',
    outcome: verdict.outcome,
    source: verdict.source,
    ran: !error,
    error,
  });
}
