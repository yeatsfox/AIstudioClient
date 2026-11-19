import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets } from './redact.mjs';

describe('redactSecrets', () => {
  it('removes a PEM private key block entirely', () => {
    const text = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\nafter';
    const output = redactSecrets(text);

    expect(output).toBe('before\n[redacted private key]\nafter');
    expect(output).not.toContain('MIIEow');
  });

  it.each([
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', '[redacted GitHub token]'],
    ['sk-proj-abcdefghijklmnopqrstuvwx', '[redacted API key]'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstu', '[redacted Google API key]'],
    ['AKIAIOSFODNN7EXAMPLE', '[redacted AWS access key]'],
  ])('redacts the token %s', (token, placeholder) => {
    expect(redactSecrets(`key=${token}`)).toContain(placeholder);
  });

  it('redacts the value of a password assignment but keeps the name', () => {
    expect(redactSecrets('password = "hunter2hunter2"')).toBe('password=[redacted]');
    expect(redactSecrets('"apiKey": "abcdef123456"')).toContain('[redacted]');
  });

  it('redacts credentials embedded in a URL', () => {
    expect(redactSecrets('https://user:s3cret@example.com/repo.git')).toBe('https://[redacted]@example.com/repo.git');
  });

  it('redacts our own session cookie', () => {
    const output = redactSecrets('Cookie: amc_session=QWxhZGRpbjpvcGVuIHNlc2FtZQ123456;');
    expect(output).not.toContain('QWxhZGRpbjpvcGVuIHNlc2FtZQ123456');
  });

  it('leaves ordinary code untouched', () => {
    const source = 'const total = items.length; // count of rows\nreturn total;';
    expect(redactSecrets(source)).toBe(source);
  });

  it('passes non-strings through unchanged', () => {
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(null)).toBeNull();
  });

  it('reports whether anything was found', () => {
    expect(containsSecret('token: ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
    expect(containsSecret('plain prose about tokens')).toBe(false);
  });
});
