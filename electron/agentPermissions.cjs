// Pre-approving tools for the Antigravity CLI.
//
// Headless `agy` cannot show an approval prompt, so a tool it was not told
// about in advance is soft-denied: the run continues and the work silently
// does not happen. The supported answer is `permissions.allow` in the CLI's
// global settings file, and this module writes exactly one rule into it.
//
// The rules this module writes are additive. The settings file belongs to the
// user and is shared with every other Antigravity surface, so the file is read,
// the new rule merged in, and the result written atomically. A file that cannot
// be parsed is never overwritten: guessing at a broken config is how a working
// setup gets destroyed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Absolute path to the CLI settings file.
 *
 * Antigravity keeps its config under the home directory on every platform, so
 * no per-OS branch is needed here. `homeDir` is injectable for tests.
 */
function settingsPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
}

/**
 * Validate a rule before it reaches the file.
 *
 * The rule arrives from the renderer, so it is treated as untrusted input: only
 * the documented `action(target)` shape is accepted, and the target may not be
 * empty. A wildcard target is allowed because the CLI documents `(*)`, but it
 * is a decision the user makes explicitly by approving that notice.
 */
const RULE_PATTERN = /^(read_file|write_file|read_url|execute_url|download_url|command|unsandboxed|mcp)\(\S(?:.*\S)?\)$/;

function isValidRule(rule) {
  return typeof rule === 'string' && rule.length <= 512 && RULE_PATTERN.test(rule);
}

/** Read the settings file. A missing file is an empty config, not an error. */
function readSettings(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { settings: {}, existed: false };
    throw error;
  }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('The Antigravity settings file does not contain a JSON object.');
  }
  return { settings, existed: true };
}

/**
 * Write the settings back without a window in which the file is empty.
 *
 * A plain `writeFileSync` truncates first, so a crash mid-write leaves the user
 * with no settings at all. Writing a sibling temp file and renaming is atomic on
 * the same filesystem.
 */
function writeSettingsAtomic(filePath, settings) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file is best-effort cleanup; the original error is what matters.
    }
    throw error;
  }
}

/**
 * Add one rule to `permissions.allow`.
 *
 * Returns `{ added }`: `false` when the rule was already present, so the caller
 * can tell a real change from a no-op instead of reporting a write that did not
 * happen.
 */
function allowRule(rule, homeDir) {
  if (!isValidRule(rule)) {
    return { added: false, error: `Not a recognised permission rule: ${String(rule).slice(0, 80)}` };
  }
  const filePath = settingsPath(homeDir);

  let settings;
  try {
    const existing = readSettings(filePath);
    settings = existing.settings;
  } catch (error) {
    // Refusing to proceed is the only safe move: the file is user data this
    // module does not understand, and rewriting it would lose their config.
    return { added: false, error: `Could not read ${filePath}: ${error.message}` };
  }

  const permissions = settings.permissions && typeof settings.permissions === 'object'
    ? settings.permissions
    : {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];

  if (allow.includes(rule)) {
    return { added: false, alreadyAllowed: true, path: filePath };
  }
  allow.push(rule);
  settings.permissions = { ...permissions, allow };

  try {
    writeSettingsAtomic(filePath, settings);
  } catch (error) {
    return { added: false, error: `Could not write ${filePath}: ${error.message}` };
  }
  return { added: true, path: filePath, rule };
}

/** Read back the current allow list, for showing the user what is granted. */
function listAllowedRules(homeDir) {
  const filePath = settingsPath(homeDir);
  try {
    const { settings } = readSettings(filePath);
    const allow = settings.permissions && Array.isArray(settings.permissions.allow)
      ? settings.permissions.allow.filter((rule) => typeof rule === 'string')
      : [];
    return { path: filePath, allow };
  } catch (error) {
    return { path: filePath, allow: [], error: error.message };
  }
}

module.exports = { settingsPath, isValidRule, allowRule, listAllowedRules, RULE_PATTERN };
