// Pure helpers for the enabled switch.
//
// `enabledByUser` records that a human flipped the switch. The bundled local
// tools server re-syncs itself whenever the workspace list changes, and that
// sync has to tell two identical-looking `enabled: false` states apart: an
// entry that was never turned on, and one the user deliberately switched off.
import type { McpServerConfig } from '@/types';

/**
 * Payload for flipping a server's switch by hand.
 *
 * The flag is written on both directions: turning something off and later
 * turning it back on are both decisions, and either way the value that follows
 * came from the user rather than from a default.
 */
export function enabledTogglePatch(enabled: boolean): Partial<McpServerConfig> {
  return { enabled, enabledByUser: true };
}
