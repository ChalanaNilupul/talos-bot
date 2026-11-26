import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../shared/types';

/**
 * The transcript is the one piece of state a user would notice losing, so it
 * survives restarts. It is not a database: one JSON array, newest end last,
 * capped at HISTORY_LIMIT by the caller. Memory and recall are P3's job.
 */
const file = () => path.join(app.getPath('userData'), 'chat-history.json');

export function loadHistory(): ChatMessage[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (m): m is ChatMessage =>
        !!m && typeof m === 'object' && typeof (m as ChatMessage).text === 'string' &&
        ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'talos')
    );
  } catch {
    /* first run, or a file we could not parse — either way, start empty rather
       than refusing to launch */
    return [];
  }
}

export function saveHistory(messages: ChatMessage[]): void {
  const target = file();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    /* Write-then-rename: a crash halfway through a plain overwrite would leave a
       truncated file, and the failure would look like the conversation vanished. */
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(messages, null, 2));
    fs.renameSync(temp, target);
  } catch (err) {
    console.error('[talos] chat history not saved:', err);
  }
}

export function clearHistoryFile(): void {
  try {
    fs.rmSync(file(), { force: true });
  } catch (err) {
    console.error('[talos] chat history not cleared:', err);
  }
}
