// Verifies the permission writer against a real temp filesystem.
//
// The behaviour that matters is what ends up on disk: an existing settings file
// must keep every unrelated key, a second approval must not duplicate the rule,
// and an unparseable file must be left exactly as it was found.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perms = require('../electron/agentPermissions.cjs');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-perm-'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  return home;
}

const settingsFor = (home) => perms.settingsPath(home);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

check('creates the settings file and directory when absent', () => {
  const home = makeHome();
  const file = settingsFor(home);
  fs.rmSync(path.join(home, '.gemini'), { recursive: true, force: true });

  const result = perms.allowRule('command(git)', home);
  assert.strictEqual(result.added, true, 'rule should be added');
  assert.ok(fs.existsSync(file), 'settings file should exist');

  const written = readJson(file);
  assert.deepStrictEqual(written.permissions.allow, ['command(git)']);
});

check('keeps unrelated keys and existing rules', () => {
  const home = makeHome();
  const file = settingsFor(home);
  fs.writeFileSync(file, JSON.stringify({
    agentMode: 'auto',
    permissions: { allow: ['command(npm)'], deny: ['command(sudo)'] },
  }, null, 2));

  perms.allowRule('write_file(src/)', home);

  const written = readJson(file);
  assert.strictEqual(written.agentMode, 'auto', 'agentMode must survive');
  assert.deepStrictEqual(written.permissions.allow, ['command(npm)', 'write_file(src/)']);
  assert.deepStrictEqual(written.permissions.deny, ['command(sudo)'], 'deny list must survive');
});

check('is idempotent: an already allowed rule reports no change', () => {
  const home = makeHome();
  const file = settingsFor(home);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['command(git)'] } }, null, 2));
  const before = fs.readFileSync(file, 'utf8');

  const result = perms.allowRule('command(git)', home);

  assert.strictEqual(result.added, false);
  assert.strictEqual(result.alreadyAllowed, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'file must not be rewritten');
});

check('leaves an unparseable file untouched and reports why', () => {
  const home = makeHome();
  const file = settingsFor(home);
  const broken = '{ this is not json';
  fs.writeFileSync(file, broken);

  const result = perms.allowRule('command(git)', home);

  assert.strictEqual(result.added, false);
  assert.match(result.error, /Could not read/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, 'broken file must be preserved');
});

check('rejects a malformed rule without touching the file', () => {
  const home = makeHome();
  const file = settingsFor(home);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }, null, 2));
  const before = fs.readFileSync(file, 'utf8');

  for (const rule of ['command()', 'rm -rf /', '', 'command(git)\n{"x":1}', null]) {
    const result = perms.allowRule(rule, home);
    assert.strictEqual(result.added, false, `should reject ${JSON.stringify(rule)}`);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

check('lists current rules, and tolerates a missing file', () => {
  const home = makeHome();
  assert.deepStrictEqual(perms.listAllowedRules(home).allow, []);

  perms.allowRule('read_url(google.com)', home);
  assert.deepStrictEqual(perms.listAllowedRules(home).allow, ['read_url(google.com)']);
});

check('creates no temp file left behind', () => {
  const home = makeHome();
  const file = settingsFor(home);
  perms.allowRule('command(git)', home);

  const stray = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
  assert.deepStrictEqual(stray, [], 'no temp files should remain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
