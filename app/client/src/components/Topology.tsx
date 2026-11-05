import { useRef, useEffect, useCallback, useState } from 'react';
import { HelpPopover, type HelpTarget } from './TopologyHelp';
import type { ModelState, UserState, ActiveRequest, Stats, GatewayStage } from '../types';
import { providerOf, providerLabel, drawProviderLogo } from './providerLogos';

const USER_COLORS = ['#42a5f5', '#66bb6a', '#ffa726', '#ab47bc', '#ef5350', '#26c6da', '#ec407a', '#8d6e63'];
const STATUS_COLORS: Record<string, string> = { healthy: '#4caf50', busy: '#ff9800', overloaded: '#f44336' };
const RATE_LIMITED_COLOR = '#475569';
const QUEUE_COLOR = '#ef4444';
const CACHE_COLOR = '#38bdf8';
/**
 * External models have no vLLM metrics, so they never get a health colour. They used to
 * fall through to slate grey, which read as "offline". Indigo says "served by someone
 * else" without borrowing the green/orange/red that mean something for internal models.
 */
const EXTERNAL_COLOR = '#4f46e5';
const CAPTION_COLOR = 'rgba(148, 163, 184, 0.85)';
const GATEWAY_COLOR = '#ff9800';
/** MaaS refused the request: its own token limit, authentication or access. */
const BLOCKED_COLOR = '#ef4444';
/** The provider behind an external model refused it (Google's quota), not MaaS. */
const PROVIDER_LIMIT_COLOR = '#f59e0b';

/**
 * Full scale for the load bar, in requests.
 *
 * This is MAX_IN_FLIGHT from server/src/traffic.ts — the generator will not have more
 * than this outstanding at once, so a full bar means one replica is holding everything
 * the demo sent. An arbitrary round number would make the bar unreadable: too small and
 * it pins at full the moment traffic starts, too large and the queue growing is invisible.
 */
const LOAD_BAR_SCALE = 50;

/**
 * How fast the bars catch up to a new reading, as a fraction per frame.
 *
 * Prometheus scrapes vLLM every 5 seconds, so the figures arrive as steps however often
 * the UI polls. Drawing them raw makes a replica jump from empty to 25 in one frame,
 * which reads as a glitch rather than as a queue filling. Easing turns each step into
 * roughly a third of a second of movement. The numbers printed in the box stay exact —
 * only the bar is smoothed, so nothing claims a measurement that was not taken.
 */
const BAR_EASING = 0.12;

/** Matches SEGMENT_MS in App.tsx: one leg of a dot's trip. */
const SEGMENT_MS = 800;

/**
 * What the MaaS gateway does to every request, in the order it does it. Drawn as the
 * gateway itself, so an audience sees a policy pipeline rather than an orange shape: a
 * stage lights up when it acts, and the ones that can refuse a request count refusals.
 */
const STAGES: { key: GatewayStage; title: string; detail: string; refuses: boolean }[] = [
  { key: 'auth', title: 'Authenticate', detail: 'API key · token · OIDC', refuses: true },
  { key: 'access', title: 'Subscription', detail: 'tier → models & limits', refuses: true },
  { key: 'limit', title: 'Token limits', detail: 'tokens / min per user', refuses: true },
  { key: 'route', title: 'Route by model', detail: 'llm-d · provider keys', refuses: false },
  { key: 'meter', title: 'Meter usage', detail: '→ Cost & Chargeback', refuses: false },
];

interface TopologyProps {
  users: UserState[];
  models: ModelState[];
  activeRequests: ActiveRequest[];
  stats: Stats;
  /** When each gateway stage last acted (performance.now()), owned by App. */
  gatewayFlash: Record<GatewayStage, number>;
}

/** One subscription tier: its shared limits on top, then one compact row per user. */
interface Band {
  label: string;
  /** Spacing, smaller in compact mode when the canvas is short. */
  pad: number; headerH: number; limitRowH: number;
  x: number; y: number; w: number; h: number;
  members: number[];
  limitsY: number;
  /** Centre of the first user row; row n is at firstRowY + n * rowH. */
  firstRowY: number;
  rowH: number;
}

interface Rect { x: number; y: number; w: number; h: number }

