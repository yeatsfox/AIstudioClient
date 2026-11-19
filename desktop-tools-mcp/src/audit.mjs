// Append-only audit trail for the local tools.
//
// The host app already shows an approval dialog, but that dialog disappears
// once clicked: there is no record of "what did the model do to my files at
// 21:04". This writes one JSON object per line so the file stays appendable
// and greppable without a parser, and never blocks a tool call: a failing log
// must not fail the operation it was recording.
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './redact.mjs';

/** Keep one file below a size that is still openable in a text editor. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function createAuditLog({ logPath, now = () => Date.now() } = {}) {
  let writeChain = Promise.resolve();
  let warned = false;

  const warnOnce = (error) => {
    if (warned) return;
    warned = true;
    // stderr is the MCP server's log channel; stdout carries the protocol.
    console.error(`desktop-tools-mcp: audit log unavailable (${error?.code ?? error?.message ?? error})`);
  };

  /** Rotate by rename so an external tail keeps its open handle. */
  const rotateIfNeeded = async () => {
    const stat = await fs.stat(logPath).catch(() => null);
    if (!stat || stat.size < MAX_LOG_BYTES) return;
    await fs.rename(logPath, `${logPath}.1`).catch(() => {});
  };

  const write = async (entry) => {
    if (!logPath) return;
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await rotateIfNeeded();
      const line = `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`;
      await fs.appendFile(logPath, redactSecrets(line), 'utf8');
    } catch (error) {
      warnOnce(error);
    }
  };

  return {
    /**
     * Record one tool call. Writes are serialised so two concurrent calls
     * cannot interleave half-lines, and the returned promise always resolves:
     * audit failures are reported once and then swallowed.
     */
    record(entry) {
      writeChain = writeChain.then(() => write(entry));
      return writeChain;
    },
    /** Wait for queued writes; used before exiting. */
    flush() {
      return writeChain;
    },
  };
}
