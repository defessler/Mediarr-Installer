// Pure helpers for rendering updater status messages. Lives in shared/
// (no React) so it's unit-testable in isolation and shared by the two
// components that render updater messages (UpdateOverlay + WhatsNew),
// instead of one reaching into the other's module for it.

/** Split a trailing https?:// URL off an error message so it can be
 *  rendered as a real clickable link (the post-quit "update manually from
 *  <url>" guidance is useless as inert text). Returns the message with the
 *  URL removed plus the URL itself, or a null url when there isn't one. */
export function splitTrailingUrl(message: string): { text: string; url: string | null } {
  // Anchored to end-of-string, so the whole match (m[0]) is the trailing URL
  // plus any whitespace before it; lop that off the end to get the lead text.
  // (Compute from length rather than m.index, which is typed number|undefined.)
  const m = message.match(/\s*(https?:\/\/\S+)\s*$/)
  if (!m) return { text: message, url: null }
  return { text: message.slice(0, message.length - m[0].length), url: m[1] }
}
