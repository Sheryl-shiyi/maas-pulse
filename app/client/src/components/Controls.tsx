import { useState, useEffect } from 'react';
import type { TrafficPattern, ModelInfo, UserInfo, ClientEvent } from '../types';

interface ControlsProps {
  models: ModelInfo[];
  users: UserInfo[];
  trafficRunning: boolean;
  connected: boolean;
  send: (event: ClientEvent) => void;
}

export function Controls({ models, users, trafficRunning, connected, send }: ControlsProps) {
  const [pattern, setPattern] = useState<TrafficPattern>('concurrent');
  const [rate, setRate] = useState(1);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);

  useEffect(() => {
    if (users.length > 0 && selectedUsers.length === 0) {
      setSelectedUsers(users.map(u => u.name));
    }
  }, [users]);

  useEffect(() => {
    if (models.length > 0 && selectedModels.length === 0) {
      setSelectedModels(models.map(m => m.name));
    }
  }, [models]);

  const handleStart = () => {
    send({
      type: 'start_traffic',
      pattern,
      usersEnabled: selectedUsers.length > 0 ? selectedUsers : users.map(u => u.name),
      modelsEnabled: selectedModels.length > 0 ? selectedModels : models.map(m => m.name),
      ratePerSecond: rate,
    });
  };

  const handleStop = () => {
    send({ type: 'stop_traffic' });
  };

  const toggleUser = (name: string) => {
    setSelectedUsers(prev =>
      prev.includes(name) ? prev.filter(u => u !== name) : [...prev, name]
    );
  };

  const toggleModel = (name: string) => {
    setSelectedModels(prev =>
      prev.includes(name) ? prev.filter(m => m !== name) : [...prev, name]
    );
  };

  return (
    <div style={styles.container}>
      <div style={styles.row}>
        <div style={styles.group}>
          <label style={styles.label}>Pattern</label>
          <select
            value={pattern}
            onChange={e => setPattern(e.target.value as TrafficPattern)}
            style={styles.select}
            disabled={trafficRunning}
          >
            <option value="concurrent">Concurrent</option>
            <option value="sequential">Sequential</option>
            <option value="random_burst">Random Burst</option>
          </select>
        </div>

        <div style={styles.group}>
          <label style={styles.label}>Rate: {rate}/s</label>
          <input
            type="range"
            min={0.2}
            max={10}
            step={0.2}
            value={rate}
            onChange={e => setRate(parseFloat(e.target.value))}
            style={styles.slider}
            disabled={trafficRunning}
          />
        </div>

        <div style={styles.group}>
          {!trafficRunning ? (
            <button onClick={handleStart} style={styles.startBtn} disabled={!connected}>
              Start
            </button>
          ) : (
            <button onClick={handleStop} style={styles.stopBtn}>
              Stop
            </button>
          )}
        </div>

        <div style={{ ...styles.status, color: connected ? '#4caf50' : '#f44336' }}>
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      <div style={styles.row}>
        <div style={styles.chips}>
          <span style={styles.chipLabel}>Users:</span>
          {users.map(u => (
            <button
              key={u.name}
              onClick={() => toggleUser(u.name)}
              style={{
                ...styles.chip,
                background: selectedUsers.includes(u.name) ? '#1976d2' : '#333',
                opacity: trafficRunning ? 0.6 : 1,
              }}
              disabled={trafficRunning}
            >
              {u.displayName}
            </button>
          ))}
        </div>

        <div style={styles.chips}>
          <span style={styles.chipLabel}>Models:</span>
          {models.map(m => (
            <button
              key={m.name}
              onClick={() => toggleModel(m.name)}
              style={{
                ...styles.chip,
                background: selectedModels.includes(m.name) ? '#7b1fa2' : '#333',
                opacity: trafficRunning ? 0.6 : 1,
              }}
              disabled={trafficRunning}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '12px 20px', background: '#131824', borderBottom: '1px solid #1e293b' },
  row: { display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 8 },
  group: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { fontSize: 13, color: '#94a3b8', whiteSpace: 'nowrap' },
  select: { background: '#1e293b', color: '#e0e0e0', border: '1px solid #334155', borderRadius: 4, padding: '4px 8px', fontSize: 13 },
  slider: { width: 100 },
  startBtn: { background: '#4caf50', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  stopBtn: { background: '#f44336', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  status: { fontSize: 12, fontWeight: 600, marginLeft: 'auto' },
  chips: { display: 'flex', alignItems: 'center', gap: 6 },
  chipLabel: { fontSize: 12, color: '#64748b' },
  chip: { color: '#e0e0e0', border: 'none', borderRadius: 12, padding: '3px 10px', fontSize: 12, cursor: 'pointer' },
};