const GATEWAY_HEADER_H = 34;
/** Height a model box needs below it for the load and cache bars. */
const BARS_H = 44;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function Topology({ users, models, activeRequests, stats, gatewayFlash }: TopologyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const propsRef = useRef({ users, models, activeRequests, stats, gatewayFlash });
  propsRef.current = { users, models, activeRequests, stats, gatewayFlash };
  /** Eased bar values per replica, keyed `<model>#<replicaIdx>`, so each one keeps its
   *  own animation across frames and across re-layouts. */
  const barsRef = useRef(new Map<string, { running: number; queued: number; cache: number }>());
  /** Clickable areas drawn in the last frame, in canvas (CSS) pixels. */
  const regionsRef = useRef<HelpTarget[]>([]);
  const [help, setHelp] = useState<HelpTarget | null>(null);

  const getLayout = useCallback((w: number, h: number) => {
    // Users are grouped by subscription tier, because limits belong to the tier: every
    // member of a tier has the same ones. So each tier shows its limits once, and its
    // users are compact rows. One card per user repeated the same four numbers ten
    // times and, on a laptop-height screen, the cards and circles overlapped.
    const tierOrder: string[] = [];
    for (const u of users) {
      const key = u.tier || '';
      if (!tierOrder.includes(key)) tierOrder.push(key);
    }
    const bandX = 14;
    const bandW = clamp(w * 0.22, 200, 250);
    const limitRows = Math.ceil(Math.max(models.length, 1) / 2);
    const gaps = Math.max(tierOrder.length - 1, 0);
    const sizeFor = (pad: number, headerH: number, limitRowH: number, gap: number) => {
      const bandFixed = pad * 2 + headerH + limitRows * limitRowH + 4;
      return { pad, headerH, limitRowH, gap, bandFixed, fixed: tierOrder.length * bandFixed + gap * gaps };
    };
    // Compact spacing when the roomy one would leave users less than 22px each, as on a
    // laptop whose controls bar has wrapped onto a second line.
    const roomy = sizeFor(8, 16, 13, 10);
    const sz = h - 16 - roomy.fixed >= users.length * 22 ? roomy : sizeFor(5, 13, 11, 6);
    const BAND_PAD = sz.pad, BAND_HEADER_H = sz.headerH, LIMIT_ROW_H = sz.limitRowH, BAND_GAP = sz.gap;
    const bandFixed = sz.bandFixed;
    const fixed = sz.fixed;
    const rowH = users.length > 0 ? clamp((h - 16 - fixed) / users.length, 16, 40) : 24;
    const total = fixed + rowH * users.length;

    const userPositions: { y: number; anchorX: number }[] = new Array(users.length);
    const bands: Band[] = [];
    let cursor = Math.max(8, (h - total) / 2);
    for (const tier of tierOrder) {
      const members = users.map((u, i) => ({ u, i })).filter(({ u }) => (u.tier || '') === tier).map(({ i }) => i);
      const bandH = bandFixed + rowH * members.length;
      const firstRowY = cursor + BAND_PAD + BAND_HEADER_H + limitRows * LIMIT_ROW_H + 4 + rowH / 2;
      members.forEach((i, n) => {
        userPositions[i] = { y: firstRowY + rowH * n, anchorX: bandX + bandW };
      });
      const label = tier
        ? tier.toUpperCase()
        : members.length === 1 ? users[members[0]!]!.displayName.toUpperCase() : 'NO TIER';
      bands.push({ label, pad: BAND_PAD, headerH: BAND_HEADER_H, limitRowH: LIMIT_ROW_H, x: bandX, y: cursor, w: bandW, h: bandH, members, limitsY: cursor + BAND_PAD + BAND_HEADER_H, firstRowY, rowH });
      cursor += bandH + BAND_GAP;
    }

    const modelX = w * 0.84;
    const modelLeft = modelX - 88;
    const gatewayX = (bandX + bandW + modelLeft) / 2;
    const gatewayY = h * 0.5;
    const gwW = clamp(w * 0.2, 190, 236);
    const stageH = clamp((h * 0.55 - GATEWAY_HEADER_H) / STAGES.length, 32, 46);
    const gwH = GATEWAY_HEADER_H + stageH * STAGES.length + 6;
    const gateway: Rect = { x: gatewayX - gwW / 2, y: gatewayY - gwH / 2, w: gwW, h: gwH };

    return {
      modelX, gatewayY, gateway, stageH, bands, userPositions,
      entry: { x: gateway.x, y: gatewayY },
      exit: { x: gateway.x + gateway.w, y: gatewayY },
    };
  }, [users, models]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let running = true;

    function resize() {
      const rect = canvas!.parentElement!.getBoundingClientRect();
      canvas!.width = rect.width * devicePixelRatio;
      canvas!.height = rect.height * devicePixelRatio;
      canvas!.style.width = `${rect.width}px`;
      canvas!.style.height = `${rect.height}px`;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      if (!running) return;
      const { users, models, activeRequests, stats, gatewayFlash } = propsRef.current;
      const w = canvas!.width / devicePixelRatio;
      const h = canvas!.height / devicePixelRatio;
      const layout = getLayout(w, h);
      const now = performance.now();

      ctx.clearRect(0, 0, w, h);
      const regions: HelpTarget[] = [];

      // Compute model box positions (one box per replica)
      const modelRectW = 176;
      const modelRectH = 56;
      const boxes: { modelIdx: number; replicaIdx: number; provisioning: boolean; x: number; y: number }[] = [];
      for (let i = 0; i < models.length; i++) {
        const m = models[i]!;
        const total = Math.max(m.replicas, m.desiredReplicas);
        for (let r = 0; r < total; r++) {
          boxes.push({ modelIdx: i, replicaIdx: r, provisioning: r >= m.replicas, x: 0, y: 0 });
        }
      }
      // Spread the boxes by the room each really takes: an internal model's box has its
      // two bars underneath. Spacing by count alone let one box's bars run into the
      // next box on a short screen.
      const heights = boxes.map(b => modelRectH + (models[b.modelIdx]!.type === 'internal' && !b.provisioning ? BARS_H : 0));
      const spare = Math.max(h - heights.reduce((a, b) => a + b, 0), 0) / (boxes.length + 1);
      let top = spare;
      for (let i = 0; i < boxes.length; i++) {
        boxes[i]!.x = layout.modelX;
        boxes[i]!.y = top + modelRectH / 2;
        top += heights[i]! + spare;
      }

      // Edges: every user into the gateway's left side, the gateway's right side out to
      // every model replica.
      for (const uPos of layout.userPositions) {
        drawCurve(ctx, uPos.anchorX, uPos.y, layout.entry.x, layout.entry.y, '#1e293b');
      }
      for (const box of boxes) {
        drawCurve(ctx, layout.exit.x, layout.exit.y, box.x, box.y, box.provisioning ? '#111827' : '#1e293b');
      }

      // Particles. A request the gateway turned away finishes its trip to the gateway,
      // then bounces back in red; it is drawn after the gateway so the bounce shows.
      const bounced: { x: number; y: number }[] = [];
      for (const req of activeRequests) {
        const elapsed = now - req.startTime;
        const userIdx = users.findIndex(u => u.name === req.user);
        const modelIdx = models.findIndex(m => m.name === req.model);
        if (userIdx < 0 || modelIdx < 0) continue;

        const u = layout.userPositions[userIdx]!;
        const uX = u.anchorX, uY = u.y;
        const color = USER_COLORS[userIdx % USER_COLORS.length]!;

        if (req.rejectedAt) {
          if (req.phase !== 'to_gateway') continue;
          if (elapsed < SEGMENT_MS) {
            drawParticle(ctx, getCurvePoint(uX, uY, layout.entry.x, layout.entry.y, elapsed / SEGMENT_MS), color);
          } else {
            const t = Math.min((elapsed - SEGMENT_MS) / SEGMENT_MS, 1);
            bounced.push(getCurvePoint(layout.entry.x, layout.entry.y, uX, uY, t));
          }
          continue;
        }

        const readyBoxes = boxes.filter(b => b.modelIdx === modelIdx && !b.provisioning);
        if (readyBoxes.length === 0) continue;
        const mPos = readyBoxes[simpleHash(req.requestId) % readyBoxes.length]!;

        let pos: { x: number; y: number } | null = null;
        if (req.phase === 'to_gateway') {
          pos = getCurvePoint(uX, uY, layout.entry.x, layout.entry.y, Math.min(elapsed / SEGMENT_MS, 1));
        } else if (req.phase === 'to_model') {
          pos = getCurvePoint(layout.exit.x, layout.exit.y, mPos.x, mPos.y, Math.min(elapsed / SEGMENT_MS, 1));
        } else if (req.phase === 'returning') {
          const t = Math.min(elapsed / (SEGMENT_MS * 2), 1);
          pos = t < 0.5
            ? getCurvePoint(mPos.x, mPos.y, layout.exit.x, layout.exit.y, t * 2)
            : getCurvePoint(layout.entry.x, layout.entry.y, uX, uY, (t - 0.5) * 2);
        }
        if (pos) drawParticle(ctx, pos, color);
      }

      drawGateway(ctx, layout.gateway, layout.stageH, stats, gatewayFlash, now, regions);
      for (const p of bounced) drawBounced(ctx, p);

      for (const band of layout.bands) drawBand(ctx, band, users, models);

      // Draw model boxes (one per replica)
      for (const box of boxes) {
        const model = models[box.modelIdx]!;
        const totalBoxes = Math.max(model.replicas, model.desiredReplicas);

        if (box.provisioning) {
          ctx.beginPath();
          ctx.roundRect(box.x - modelRectW / 2, box.y - modelRectH / 2, modelRectW, modelRectH, 10);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
          ctx.fill();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.setLineDash([]);
          // Name the replica that is coming, and how long it has been starting: a new
          // vLLM pod takes 5-10 minutes (image pulls, model load), and an audience
          // watching a box that just says "Starting..." cannot tell slow from stuck.
          drawText(ctx, `${model.displayName} #${box.replicaIdx + 1}`, box.x, box.y - 8, '#f59e0b', 13, 'bold');
          const since = model.scalingSince ? Math.max(0, Math.floor((Date.now() - model.scalingSince) / 1000)) : null;
          const clock = since === null ? '' : ` · ${Math.floor(since / 60)}:${String(since % 60).padStart(2, '0')}`;
          drawText(ctx, `starting vLLM on a new GPU${clock}`, box.x, box.y + 12, 'rgba(245, 158, 11, 0.85)', 10);
        } else {
          // A replica that is Ready but has not been scraped yet has no figures of its
          // own. It must not borrow the model-level summary: with only one replica
          // reporting, that summary equals the other replica's numbers, so a brand new
          // pod appeared as an exact clone of the busy one it had just joined.
          const stat = model.replicaStats[box.replicaIdx];
          const external = model.type !== 'internal';
          const statusColor = external ? EXTERNAL_COLOR : stat ? (STATUS_COLORS[stat.status] || '#4caf50') : '#475569';
          drawRoundedRect(ctx, box.x - modelRectW / 2, box.y - modelRectH / 2, modelRectW, modelRectH, 10, statusColor);
          const label = totalBoxes > 1 ? `${model.displayName} #${box.replicaIdx + 1}` : model.displayName;
          drawText(ctx, label, box.x, box.y - 8, '#fff', 13, 'bold');
          const boxRect = { x: box.x - modelRectW / 2, y: box.y - modelRectH / 2, w: modelRectW, h: modelRectH };
          regions.push({ topic: external ? 'external' : 'replica', modelIdx: box.modelIdx, replicaIdx: box.replicaIdx, rect: boxRect });
          if (!external) {
            // Say what is serving here. Running, queued and the hit rate have bars of
            // their own below; the KV cache, one of the two scale-up triggers, does not.
            const detail = stat ? `vLLM · KV cache ${stat.kvCachePercent}%` : 'vLLM · awaiting metrics';
            drawText(ctx, detail, box.x, box.y + 12, 'rgba(255,255,255,0.8)', 10);
          } else {
            const provider = providerOf(model.name);
            if (provider) drawProviderLogo(ctx, provider, box.x - modelRectW / 2 + 22, box.y, 22);
            drawText(ctx, providerLabel(provider), box.x, box.y + 12, 'rgba(255,255,255,0.8)', 11);
          }

          // Below the box: how much work this replica is holding, and how warm its
          // prefix cache is. Together these are what separates a replica that has just
          // been scaled up from the one it joined — same colour, very different bars.
          if (model.type === 'internal' && stat) {
            const key = `${model.name}#${box.replicaIdx}`;
            const eased = barsRef.current.get(key) ?? { running: 0, queued: 0, cache: 0 };
            eased.running = approach(eased.running, stat.runningRequests);
            eased.queued = approach(eased.queued, stat.queuedRequests);
            eased.cache = approach(eased.cache, stat.cacheHitPercent ?? 0);
            barsRef.current.set(key, eased);

            // Each bar carries a one-line caption: an audience cannot be expected to know
            // what two unlabelled strips under a box mean. The captions print the exact
            // readings; only the bars themselves are eased.
            const barX = box.x - modelRectW / 2;
            const barY = box.y + modelRectH / 2 + 6;
            drawLoadBar(ctx, barX, barY, modelRectW, eased.running, eased.queued, statusColor);
            const queued = stat.queuedRequests;
            drawCaption(ctx, barX, barY + 14, modelRectW, `In flight (of ${LOAD_BAR_SCALE})`,
              queued > 0 ? `${stat.runningRequests} + ${queued} queued` : `${stat.runningRequests} running`,
              queued > 0 ? QUEUE_COLOR : CAPTION_COLOR);
            regions.push({ topic: 'inflight', modelIdx: box.modelIdx, replicaIdx: box.replicaIdx, rect: { x: barX, y: barY - 2, w: modelRectW, h: 21 } });
            const cacheY = barY + 22;
            drawCacheBar(ctx, barX, cacheY, modelRectW, eased.cache, stat.cacheHitPercent === null);
            // "off" when this vLLM does not prefix-cache at all (Nemotron, a hybrid Mamba
            // model), which is different from "idle": no recent traffic to measure.
            drawCaption(ctx, barX, cacheY + 11, modelRectW, 'Cache hit rate',
              stat.prefixCaching === false ? 'off'
                : stat.cacheHitPercent === null ? 'idle' : `${stat.cacheHitPercent}%`,
              CAPTION_COLOR);
            regions.push({ topic: 'cache', modelIdx: box.modelIdx, replicaIdx: box.replicaIdx, rect: { x: barX, y: cacheY - 3, w: modelRectW, h: 20 } });
          }
        }
      }

      regionsRef.current = regions;
      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [getLayout]);

  const regionAt = (e: React.MouseEvent<HTMLCanvasElement>): HelpTarget | undefined => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return regionsRef.current.find(g => x >= g.rect.x && x <= g.rect.x + g.rect.w && y >= g.rect.y && y <= g.rect.y + g.rect.h);
  };
  const canvas = canvasRef.current;
  const helpModel = help && help.modelIdx >= 0 ? models[help.modelIdx] : undefined;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        // Explanations only on click, so the view stays clean for people who know it.
        onClick={e => {
          const g = regionAt(e);
          setHelp(prev => (g && !(prev && prev.topic === g.topic && prev.modelIdx === g.modelIdx && prev.replicaIdx === g.replicaIdx) ? g : null));
        }}
        onMouseMove={e => { e.currentTarget.style.cursor = regionAt(e) ? 'pointer' : 'default'; }}
      />
      {help && (
        <HelpPopover
          target={help}
          model={helpModel}
          stat={helpModel?.replicaStats[help.replicaIdx]}
          stats={stats}
          containerW={canvas?.clientWidth ?? 800}
          containerH={canvas?.clientHeight ?? 600}
          onClose={() => setHelp(null)}
        />
      )}
    </div>
  );
}

