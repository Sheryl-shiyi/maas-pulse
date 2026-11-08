/**
 * Model answers arrive as Markdown. The feed and the trace show them as plain text, so
 * strip the markup rather than print "**hash table**" on a projector.
 */
export function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
