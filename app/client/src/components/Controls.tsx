import { useState, useEffect } from 'react';
import type { TrafficPattern, PromptShape, ModelInfo, UserInfo, ClientEvent } from '../types';
import { SCENES, type Scene } from './scenes';
import { providerOf } from './providerLogos';

interface ControlsProps {
  models: ModelInfo[];
  users: UserInfo[];
  trafficRunning: boolean;
  connected: boolean;
  send: (event: ClientEvent) => void;
  /** Open "Trace a request". */
  onTrace: () => void;
  /** A scene was started (its index in SCENES). */
  onScene: (index: number) => void;
  activeScene: number | null;
}

export function Controls({ models, users, trafficRunning, connected, send, onTrace, onScene, activeScene }: ControlsProps) {
  const [pattern, setPattern] = useState<TrafficPattern>('concurrent');
  const [rate, setRate] = useState(3);
  const [promptShape, setPromptShape] = useState<PromptShape>('short');
  /** Document length for the long prompt shapes; scenes may set it. */
  const [promptTokens, setPromptTokens] = useState(1500);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  /** The manual traffic settings, folded away by default: the scenes set them all. */
  const [manualOpen, setManualOpen] = useState(false);

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
      promptTokens,
    });
  };

  const handleStop = () => {
    send({ type: 'stop_traffic' });
  };

  /** Set every control to the scene's values, so the hint line and chips match, and run it. */
  const startScene = (scene: Scene, index: number) => {
    const u = users.filter(scene.users).map(x => x.name);
    const m = models.filter(scene.models).map(x => x.name);
    setPattern(scene.pattern);
    setPromptShape(scene.promptShape);
    setPromptTokens(scene.promptTokens ?? 1500);
    setRate(scene.rate);
    setSelectedUsers(u);
    setSelectedModels(m);
    onScene(index);
    const start = () => send({
      type: 'start_traffic', pattern: scene.pattern, usersEnabled: u, modelsEnabled: m,
      ratePerSecond: scene.rate, promptShape: scene.promptShape, promptTokens: scene.promptTokens ?? 1500,
    });
    // The generator ignores a start while it is running, so stop first.
    if (trafficRunning) { send({ type: 'stop_traffic' }); setTimeout(start, 500); } else start();
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
      {/* One row for the live demo: the scenes, Start/Stop, Trace. Everything a scene sets
          by itself (pattern, prompt, rate, who sends to what) folds away below, so the
          canvas keeps the height it needs on a 720p projector. */}
      <div style={styles.bar}>
        <span style={styles.barLabel}>Scenes</span>
        {SCENES.map((sc, i) => (
          <button
            key={sc.id}
            onClick={() => startScene(sc, i)}
            disabled={!connected}
            style={{ ...styles.scene, ...(activeScene === i ? styles.sceneActive : {}) }}
            title={`${sc.title}\n\n${sc.watch.map(w => '• ' + w.replace(/\*\*/g, '')).join('\n')}`}
          >
            {i + 1} · {sc.short}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {!trafficRunning ? (
          <button onClick={handleStart} style={styles.startBtn} disabled={!connected}>Start</button>
        ) : (
          <button onClick={handleStop} style={styles.stopBtn}>Stop</button>
        )}
        <button onClick={onTrace} style={styles.traceBtn} disabled={!connected}>Trace a request</button>
        <button onClick={() => setManualOpen(o => !o)} style={styles.manualBtn} aria-expanded={manualOpen}>
          Manual traffic {manualOpen ? '▴' : '▾'}
        </button>
      </div>

      {manualOpen && (
        <div style={styles.manual}>
          <div style={styles.row}>
            <div style={styles.group}>
              <label style={styles.label}>Pattern</label>
              <select value={pattern} onChange={e => setPattern(e.target.value as TrafficPattern)} style={styles.select} disabled={trafficRunning}>
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
                <option value="per-user-prefix">One document per user (sticky routing)</option>
              </select>
            </div>
            <div style={styles.group}>
              <label style={styles.label}>Rate: {rate}/s</label>
              <input type="range" min={0.2} max={10} step={0.2} value={rate} onChange={e => setRate(parseFloat(e.target.value))} style={styles.slider} disabled={trafficRunning} />
            </div>
          </div>

          {/* What the current choices will actually send, in words an audience can follow.
              "Rate" alone misleads: in Concurrent mode every selected user fires per tick. */}
          <div style={styles.hint}>
            <span><b style={styles.hintKey}>{PATTERN_NAMES[pattern]}:</b> {patternHint(pattern, rate, selectedUsers.length || users.length)}</span>
            <span><b style={styles.hintKey}>{PROMPT_NAMES[promptShape]}:</b> {promptHint(promptShape, promptTokens)}</span>
          </div>

          <div style={styles.row}>
            <div style={styles.chips}>
              <span style={styles.chipLabel}>Users:</span>
              {users.map(u => (
                <button
                  key={u.name}
                  onClick={() => toggleUser(u.name)}
                  style={{ ...styles.chip, background: selectedUsers.includes(u.name) ? tierChip(u.tier) : '#333', opacity: trafficRunning ? 0.6 : 1 }}
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
                  style={{ ...styles.chip, background: selectedModels.includes(m.name) ? modelChip(m) : '#333', opacity: trafficRunning ? 0.6 : 1 }}
                  disabled={trafficRunning}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Selected user chips in their tier's colour (a dark shade, for white text). */
function tierChip(tier?: string): string {
  switch ((tier ?? '').toLowerCase()) {
    case 'free': return '#147878';
    case 'pro': return '#0066cc';
    case 'max': return '#5e40be';
    default: return '#4d4d4d';
  }
}
/** Selected model chips: our own models green, cloud models in their provider's colours. */
function modelChip(m: ModelInfo): string {
  if (m.type === 'internal') return '#2e7d32';
  const p = providerOf(m.name);
  if (p === 'openai') return '#0d7a5f';
  if (p === 'gemini') return 'linear-gradient(90deg, #3367d6, #7b4fb8)';
  return '#4d4d4d';
}

const PATTERN_NAMES: Record<TrafficPattern, string> = { concurrent: 'Concurrent', sequential: 'Sequential', random_burst: 'Random burst' };
const PROMPT_NAMES: Record<PromptShape, string> = { short: 'Short', 'shared-prefix': 'Shared prefix', 'unique-prefix': 'Unique prefix', 'per-user-prefix': 'One document per user' };

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

/**
 * The prompt length a setting really produces. The generator counts 4 characters per token,
 * but its corpus tokenises at about 5.5 on Qwen3 (2000 → ~1,450, measured 2026-11-08).
 */
function realTokens(setting: number): number {
  return Math.round((setting * 4) / 5.5 / 50) * 50;
}

function promptHint(shape: PromptShape, tokens: number): string {
  const doc = `~${realTokens(tokens).toLocaleString()}-token document`;
  switch (shape) {
    case 'short':
      return 'one question from a pool of 50. Cheap; a repeated question is mostly served from the prefix cache.';
    case 'shared-prefix':
      return `the same ${doc} before every question. Shows cache hits; once every replica holds it, llm-d simply shares the load.`;
    case 'per-user-prefix':
      return `each user's own ${doc}, new for every run. The first question reads it; llm-d sends that user's next ones to the replica holding it.`;
    case 'unique-prefix':
      return `a different ${doc} every time. Nothing to reuse, so it fills GPU memory and queues: use it to trigger autoscaling. It uses up a tier\u2019s token budget fast.`;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '8px 20px', background: '#141414', borderBottom: '1px solid #1f1f1f' },
  bar: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 36 },
  barLabel: { fontSize: 13, color: '#8a8a8a', marginRight: 2 },
  manual: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #262626' },
  row: { display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 8 },
  group: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { fontSize: 13, color: '#a3a3a3', whiteSpace: 'nowrap' },
  select: { background: '#1f1f1f', color: '#e0e0e0', border: '1px solid #383838', borderRadius: 4, padding: '4px 8px', fontSize: 13 },
  slider: { width: 100 },
  startBtn: { background: '#4caf50', color: '#fff', border: 'none', borderRadius: 5, padding: '7px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  traceBtn: { background: 'transparent', color: '#f2f2f2', border: '1px solid #f2f2f2', borderRadius: 5, padding: '7px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  stopBtn: { background: '#ee0000', color: '#fff', border: 'none', borderRadius: 5, padding: '7px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  manualBtn: { background: 'transparent', color: '#a3a3a3', border: '1px solid #383838', borderRadius: 5, padding: '7px 12px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  scene: { background: 'transparent', color: '#e0e0e0', border: '1px solid rgba(242,242,242,0.5)', borderRadius: 16, padding: '6px 13px', fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' },
  sceneActive: { background: '#0c4a6e', color: '#f2f2f2', borderColor: '#f2f2f2' },
  hint: { display: 'flex', columnGap: 24, rowGap: 2, flexWrap: 'wrap', fontSize: 11, color: '#a3a3a3', margin: '-2px 0 8px' },
  hintKey: { color: '#c7c7c7', fontWeight: 600 },
  chips: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chipLabel: { fontSize: 12, color: '#8a8a8a' },
  chip: { color: '#e0e0e0', border: 'none', borderRadius: 12, padding: '3px 10px', fontSize: 12, cursor: 'pointer' },
};