function getModelShortName(key: string, models: ModelState[]): string {
  const model = models.find(m => m.name.endsWith(key) || m.name === key);
  if (model) return model.displayName.split(' ')[0]!.slice(0, 10);
  return key.split('-')[0]!.slice(0, 10);
}

function drawParticle(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, color: string): void {
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;
}

/**
 * A request the gateway turned away, on its way back to the user. Ringed in white and
 * crossed, so it cannot be mistaken for a user whose own colour happens to be red.
 */
function drawBounced(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = BLOCKED_COLOR;
  ctx.shadowColor = BLOCKED_COLOR;
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pos.x - 3, pos.y - 3); ctx.lineTo(pos.x + 3, pos.y + 3);
  ctx.moveTo(pos.x + 3, pos.y - 3); ctx.lineTo(pos.x - 3, pos.y + 3);
  ctx.stroke();
  ctx.restore();
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * The gateway as the policy pipeline it is. Each stage's row lights up for a moment when
 * it acts: red when it refused a request, green when requests went through it. The
 * count on the right is how often it has done so since the page loaded.
 */
function drawGateway(
  ctx: CanvasRenderingContext2D,
  card: Rect, stageH: number,
  stats: Stats, flash: Record<GatewayStage, number>,
  now: number,
  regions: HelpTarget[],
): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(card.x, card.y, card.w, card.h, 12);
  ctx.fillStyle = '#0f172a';
  ctx.shadowColor = 'rgba(255, 152, 0, 0.28)';
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = GATEWAY_COLOR;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  drawHexagon(ctx, card.x + 20, card.y + GATEWAY_HEADER_H / 2, 9, GATEWAY_COLOR);
  ctx.font = 'bold 14px -apple-system, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('MaaS Gateway', card.x + 36, card.y + GATEWAY_HEADER_H / 2 + 1);
  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.fillText('click a step', card.x + card.w - 12, card.y + GATEWAY_HEADER_H / 2 + 1);
  ctx.beginPath();
  ctx.moveTo(card.x + 10, card.y + GATEWAY_HEADER_H);
  ctx.lineTo(card.x + card.w - 10, card.y + GATEWAY_HEADER_H);
  ctx.strokeStyle = 'rgba(255, 152, 0, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const counts: Record<GatewayStage, { value: number; label: string }> = {
    auth: { value: stats.authRejected, label: 'rejected' },
    access: { value: stats.accessDenied, label: 'denied' },
    limit: { value: stats.rateLimitedRequests, label: 'limited' },
    route: { value: stats.routedRequests, label: 'routed' },
    meter: { value: stats.totalTokens, label: 'tokens' },
  };

  STAGES.forEach((stage, i) => {
    const top = card.y + GATEWAY_HEADER_H + 3 + stageH * i;
    const cy = top + stageH / 2;
    const duration = stage.refuses ? 900 : 450;
    const since = now - flash[stage.key];
    const glow = flash[stage.key] > 0 && since >= 0 && since < duration ? 1 - since / duration : 0;
    const accent = stage.refuses ? BLOCKED_COLOR : '#4caf50';
    regions.push({ topic: `gw-${stage.key}`, modelIdx: -1, replicaIdx: 0, rect: { x: card.x + 5, y: top + 2, w: card.w - 10, h: stageH - 4 } });

    if (glow > 0) {
      ctx.beginPath();
      ctx.roundRect(card.x + 5, top + 2, card.w - 10, stageH - 4, 8);
      ctx.fillStyle = stage.refuses ? `rgba(239, 68, 68, ${0.38 * glow})` : `rgba(76, 175, 80, ${0.22 * glow})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(card.x + 20, cy, 9, 0, Math.PI * 2);
    ctx.fillStyle = glow > 0.05 ? accent : '#334155';
    ctx.fill();
    drawText(ctx, `${i + 1}`, card.x + 20, cy + 0.5, '#fff', 10, 'bold');

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(stage.title, card.x + 36, cy - 7);
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(stage.detail, card.x + 36, cy + 8);

    const { value, label } = counts[stage.key];
    ctx.textAlign = 'right';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.fillStyle = stage.refuses && value > 0 ? '#f87171' : value > 0 ? '#cbd5e1' : '#475569';
    ctx.fillText(formatCount(value), card.x + card.w - 12, cy - 7);
    ctx.font = '9px -apple-system, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText(label, card.x + card.w - 12, cy + 8);
  });
}

/** "800k/1m" → { limit: "800k", window: "1m" }; anything else is shown as it is. */
function splitLimit(text: string): { limit: string; window: string | null } {
  const m = /^(.+)\/(\d+[smhd])$/.exec(text);
  return m ? { limit: m[1]!, window: m[2]! } : { limit: text, window: null };
}

/**
 * A subscription tier: its per-user limits once, then its users, each with the models it
 * is currently paused on. Red is MaaS refusing (the tier's token limit), amber is the
 * provider behind an external model refusing (Google's quota), which MaaS cannot help.
 */
function drawBand(ctx: CanvasRenderingContext2D, band: Band, users: UserState[], models: ModelState[]): void {
  const { pad: BAND_PAD, headerH: BAND_HEADER_H, limitRowH: LIMIT_ROW_H } = band;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(band.x, band.y, band.w, band.h, 10);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.06)';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // The tier's limits. Every member has the same ones; if they ever differ, say so
  // rather than show one member's numbers as everyone's.
  const cells = models.map(m => {
    const values = band.members
      .map(i => Object.entries(users[i]!.rateLimits).find(([k]) => m.name === k || m.name.endsWith(k))?.[1])
      .filter((v): v is string => v !== undefined);
    const distinct = [...new Set(values)];
    return { name: getModelShortName(m.name, models), text: distinct.length === 0 ? null : distinct.length === 1 ? distinct[0]! : 'varies' };
  });
  const parsed = cells.map(c => (c.text ? splitLimit(c.text) : null));
  const perMinute = parsed.every(p => p === null || p.window === '1m');

  const headerY = band.y + BAND_PAD + BAND_HEADER_H / 2 - 1;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(band.label, band.x + BAND_PAD, headerY);
  ctx.textAlign = 'right';
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(perMinute ? 'tokens/min per user' : 'tokens per user', band.x + band.w - BAND_PAD, headerY);

  const colW = (band.w - BAND_PAD * 2) / 2;
  const anyLimits = cells.some(c => c.text !== null);
  cells.forEach((c, k) => {
    const cx = band.x + BAND_PAD + (k % 2) * colW;
    const cy = band.limitsY + Math.floor(k / 2) * LIMIT_ROW_H + LIMIT_ROW_H / 2;
    ctx.textAlign = 'left';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(c.name, cx, cy);
    const p = parsed[k];
    const value = !anyLimits ? '…' : p === null ? '–' : perMinute ? p.limit : c.text!;
    ctx.textAlign = 'right';
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(value, cx + colW - 10, cy);
  });

  const r = Math.min(9, band.rowH * 0.3);
  const nameSize = band.rowH < 24 ? 11 : 12;
  band.members.forEach((i, n) => {
    const user = users[i]!;
    const y = band.firstRowY + band.rowH * n;
    const paused = Object.entries(user.rateLimitedModels);
    const byGateway = paused.filter(([, by]) => by === 'gateway').map(([m]) => m);
    const byProvider = paused.filter(([, by]) => by === 'provider').map(([m]) => m);
    const allBlocked = models.length > 0 && byGateway.length >= models.length;

    const dotX = band.x + BAND_PAD + r;
    drawCircle(ctx, dotX, y, r, allBlocked ? RATE_LIMITED_COLOR : USER_COLORS[i % USER_COLORS.length]!);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${nameSize}px -apple-system, sans-serif`;
    ctx.fillStyle = allBlocked ? '#94a3b8' : '#fff';
    const nameX = dotX + r + 8;
    ctx.fillText(user.displayName, nameX, y + 0.5);

    let x = nameX + ctx.measureText(user.displayName).width + 10;
    const right = band.x + band.w - BAND_PAD;
    if (byGateway.length > 0) {
      const names = allBlocked ? 'all models'
        : byGateway.length > 2 ? `${byGateway.length} models`
        : byGateway.map(m => getModelShortName(m, models)).join(', ');
      x = drawStatus(ctx, x, y, right, names, BLOCKED_COLOR, 'blocked');
    }
    for (const m of byProvider) {
      const p = providerOf(m);
      const who = p === 'gemini' ? 'Google' : p === 'openai' ? 'OpenAI' : 'provider';
      // The provider names the model well enough (Google = Gemini) and keeps it short.
      x = drawStatus(ctx, x, y, right, `${who} quota`, PROVIDER_LIMIT_COLOR, 'provider');
    }
  });
}

