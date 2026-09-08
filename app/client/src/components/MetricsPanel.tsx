import type { Stats } from '../types';

interface MetricsPanelProps {
  stats: Stats;
}

export function MetricsPanel({ stats }: MetricsPanelProps) {
  return (
    <div style={styles.container}>
      <h3 style={styles.title}>Stats</h3>
      <div style={styles.grid}>
        <Stat label="Requests" value={stats.totalRequests} />
        <Stat label="Completed" value={stats.completedRequests} color="#4caf50" />
        <Stat label="Rate Limited" value={stats.rateLimitedRequests} color="#f44336" />
        <Stat label="Errors" value={stats.errorRequests} color="#ff9800" />
        <Stat label="Total Tokens" value={stats.totalTokens.toLocaleString()} />
        <Stat label="Avg Latency" value={stats.avgLatencyMs > 0 ? `${Math.round(stats.avgLatencyMs)}ms` : '-'} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={styles.stat}>
      <div style={{ ...styles.value, color: color || '#e0e0e0' }}>{value}</div>
      <div style={styles.label}>{label}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { borderTop: '1px solid #1e293b' },
  title: { fontSize: 14, color: '#94a3b8', padding: '8px 12px', margin: 0 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: '0 12px 12px' },
  stat: { background: '#131824', borderRadius: 4, padding: '6px 8px', textAlign: 'center' },
  value: { fontSize: 16, fontWeight: 700 },
  label: { fontSize: 10, color: '#64748b', marginTop: 2 },
};
