import { useState, useCallback, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { Topology } from './components/Topology';
import { Controls } from './components/Controls';
import { LiveFeed } from './components/LiveFeed';
import { MetricsPanel } from './components/MetricsPanel';
import type { ServerEvent, ModelInfo, UserInfo, ModelState, UserState, ActiveRequest, FeedEntry, Stats } from './types';

const MAX_FEED = 50;
const MAX_PARTICLES = 100;

function initialModelState(info: ModelInfo): ModelState {
  return { ...info, status: 'healthy', queueDepth: 0, latencyP95Ms: 0, kvCachePercent: 0 };
}

function initialUserState(info: UserInfo): UserState {
  return { name: info.name, displayName: info.displayName, rateLimit: info.rateLimit, rateLimited: false, activeRequests: 0 };
}

export default function App() {
  const [models, setModels] = useState<ModelState[]>([]);
  const [users, setUsers] = useState<UserState[]>([]);
  const [modelInfos, setModelInfos] = useState<ModelInfo[]>([]);
  const [userInfos, setUserInfos] = useState<UserInfo[]>([]);
  const [activeRequests, setActiveRequests] = useState<ActiveRequest[]>([]);
  const activeRequestsRef = useRef<ActiveRequest[]>([]);
  const usersRef = useRef<UserState[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [stats, setStats] = useState<Stats>({ totalRequests: 0, completedRequests: 0, rateLimitedRequests: 0, errorRequests: 0, totalTokens: 0, avgLatencyMs: 0 });
  const [trafficRunning, setTrafficRunning] = useState(false);
  const latencySamples = useRef<number[]>([]);

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'config': {
        setModelInfos(event.models);
        setUserInfos(event.users);
        setModels(event.models.map(initialModelState));
        const newUsers = event.users.map(initialUserState);
        usersRef.current = newUsers;
        setUsers(newUsers);
        break;
      }

      case 'request_start': {
        if (usersRef.current.find(u => u.name === event.user)?.rateLimited) break;
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
        // Phase transitions: to_gateway → to_model after 800ms
        setTimeout(() => {
          setActiveRequests(prev => prev.map(r =>
            r.requestId === event.requestId ? { ...r, phase: 'to_model' as const, startTime: performance.now() } : r
          ));
        }, 800);
        break;
      }

      case 'request_complete':
        latencySamples.current.push(event.latencyMs);
        if (latencySamples.current.length > 100) latencySamples.current.shift();
        const avgLatency = latencySamples.current.reduce((a, b) => a + b, 0) / latencySamples.current.length;

        setStats(s => ({
          ...s,
          completedRequests: s.completedRequests + 1,
          totalTokens: s.totalTokens + event.tokensUsed,
          avgLatencyMs: avgLatency,
        }));
        setUsers(prev => prev.map(u =>
          u.name === event.user ? { ...u, activeRequests: Math.max(0, u.activeRequests - 1) } : u
        ));
        setActiveRequests(prev => {
          const next = prev.map(r =>
            r.requestId === event.requestId ? { ...r, phase: 'returning' as const, startTime: performance.now() } : r
          );
          activeRequestsRef.current = next;
          return next;
        });
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
        }, ...prev].slice(0, MAX_FEED));
        break;

      case 'rate_limited':
        setStats(s => ({ ...s, rateLimitedRequests: s.rateLimitedRequests + 1 }));
        setUsers(prev => {
          const next = prev.map(u =>
            u.name === event.user ? { ...u, rateLimited: true, rateLimitedAt: Date.now(), activeRequests: 0 } : u
          );
          usersRef.current = next;
          return next;
        });
        setActiveRequests(prev => {
          const next = prev.filter(r => r.user !== event.user);
          activeRequestsRef.current = next;
          return next;
        });
        setFeed(prev => [{
          id: event.requestId,
          user: event.user,
          model: event.model,
          question: activeRequestsRef.current.find(r => r.requestId === event.requestId)?.question || '',
          answer: '',
          latencyMs: 0,
          tokensUsed: 0,
          timestamp: Date.now(),
          rateLimited: true,
        }, ...prev].slice(0, MAX_FEED));
        break;

      case 'rate_limit_reset':
        setUsers(prev => {
          const next = prev.map(u =>
            u.name === event.user ? { ...u, rateLimited: false } : u
          );
          usersRef.current = next;
          return next;
        });
        break;

      case 'request_error':
        setStats(s => ({ ...s, errorRequests: s.errorRequests + 1 }));
        setUsers(prev => prev.map(u =>
          u.name === event.user ? { ...u, activeRequests: Math.max(0, u.activeRequests - 1) } : u
        ));
        setActiveRequests(prev => {
          const next = prev.filter(r => r.requestId !== event.requestId);
          activeRequestsRef.current = next;
          return next;
        });
        setFeed(prev => [{
          id: event.requestId,
          user: event.user,
          model: event.model,
          question: activeRequestsRef.current.find(r => r.requestId === event.requestId)?.question || '',
          answer: '',
          latencyMs: 0,
          tokensUsed: 0,
          timestamp: Date.now(),
          error: event.error,
        }, ...prev].slice(0, MAX_FEED));
        break;

      case 'model_status':
        setModels(prev => prev.map(m =>
          m.name === event.model ? {
            ...m,
            status: event.status,
            queueDepth: event.queueDepth,
            latencyP95Ms: event.latencyP95Ms,
            kvCachePercent: event.kvCachePercent,
          } : m
        ));
        break;

      case 'traffic_started':
        setTrafficRunning(true);
        break;

      case 'traffic_stopped':
        setTrafficRunning(false);
        break;
    }
  }, []);

  const { send, connected } = useWebSocket(handleEvent);

  return (
    <div style={styles.app}>
      <Controls
        models={modelInfos}
        users={userInfos}
        trafficRunning={trafficRunning}
        connected={connected}
        send={send}
      />
      <div style={styles.main}>
        <div style={styles.topologyArea}>
          <Topology users={users} models={models} activeRequests={activeRequests} />
        </div>
        <div style={styles.sidebar}>
          <LiveFeed entries={feed} />
          <MetricsPanel stats={stats} />
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0e17' },
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  topologyArea: { flex: 1, position: 'relative' },
  sidebar: { width: 320, borderLeft: '1px solid #1e293b', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
};