/**
 * A small status mark and text after a user's name: a no-entry sign for a MaaS block,
 * a warning triangle for a provider's. Shortened with an ellipsis to fit. Returns where
 * the next mark may start.
 */
function drawStatus(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, right: number,
  text: string, color: string, kind: 'blocked' | 'provider',
): number {
  if (x + 16 > right) return x;
  ctx.save();
  if (kind === 'blocked') {
    ctx.beginPath();
    ctx.arc(x + 5, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 2, y - 1, 6, 2);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + 5, y - 5);
    ctx.lineTo(x + 10, y + 4.5);
    ctx.lineTo(x, y + 4.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x + 4.4, y - 2, 1.3, 3.5);
    ctx.fillRect(x + 4.4, y + 2.4, 1.3, 1.2);
  }
  ctx.font = 'bold 10px -apple-system, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let label = text;
  const room = right - (x + 14);
  if (ctx.measureText(label).width > room) {
    while (label.length > 1 && ctx.measureText(label + '…').width > room) label = label.slice(0, -1);
    label += '…';
  }
  ctx.fillText(label, x + 14, y + 0.5);
  const end = x + 14 + ctx.measureText(label).width + 8;
  ctx.restore();
  return end;
}

/**
 * A small caption under a bar: what it measures on the left, the reading on the right,
 * and an (i) after the label, because clicking the bar explains it.
 */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number,
  label: string, value: string, valueColor: string,
): void {
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = CAPTION_COLOR;
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y);
  const ix = x + ctx.measureText(label).width + 8;
  ctx.beginPath();
  ctx.arc(ix, y, 4.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = 'bold 7px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('i', ix, y + 0.5);
  ctx.font = 'bold 9px -apple-system, sans-serif';
  ctx.fillStyle = valueColor;
  ctx.textAlign = 'right';
  ctx.fillText(value, x + w, y);
}

