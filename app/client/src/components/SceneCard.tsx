import type { Scene } from './scenes';

interface SceneCardProps {
  scene: Scene;
  index: number;
  total: number;
  trafficRunning: boolean;
  onStop: () => void;
  onClose: () => void;
}

/** What the audience should watch in the current scene, docked at the top of the sidebar. */
export function SceneCard({ scene, index, total, trafficRunning, onStop, onClose }: SceneCardProps) {
  return (
    <div style={styles.card} role="status">
      <div style={styles.head}>
        <span style={styles.kicker}>Scene {index + 1} of {total}</span>
        <button style={styles.close} onClick={onClose} aria-label="Close">×</button>
      </div>
      <div style={styles.title}>{scene.title}</div>
      <div style={styles.watchLabel}>What to watch</div>
      <ul style={styles.list}>
        {scene.watch.map((w, i) => <li key={i} style={styles.item}>{w}</li>)}
      </ul>
      {trafficRunning && <button style={styles.stop} onClick={onStop}>■ Stop traffic</button>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    margin: 8, background: 'rgba(15, 23, 42, 0.98)', border: '1px solid #38bdf8', borderLeftWidth: 4,
    borderRadius: 10, padding: '10px 14px', color: '#e2e8f0', flexShrink: 0,
  },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { fontSize: 12, color: '#38bdf8', fontWeight: 700 },
  close: { background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: 0 },
  title: { fontSize: 16, fontWeight: 700, margin: '2px 0 6px', color: '#f8fafc' },
  watchLabel: { fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 },
  list: { margin: '4px 0 6px', paddingLeft: 18 },
  item: { fontSize: 13, color: '#cbd5e1', lineHeight: 1.45, marginBottom: 3 },
  stop: { background: 'transparent', color: '#f87171', border: '1px solid #f87171', borderRadius: 5, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
};
