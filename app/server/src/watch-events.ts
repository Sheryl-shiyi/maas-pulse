/**
 * What one line of a Kubernetes watch stream means for the deployment watcher.
 *
 * The API server reports an expired resourceVersion INSIDE the stream: HTTP 200, then
 * {"type":"ERROR","object":{"kind":"Status","code":410,"reason":"Expired"}}, then it closes.
 * Reconnecting with the same resourceVersion only gets the same answer, forever (seen on the
 * backup cluster on 2026-11-09: two reconnects a second for a day, and no replica updates).
 * An ERROR means: list again for a fresh resourceVersion.
 */
export type WatchEvent =
  | { kind: 'deployment'; object: Record<string, any>; resourceVersion?: string }
  | { kind: 'bookmark'; resourceVersion?: string }
  | { kind: 'relist'; code?: number; reason?: string; message?: string }
  | { kind: 'ignore' };

export function classifyWatchEvent(event: any): WatchEvent {
  const type = event?.type;
  const rv: string | undefined = event?.object?.metadata?.resourceVersion || undefined;
  if (type === 'ERROR') {
    const o = event.object ?? {};
    return { kind: 'relist', code: o.code, reason: o.reason, message: o.message };
  }
  if (type === 'BOOKMARK') return { kind: 'bookmark', resourceVersion: rv };
  if (type === 'ADDED' || type === 'MODIFIED') return { kind: 'deployment', object: event.object, resourceVersion: rv };
  return { kind: 'ignore' };
}