/** One easing step toward a target, snapping once the remaining gap is invisible. */
function approach(current: number, target: number): number {
  const next = current + (target - current) * BAR_EASING;
  return Math.abs(target - next) < 0.05 ? target : next;
}

function barTrack(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
  ctx.fill();
}

/**
 * Requests this replica is holding: the continuous batch it is serving, then the
 * backlog that could not get into it. The backlog is drawn in red regardless of the
 * status colour because a queue is the thing to watch, whatever the box says.
 */
function drawLoadBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number,
  running: number, queued: number,
  statusColor: string,
): void {
  const h = 7;
  barTrack(ctx, x, y, w, h);

  const runW = Math.min(running / LOAD_BAR_SCALE, 1) * w;
  const totalW = Math.min((running + queued) / LOAD_BAR_SCALE, 1) * w;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.clip();
  if (runW > 0) {
    ctx.fillStyle = statusColor;
    ctx.fillRect(x, y, runW, h);
  }
  if (totalW > runW) {
    ctx.fillStyle = QUEUE_COLOR;
    ctx.fillRect(x + runW, y, totalW - runW, h);
  }
  ctx.restore();
}

/**
 * Prefix cache hit rate. An empty track with no fill is a replica that has served
 * nothing recently and therefore has no hit rate — not one whose cache is cold.
 */
function drawCacheBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number,
  percent: number, unknown: boolean,
): void {
  const h = 4;
  barTrack(ctx, x, y, w, h);
  if (unknown) return;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.clip();
  ctx.fillStyle = CACHE_COLOR;
  ctx.fillRect(x, y, (Math.min(Math.max(percent, 0), 100) / 100) * w, h);
  ctx.restore();
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function drawCurve(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
  const cp1x = x1 + (x2 - x1) * 0.4;
  const cp2x = x1 + (x2 - x1) * 0.6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cp1x, y1, cp2x, y2, x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function getCurvePoint(x1: number, y1: number, x2: number, y2: number, t: number) {
  const cp1x = x1 + (x2 - x1) * 0.4;
  const cp2x = x1 + (x2 - x1) * 0.6;
  const u = 1 - t;
  return {
    x: u * u * u * x1 + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * x2,
    y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2,
  };
}

function drawCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, color: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, weight: string = 'normal') {
  ctx.font = `${weight} ${size}px -apple-system, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}
