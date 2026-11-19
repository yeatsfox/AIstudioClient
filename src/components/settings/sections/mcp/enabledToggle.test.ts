import { describe, expect, it } from 'vitest';
import { enabledTogglePatch } from './enabledToggle';

describe('enabledTogglePatch', () => {
  it('marks a manual enable so the desktop sync respects it', () => {
    expect(enabledTogglePatch(true)).toEqual({ enabled: true, enabledByUser: true });
  });

  it('marks a manual disable so the desktop sync leaves it alone', () => {
    // Without the flag, adding a workspace would switch the server back on and
    // silently override the user.
    expect(enabledTogglePatch(false)).toEqual({ enabled: false, enabledByUser: true });
  });
});
