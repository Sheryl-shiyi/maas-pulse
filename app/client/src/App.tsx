import { useState, useCallback, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { Topology } from './components/Topology';
import { Controls } from './components/Controls';
import { LiveFeed } from './components/LiveFeed';
import { MetricsPanel } from './components/MetricsPanel';
import { ChargebackView } from './components/ChargebackView';
import { OidcView } from './components/OidcView';
import type { ServerEvent, ModelInfo, UserInfo, ModelState, UserState, ActiveRequest, FeedEntry, Stats, GatewayStage, ScaleNotice, EppWeights } from './types';
import { ScaleNotices } from './components/ScaleNotices';
import { TraceForm, TraceCaption } from './components/TracePanel';
import { SceneCard } from './components/SceneCard';
import { SCENES } from './components/scenes';
import { buildTraceSteps, type TraceResponse, type TraceStep, type TraceView } from './components/traceSteps';

type ViewTab = 'traffic' | 'cost' | 'oidc';

const MAX_FEED = 50;
const MAX_PARTICLES = 100;
/** How long a dot takes from a user to the gateway, and again on the way back. */
const SEGMENT_MS = 800;

function initialModelState(info: ModelInfo): ModelState {
  return { ...info, status: 'healthy', runningRequests: 0, queuedRequests: 0, latencyP95Ms: 0, kvCachePercent: 0, replicas: 1, desiredReplicas: 1, replicaStats: [] };
}

function initialUserState(info: UserInfo): UserState {
  return { name: info.name, displayName: info.displayName, rateLimit: info.rateLimit, tier: info.tier, rateLimits: {}, rateLimitedModels: {}, activeRequests: 0 };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ViewTab>(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('tab') as ViewTab) || 'traffic';
  });
  const [models, setModels] = useState<ModelState[]>([]);
  const modelsRef = useRef<ModelState[]>([]);
  modelsRef.current = models;
  const [users, setUsers] = useState<UserState[]>([]);
  const [modelInfos, setModelInfos] = useState<ModelInfo[]>([]);
  const [userInfos, setUserInfos] = useState<UserInfo[]>([]);
  const [activeRequests, setActiveRequests] = useState<ActiveRequest[]>([]);
  const activeRequestsRef = useRef<ActiveRequest[]>([]);
  const usersRef = useRef<UserState[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [stats, setStats] = useState<Stats>({
    totalRequests: 0, completedRequests: 0, rateLimitedRequests: 0, errorRequests: 0,
    authRejected: 0, accessDenied: 0, routedRequests: 0, totalTokens: 0, avgLatencyMs: 0,
  });
  /** When each gateway stage last acted, on the performance.now() clock, so the topology
   *  can light that stage up. A ref, not state: it changes on every request and is only
   *  read by the canvas loop. */
  const gatewayFlash = useRef<Record<GatewayStage, number>>({ auth: 0, access: 0, limit: 0, route: 0, meter: 0 });
  const [trafficRunning, setTrafficRunning] = useState(false);
  const [scaleNotices, setScaleNotices] = useState<ScaleNotice[]>([]);
  const [eppWeights, setEppWeights] = useState<EppWeights | null>(null);
  /** "Trace a request": the form, then the replay of one real request. */
  const [traceFormOpen, setTraceFormOpen] = useState(false);
  /** The demo scene in progress, by index in SCENES. */
  const [activeScene, setActiveScene] = useState<number | null>(null);
  const [trace, setTrace] = useState<null | {
    status: 'sending' | 'ready' | 'error'; header: string; steps: TraceStep[]; index: number;
    user: string; model: string; replicaIdx: number | null; error?: string;
  }>(null);
  const latencySamples = useRef<number[]>([]);

  /** The gateway stopped this request at `stage`: its dot finishes the trip to the
   *  gateway, then bounces back, and the stage lights up when the dot arrives. */
  const rejectAt = (requestId: string, stage: GatewayStage, dropAlso?: (r: ActiveRequest) => boolean) => {
    const req = activeRequestsRef.current.find(r => r.requestId === requestId);
    const now = performance.now();
    gatewayFlash.current[stage] = req ? Math.max(now, req.startTime + SEGMENT_MS) : now;
    setActiveRequests(prev => {
      const next = prev.flatMap(r =>
        r.requestId === requestId ? [{ ...r, rejectedAt: stage }] : dropAlso?.(r) ? [] : [r]);
      activeRequestsRef.current = next;
      return next;
    });
    const remaining = req ? Math.max(0, req.startTime + 2 * SEGMENT_MS - now) : 0;
    setTimeout(() => {
      setActiveRequests(prev => {
        const next = prev.filter(r => r.requestId !== requestId);
        activeRequestsRef.current = next;
        return next;
      });
    }, remaining + 30);
  };

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'config': {
        setModelInfos(event.models);
        setUserInfos(event.users);
        setModels(event.models.map(initialModelState));
        const newUsers = event.users.map(initialUserState);
        usersRef.current = newUsers;
        setUsers(newUsers);
        setTrafficRunning(event.trafficRunning);
        setEppWeights(event.eppWeights ?? null);
        break;
      }

      case 'request_start': {
        const sender = usersRef.current.find(u => u.name === event.user);
        if (sender?.rateLimitedModels[event.model]) break;
        setStats(s => ({ ...s, totalRequests: s.totalRequests + 1 }));
        setUsers(prev => {
          const next = prev.map(u =>
            u.name === event.user ? { ...u, activeRequests: u.activeRequests + 1 } : u
          );
          usersRef.current = next;
          return next;
        });
        setActiveRequests(prev => {
          const next = [...prev, {
            requestId: event.requestId,
            user: event.user,
            model: event.model,
            question: event.question,
            startTime: performance.now(),
            phase: 'to_gateway' as const,
            progress: 0,
          }];
          if (next.length > MAX_PARTICLES) next.shift();
          activeRequestsRef.current = next;
          return next;
        });
        // Phase transitions: to_gateway → to_model once the dot reaches the gateway,
        // unless the gateway has turned it away in the meantime.
        setTimeout(() => {
          const req = activeRequestsRef.current.find(r => r.requestId === event.requestId);
          if (!req || req.rejectedAt) return;
          gatewayFlash.current.route = performance.now();
          setActiveRequests(prev => {
            const next = prev.map(r =>
              r.requestId === event.requestId && !r.rejectedAt ? { ...r, phase: 'to_model' as const, startTime: performance.now() } : r
            );
            activeRequestsRef.current = next;
            return next;
          });
        }, SEGMENT_MS);
        break;
      }

      case 'request_complete':
        latencySamples.current.push(event.latencyMs);
        if (latencySamples.current.length > 100) latencySamples.current.shift();
        const avgLatency = latencySamples.current.reduce((a, b) => a + b, 0) / latencySamples.current.length;

        setStats(s => ({
          ...s,
          completedRequests: s.completedRequests + 1,
          routedRequests: s.routedRequests + 1,
          totalTokens: s.totalTokens + event.tokensUsed,
          avgLatencyMs: avgLatency,
        }));
        gatewayFlash.current.meter = performance.now();
        setUsers(prev => prev.map(u =>
          u.name === event.user ? { ...u, activeRequests: Math.max(0, u.activeRequests - 1) } : u
        ));
        // Which replica really answered: the gateway names the pod (x-maas-upstream) and
        // each replica's metrics carry the same address. The dot returns from there.
        const servingModel = modelsRef.current.find(m => m.name === event.model);
        const servedIdx = servingModel && event.upstream
          ? servingModel.replicaStats.findIndex(r => r.instance === event.upstream) : -1;
        const cachedFraction = event.promptTokens ? (event.cachedTokens ?? 0) / event.promptTokens : undefined;
        setActiveRequests(prev => {
          const next = prev.map(r =>
            r.requestId === event.requestId ? {
              ...r, phase: 'returning' as const, startTime: performance.now(),
              servedReplica: servedIdx >= 0 ? servedIdx : undefined, cachedFraction,
            } : r
          );
          activeRequestsRef.current = next;
          return next;
        });
        const servedBy = servingModel?.type === 'internal'
          ? servingModel.displayName + (servedIdx >= 0 && (servingModel.replicas > 1 || servingModel.desiredReplicas > 1) ? ` #${servedIdx + 1}` : '')
          : undefined;
        setTimeout(() => {
          setActiveRequests(prev => {
            const next = prev.filter(r => r.requestId !== event.requestId);
            activeRequestsRef.current = next;
            return next;
          });
        }, 1600);
        setFeed(prev => [{
          id: event.requestId,
          user: event.user,
          model: event.model,
          question: activeRequestsRef.current.find(r => r.requestId === event.requestId)?.question || '',
          answer: event.answer,
          latencyMs: event.latencyMs,
          tokensUsed: event.tokensUsed,
          timestamp: Date.now(),
          servedBy,
          promptTokens: event.promptTokens,
          cachedTokens: event.cachedTokens,
        }, ...prev].slice(0, MAX_FEED));
        break;

      case 'rate_limited': {
        // Same ordering trap as request_error: capture before the removal below.
        const limitedQuestion = activeRequestsRef.current.find(r => r.requestId === event.requestId)?.question || '';
        const source = event.source ?? 'gateway';
        const sameUserModel = (r: ActiveRequest) => r.user === event.user && r.model === event.model;
        // Only the gateway's own 429 is a MaaS rate limit. A provider's own rate limit
        // was hit after routing, at the provider, so it counts as an upstream error.
        setStats(s => source === 'gateway'
          ? { ...s, rateLimitedRequests: s.rateLimitedRequests + 1 }
          : { ...s, errorRequests: s.errorRequests + 1, routedRequests: s.routedRequests + 1 });
        setUsers(prev => {
          const next = prev.map(u =>
            u.name === event.user ? {
              ...u,
              rateLimitedModels: { ...u.rateLimitedModels, [event.model]: source },
              activeRequests: Math.max(0, u.activeRequests - 1),
            } : u
          );
          usersRef.current = next;
          return next;
        });
        if (source === 'gateway') {
          rejectAt(event.requestId, 'limit', sameUserModel);
        } else {
          setActiveRequests(prev => {
            const next = prev.filter(r => !sameUserModel(r));
            activeRequestsRef.current = next;
            return next;
          });
        }
        setFeed(prev => [{
          id: event.requestId,
          user: event.user,
          model: event.model,
          question: limitedQuestion,
          answer: '',
          latencyMs: 0,
          tokensUsed: 0,
          timestamp: Date.now(),
          rateLimited: source === 'gateway',
          providerLimited: source === 'provider',
          providerMessage: event.message,
        }, ...prev].slice(0, MAX_FEED));
        break;
      }

      case 'rate_limit_reset': {
        setUsers(prev => {
          const next = prev.map(u => {
            if (u.name !== event.user) return u;
            const { [event.model]: _, ...rest } = u.rateLimitedModels;
            return { ...u, rateLimitedModels: rest };
          });
          usersRef.current = next;
          return next;
        });
        break;
      }

      case 'rate_limit_update':
        setUsers(prev => {
          const next = prev.map(u =>
            u.name === event.user ? { ...u, rateLimits: event.rateLimits } : u
          );
          usersRef.current = next;
          return next;
        });
        break;

      case 'request_error': {
        // Read the question before dropping the request: unlike the success path,
        // which defers removal, this removes synchronously, so looking it up
        // afterwards always missed and the feed showed an empty "Q:".
        const question = activeRequestsRef.current.find(r => r.requestId === event.requestId)?.question || '';
        // 401: the gateway could not authenticate the caller. 403: authenticated, but
        // no subscription gives it this model. Anything else got past the gateway.
        const stage: GatewayStage | null = event.status === 401 ? 'auth' : event.status === 403 ? 'access' : null;
        setStats(s => ({
          ...s,
          errorRequests: s.errorRequests + 1,
          authRejected: s.authRejected + (stage === 'auth' ? 1 : 0),
          accessDenied: s.accessDenied + (stage === 'access' ? 1 : 0),
          routedRequests: s.routedRequests + (stage ? 0 : 1),
        }));
        setUsers(prev => prev.map(u =>
          u.name === event.user ? { ...u, activeRequests: Math.max(0, u.activeRequests - 1) } : u
        ));
        if (stage) {
          rejectAt(event.requestId, stage);
        } else {
          setActiveRequests(prev => {
            const next = prev.filter(r => r.requestId !== event.requestId);
            activeRequestsRef.current = next;
            return next;
          });
        }
        setFeed(prev => [{
          id: event.requestId,
          user: event.user,
          model: event.model,
          question,
          answer: '',
          latencyMs: 0,
          tokensUsed: 0,
          timestamp: Date.now(),
          error: event.error,
          status: event.status,
        }, ...prev].slice(0, MAX_FEED));
        break;
      }

      case 'model_status':
        setModels(prev => prev.map(m =>
          m.name === event.model ? {
            ...m,
            status: event.status,
            runningRequests: event.runningRequests,
            queuedRequests: event.queuedRequests,
            latencyP95Ms: event.latencyP95Ms,
            kvCachePercent: event.kvCachePercent,
            replicaStats: event.replicas,
          } : m
        ));
        break;

      case 'scale_update':
        setModels(prev => prev.map(m =>
          m.name === event.model || m.name.endsWith(event.model)
            ? {
                ...m,
                replicas: event.replicas,
                desiredReplicas: event.desiredReplicas,
                // Start the "starting for m:ss" clock the first time a replica is missing,
                // and stop it once every desired replica is ready.
                scalingSince: event.desiredReplicas > event.replicas ? (m.scalingSince ?? Date.now()) : undefined,
              }
            : m
        ));
        break;

      case 'scale_event': {
        const model = modelsRef.current.find(m => m.name === event.model || m.name.endsWith(event.model));
        const at = Date.now();
        if (event.direction === 'up') {
          setModels(prev => prev.map(m => (m.name === model?.name ? { ...m, scalingSince: at } : m)));
        }
        setScaleNotices(prev => [{
          id: `${event.model}-${event.at}`,
          model: model?.name ?? event.model,
          modelDisplayName: model?.displayName ?? event.model,
          direction: event.direction,
          from: event.from,
          to: event.to,
          summary: event.summary,
          checks: event.checks,
          at,
        }, ...prev].slice(0, 3));
        break;
      }

      case 'traffic_started':
        setTrafficRunning(true);
        break;

      case 'traffic_stopped':
        setTrafficRunning(false);
        break;
    }
  }, []);

  const { send, connected } = useWebSocket(handleEvent);

  const startTrace = useCallback(async (user: string, model: string, question: string) => {
    setTraceFormOpen(false);
    const u = usersRef.current.find(x => x.name === user);
    const m = modelsRef.current.find(x => x.name === model);
    // llm-d's view of the replicas as the request leaves, for the replay's llm-d step.
    const snapshot = m ? (JSON.parse(JSON.stringify(m)) as ModelState) : undefined;
    const header = `Tracing ${u?.displayName ?? user} → ${m?.displayName ?? model}`;
    setTrace({ status: 'sending', header, steps: [], index: 0, user, model, replicaIdx: null });
    try {
      const res = await fetch('/api/trace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, model, question }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { steps, replicaIdx } = buildTraceSteps((await res.json()) as TraceResponse, snapshot);
      setTrace(t => t && { ...t, status: 'ready', steps, replicaIdx, index: 0 });
    } catch (e) {
      setTrace(t => t && { ...t, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const traceView: TraceView | null = trace ? {
    user: trace.user, model: trace.model, replicaIdx: trace.replicaIdx,
    focus: trace.status === 'ready' ? trace.steps[trace.index]?.focus ?? 'user' : 'user',
    tone: trace.status === 'ready' ? trace.steps[trace.index]?.tone : undefined,
    reached: trace.status === 'ready' ? trace.steps.slice(0, trace.index + 1).map(s => s.focus) : ['user'],
  } : null;

  return (
    <div style={styles.app}>
      <div style={styles.tabBar}>
        <div style={styles.tabGroup}>
          <button
            onClick={() => setActiveTab('traffic')}
            style={{ ...styles.tab, ...(activeTab === 'traffic' ? styles.tabActive : {}) }}
          >
            Traffic
          </button>
          <button
            onClick={() => setActiveTab('cost')}
            style={{ ...styles.tab, ...(activeTab === 'cost' ? styles.tabActive : {}) }}
          >
            Cost & Chargeback
          </button>
          <button
            onClick={() => setActiveTab('oidc')}
            style={{ ...styles.tab, ...(activeTab === 'oidc' ? styles.tabActive : {}) }}
          >
            OIDC
          </button>
        </div>
        <div style={{ ...styles.connStatus, color: connected ? '#4caf50' : '#ee0000' }}>
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      {activeTab === 'traffic' ? (
        <>
          {/* While a trace replays, everything that is not the replay steps back. */}
          <div style={{ opacity: trace ? 0.3 : 1, transition: 'opacity .35s ease', pointerEvents: trace ? 'none' : 'auto' }}>
          <Controls
            models={modelInfos}
            users={userInfos}
            trafficRunning={trafficRunning}
            connected={connected}
            send={send}
            onTrace={() => { setTrace(null); setTraceFormOpen(true); }}
            onScene={i => setActiveScene(i)}
            activeScene={activeScene}
          />
          </div>
          <div style={styles.main}>
            <div style={styles.topologyArea}>
              <Topology users={users} models={models} activeRequests={activeRequests} stats={stats} gatewayFlash={gatewayFlash.current} eppWeights={eppWeights} trace={traceView} />
              {!trace && (
                <ScaleNotices
                  notices={scaleNotices}
                  onDismiss={id => setScaleNotices(prev => prev.filter(n => n.id !== id))}
                />
              )}
              {traceFormOpen && (
                <>
                  {/* A modal: the rest of the page darkens until a user and model are picked. */}
                  <div style={styles.scrim} onClick={() => setTraceFormOpen(false)} />
                  <TraceForm users={userInfos} models={modelInfos} onTrace={startTrace} onCancel={() => setTraceFormOpen(false)} />
                </>
              )}

            </div>
            <div style={styles.sidebar}>
              {trace && (
                <TraceCaption
                  header={trace.header} status={trace.status} steps={trace.steps} index={trace.index} error={trace.error}
                  onBack={() => setTrace(t => t && { ...t, index: Math.max(0, t.index - 1) })}
                  onNext={() => setTrace(t => t && { ...t, index: Math.min(t.steps.length - 1, t.index + 1) })}
                  onClose={() => setTrace(null)}
                />
              )}
              {!trace && activeScene !== null && SCENES[activeScene] && (
                <SceneCard
                  scene={SCENES[activeScene]!} index={activeScene} total={SCENES.length}
                  trafficRunning={trafficRunning}
                  onStop={() => send({ type: 'stop_traffic' })}
                  onClose={() => setActiveScene(null)}
                />
              )}
              <div style={{ ...styles.sideRest, opacity: trace ? 0.25 : 1 }}>
                <LiveFeed entries={feed} users={users} models={models} />
                <MetricsPanel stats={stats} />
              </div>
            </div>
          </div>
        </>
      ) : activeTab === 'cost' ? (
        <div style={styles.main}>
          <ChargebackView />
        </div>
      ) : (
        <div style={styles.main}>
          <OidcView />
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0a' },
  tabBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', background: '#0d1117', borderBottom: '1px solid #1f1f1f' },
  tabGroup: { display: 'flex', gap: 0 },
  tab: {
    background: 'transparent', color: '#8a8a8a', border: 'none', borderBottom: '2px solid transparent',
    padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  tabActive: { color: '#e0e0e0', borderBottom: '2px solid #c7c7c7' },
  connStatus: { fontSize: 12, fontWeight: 600 },
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  topologyArea: { flex: 1, position: 'relative' },
  sidebar: { width: 320, borderLeft: '1px solid #1f1f1f', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  sideRest: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', transition: 'opacity .35s ease' },
  scrim: { position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(2px)' },
};
