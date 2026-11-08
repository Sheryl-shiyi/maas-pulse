import { useEffect, useState } from 'react';
import type { ModelInfo, UserInfo } from '../types';
import type { TraceStep } from './traceSteps';

interface TraceFormProps {
  users: UserInfo[];
  models: ModelInfo[];
  onTrace: (user: string, model: string, question: string) => void;
  onCancel: () => void;
}

/**
 * Pick who asks which model, and optionally type the question (or take one from the
 * pool). The request is then sent for real and replayed step by step.
 */
export function TraceForm({ users, models, onTrace, onCancel }: TraceFormProps) {
  const defaultUser = users.find(u => u.tier === 'max')?.name ?? users[0]?.name ?? '';
  const defaultModel = models.find(m => m.type === 'internal')?.name ?? models[0]?.name ?? '';
  const [user, setUser] = useState(defaultUser);
  const [model, setModel] = useState(defaultModel);
  const [question, setQuestion] = useState('');

  return (
    <div style={styles.formCard} role="dialog" aria-label="Trace a request">
      <div style={styles.formTitle}>Trace a request</div>
      <div style={styles.formHint}>Sends one real request, then replays its trip through the stack, step by step.</div>
      <div style={styles.row}>
        <label style={styles.label}>Who</label>
        <select style={styles.select} value={user} onChange={e => setUser(e.target.value)}>
          {users.map(u => <option key={u.name} value={u.name}>{u.displayName}</option>)}
        </select>
        <label style={styles.label}>asks</label>
        <select style={styles.select} value={model} onChange={e => setModel(e.target.value)}>
          {models.map(m => <option key={m.name} value={m.name}>{m.displayName}</option>)}
        </select>
      </div>
      <input
        style={styles.input}
        value={question}
        placeholder="Type a question, or leave empty for one from the pool"
        onChange={e => setQuestion(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onTrace(user, model, question); if (e.key === 'Escape') onCancel(); }}
        autoFocus
      />
      <div style={styles.buttons}>
        <button style={styles.secondary} onClick={onCancel}>Cancel</button>
        <button style={styles.primary} onClick={() => onTrace(user, model, question)} disabled={!user || !model}>Trace</button>
      </div>
    </div>
  );
}

interface TraceCaptionProps {
  header: string;
  status: 'sending' | 'ready' | 'error';
  steps: TraceStep[];
  index: number;
  error?: string;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}

/**
 * The replay's caption, under the topology: which step, what happened there, and the
 * figures. The presenter moves on with Next (or →, space), back with Back (←), out with
 * Close (Esc), so the replay goes at the speed of the talk.
 */
export function TraceCaption({ header, status, steps, index, error, onBack, onNext, onClose }: TraceCaptionProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') onClose();
      else if (status === 'ready' && (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onNext(); }
      else if (status === 'ready' && e.key === 'ArrowLeft') { e.preventDefault(); onBack(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, onBack, onNext, onClose]);

  const step = steps[index];
  // The scene-button blue, so the replay has a colour of its own; red or orange when refused.
  const accent = step?.tone === 'blocked' ? '#ee0000' : step?.tone === 'provider' ? '#f8ae54' : '#3b8ec4';
  return (
    <div style={{ ...styles.caption, borderColor: accent, boxShadow: `0 0 0 1px ${accent}, 0 0 26px ${tintOf(accent, 0.45)}`, background: `linear-gradient(${tintOf(accent, 0.22)}, ${tintOf(accent, 0.22)}), rgba(21, 21, 21, 0.98)` }} role="status">
      {/* Each step pulses the frame twice, so eyes go to the caption when it changes. */}
      <div key={index} style={{ ...styles.pulse, ['--c' as string]: tintOf(accent, 0.9) } as React.CSSProperties} />
      <div style={styles.captionHead}>
        <span style={styles.captionHeader}>{header}</span>
        {status === 'ready' && <span style={styles.counter}>step {index + 1} of {steps.length}</span>}
      </div>
      {status === 'sending' && <div style={styles.captionTitle}>Sending the request…</div>}
      {status === 'error' && <div style={{ ...styles.captionTitle, color: '#f56e6e' }}>Could not trace: {error}</div>}
      {status === 'ready' && step && (
        <>
          <div style={{ ...styles.captionTitle, color: step.tone ? accent : '#fafafa' }}>{step.title}</div>
          {step.lines.map((l, i) => <div key={i} style={styles.line}>{l}</div>)}
        </>
      )}
      <div style={styles.buttons}>
        {status === 'ready' && (
          <button style={{ ...styles.secondary, ...(index === 0 ? styles.disabled : {}) }} onClick={onBack} disabled={index === 0}>◀ Back</button>
        )}
        {status === 'ready' && (
          <button style={{ ...styles.primary, ...(index >= steps.length - 1 ? styles.disabled : {}) }} onClick={onNext} disabled={index >= steps.length - 1}>
            {index >= steps.length - 1 ? 'End' : 'Next ▶'}
          </button>
        )}
        <button style={styles.secondary} onClick={onClose}>✕ Close</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  formCard: {
    position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', width: 'min(520px, 92%)', zIndex: 30, boxShadow: '0 0 0 1px #3b8ec4, 0 16px 48px rgba(0,0,0,0.6), 0 0 36px rgba(59,142,196,0.45)',
    background: 'rgba(12, 74, 110, 0.92)', border: '1px solid #3b8ec4', borderRadius: 10, padding: '14px 16px', color: '#e0e0e0',
  },
  formTitle: { fontSize: 15, fontWeight: 700, color: '#cfe8f8' },
  formHint: { fontSize: 12, color: '#a3a3a3', margin: '4px 0 10px' },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  label: { fontSize: 13, color: '#a3a3a3' },
  select: { background: '#1f1f1f', color: '#e0e0e0', border: '1px solid #383838', borderRadius: 4, padding: '5px 8px', fontSize: 13 },
  input: {
    width: '100%', boxSizing: 'border-box', background: '#0b1220', color: '#e0e0e0', border: '1px solid #383838',
    borderRadius: 6, padding: '8px 10px', fontSize: 13, marginBottom: 10,
  },
  buttons: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  primary: { background: '#3b8ec4', color: '#ffffff', border: 'none', borderRadius: 5, padding: '6px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  disabled: { opacity: 0.35, cursor: 'default' },
  secondary: { background: 'transparent', color: '#c7c7c7', border: '1px solid #383838', borderRadius: 5, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  // Docked at the top of the sidebar, so it never covers the part of the canvas it is
  // talking about (it used to sit on the gateway's lower steps).
  caption: {
    margin: 8, position: 'relative', background: 'rgba(21, 21, 21, 0.98)', border: '1px solid', borderLeftWidth: 4, borderRadius: 10,
    padding: '12px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)', color: '#e0e0e0', flexShrink: 0,
  },
  pulse: { position: 'absolute', inset: -1, borderRadius: 10, pointerEvents: 'none', animation: 'traceFocus 1s ease-out 2' },
  captionHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  captionHeader: { fontSize: 12, color: '#a3a3a3', fontWeight: 600 },
  counter: { fontSize: 12, color: '#8a8a8a' },
  captionTitle: { fontSize: 16, fontWeight: 700, margin: '2px 0 6px', lineHeight: 1.3 },
  line: { fontSize: 14, color: '#c7c7c7', lineHeight: 1.5 },
};

/** "#rrggbb" at the given opacity: a translucent block of the accent colour. */
function tintOf(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
