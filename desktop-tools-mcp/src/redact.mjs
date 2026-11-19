// Redaction for anything the tools send back to the model.
//
// The model reads file contents and command output. If a file happens to
// contain a token, the model would otherwise repeat it into the chat — and
// from there into logs, exports and screenshots. This strips the shapes that
// are unmistakably credentials while leaving ordinary prose untouched.
//
// Deliberately conservative: over-redacting source code makes the tools
// useless, so only high-confidence patterns are matched and the replacement
// keeps a short prefix so the user can still tell which value was hidden.
const RULES = [
  // PEM blocks win over everything else; a key body must never leak in part.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[redacted private key]',
  },
  // Well-known token formats.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '[redacted GitHub token]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: '[redacted GitHub token]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: '[redacted API key]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: '[redacted Google API key]' },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[redacted Slack token]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[redacted AWS access key]' },
  // Our own auth cookie: `amc_session="<base64 payload>"`. It is not a PEM or
  // a vendor token, so only this rule knows what it is.
  {
    pattern: /\b(amc[_-][A-Za-z0-9_-]*)\s*=\s*"?[A-Za-z0-9%._~+/-]{16,}"?/gi,
    replace: (_match, name) => `${name}=[redacted]`,
  },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[redacted JWT]' },
  // Assignments in any of the shapes that show up in config files and JSON:
  // `password = "..."`, `password: "..."`, `"apiKey": "..."`, `SECRET=...`.
  // The key may be quoted, and the separator may be `:` or `=`.
  {
    pattern:
      /["']?\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;}{]{6,})/gi,
    replace: (_match, name) => `${name}=[redacted]`,
  },
  // Credentials embedded in URLs: scheme://user:pass@host
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replace: (_match, scheme) => `${scheme}[redacted]@`,
  },
];

/**
 * Redact high-confidence secrets from text.
 *
 * Non-string input is returned unchanged so callers can pass results through
 * without a type check at every site.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  let output = text;
  for (const rule of RULES) {
    output = output.replace(rule.pattern, rule.replace);
  }
  return output;
}

/** True when redaction changed the text — used to flag a call in the audit log. */
export function containsSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return RULES.some((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(text);
  });
}
