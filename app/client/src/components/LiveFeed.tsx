import type { FeedEntry } from '../types';
import { providerOf } from './providerLogos';
import { userColors } from './colors';

interface Named { name: string; displayName: string; tier?: string }

interface LiveFeedProps {
  entries: FeedEntry[];
  /** For showing the names the topology uses (free:user1, Nemotron 30B) rather than the
   *  internal ones (user1, publishers/llm/models/...). Falls back to the raw name. */
  users?: Named[];
  models?: Named[];
}

export function LiveFeed({ entries, users = [], models = [] }: LiveFeedProps) {
  const userName = (n: string) => users.find(u => u.name === n)?.displayName ?? n;
  // The same tier colours as the topology, so a feed entry and its dot match.
  const colors = userColors(users);
  const userColor = (n: string) => colors[users.findIndex(u => u.name === n)] ?? '#4394e5';
  const modelName = (n: string) => models.find(m => m.name === n)?.displayName ?? n;
  return (
    <div style={styles.container}>
      <h3 style={styles.title}>Live Feed</h3>
      <div style={styles.list}>
        {entries.length === 0 && (
          <div style={styles.empty}>No requests yet. Click Start to begin.</div>
        )}
        {entries.map(entry => (
          <div key={entry.id} style={styles.entry}>
            <div style={styles.header}>
              <span style={{ ...styles.user, color: userColor(entry.user) }}>{userName(entry.user)}</span>
              <span style={styles.arrow}>&rarr;</span>
              <span style={styles.model}>{modelName(entry.model)}</span>
              {entry.rateLimited ? (
                <span style={styles.blocked}>429</span>
              ) : entry.providerLimited ? (
                <span style={styles.errorBadge}>429</span>
              ) : entry.error ? (
                <span style={styles.errorBadge}>{entry.status ?? 'ERR'}</span>
              ) : (
                <span style={styles.latency}>{entry.latencyMs}ms</span>
              )}
            </div>
            {/* A request already in flight when this page opened has no question. */}
            {entry.question && <div style={styles.question}>Q: {truncate(entry.question, 70)}</div>}
            {entry.answer && (
              <div style={styles.answer}>A: {truncate(entry.answer, 80)}</div>
            )}
            {entry.servedBy && (
              <div style={styles.served}>
                served by {entry.servedBy}
                {entry.promptTokens ? ` · ${entry.cachedTokens ?? 0} of ${entry.promptTokens} prompt tokens from cache` : ''}
              </div>
            )}
            {entry.rateLimited && (
              <div style={styles.rateLimitMsg}>Rate limited by MaaS (token limit)</div>
            )}
            {entry.providerLimited && (
              <div style={styles.providerMsg} title={entry.providerMessage}>
                {providerName(entry.model)} rate limit, not a MaaS limit
                {entry.providerMessage ? `: ${truncate(entry.providerMessage, 60)}` : ''}
              </div>
            )}
            {entry.error && (
              <div style={styles.rateLimitMsg}>
                {entry.status === 403 || entry.status === 401
                  ? 'Rejected by the gateway — this identity was not accepted'
                  : entry.error}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function providerName(model: string): string {
  const p = providerOf(model);
  return p === 'gemini' ? 'Google' : p === 'openai' ? 'OpenAI' : 'Provider';
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  title: { fontSize: 14, color: '#a3a3a3', padding: '8px 12px', margin: 0, borderBottom: '1px solid #1f1f1f' },
  list: { flex: 1, overflow: 'auto', padding: 8 },
  empty: { color: '#4d4d4d', fontSize: 13, textAlign: 'center', padding: 20 },
  entry: { background: '#141414', borderRadius: 6, padding: 8, marginBottom: 6, fontSize: 12 },
  header: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 },
  user: { color: '#4394e5', fontWeight: 600 },
  arrow: { color: '#4d4d4d' },
  model: { color: '#876fd4', fontWeight: 600 },
  latency: { marginLeft: 'auto', color: '#a3a3a3', fontSize: 11 },
  blocked: { marginLeft: 'auto', color: '#ee0000', fontWeight: 700, fontSize: 11 },
  errorBadge: { marginLeft: 'auto', color: '#f5921b', fontWeight: 700, fontSize: 11 },
  question: { color: '#a3a3a3', lineHeight: 1.4 },
  answer: { color: '#8a8a8a', lineHeight: 1.4, fontStyle: 'italic' },
  rateLimitMsg: { color: '#ee0000', fontWeight: 600, fontSize: 11 },
  providerMsg: { color: '#f8ae54', fontWeight: 600, fontSize: 11 },
  served: { color: '#f2f2f2', fontSize: 11, marginTop: 2 },
};
