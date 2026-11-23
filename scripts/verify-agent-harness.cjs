/**
 * End-to-end exercise of the agent harness manager against a fake `agy`.
 *
 * The real CLI is not installed in this environment, so the transport is
 * proved against a stub that speaks the documented `stream-json` protocol.
 * This covers what unit tests cannot: that the manager spawns the binary, that
 * one process serves several turns, that lines are reassembled correctly, and
 * that quitting kills the child.
 */
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Put the stub on PATH before requiring the manager, which resolves lazily.
const stubDir = '/tmp/agy-stub';
process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;

const harness = require('/root/.openclaw/workspace/projects/AIstudioClient/electron/agentHarness.cjs');

const collected = [];
const emit = (payload) => collected.push(payload);

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Collected: ${JSON.stringify(collected, null, 1)}`);
};

(async () => {
  // 1. Detection finds the stub on PATH.
  const detected = harness.detectHarnesses();
  const antigravity = detected.find((entry) => entry.id === 'antigravity');
  assert.strictEqual(antigravity.installed, true, 'stub should be detected as installed');
  assert.strictEqual(antigravity.path, path.join(stubDir, 'agy'), 'resolved path should be the stub');
  console.log('PASS detect: found the CLI at', antigravity.path);

  // 2. Start a conversation.
  const cwd = fs.mkdtempSync('/tmp/agent-e2e-');
  const started = harness.startSession({ harness: 'antigravity', cwd }, emit);
  assert.ok(started.sessionId, `start should return a session id, got ${JSON.stringify(started)}`);
  const { sessionId } = started;
  console.log('PASS start:', sessionId);

  await waitFor(() => collected.some((p) => p.stream === 'stdout' && p.line.includes('"init"')), 'init event');
  console.log('PASS init event received');

  // 3. First turn.
  const sent1 = harness.sendPrompt(sessionId, 'list the files');
  assert.deepStrictEqual(sent1, { ok: true }, 'first prompt should be accepted');
  await waitFor(() => collected.some((p) => p.stream === 'stdout' && p.line.includes('"result"')), 'turn 1 result');
  console.log('PASS turn 1 produced a result');

  // The same process serves a second turn: this is the property that makes the
  // warm conversation worth keeping alive rather than restarting per message.
  collected.length = 0;
  const sent2 = harness.sendPrompt(sessionId, 'now summarize');
  assert.deepStrictEqual(sent2, { ok: true });
  await waitFor(() => collected.some((p) => p.stream === 'stdout' && p.line.includes('"result"')), 'turn 2 result');

  const resultLines = collected.filter((p) => p.stream === 'stdout' && p.line.includes('"result"'));
  const turn2 = JSON.parse(resultLines[0].line);
  assert.strictEqual(turn2.result.num_turns, 2, 'second turn should reuse the process and count as turn 2');
  assert.ok(turn2.result.response.includes('now summarize'), 'response should answer the second prompt');
  console.log('PASS turn 2 reused the same process (num_turns=2)');

  // 4. Tool output and a tool error arrive on stdout as step events.
  const toolLines = collected.filter((p) => p.stream === 'stdout' && p.line.includes('"tool"'));
  assert.ok(toolLines.length >= 2, 'expected tool step events');
  const deniedLine = toolLines.find((p) => p.line.includes('denied by policy'));
  assert.ok(deniedLine, 'the failed tool step should be forwarded');
  console.log('PASS tool steps forwarded, including a permission failure');

  // 5. stderr is forwarded separately, so the UI can notice soft-denials.
  const stderrLines = collected.filter((p) => p.stream === 'stderr');
  assert.ok(
    stderrLines.some((p) => p.line.includes('requires approval')),
    'stderr notices should be forwarded',
  );
  console.log('PASS stderr forwarded');

  // 6. Rejections.
  const badHarness = harness.startSession({ harness: 'nope', cwd }, emit);
  assert.ok(badHarness.error, 'unknown harness must be rejected');
  console.log('PASS rejects an unknown harness');

  const badCwd = harness.startSession({ harness: 'antigravity', cwd: '/definitely/not/here' }, emit);
  assert.ok(badCwd.error, 'a missing folder must be rejected');
  console.log('PASS rejects a missing working folder');

  const emptyPrompt = harness.sendPrompt(sessionId, '   ');
  assert.ok(emptyPrompt.error, 'empty prompts must be rejected');
  console.log('PASS rejects an empty prompt');

  const unknownSession = harness.sendPrompt('agent-9999', 'hello');
  assert.ok(unknownSession.error, 'unknown session must be rejected');
  console.log('PASS rejects an unknown session');

  // 7. Stopping terminates the child and reports the exit.
  collected.length = 0;
  harness.stopSession(sessionId);
  await waitFor(() => collected.some((p) => p.stream === 'exit'), 'exit event');
  const exit = collected.find((p) => p.stream === 'exit');
  assert.strictEqual(exit.stopped, true, 'exit should be marked as user-stopped');
  console.log('PASS stop terminates the process and marks it stopped');

  // 8. stopAll cleans up anything left over.
  const second = harness.startSession({ harness: 'antigravity', cwd }, emit);
  assert.ok(second.sessionId);
  harness.stopAll();
  console.log('PASS stopAll cleaned up');

  console.log('\nALL E2E CHECKS PASSED');
  process.exit(0);
})().catch((error) => {
  console.error('E2E FAILED:', error.message);
  harness.stopAll();
  process.exit(1);
});
