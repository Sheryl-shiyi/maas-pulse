import { useState, useEffect } from 'react';
import type { TrafficPattern, PromptShape, ModelInfo, UserInfo, ClientEvent } from '../types';

interface ControlsProps {
  models: ModelInfo[];
  users: UserInfo[];
  trafficRunning: boolean;
  connected: boolean;
  send: (event: ClientEvent) => void;
}

export function Controls({ models, users, trafficRunning, connected, send }: ControlsProps) {
  const [pattern, setPattern] = useState<TrafficPattern>('concurrent');
  const [rate, setRate] = useState(3);
  const [promptShape, setPromptShape] = useState<PromptShape>('short');
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
      promptShape,
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
          <label style={styles.label}>Prompt</label>
          <select
            value={promptShape}
            onChange={e => setPromptShape(e.target.value as PromptShape)}
            style={styles.select}
            disabled={trafficRunning}
            title={
              'Short: the question alone, cheap and highly cacheable.\n' +
              'Shared prefix: one long preamble reused by every request, so the prefix cache hits.\n' +
              'Unique prefix: a long preamble distinct per request — the only shape that creates real queueing and KV pressure, and so the only one that can trigger autoscaling. It also burns a tier\u2019s token budget in a request or two.'
            }
          >
            <option value="short">Short</option>
            <option value="shared-prefix">Shared prefix (cache hits)</option>
            <option value="unique-prefix">Unique prefix (real load)</option>
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

      {/* What the current choices will actually send, in words an audience can follow.
          "Rate" alone misleads: in Concurrent mode every selected user fires per tick. */}
      <div style={styles.hint}>
        <span><b style={styles.hintKey}>{PATTERN_NAMES[pattern]}:</b> {patternHint(pattern, rate, selectedUsers.length || users.length)}</span>
        <span><b style={styles.hintKey}>{PROMPT_NAMES[promptShape]}:</b> {PROMPT_HINTS[promptShape]}</span>
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

const PATTERN_NAMES: Record<TrafficPattern, string> = { concurrent: 'Concurrent', sequential: 'Sequential', random_burst: 'Random burst' };
const PROMPT_NAMES: Record<PromptShape, string> = { short: 'Short', 'shared-prefix': 'Shared prefix', 'unique-prefix': 'Unique prefix' };

/** Matches server/src/traffic.ts: what each pattern sends, at the chosen rate. */
function patternHint(pattern: TrafficPattern, rate: number, users: number): string {
  const r = Number(rate.toFixed(1));
  switch (pattern) {
    case 'concurrent':
      return `all ${users} selected users send at once, ${r} times a second (about ${Math.round(users * r)} requests/s; never more than 50 waiting for an answer).`;
    case 'sequential':
      return `users take turns, one request at a time, ${r} per second.`;
    case 'random_burst':
      return 'bursts of 2–6 requests from random users with random pauses: spiky traffic. Higher rate, shorter pauses.';
  }
}

const PROMPT_HINTS: Record<PromptShape, string> = {
  short: 'one question from a pool of 50. Cheap; a repeated question is mostly served from the prefix cache.',
  'shared-prefix': 'the same ~1,500-token document before every question. Shows cache hits, and llm-d keeping requests on the replica that has it cached.',
  'unique-prefix': 'a different ~1,500-token document every time. Nothing to reuse, so it fills GPU memory and queues: use it to trigger autoscaling. It uses up a tier\u2019s token budget fast.',
};

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
  hint: { display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 11, color: '#94a3b8', margin: '-2px 0 8px' },
  hintKey: { color: '#cbd5e1', fontWeight: 600 },
  chips: { display: 'flex', alignItems: 'center', gap: 6 },
  chipLabel: { fontSize: 12, color: '#64748b' },
  chip: { color: '#e0e0e0', border: 'none', borderRadius: 12, padding: '3px 10px', fontSize: 12, cursor: 'pointer' },
};
