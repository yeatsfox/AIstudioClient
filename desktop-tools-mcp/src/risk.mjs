// Risk classification for the local tools.
//
// Why this exists: the host app can only answer "does this tool need approval"
// per tool name, which gives the user one blunt decision — approve `run_powershell`
// and every future shell command in the session runs silently. This module adds
// a second, content-aware layer inside the server itself: the same tool can be
// read-only for one call and destructive for the next, and the caller learns
// which before anything executes.
//
// The classification is advisory for the host and authoritative for the audit
// log. It is deliberately conservative: an unknown shape is treated as the
// riskiest category the tool could produce, never as `read`.
import path from 'node:path';

export const RISK_LEVELS = ['read', 'mutate', 'exec', 'destructive'];

/** Ordering used to compare and aggregate risk levels. */
const RISK_RANK = { read: 0, mutate: 1, exec: 2, destructive: 3 };

export function compareRisk(a, b) {
  return (RISK_RANK[a] ?? 0) - (RISK_RANK[b] ?? 0);
}

export function maxRisk(...levels) {
  return levels.reduce((worst, level) => (compareRisk(level, worst) > 0 ? level : worst), 'read');
}

// Paths whose modification changes how the *machine* behaves rather than how a
// project reads. Writing these is never a routine edit and is worth flagging.
const SENSITIVE_SEGMENTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  'appdata/roaming/microsoft/windows/start menu',
  'system32',
  'windows',
  'etc',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.gitconfig',
  '.npmrc',
  '.netrc',
];

const SECRET_FILENAME_PATTERN =
  /(^\.env($|\.)|\.(pem|p12|pfx|key|keystore|jks|ppk)$|^(id_rsa|id_ed25519|id_ecdsa|credentials|\.netrc|\.npmrc)$)/i;

const SECRET_EXTENSION_PATTERN = /\.(pem|p12|pfx|key|keystore|jks|ppk|kdbx|crt|cer)$/i;

/**
 * Whether a path looks like it holds a secret or drives system behaviour.
 *
 * Case-insensitive and separator-normalised so Windows paths match POSIX
 * patterns; this runs on a path the caller already resolved inside a root.
 */
export function isSensitivePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);

  if (SECRET_FILENAME_PATTERN.test(base) || SECRET_EXTENSION_PATTERN.test(normalized)) {
    return true;
  }
  return SENSITIVE_SEGMENTS.some((segment) => normalized.includes(segment));
}

// Shell commands that destroy data or reconfigure the machine. Kept as narrow,
// literal patterns: a false warning teaches users to click through warnings,
// which is worse than missing an exotic case.
const DESTRUCTIVE_PATTERNS = [
  // Specific pattern first: the label is shown to the user, so "recursive
  // delete" must win over the generic "delete".
  {
    pattern: /\bremove-item\b[\s\S]*(-recurse|-force)|(-recurse|-force)[\s\S]*\bremove-item\b/i,
    reason: 'recursive/forced delete',
  },
  // A bare Remove-Item is a delete. Matching the verb alone matters because it
  // is often piped (`Get-ChildItem | Remove-Item`) with no switch on the line.
  { pattern: /\bremove-item\b/i, reason: 'file/directory delete' },
  { pattern: /\brm\b\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: 'recursive/forced delete' },
  { pattern: /\b(rmdir|rd)\b\s+\/s/i, reason: 'directory tree delete' },
  { pattern: /\bdel\b\s+\/[fsq]/i, reason: 'forced delete' },
  { pattern: /\bformat(-volume)?\b\s+[a-z]:/i, reason: 'volume format' },
  { pattern: /\b(cipher)\b\s+\/w/i, reason: 'free-space wipe' },
  { pattern: /\b(drop\s+(database|table)|truncate\s+table)\b/i, reason: 'SQL destructive statement' },
  {
    pattern: /\bgit\b\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|push\s+.*-f\b)/i,
    reason: 'irreversible git operation',
  },
  {
    pattern: /\b(set-executionpolicy|set-mppreference|disable-windowsdefender|bcdedit|diskpart|reg\s+delete)\b/i,
    reason: 'system or security reconfiguration',
  },
  { pattern: /\b(shutdown|restart-computer|stop-computer)\b/i, reason: 'machine power state change' },
  { pattern: /\bset-itemproperty\b[\s\S]*\b(environment|path)\b/i, reason: 'environment/registry mutation' },
  {
    pattern: /\b(curl|wget|invoke-webrequest|iwr|irm)\b[\s\S]*\|\s*(iex|invoke-expression|sh|bash|node|python)/i,
    reason: 'download piped into an interpreter',
  },
];

// Commands that run code or reach the network: not destructive by themselves,
// but they can do things the file tools cannot express, so they are `exec`.
const EXEC_PATTERNS = [
  /\b(git|npm|pnpm|yarn|node|python|pip|dotnet|cargo|go|mvn|gradle|docker|kubectl|terraform)\b/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i,
  /[;&|]{1,2}\s*/,
  /\$\(|`/,
];

/**
 * Classify a PowerShell script.
 *
 * Returns the risk level plus the matched reason, so the approval prompt and
 * the audit log can say *why* rather than showing a bare colour.
 */
export function classifyShellCommand(script) {
  const text = typeof script === 'string' ? script : '';
  if (!text.trim()) {
    return { level: 'exec', reason: 'empty script' };
  }

  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(text)) {
      return { level: 'destructive', reason };
    }
  }

  // A script that only reads: Get-*, Select-*, Where-Object, Test-Path, and
  // friends. Anything outside that vocabulary gets the safer `exec` label.
  const readOnlyVerb =
    /^\s*(get-[a-z]+|select-[a-z]+|where-object|sort-object|measure-object|test-path|resolve-path|compare-object|group-object|format-(table|list)|out-string|convertto-json|convertfrom-json|write-output|write-host|echo|pwd|dir|ls|cat|type|findstr|select-string)\b/i;
  const hasPipeline = /[;&|]/.test(text);
  const hasAssignment = /^\s*\$[a-z_][\w]*\s*=/i.test(text);

  if (hasAssignment || !readOnlyVerb.test(text) || hasPipeline) {
    return { level: 'exec', reason: hasPipeline ? 'contains chaining/pipeline' : 'not a known read-only verb' };
  }

  return { level: 'read', reason: 'read-only cmdlet' };
}

/** Classify a file tool call from its arguments. */
export function classifyFileTool(toolName, args = {}) {
  const target = typeof args.path === 'string' ? args.path : '';
  const sensitive = isSensitivePath(target);

  switch (toolName) {
    case 'list_dir':
    case 'read_file':
    case 'search_files':
      return { level: 'read', reason: sensitive ? 'reads a sensitive path' : 'read-only tool' };
    case 'write_file':
    case 'replace_in_file':
      return {
        level: sensitive ? 'destructive' : 'mutate',
        reason: sensitive ? 'writes a sensitive path' : 'modifies a file',
      };
    default:
      return { level: 'exec', reason: 'unclassified tool' };
  }
}

/** Single entry point: classify any tool call before it runs. */
export function classifyToolCall(toolName, args = {}) {
  if (toolName === 'run_powershell') {
    return classifyShellCommand(typeof args.script === 'string' ? args.script : '');
  }
  return classifyFileTool(toolName, args);
}
