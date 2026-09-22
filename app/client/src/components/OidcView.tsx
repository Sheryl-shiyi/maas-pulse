import { useState, useEffect } from 'react';

interface OidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
}

interface OidcSession {
  signedIn: boolean;
  username?: string;
  groups?: string[];
  issuer?: string;
  tokenExp?: string;
  subscription?: string;
  apiKeyMasked?: string;
  keyExpires?: string;
}

interface ChatResult {
  ok: boolean;
  content?: string;
  usage?: Record<string, number>;
  status?: number;
  body?: Record<string, unknown>;
}

interface BurstResult {
  ok: number;
  limited: number;
  other: number;
  tokens: number;
}

export function OidcView() {
  const [config, setConfig] = useState<OidcConfig | null>(null);
  const [session, setSession] = useState<OidcSession | null>(null);
  const [prompt, setPrompt] = useState('say hello in three words');
  const [chatResult, setChatResult] = useState<ChatResult | null>(null);
  const [burstResult, setBurstResult] = useState<BurstResult | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [burstLoading, setBurstLoading] = useState(false);

  useEffect(() => {
    fetch('/api/oidc/config').then(r => r.json()).then(setConfig);
    fetch('/api/oidc/session').then(r => r.json()).then(setSession);
  }, []);

  if (!config) return <div style={s.container}><p style={s.muted}>Loading...</p></div>;

  if (!config.enabled) {
    return (
      <div style={s.container}>
        <h2 style={s.heading}>OIDC Authentication</h2>
        <div style={s.card}>
          <p style={s.muted}>
            OIDC is not configured. Set <code style={s.code}>OIDC_ISSUER_URL</code> environment variable to enable.
          </p>
        </div>
      </div>
    );
  }

  const signedIn = session?.signedIn ?? false;

  const handleSend = async () => {
    setChatLoading(true);
    setChatResult(null);
    setBurstResult(null);
    try {
      const res = await fetch('/api/oidc/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      setChatResult(await res.json());
    } catch (e) {
      setChatResult({ ok: false, status: 0, body: { error: String(e) } });
    } finally {
      setChatLoading(false);
    }
  };

  const handleBurst = async () => {
    setBurstLoading(true);
    setChatResult(null);
    setBurstResult(null);
    try {
      const res = await fetch('/api/oidc/burst', { method: 'POST' });
      setBurstResult(await res.json());
    } catch {
      setBurstResult({ ok: 0, limited: 0, other: 1, tokens: 0 });
    } finally {
      setBurstLoading(false);
    }
  };

  return (
    <div style={s.container}>
      <h2 style={s.heading}>Models-as-a-Service — external OIDC</h2>
      <p style={s.sub}>
        issuer <code style={s.code}>{config.issuer}</code> · client <code style={s.code}>{config.clientId}</code>
      </p>

      {/* Step 1: Sign in */}
      <div style={{ ...s.card, ...(signedIn ? s.cardDone : {}) }}>
        <div style={s.step}>STEP 1</div>
        <h3 style={s.cardTitle}>Sign in with Keycloak</h3>
        <p style={s.muted}>
          These users exist only in Keycloak — they have no OpenShift account.
          Sign-in uses the authorization code flow with PKCE, so the password is never seen by this app.
        </p>
        <div style={s.row}>
          {signedIn ? (
            <>
              <span style={s.muted}>Signed in as <b style={{ color: '#e0e0e0' }}>{session?.username}</b></span>
              <a href="/auth/logout" style={s.ghostBtn}>Switch user</a>
            </>
          ) : (
            <>
              <a href="/auth/login" style={s.primaryBtn}>Sign in with Keycloak</a>
              <span style={s.hint}>maas-user / maas-user · restricted-user / restricted-user</span>
            </>
          )}
        </div>
      </div>

      {/* Step 2: Token claims */}
      <div style={{ ...s.card, ...(signedIn ? s.cardDone : s.cardIdle) }}>
        <div style={s.step}>STEP 2</div>
        <h3 style={s.cardTitle}>The token</h3>
        {signedIn ? (
          <>
            <div style={s.kv}>
              <div style={s.kvLabel}>preferred_username</div>
              <div style={s.kvValue}><b>{session?.username}</b></div>
              <div style={s.kvLabel}>groups</div>
              <div style={s.kvValue}>
                {session?.groups?.map(g => <span key={g} style={s.pill}>{g}</span>)}
              </div>
              <div style={s.kvLabel}>issuer</div>
              <div style={s.kvValue}><code style={s.code}>{session?.issuer}</code></div>
              <div style={s.kvLabel}>expires</div>
              <div style={s.kvValue}>{session?.tokenExp}</div>
            </div>
            <p style={{ ...s.muted, marginTop: 12 }}>
              Decoded locally for display — no signature check happens here.
              MaaS verifies the signature against the issuer's public keys.
            </p>
          </>
        ) : (
          <p style={s.muted}>Sign in to see the token claims.</p>
        )}
      </div>

      {/* Step 3: API key */}
      <div style={{ ...s.card, ...(signedIn ? s.cardDone : s.cardIdle) }}>
        <div style={s.step}>STEP 3</div>
        <h3 style={s.cardTitle}>Exchanged for a MaaS API key</h3>
        {signedIn ? (
          <div style={s.kv}>
            <div style={s.kvLabel}>subscription</div>
            <div style={s.kvValue}><b>{session?.subscription}</b></div>
            <div style={s.kvLabel}>api key</div>
            <div style={s.kvValue}><code style={s.codeKey}>{session?.apiKeyMasked}</code></div>
            <div style={s.kvLabel}>expires</div>
            <div style={s.kvValue}>{session?.keyExpires}</div>
          </div>
        ) : (
          <p style={s.muted}>The <code style={s.code}>groups</code> claim decides which subscription applies.</p>
        )}
      </div>

      {/* Step 4: Call the model */}
      <div style={{ ...s.card, ...(signedIn ? s.cardDone : s.cardIdle) }}>
        <div style={s.step}>STEP 4</div>
        <h3 style={s.cardTitle}>Call the model</h3>
        <div style={s.row}>
          <input
            type="text"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !chatLoading && signedIn && handleSend()}
            style={s.input}
            disabled={!signedIn}
            placeholder="Type a prompt..."
          />
          <button onClick={handleSend} disabled={!signedIn || chatLoading} style={s.primaryBtn}>
            {chatLoading ? 'Calling…' : 'Send'}
          </button>
        </div>
        <div style={s.row}>
          <button onClick={handleBurst} disabled={!signedIn || burstLoading} style={s.ghostBtn}>
            {burstLoading ? 'Sending…' : 'Burst 15 requests'}
          </button>
          <span style={s.hint}>shows the rate limit for this subscription</span>
        </div>

        {chatResult && (
          chatResult.ok ? (
            <div>
              <pre style={s.pre}>{chatResult.content}</pre>
              <p style={s.muted}>usage: {JSON.stringify(chatResult.usage)}</p>
            </div>
          ) : (
            <pre style={s.pre}>{'HTTP ' + chatResult.status + '\n' + JSON.stringify(chatResult.body, null, 2)}</pre>
          )
        )}

        {burstResult && (
          <div style={{ marginTop: 12 }}>
            <div style={s.burstBar}>
              {burstResult.ok > 0 && <div style={{ ...s.burstOk, flex: burstResult.ok }} />}
              {burstResult.limited > 0 && <div style={{ ...s.burstLim, flex: burstResult.limited }} />}
              {burstResult.other > 0 && <div style={{ ...s.burstOther, flex: burstResult.other }} />}
            </div>
            <p style={s.muted}>
              <b style={{ color: '#10b981' }}>{burstResult.ok}</b> succeeded
              {' · '}<b style={{ color: '#f59e0b' }}>{burstResult.limited}</b> rate-limited (HTTP 429)
              {' · '}{burstResult.other} other
              {' · '}{burstResult.tokens} tokens consumed
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { padding: '24px 32px', overflowY: 'auto', height: '100%', background: '#0a0e17', maxWidth: 920, margin: '0 auto' },
  heading: { margin: '0 0 4px', fontSize: 22, color: '#e0e0e0', fontWeight: 700 },
  sub: { color: '#64748b', margin: '0 0 24px', fontSize: 13 },

  card: {
    background: '#131824', border: '1px solid #1e293b', borderRadius: 10,
    padding: '18px 20px', marginBottom: 16,
  },
  cardDone: { borderLeft: '3px solid #10b981' },
  cardIdle: { opacity: 0.5 },

  step: { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 8 },
  cardTitle: { fontSize: 16, margin: '0 0 10px', color: '#e0e0e0', fontWeight: 600 },

  row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 },
  muted: { color: '#64748b', fontSize: 13, margin: 0 },
  hint: { color: '#475569', fontSize: 13 },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, color: '#94a3b8' },
  codeKey: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, color: '#94a3b8', background: '#1e293b', padding: '2px 6px', borderRadius: 4 },

  kv: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '8px 14px', marginTop: 10 },
  kvLabel: { color: '#64748b', fontSize: 13 },
  kvValue: { color: '#cbd5e1', fontSize: 14 },

  pill: {
    display: 'inline-block', background: '#064e3b', color: '#10b981', borderRadius: 999,
    padding: '2px 10px', fontSize: 12, marginRight: 6,
  },

  primaryBtn: {
    background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6,
    padding: '9px 16px', fontSize: 14, cursor: 'pointer', textDecoration: 'none',
    fontWeight: 500, display: 'inline-block',
  },
  ghostBtn: {
    background: '#1e293b', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 6,
    padding: '9px 16px', fontSize: 14, cursor: 'pointer', textDecoration: 'none',
    display: 'inline-block',
  },

  input: {
    flex: 1, padding: '9px 11px', border: '1px solid #334155', borderRadius: 6,
    fontSize: 14, background: '#1e293b', color: '#e0e0e0', outline: 'none',
  },

  pre: {
    background: '#0f1115', color: '#e6e6e6', padding: '12px 14px', borderRadius: 8,
    overflowX: 'auto', margin: '10px 0 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
  },

  burstBar: { display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', marginBottom: 8 },
  burstOk: { background: '#10b981' },
  burstLim: { background: '#f59e0b' },
  burstOther: { background: '#64748b' },
};
