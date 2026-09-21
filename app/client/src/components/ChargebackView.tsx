import { useState, useEffect, useCallback } from 'react';

interface ChargebackRow {
  user: string;
  model: string;
  tokens: number;
  requests: number;
  rateLimited: number;
  costUsd: number;
}

interface ModelRate {
  model: string;
  displayName: string;
  inputPer1M: number;
  outputPer1M: number;
}

interface ChargebackData {
  rows: ChargebackRow[];
  totalTokens: number;
  totalRequests: number;
  totalRateLimited: number;
  totalCostUsd: number;
  modelRates: ModelRate[];
  timeRange: string;
}

type SortField = 'user' | 'model' | 'tokens' | 'requests' | 'rateLimited' | 'costUsd';

const TIME_RANGES = [
  { value: '1h', label: 'Last 1h' },
  { value: '6h', label: 'Last 6h' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: 'all', label: 'All Time' },
];

export function ChargebackView() {
  const [data, setData] = useState<ChargebackData | null>(null);
  const [timeRange, setTimeRange] = useState('24h');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState<SortField>('costUsd');
  const [sortAsc, setSortAsc] = useState(false);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editOutput, setEditOutput] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/chargeback?range=${timeRange}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const handleSaveRate = async (model: string) => {
    const inputPer1M = parseFloat(editInput);
    const outputPer1M = parseFloat(editOutput);
    if (isNaN(inputPer1M) || isNaN(outputPer1M)) return;
    await fetch('/api/chargeback/rates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, inputPer1M, outputPer1M }),
    });
    setEditingRate(null);
    fetchData();
  };

  const sortedRows = data?.rows.slice().sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (typeof av === 'string' && typeof bv === 'string') {
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
  }) ?? [];

  const userTotals = new Map<string, { tokens: number; requests: number; costUsd: number }>();
  for (const row of data?.rows ?? []) {
    const prev = userTotals.get(row.user) ?? { tokens: 0, requests: 0, costUsd: 0 };
    userTotals.set(row.user, {
      tokens: prev.tokens + row.tokens,
      requests: prev.requests + row.requests,
      costUsd: prev.costUsd + row.costUsd,
    });
  }

  const modelTotals = new Map<string, { tokens: number; requests: number; costUsd: number }>();
  for (const row of data?.rows ?? []) {
    const prev = modelTotals.get(row.model) ?? { tokens: 0, requests: 0, costUsd: 0 };
    modelTotals.set(row.model, {
      tokens: prev.tokens + row.tokens,
      requests: prev.requests + row.requests,
      costUsd: prev.costUsd + row.costUsd,
    });
  }

  const fmtCost = (v: number) => v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  const fmtTokens = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
  const sortIcon = (field: SortField) => sortField === field ? (sortAsc ? ' ▲' : ' ▼') : '';

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>Cost & Chargeback</h2>
          <p style={styles.subtitle}>Token usage converted to cost estimates for chargeback</p>
        </div>
        <div style={styles.controls}>
          <div style={styles.timeRanges}>
            {TIME_RANGES.map(r => (
              <button
                key={r.value}
                onClick={() => setTimeRange(r.value)}
                style={{
                  ...styles.rangeBtn,
                  ...(timeRange === r.value ? styles.rangeBtnActive : {}),
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={fetchData} style={styles.refreshBtn} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Overview Cards */}
      {data && (
        <div style={styles.cardGrid}>
          <div style={{ ...styles.card, borderLeft: '3px solid #10b981' }}>
            <div style={styles.cardValue}>{fmtCost(data.totalCostUsd)}</div>
            <div style={styles.cardLabel}>Total Cost</div>
          </div>
          <div style={{ ...styles.card, borderLeft: '3px solid #6366f1' }}>
            <div style={styles.cardValue}>{fmtTokens(data.totalTokens)}</div>
            <div style={styles.cardLabel}>Total Tokens</div>
          </div>
          <div style={{ ...styles.card, borderLeft: '3px solid #3b82f6' }}>
            <div style={styles.cardValue}>{data.totalRequests.toLocaleString()}</div>
            <div style={styles.cardLabel}>Total Requests</div>
          </div>
          <div style={{ ...styles.card, borderLeft: '3px solid #f43f5e' }}>
            <div style={styles.cardValue}>{data.totalRateLimited.toLocaleString()}</div>
            <div style={styles.cardLabel}>Rate Limited</div>
          </div>
        </div>
      )}

      <div style={styles.twoCol}>
        {/* User Cost Summary */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Cost by User</h3>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>User</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Tokens</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Requests</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Cost</th>
                <th style={{ ...styles.th, textAlign: 'right', width: 80 }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(userTotals.entries())
                .sort((a, b) => b[1].costUsd - a[1].costUsd)
                .map(([user, t]) => (
                  <tr key={user}>
                    <td style={styles.td}>{user}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{fmtTokens(t.tokens)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{t.requests.toLocaleString()}</td>
                    <td style={{ ...styles.td, textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{fmtCost(t.costUsd)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <div style={styles.barContainer}>
                        <div style={{ ...styles.bar, width: `${data && data.totalCostUsd > 0 ? (t.costUsd / data.totalCostUsd * 100) : 0}%` }} />
                        <span style={styles.barLabel}>{data && data.totalCostUsd > 0 ? `${(t.costUsd / data.totalCostUsd * 100).toFixed(0)}%` : '0%'}</span>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Model Cost Summary */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Cost by Model</h3>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Model</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Tokens</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Cost</th>
                <th style={{ ...styles.th, textAlign: 'right', width: 80 }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(modelTotals.entries())
                .sort((a, b) => b[1].costUsd - a[1].costUsd)
                .map(([model, t]) => {
                  const rate = data?.modelRates.find(r => r.model === model);
                  return (
                    <tr key={model}>
                      <td style={styles.td}>
                        <div>{rate?.displayName || model}</div>
                        <div style={styles.rateHint}>
                          ${rate ? ((rate.inputPer1M + rate.outputPer1M) / 2).toFixed(3) : '?'}/1M tokens
                        </div>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>{fmtTokens(t.tokens)}</td>
                      <td style={{ ...styles.td, textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{fmtCost(t.costUsd)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <div style={styles.barContainer}>
                          <div style={{ ...styles.bar, width: `${data && data.totalCostUsd > 0 ? (t.costUsd / data.totalCostUsd * 100) : 0}%`, background: '#6366f1' }} />
                          <span style={styles.barLabel}>{data && data.totalCostUsd > 0 ? `${(t.costUsd / data.totalCostUsd * 100).toFixed(0)}%` : '0%'}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pricing Configuration */}
      {data && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Pricing Configuration</h3>
          <p style={styles.pricingHint}>Edit rates to see cost impact. Rates are per 1M tokens (USD).</p>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Model</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Input $/1M</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Output $/1M</th>
                <th style={{ ...styles.th, textAlign: 'center', width: 80 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.modelRates.map(rate => (
                <tr key={rate.model}>
                  <td style={styles.td}>{rate.displayName}</td>
                  {editingRate === rate.model ? (
                    <>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          value={editInput}
                          onChange={e => setEditInput(e.target.value)}
                          style={styles.rateInput}
                        />
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          value={editOutput}
                          onChange={e => setEditOutput(e.target.value)}
                          style={styles.rateInput}
                        />
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <button onClick={() => handleSaveRate(rate.model)} style={styles.saveBtn}>Save</button>
                        <button onClick={() => setEditingRate(null)} style={styles.cancelBtn}>X</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ ...styles.td, textAlign: 'right' }}>${rate.inputPer1M.toFixed(3)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>${rate.outputPer1M.toFixed(3)}</td>
                      <td style={{ ...styles.td, textAlign: 'center' }}>
                        <button
                          onClick={() => {
                            setEditingRate(rate.model);
                            setEditInput(String(rate.inputPer1M));
                            setEditOutput(String(rate.outputPer1M));
                          }}
                          style={styles.editBtn}
                        >
                          Edit
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detailed Breakdown */}
      {data && sortedRows.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Detailed Breakdown</h3>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.thClickable} onClick={() => handleSort('user')}>User{sortIcon('user')}</th>
                <th style={styles.thClickable} onClick={() => handleSort('model')}>Model{sortIcon('model')}</th>
                <th style={{ ...styles.thClickable, textAlign: 'right' }} onClick={() => handleSort('tokens')}>Tokens{sortIcon('tokens')}</th>
                <th style={{ ...styles.thClickable, textAlign: 'right' }} onClick={() => handleSort('requests')}>Requests{sortIcon('requests')}</th>
                <th style={{ ...styles.thClickable, textAlign: 'right' }} onClick={() => handleSort('rateLimited')}>Rate Limited{sortIcon('rateLimited')}</th>
                <th style={{ ...styles.thClickable, textAlign: 'right' }} onClick={() => handleSort('costUsd')}>Cost{sortIcon('costUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(row => (
                <tr key={`${row.user}-${row.model}`}>
                  <td style={styles.td}>{row.user}</td>
                  <td style={styles.td}>{data.modelRates.find(r => r.model === row.model)?.displayName || row.model}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{fmtTokens(row.tokens)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{row.requests.toLocaleString()}</td>
                  <td style={{ ...styles.td, textAlign: 'right', color: row.rateLimited > 0 ? '#f43f5e' : undefined }}>{row.rateLimited}</td>
                  <td style={{ ...styles.td, textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{fmtCost(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '24px 32px', overflowY: 'auto', height: '100%', background: '#0a0e17' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 16 },
  title: { margin: 0, fontSize: 22, color: '#e0e0e0', fontWeight: 700 },
  subtitle: { margin: '4px 0 0', fontSize: 13, color: '#64748b' },
  controls: { display: 'flex', alignItems: 'center', gap: 12 },
  timeRanges: { display: 'flex', gap: 2, background: '#1e293b', borderRadius: 6, padding: 2 },
  rangeBtn: {
    background: 'transparent', color: '#94a3b8', border: 'none', borderRadius: 4,
    padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 500,
  },
  rangeBtnActive: { background: '#334155', color: '#e0e0e0', fontWeight: 600 },
  refreshBtn: {
    background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 6,
    padding: '5px 14px', fontSize: 12, cursor: 'pointer',
  },
  error: { background: '#7f1d1d', color: '#fca5a5', padding: '8px 12px', borderRadius: 6, marginBottom: 16, fontSize: 13 },

  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 },
  card: { background: '#131824', borderRadius: 8, padding: '16px 20px' },
  cardValue: { fontSize: 28, fontWeight: 700, color: '#e0e0e0' },
  cardLabel: { fontSize: 12, color: '#64748b', marginTop: 4 },

  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 },
  section: { background: '#131824', borderRadius: 8, padding: 16, marginBottom: 16 },
  sectionTitle: { margin: '0 0 12px', fontSize: 15, color: '#94a3b8', fontWeight: 600 },

  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #1e293b', color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  thClickable: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #1e293b', color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em', cursor: 'pointer' },
  td: { padding: '8px 10px', borderBottom: '1px solid rgba(30,41,59,0.5)', color: '#cbd5e1' },

  barContainer: { display: 'flex', alignItems: 'center', gap: 6 },
  bar: { height: 6, borderRadius: 3, background: '#10b981', minWidth: 2 },
  barLabel: { fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' },

  rateHint: { fontSize: 10, color: '#64748b', marginTop: 2 },
  pricingHint: { fontSize: 12, color: '#64748b', margin: '-4px 0 12px' },
  rateInput: { width: 70, background: '#1e293b', color: '#e0e0e0', border: '1px solid #334155', borderRadius: 4, padding: '3px 6px', fontSize: 13, textAlign: 'right' as const },
  editBtn: { background: '#334155', color: '#94a3b8', border: 'none', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer' },
  saveBtn: { background: '#10b981', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', marginRight: 4 },
  cancelBtn: { background: '#475569', color: '#e0e0e0', border: 'none', borderRadius: 4, padding: '3px 8px', fontSize: 11, cursor: 'pointer' },
};
