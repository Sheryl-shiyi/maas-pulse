import type { ScaleNotice } from '../types';

interface ScaleNoticesProps {
  notices: ScaleNotice[];
  onDismiss: (id: string) => void;
}

/**
 * Why the autoscaler just changed a model's replicas, pinned under the topology until
 * someone closes it. The topology shows the effect (a new box starting); this shows the
 * cause: each condition the autoscaler checks, the reading, the limit, and which one
 * fired. Without it, an audience sees a GPU appear and has to be told why.
 */
export function ScaleNotices({ notices, onDismiss }: ScaleNoticesProps) {
  if (notices.length === 0) return null;
  return (
    <div style={styles.stack}>
      {notices.map(n => {
        const up = n.direction === 'up';
        // Green: a new vLLM replica, the colour of our replicas. Not the gateway's colour.
        const accent = up ? '#4caf50' : '#a3a3a3';
        return (
          <div key={n.id} style={{ ...styles.card, borderColor: accent, background: `linear-gradient(${tintOf(accent, 0.13)}, ${tintOf(accent, 0.13)}), rgba(21, 21, 21, 0.97)` }} role="status">
            <div style={styles.header}>
              <span style={{ ...styles.icon, color: accent }}>{up ? '▲' : '▼'}</span>
              <span style={styles.title}>
                {up ? 'Scaling up' : 'Scaling down'} {n.modelDisplayName}: {n.from} → {n.to} replicas
              </span>
              <span style={styles.time}>{new Date(n.at).toLocaleTimeString()}</span>
              <button style={styles.close} onClick={() => onDismiss(n.id)} aria-label="Dismiss">×</button>
            </div>
            <div style={styles.why}>
              {up
                ? 'The autoscaler adds a replica when either condition below is crossed:'
                : 'The autoscaler gives a replica back after sustained quiet:'}
            </div>
            <table style={styles.table}>
              <tbody>
                {n.checks.map(c => (
                  <tr key={c.label}>
                    <td style={styles.label}>{c.label}</td>
                    <td style={{ ...styles.value, color: c.tripped ? accent : '#c7c7c7' }}>{c.value}{c.unit}</td>
                    <td style={styles.limit}>{limitText(n.direction, c.limit, c.unit)}</td>
                    <td style={{ ...styles.badge, color: c.tripped ? accent : '#4d4d4d' }}>
                      {c.tripped ? (up ? 'triggered' : 'met') : 'not the cause'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={styles.next}>
              {up
                ? 'A new vLLM replica is starting on a spare GPU. Pulling the images and loading the model takes 2–10 minutes (less when the node already has them); the existing replica keeps serving meanwhile. A busy batch alone never triggers this: only requests that cannot get in, or GPU memory running out.'
                : 'The extra replica is stopped and its GPU released; the remaining replica serves all traffic.'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function limitText(direction: 'up' | 'down', limit: number, unit: string): string {
  if (direction === 'up') return `limit: more than ${limit}${unit}`;
  return limit === 0 ? 'needs: none' : `needs: under ${limit}${unit}`;
}

const styles: Record<string, React.CSSProperties> = {
  stack: {
    position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
    width: 'min(560px, 92%)', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 5,
  },
  card: {
    background: 'rgba(21, 21, 21, 0.97)', border: '1px solid', borderLeftWidth: 4, borderRadius: 8,
    padding: '10px 12px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)', color: '#e0e0e0', fontSize: 12,
  },
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  icon: { fontSize: 12 },
  title: { fontWeight: 700, fontSize: 13, flex: 1 },
  time: { color: '#8a8a8a', fontSize: 11 },
  close: {
    background: 'transparent', border: 'none', color: '#a3a3a3', fontSize: 18, lineHeight: 1,
    cursor: 'pointer', padding: '0 2px',
  },
  why: { color: '#a3a3a3', margin: '6px 0 4px' },
  table: { borderCollapse: 'collapse', width: '100%' },
  label: { padding: '2px 8px 2px 0', color: '#c7c7c7' },
  value: { padding: '2px 8px', fontWeight: 700, textAlign: 'right', width: 60 },
  limit: { padding: '2px 8px', color: '#8a8a8a' },
  badge: { padding: '2px 0', fontWeight: 600, textAlign: 'right' },
  next: { color: '#a3a3a3', marginTop: 6, lineHeight: 1.45 },
};

/** "#rrggbb" at the given opacity: a translucent block of the accent colour. */
function tintOf(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
