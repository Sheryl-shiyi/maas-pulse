import type { FeedEntry } from '../types';

interface LiveFeedProps {
  entries: FeedEntry[];
}

export function LiveFeed({ entries }: LiveFeedProps) {
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
              <span style={styles.user}>{entry.user}</span>
              <span style={styles.arrow}>&rarr;</span>
              <span style={styles.model}>{entry.model}</span>
              {entry.rateLimited ? (
                <span style={styles.blocked}>429</span>
              ) : entry.error ? (
                <span style={styles.errorBadge}>ERR</span>
              ) : (
                <span style={styles.latency}>{entry.latencyMs}ms</span>
              )}
            </div>
            <div style={styles.question}>Q: {truncate(entry.question, 70)}</div>
            {entry.answer && (
              <div style={styles.answer}>A: {truncate(entry.answer, 80)}</div>
            )}
            {entry.rateLimited && (
              <div style={styles.rateLimitMsg}>Rate limited</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  title: { fontSize: 14, color: '#94a3b8', padding: '8px 12px', margin: 0, borderBottom: '1px solid #1e293b' },
  list: { flex: 1, overflow: 'auto', padding: 8 },
  empty: { color: '#475569', fontSize: 13, textAlign: 'center', padding: 20 },
  entry: { background: '#131824', borderRadius: 6, padding: 8, marginBottom: 6, fontSize: 12 },
  header: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 },
  user: { color: '#42a5f5', fontWeight: 600 },
  arrow: { color: '#475569' },
  model: { color: '#a78bfa', fontWeight: 600 },
  latency: { marginLeft: 'auto', color: '#94a3b8', fontSize: 11 },
  blocked: { marginLeft: 'auto', color: '#f44336', fontWeight: 700, fontSize: 11 },
  errorBadge: { marginLeft: 'auto', color: '#ff9800', fontWeight: 700, fontSize: 11 },
  question: { color: '#94a3b8', lineHeight: 1.4 },
  answer: { color: '#64748b', lineHeight: 1.4, fontStyle: 'italic' },
  rateLimitMsg: { color: '#f44336', fontWeight: 600, fontSize: 11 },
};
