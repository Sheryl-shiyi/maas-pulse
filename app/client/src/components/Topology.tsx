import { useRef, useEffect, useCallback, useState } from 'react';
import { HelpPopover, type HelpTarget } from './TopologyHelp';
import type { TraceView, TraceFocus } from './traceSteps';
import type { ModelState, UserState, ActiveRequest, Stats, GatewayStage, EppWeights } from '../types';
import { providerOf, providerLabel, drawProviderLogo } from './providerLogos';
import { userColors } from './colors';

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
/** Card background shared by the tier bands, the gateway and the model cards. */
const CARD_FILL = '#0f172a';
/** Connection lines: bright enough to read on a projector, still behind everything. */
const EDGE_COLOR = '#334155';

/**
 * All canvas text is drawn this much larger than the sizes written in this file, so the
 * small print (captions, limits, gateway details) stays legible on a projector.
 */
const TEXT_SCALE = 1.15;
function font(size: number, weight = '', family = '-apple-system, sans-serif'): string {
  return `${weight} ${Math.round(size * TEXT_SCALE * 2) / 2}px ${family}`.trim();
}
const GATEWAY_COLOR = '#ff9800';
/** llm-d's accent: a colour nothing else on the canvas uses. */
const LLMD_COLOR = '#e879f9';
/** MaaS refused the request: its own token limit, authentication or access. */
const BLOCKED_COLOR = '#ef4444';
/** The provider behind an external model refused it (its own rate limit), not MaaS. */
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
  /** llm-d's scorer weights from the chart, for its panel; null if not configured. */
  eppWeights: EppWeights | null;
  /** A request being replayed step by step; the rest of the view dims around it. */
  trace: TraceView | null;
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

const GATEWAY_HEADER_H = 36;
/** Space above the model column for the cluster boundary's label. */
const BOUNDARY_TOP = 30;
const BOUNDARY_PAD = 14;

/** Height a model box needs below it for the load and cache bars. */
const BARS_H = 50;
/** The model column's group frames: two-line header, then padding around the boxes. */
const MODEL_GROUP_HEAD = 30;
const MODEL_GROUP_PAD = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function Topology({ users, models, activeRequests, stats, gatewayFlash, eppWeights, trace }: TopologyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const propsRef = useRef({ users, models, activeRequests, stats, gatewayFlash, trace });
  propsRef.current = { users, models, activeRequests, stats, gatewayFlash, trace };
  /** The replay's dot, gliding from one step's position to the next. */
  const traceDotRef = useRef({ key: '', from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, start: 0 });
  /** Eased bar values per replica, keyed `<model>#<replicaIdx>`, so each one keeps its
   *  own animation across frames and across re-layouts. */
  const barsRef = useRef(new Map<string, { running: number; queued: number; cache: number }>());
  /** Clickable areas drawn in the last frame, in canvas (CSS) pixels. */
  const regionsRef = useRef<HelpTarget[]>([]);
  /** Which replica each in-flight request's dot is heading for, chosen once. */
  const routedRef = useRef(new Map<string, number>());
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
    const bandW = clamp(w * 0.22, 210, 260);
    // Internal models in the left column of each tier's limits, external ones in the
    // right, so the rows are as many as the longer of the two lists.
    const internalCount = models.filter(m => m.type === 'internal').length;
    const limitRows = Math.max(internalCount, models.length - internalCount, 1);
    const gaps = Math.max(tierOrder.length - 1, 0);
    const sizeFor = (pad: number, headerH: number, limitRowH: number, gap: number) => {
      const bandFixed = pad * 2 + headerH + limitRows * limitRowH + 4;
      return { pad, headerH, limitRowH, gap, bandFixed, fixed: tierOrder.length * bandFixed + gap * gaps };
    };
    // Compact spacing when the roomy one would leave users less than 22px each, as on a
    // laptop whose controls bar has wrapped onto a second line.
    const roomy = sizeFor(8, 18, 15, 10);
    const sz = h - 16 - roomy.fixed >= users.length * 24 ? roomy : sizeFor(5, 15, 13, 6);
    const BAND_PAD = sz.pad, BAND_HEADER_H = sz.headerH, LIMIT_ROW_H = sz.limitRowH, BAND_GAP = sz.gap;
    const bandFixed = sz.bandFixed;
    const fixed = sz.fixed;
    const rowH = users.length > 0 ? clamp((h - 16 - fixed) / users.length, 18, 40) : 24;
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
    const modelLeft = modelX - 105;
    // llm-d sits between the gateway and our own replicas, inside the cluster group, which
    // widens to the left to hold it. External models have no llm-d in front of them.
    const hasInternal = models.some(m => m.type === 'internal');
    const llmdW = 124;
    const llmdX = modelLeft - 34 - llmdW / 2;
    const clusterLeft = llmdX - llmdW / 2 - 12;
    const gatewayX = (bandX + bandW + (hasInternal ? clusterLeft : modelLeft)) / 2;
    const gatewayY = h * 0.5;
    const gwW = clamp(w * 0.23, 232, 262);
    const stageH = clamp((h * 0.55 - GATEWAY_HEADER_H) / STAGES.length, 36, 50);
    const gwH = GATEWAY_HEADER_H + stageH * STAGES.length + 6;
    const gateway: Rect = { x: gatewayX - gwW / 2, y: gatewayY - gwH / 2, w: gwW, h: gwH };

    return {
      modelX, gatewayY, gateway, stageH, bands, userPositions,
      llmd: hasInternal ? { x: llmdX, w: llmdW, h: 58 } : null,
      clusterLeft,
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
      const { users, models, activeRequests, stats, gatewayFlash, trace } = propsRef.current;
      const cssW = canvas!.width / devicePixelRatio;
      const cssH = canvas!.height / devicePixelRatio;
      const now = performance.now();

      // Compute model box positions (one box per replica)
      const modelRectW = 190;
      const modelRectH = 58;
      const boxes: { modelIdx: number; replicaIdx: number; provisioning: boolean; x: number; y: number }[] = [];
      for (let i = 0; i < models.length; i++) {
        const m = models[i]!;
        const total = Math.max(m.replicas, m.desiredReplicas);
        for (let r = 0; r < total; r++) {
          boxes.push({ modelIdx: i, replicaIdx: r, provisioning: r >= m.replicas, x: 0, y: 0 });
        }
      }

      // On a short canvas (a 720p projector, a wrapped controls bar) draw the whole view
      // smaller rather than let the user column or the model column run off the bottom:
      // lay it out on a virtual canvas tall enough for everything, then scale it down.
      // Text then shrinks towards its original size, never below it.
      const fit = Math.min(1, cssH / minHeightFor(users, models, boxes, modelRectH));
      const w = cssW / fit;
      const h = cssH / fit;
      const layout = getLayout(w, h);

      ctx.clearRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.scale(fit, fit);
      const regions: HelpTarget[] = [];
      // The model column in two groups, framed like the tier bands: replicas on our own
      // GPUs, then the external providers. That split is the point of MaaS, so it is
      // drawn rather than left to colour. Boxes are spread by the room each takes (an
      // internal box has its two bars underneath), so one never runs into the next.
      const boxH = (b: typeof boxes[number]) =>
        modelRectH + (models[b.modelIdx]!.type === 'internal' && !b.provisioning ? BARS_H : 0);
      const groups = [
        { label: 'SELF-HOSTED MODELS', note: 'AI Inference on OpenShift AI', external: false, members: boxes.filter(b => models[b.modelIdx]!.type === 'internal') },
        { label: 'CLOUD-HOSTED APIs', note: 'via the MaaS gateway', external: true, members: boxes.filter(b => models[b.modelIdx]!.type !== 'internal') },
      ].filter(g => g.members.length > 0);
      const contentH = boxes.reduce((a, b) => a + boxH(b), 0) + groups.length * (MODEL_GROUP_HEAD + 2 * MODEL_GROUP_PAD);
      const innerGaps = groups.reduce((a, g) => a + g.members.length - 1, 0);
      // Room at the top for the cluster boundary's label and margin.
      const spare = Math.max(0, h - contentH - BOUNDARY_TOP);
      const inner = innerGaps > 0 ? Math.min(28, (spare * 0.5) / innerGaps) : 0;
      const outer = (spare - inner * innerGaps) / (groups.length + 1);
      let cursor = BOUNDARY_TOP + outer;
      const frames: { x: number; y: number; w: number; h: number; label: string; note: string; external: boolean }[] = [];
      const frameX = layout.modelX - modelRectW / 2 - 10;
      const frameW = modelRectW + 20;
      for (const g of groups) {
        const top = cursor;
        cursor += MODEL_GROUP_HEAD + MODEL_GROUP_PAD;
        g.members.forEach((b, i) => {
          b.x = layout.modelX;
          b.y = cursor + modelRectH / 2;
          cursor += boxH(b) + (i < g.members.length - 1 ? inner : 0);
        });
        cursor += MODEL_GROUP_PAD;
        const left = !g.external && layout.llmd ? layout.clusterLeft : frameX;
        frames.push({ x: left, y: top, w: frameX + frameW - left, h: cursor - top, label: g.label, note: g.note, external: g.external });
        cursor += outer;
      }

      // The cluster boundary: around the gateway and our self-hosted models, with the
      // cloud-hosted APIs left outside. Prompts to our models never leave it; prompts to
      // an external API cross it, and a marker says so where they do.
      const selfFrame = frames.find(f => !f.external);
      const cloudFrame = frames.find(f => f.external);
      const boundary = clusterBoundary(layout.gateway, selfFrame, cloudFrame);
      drawBoundary(ctx, boundary);
      for (const f of frames) drawModelGroup(ctx, f.x, f.y, f.w, f.h, f.label, f.note, f.external);

      // llm-d: vertically centred on the replicas it chooses between.
      const internalBoxes = boxes.filter(b => models[b.modelIdx]!.type === 'internal');
      const llmd = layout.llmd && internalBoxes.length > 0 ? (() => {
        const cy = (internalBoxes[0]!.y + internalBoxes[internalBoxes.length - 1]!.y) / 2;
        return { x: layout.llmd.x - layout.llmd.w / 2, y: cy - layout.llmd.h / 2, w: layout.llmd.w, h: layout.llmd.h };
      })() : null;
      const llmdIn = llmd ? { x: llmd.x, y: llmd.y + llmd.h / 2 } : null;
      const llmdOut = llmd ? { x: llmd.x + llmd.w, y: llmd.y + llmd.h / 2 } : null;
      const isInternal = (modelIdx: number) => models[modelIdx]!.type === 'internal';
      // Lines end at a card's left edge, level with its centre, so a curve never crosses
      // the captions of the card above. A dot then slides on, hidden, to the card's centre.
      const doorOf = (b: { x: number; y: number }) => ({ x: b.x - modelRectW / 2, y: b.y });

      // Edges: every user into the gateway's left side, the gateway's right side out to
      // every model replica.
      for (const uPos of layout.userPositions) {
        drawCurve(ctx, uPos.anchorX, uPos.y, layout.entry.x, layout.entry.y, EDGE_COLOR);
      }
      if (llmdIn) drawCurve(ctx, layout.exit.x, layout.exit.y, llmdIn.x, llmdIn.y, EDGE_COLOR);
      for (const box of boxes) {
        const from = isInternal(box.modelIdx) && llmdOut ? llmdOut : layout.exit;
        const door = doorOf(box);
        drawCurve(ctx, from.x, from.y, door.x, door.y, box.provisioning ? '#1e293b' : EDGE_COLOR);
      }
      // Where the lines to the cloud-hosted APIs cross the boundary.
      const crossings = boxes.filter(b => !isInternal(b.modelIdx))
        .map(b => { const d = doorOf(b); return firstExit(boundary, layout.exit, d); })
        .filter((p): p is { x: number; y: number } => p !== null);
      // Lit while a request to an external model is on its way across.
      const leaving = activeRequests.some(r => {
        const mi = models.findIndex(m => m.name === r.model);
        return mi >= 0 && !isInternal(mi) && r.phase === 'to_model' && !r.rejectedAt && now - r.startTime < SEGMENT_MS * 0.9;
      });

      // Particles. A request the gateway turned away finishes its trip to the gateway,
      // then bounces back in red; it is drawn after the gateway so the bounce shows.
      const bounced: { x: number; y: number }[] = [];
      const colors = userColors(users);
      for (const req of activeRequests) {
        const elapsed = now - req.startTime;
        const userIdx = users.findIndex(u => u.name === req.user);
        const modelIdx = models.findIndex(m => m.name === req.model);
        if (userIdx < 0 || modelIdx < 0) continue;

        const u = layout.userPositions[userIdx]!;
        const uX = u.anchorX, uY = u.y;
        const color = colors[userIdx]!;

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
        // Send the dot where llm-d actually sends this model's traffic. The response does
        // not say which replica answered, so pick in proportion to the requests each
        // replica finished in the last minute. Dots used to be shared out evenly, which
        // showed a cold new replica taking half the load while it served almost none.
        let replica = routedRef.current.get(req.requestId);
        if (replica === undefined || !readyBoxes.some(b => b.replicaIdx === replica)) {
          const stats = models[modelIdx]!.replicaStats;
          replica = pickReplica(
            readyBoxes.map(b => b.replicaIdx),
            readyBoxes.map(b => stats[b.replicaIdx]?.requestsPerSecond ?? 0),
            simpleHash(req.requestId),
          );
          routedRef.current.set(req.requestId, replica);
        }
        const mPos = readyBoxes.find(b => b.replicaIdx === replica)!;
        // On the way back the dot leaves from the replica that really served it, which is
        // known only once the response names it.
        const backFrom = req.servedReplica !== undefined
          ? readyBoxes.find(b => b.replicaIdx === req.servedReplica) ?? mPos : mPos;

        let pos: { x: number; y: number } | null = null;
        if (req.phase === 'to_gateway') {
          pos = getCurvePoint(uX, uY, layout.entry.x, layout.entry.y, Math.min(elapsed / SEGMENT_MS, 1));
        } else if (req.phase === 'to_model') {
          const t = Math.min(elapsed / SEGMENT_MS, 1);
          const door = doorOf(mPos);
          // Internal requests pass through llm-d (the dot goes under its card), then on
          // to the replica it picked. External ones go straight to the provider.
          const via = llmdIn && llmdOut && isInternal(modelIdx);
          const split = via ? 0.45 : 0;
          if (via && t < split) {
            pos = getCurvePoint(layout.exit.x, layout.exit.y, llmdIn!.x, llmdIn!.y, t / split);
          } else if (t < 0.85) {
            const from = via ? llmdOut! : layout.exit;
            pos = getCurvePoint(from.x, from.y, door.x, door.y, (t - split) / (0.85 - split));
          } else {
            pos = lerp(door, mPos, (t - 0.85) / 0.15);
          }
        } else if (req.phase === 'returning') {
          const t = Math.min(elapsed / (SEGMENT_MS * 2), 1);
          const door = doorOf(backFrom);
          const via = llmdIn && llmdOut && isInternal(modelIdx);
          if (t >= 0.5) {
            pos = getCurvePoint(layout.entry.x, layout.entry.y, uX, uY, (t - 0.5) * 2);
          } else if (t < 0.06) {
            pos = lerp(backFrom, door, t / 0.06);
          } else if (via && t < 0.3) {
            pos = getCurvePoint(door.x, door.y, llmdOut!.x, llmdOut!.y, (t - 0.06) / 0.24);
          } else if (via) {
            pos = getCurvePoint(llmdIn!.x, llmdIn!.y, layout.exit.x, layout.exit.y, (t - 0.3) / 0.2);
          } else {
            pos = getCurvePoint(door.x, door.y, layout.exit.x, layout.exit.y, (t - 0.06) / 0.44);
          }
        }
        if (pos) {
          drawParticle(ctx, pos, color);
          // An answer mostly served from the prefix cache comes back ringed in cache blue.
          if (req.phase === 'returning' && (req.cachedFraction ?? 0) >= 0.5) drawCacheRing(ctx, pos);
        }
      }

      if (routedRef.current.size > 300) {
        const live = new Set(activeRequests.map(r => r.requestId));
        for (const id of routedRef.current.keys()) if (!live.has(id)) routedRef.current.delete(id);
      }

      drawLeavesMarker(ctx, crossings, leaving);
      drawGateway(ctx, layout.gateway, layout.stageH, stats, gatewayFlash, now, regions);
      if (llmd) {
        // Glows briefly each time the gateway routes a request onward.
        drawLlmd(ctx, llmd, now - gatewayFlash.route < 260 && gatewayFlash.route > 0);
        regions.push({ topic: 'llmd', modelIdx: -1, replicaIdx: 0, rect: llmd });
      }
      for (const p of bounced) drawBounced(ctx, p);

      for (const band of layout.bands) drawBand(ctx, band, users, models, colors);

      // Draw model boxes (one per replica). A trace draws some of them again over the
      // dimmed view; `again` then skips the easing step and the click regions.
      const drawBox = (box: typeof boxes[number], again = false) => {
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
          drawText(ctx, `starting on a new GPU${clock}`, box.x, box.y + 12, 'rgba(245, 158, 11, 0.85)', 10);
        } else {
          // A replica that is Ready but has not been scraped yet has no figures of its
          // own. It must not borrow the model-level summary: with only one replica
          // reporting, that summary equals the other replica's numbers, so a brand new
          // pod appeared as an exact clone of the busy one it had just joined.
          const stat = model.replicaStats[box.replicaIdx];
          const external = model.type !== 'internal';
          const statusColor = external ? EXTERNAL_COLOR : stat ? (STATUS_COLORS[stat.status] || '#4caf50') : '#475569';
          // A dark card like every other node, its state in the border and a small label.
          // A solid green box was the loudest thing on screen while saying the least:
          // healthy is the state that needs no attention. Busy and overloaded also glow.
          drawCard(ctx, box.x - modelRectW / 2, box.y - modelRectH / 2, modelRectW, modelRectH,
            statusColor, !external && !!stat && stat.status !== 'healthy');
          if (!external) {
            drawStatusPill(ctx, box.x + modelRectW / 2, box.y - modelRectH / 2, stat ? stat.status : 'no data', statusColor);
          }
          const label = totalBoxes > 1 ? `${model.displayName} #${box.replicaIdx + 1}` : model.displayName;
          drawText(ctx, label, box.x, box.y - 8, '#f1f5f9', 13, 'bold');
          const boxRect = { x: box.x - modelRectW / 2, y: box.y - modelRectH / 2, w: modelRectW, h: modelRectH };
          if (!again) regions.push({ topic: external ? 'external' : 'replica', modelIdx: box.modelIdx, replicaIdx: box.replicaIdx, rect: boxRect });
          if (!external) {
            // Say what is serving here. Running, queued and the hit rate have bars of
            // their own below; the KV cache, one of the two scale-up triggers, does not.
            const detail = stat ? `vLLM · KV cache ${stat.kvCachePercent}%` : 'vLLM · awaiting metrics';
            drawText(ctx, detail, box.x, box.y + 12, '#94a3b8', 10);
          } else {
            const provider = providerOf(model.name);
            if (provider) drawProviderLogo(ctx, provider, box.x - modelRectW / 2 + 22, box.y, 22, '#c7d2fe');
            drawText(ctx, providerLabel(provider), box.x, box.y + 12, '#a5b4fc', 11);
          }

          // Below the box: how much work this replica is holding, and how warm its
          // prefix cache is. Together these are what separates a replica that has just
          // been scaled up from the one it joined — same colour, very different bars.
          if (model.type === 'internal' && stat) {
            const key = `${model.name}#${box.replicaIdx}`;
            const eased = barsRef.current.get(key) ?? { running: 0, queued: 0, cache: 0 };
            if (!again) {
              eased.running = approach(eased.running, stat.runningRequests);
              eased.queued = approach(eased.queued, stat.queuedRequests);
              eased.cache = approach(eased.cache, stat.cacheHitPercent ?? 0);
              barsRef.current.set(key, eased);
            }

            // Each bar carries a one-line caption: an audience cannot be expected to know
            // what two unlabelled strips under a box mean. The captions print the exact
            // readings; only the bars themselves are eased.
            const barX = box.x - modelRectW / 2;
            const barY = box.y + modelRectH / 2 + 6;
            drawLoadBar(ctx, barX, barY, modelRectW, eased.running, eased.queued, statusColor);
            const queued = stat.queuedRequests;
            drawCaption(ctx, barX, barY + 16, modelRectW, `In flight (of ${LOAD_BAR_SCALE})`,
              queued > 0 ? `${stat.runningRequests} + ${queued} queued` : `${stat.runningRequests} running`,
              queued > 0 ? QUEUE_COLOR : CAPTION_COLOR);
            if (!again) regions.push({ topic: 'inflight', modelIdx: box.modelIdx, replicaIdx: box.replicaIdx, rect: { x: barX, y: barY - 2, w: modelRectW, h: 24 } });
            const cacheY = barY + 25;
            drawCacheBar(ctx, barX, cacheY, modelRectW, eased.cache, stat.cacheHitPercent === null);
            // "off" when this vLLM does not prefix-cache at all (Nemotron, a hybrid Mamba
            // model), which is different from "idle": no recent traffic to measure.
            drawCaption(ctx, barX, cacheY + 13, modelRectW, 'Cache hit rate',
              stat.prefixCaching === false ? 'off'
                : stat.cacheHitPercent === null ? 'idle' : `${stat.cacheHitPercent}%`,
              CAPTION_COLOR);
            if (!again) regions.push({ topic: 'cache', modelIdx: box.modelIdx, replicaIdx: box.replicaIdx, rect: { x: barX, y: cacheY - 3, w: modelRectW, h: 23 } });
          }
        }
      };
      for (const box of boxes) drawBox(box);

      // "Trace a request": dim everything, then light this request's path and the part
      // of the stack the replay is at, with a dot gliding from step to step.
      if (trace) {
        const userIdx = users.findIndex(u => u.name === trace.user);
        const modelIdx = models.findIndex(m => m.name === trace.model);
        if (userIdx >= 0 && modelIdx >= 0) {
          const internal = isInternal(modelIdx);
          const u = layout.userPositions[userIdx]!;
          const userPt = { x: u.anchorX, y: u.y };
          const modelBoxes = boxes.filter(b => b.modelIdx === modelIdx && !b.provisioning);
          const chosen = trace.replicaIdx !== null
            ? modelBoxes.find(b => b.replicaIdx === trace.replicaIdx)
            : modelBoxes.length === 1 ? modelBoxes[0] : undefined;
          const target = internal ? chosen : modelBoxes[0];
          const reached = new Set(trace.reached);
          const stageIdx: Partial<Record<TraceFocus, number>> = { 'gw-auth': 0, 'gw-access': 1, 'gw-limit': 2, 'gw-route': 3, 'gw-meter': 4 };
          const stageRow = (i: number) => {
            const top = layout.gateway.y + GATEWAY_HEADER_H + 3 + layout.stageH * i;
            return { x: layout.gateway.x + 5, y: top + 2, w: layout.gateway.w - 10, h: layout.stageH - 4 };
          };
          const pointFor = (f: TraceFocus) => {
            if (f === 'user' || f === 'answer') return userPt;
            // The dot waits at the door of each part, never on top of its text.
            const si = stageIdx[f];
            if (si !== undefined) { const r = stageRow(si); return { x: layout.gateway.x, y: r.y + r.h / 2 }; }
            if (f === 'llmd' && llmdIn) return llmdIn;
            if ((f === 'replica' || f === 'external' || f === 'llmd') && target) return doorOf(target);
            return { x: layout.gateway.x + layout.gateway.w / 2, y: layout.gatewayY };
          };

          ctx.fillStyle = 'rgba(3, 6, 12, 0.74)';
          ctx.fillRect(0, 0, w, h);

          if (trace.reached.some(f => f !== 'user')) drawCurve(ctx, userPt.x, userPt.y, layout.entry.x, layout.entry.y, TRACE_COLOR, 3);
          if (internal && llmdIn && llmdOut && reached.has('llmd')) {
            drawCurve(ctx, layout.exit.x, layout.exit.y, llmdIn.x, llmdIn.y, TRACE_COLOR, 3);
            if (chosen) { const d = doorOf(chosen); drawCurve(ctx, llmdOut.x, llmdOut.y, d.x, d.y, TRACE_COLOR, 3); }
          }
          if (!internal && target && reached.has('external')) {
            const d = doorOf(target);
            drawCurve(ctx, layout.exit.x, layout.exit.y, d.x, d.y, TRACE_COLOR, 3);
            const cross = firstExit(boundary, layout.exit, d);
            if (cross) drawLeavesMarker(ctx, [cross], true);
          }

          drawGateway(ctx, layout.gateway, layout.stageH, stats, gatewayFlash, now, []);
          const si = stageIdx[trace.focus];
          if (si !== undefined) drawRing(ctx, stageRow(si), trace.tone ? toneColor(trace.tone) : TRACE_COLOR, 8);
          // llm-d lights up only once the request has reached it: one refused at the gateway
          // never gets there.
          if (internal && llmd && reached.has('llmd')) {
            drawLlmd(ctx, llmd, trace.focus === 'llmd');
            if (trace.focus === 'llmd') drawRing(ctx, llmd, TRACE_COLOR, 12);
          }
          if (internal && reached.has('llmd')) for (const b of modelBoxes) drawBox(b, true);
          if (!internal && target && reached.has('external')) drawBox(target, true);
          if (target && (trace.focus === 'replica' || trace.focus === 'external' || (trace.focus === 'llmd' && chosen))) {
            drawRing(ctx, { x: target.x - modelRectW / 2 - 5, y: target.y - modelRectH / 2 - 5, w: modelRectW + 10, h: modelRectH + 10 },
              trace.tone ? toneColor(trace.tone) : TRACE_COLOR, 13);
          }
          const band = layout.bands.find(b => b.members.includes(userIdx));
          if (band) {
            const n = band.members.indexOf(userIdx);
            const y = band.firstRowY + band.rowH * n;
            const r = Math.min(9, band.rowH * 0.3);
            drawCircle(ctx, band.x + band.pad + r, y, r, colors[userIdx]!);
            ctx.font = font(12, 'bold');
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(users[userIdx]!.displayName, band.x + band.pad + r * 2 + 8, y + 0.5);
            if (trace.focus === 'user' || trace.focus === 'answer') {
              drawRing(ctx, { x: band.x + 3, y: y - band.rowH / 2, w: band.w - 6, h: band.rowH }, TRACE_COLOR, 8);
            }
          }

          const dot = traceDotRef.current;
          const key = `${trace.user}|${trace.model}|${trace.reached.length}|${trace.focus}`;
          const to = pointFor(trace.focus);
          if (dot.key !== key) {
            const fresh = dot.key === '' || !dot.key.startsWith(`${trace.user}|${trace.model}|`);
            dot.from = fresh ? to : currentTracePoint(dot, now);
            dot.to = to;
            dot.start = now;
            dot.key = key;
          }
          dot.to = to;
          drawTraceDot(ctx, currentTracePoint(dot, now), trace.tone ? toneColor(trace.tone) : colors[userIdx]!);
        }
      } else {
        traceDotRef.current.key = '';
      }

      ctx.restore();
      // Clickable areas in real canvas pixels, for hit testing and placing popovers.
      regionsRef.current = regions.map(g => ({
        ...g, rect: { x: g.rect.x * fit, y: g.rect.y * fit, w: g.rect.w * fit, h: g.rect.h * fit },
      }));
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
          if (propsRef.current.trace) return;
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
          models={models}
          eppWeights={eppWeights}
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

/**
 * The least height the view needs at full size: the taller of the user column in its
 * compact spacing, the model column with minimal gaps, and the gateway card. Below
 * this, the view is drawn scaled down to fit.
 */
function minHeightFor(
  users: UserState[], models: ModelState[],
  boxes: { modelIdx: number; provisioning: boolean }[], modelRectH: number,
): number {
  const tiers = new Set(users.map(u => u.tier || '')).size;
  const internal = models.filter(m => m.type === 'internal').length;
  const limitRows = Math.max(internal, models.length - internal, 1);
  const left = tiers * (5 * 2 + 15 + limitRows * 13 + 4) + 6 * Math.max(tiers - 1, 0) + users.length * 18 + 16;
  const groupsUsed = new Set(boxes.map(b => models[b.modelIdx]!.type === 'internal')).size;
  const right = boxes.reduce((a, b) => a + modelRectH + (models[b.modelIdx]!.type === 'internal' && !b.provisioning ? BARS_H : 0), 0)
    + groupsUsed * (MODEL_GROUP_HEAD + 2 * MODEL_GROUP_PAD) + 8 * Math.max(boxes.length - groupsUsed, 0) + 10 * (groupsUsed + 1) + BOUNDARY_TOP;
  const gateway = GATEWAY_HEADER_H + 36 * STAGES.length + 6 + 20;
  return Math.max(left, right, gateway);
}

/** The replay's light: the path walked so far and the step in focus. */
const TRACE_COLOR = '#fbbf24';

function toneColor(tone: 'blocked' | 'provider'): string {
  return tone === 'blocked' ? BLOCKED_COLOR : PROVIDER_LIMIT_COLOR;
}

function drawRing(ctx: CanvasRenderingContext2D, r: Rect, color: string, radius: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.restore();
}

/** Where the replay's dot is now: eased from the last step's point to this one's. */
function currentTracePoint(dot: { from: { x: number; y: number }; to: { x: number; y: number }; start: number }, now: number) {
  const t = Math.min(1, (now - dot.start) / 700);
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return { x: dot.from.x + (dot.to.x - dot.from.x) * e, y: dot.from.y + (dot.to.y - dot.from.y) * e };
}

function drawTraceDot(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 20;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/** llm-d's card: the inference scheduler between the gateway and our replicas. */
function drawLlmd(ctx: CanvasRenderingContext2D, r: Rect, active: boolean): void {
  drawCard(ctx, r.x, r.y, r.w, r.h, LLMD_COLOR, active);
  drawText(ctx, 'llm-d', r.x + r.w / 2, r.y + r.h / 2 - 8, '#f1f5f9', 14, 'bold');
  drawText(ctx, 'inference scheduler', r.x + r.w / 2, r.y + r.h / 2 + 11, '#f0abfc', 9);
}

type Pt = { x: number; y: number };

/**
 * The cluster boundary as a polygon: a rectangle around the gateway and the self-hosted
 * group, with a notch cut out where the cloud-hosted group sits below and to the right,
 * so that group stays outside.
 */
function clusterBoundary(g: Rect, self: Rect | undefined, cloud: Rect | undefined): Pt[] {
  const P = BOUNDARY_PAD;
  const top = Math.min(g.y, self ? self.y : g.y) - P - (self ? 0 : 26);
  const left = g.x - P;
  const right = self ? self.x + self.w + P : g.x + g.w + P;
  const selfBottom = self ? self.y + self.h + P : g.y + g.h + P;
  const gwBottom = g.y + g.h + P;
  const labelTop = Math.min(top, g.y - 44);
  if (cloud && gwBottom > cloud.y - P / 2 && cloud.x - P / 2 > g.x + g.w + P) {
    const notchX = cloud.x - P * 0.75;
    const notchY = Math.min(selfBottom, cloud.y - P * 0.75);
    return [
      { x: left, y: labelTop }, { x: right, y: labelTop }, { x: right, y: notchY },
      { x: notchX, y: notchY }, { x: notchX, y: gwBottom }, { x: left, y: gwBottom },
    ];
  }
  return [
    { x: left, y: labelTop }, { x: right, y: labelTop },
    { x: right, y: Math.max(selfBottom, gwBottom) }, { x: left, y: Math.max(selfBottom, gwBottom) },
  ];
}

function drawBoundary(ctx: CanvasRenderingContext2D, poly: Pt[]): void {
  if (poly.length < 3) return;
  ctx.save();
  ctx.beginPath();
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.025)';
  ctx.fill();
  ctx.setLineDash([8, 6]);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
  const corner = poly[0]!;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font(10, 'bold', 'system-ui, sans-serif');
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText('YOUR OPENSHIFT CLUSTER', corner.x + 12, corner.y + 13);
  ctx.font = font(9, '', 'system-ui, sans-serif');
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('prompts and data stay inside', corner.x + 12, corner.y + 27);
  ctx.restore();
}

function insidePolygon(poly: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Where the curve from `from` to `to` (drawn by drawCurve) first leaves the polygon. */
function firstExit(poly: Pt[], from: Pt, to: Pt): Pt | null {
  if (poly.length < 3 || !insidePolygon(poly, from)) return null;
  for (let i = 1; i <= 80; i++) {
    const p = getCurvePoint(from.x, from.y, to.x, to.y, i / 80);
    if (!insidePolygon(poly, p)) return p;
  }
  return null;
}

/** "prompt leaves your network", where the lines to cloud-hosted APIs cross the boundary. */
function drawLeavesMarker(ctx: CanvasRenderingContext2D, points: Pt[], lit: boolean): void {
  if (points.length === 0) return;
  ctx.save();
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, lit ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = lit ? '#c7d2fe' : '#818cf8';
    if (lit) { ctx.shadowColor = '#818cf8'; ctx.shadowBlur = 14; }
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  const anchor = points.reduce((a, p) => (p.y < a.y ? p : a), points[0]!);
  const text = 'prompt leaves your network';
  ctx.font = font(9, 'bold');
  const tw = ctx.measureText(text).width;
  const w = tw + 16, h = 18;
  const x = anchor.x - w - 10, y = anchor.y - h - 6;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = CARD_FILL;
  if (lit) { ctx.shadowColor = '#818cf8'; ctx.shadowBlur = 16; }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = lit ? '#a5b4fc' : 'rgba(129, 140, 248, 0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = lit ? '#e0e7ff' : '#a5b4fc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

/** One of the model column's two groups, styled like the tier bands on the left. */
function drawModelGroup(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string, note: string, external: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.06)';
  ctx.strokeStyle = external ? 'rgba(129, 140, 248, 0.35)' : 'rgba(148, 163, 184, 0.22)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font(10, 'bold', 'system-ui, sans-serif');
  ctx.fillStyle = external ? '#a5b4fc' : '#94a3b8';
  ctx.fillText(label, x + 9, y + 11);
  ctx.font = font(9, '', 'system-ui, sans-serif');
  ctx.fillStyle = '#64748b';
  ctx.fillText(note, x + 9, y + 23);
  ctx.restore();
}

/** A node card: dark fill, coloured border, and a glow when it needs attention. */
function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, border: string, glow: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fillStyle = CARD_FILL;
  if (glow) {
    ctx.shadowColor = border;
    ctx.shadowBlur = 18;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** A small label sitting on a card's top edge, at the right: healthy, busy, overloaded. */
function drawStatusPill(ctx: CanvasRenderingContext2D, cardRight: number, cardTop: number, text: string, color: string): void {
  ctx.save();
  ctx.font = font(9, 'bold');
  const w = ctx.measureText(text).width + 12;
  const h = 15;
  const x = cardRight - w - 10;
  const y = cardTop - h / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = CARD_FILL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

/** The light-blue ring on a returning dot whose prompt came mostly from the prefix cache. */
function drawCacheRing(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 10.5, 0, Math.PI * 2);
  ctx.strokeStyle = CACHE_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
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
  ctx.font = font(14, 'bold');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('MaaS Gateway', card.x + 36, card.y + GATEWAY_HEADER_H / 2 + 1);
  ctx.font = font(9);
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
    ctx.font = font(12, 'bold');
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(stage.title, card.x + 36, cy - 7);
    ctx.font = font(10);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(stage.detail, card.x + 36, cy + 8);

    const { value, label } = counts[stage.key];
    ctx.textAlign = 'right';
    ctx.font = font(12, 'bold');
    ctx.fillStyle = stage.refuses && value > 0 ? '#f87171' : value > 0 ? '#cbd5e1' : '#475569';
    ctx.fillText(formatCount(value), card.x + card.w - 12, cy - 7);
    ctx.font = font(9);
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
 * provider behind an external model refusing (its own rate limit), which MaaS cannot help.
 */
function drawBand(ctx: CanvasRenderingContext2D, band: Band, users: UserState[], models: ModelState[], colors: string[]): void {
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
    return {
      name: getModelShortName(m.name, models),
      external: m.type !== 'internal',
      text: distinct.length === 0 ? null : distinct.length === 1 ? distinct[0]! : 'varies',
    };
  });
  // Our GPUs on the left, external providers on the right, each in model order.
  const slot: { col: number; row: number }[] = [];
  let nIn = 0, nOut = 0;
  for (const c of cells) slot.push(c.external ? { col: 1, row: nOut++ } : { col: 0, row: nIn++ });
  const parsed = cells.map(c => (c.text ? splitLimit(c.text) : null));
  const perMinute = parsed.every(p => p === null || p.window === '1m');

  const headerY = band.y + BAND_PAD + BAND_HEADER_H / 2 - 1;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = font(10, 'bold', 'system-ui, sans-serif');
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(band.label, band.x + BAND_PAD, headerY);
  ctx.textAlign = 'right';
  ctx.font = font(9, '', 'system-ui, sans-serif');
  ctx.fillStyle = '#64748b';
  ctx.fillText(perMinute ? 'tokens/min per user' : 'tokens per user', band.x + band.w - BAND_PAD, headerY);

  const colW = (band.w - BAND_PAD * 2) / 2;
  const anyLimits = cells.some(c => c.text !== null);
  cells.forEach((c, k) => {
    const cx = band.x + BAND_PAD + slot[k]!.col * colW;
    const cy = band.limitsY + slot[k]!.row * LIMIT_ROW_H + LIMIT_ROW_H / 2;
    ctx.textAlign = 'left';
    ctx.font = font(10);
    // External model names take a tint of the indigo their boxes are drawn in.
    ctx.fillStyle = c.external ? '#a5b4fc' : '#94a3b8';
    ctx.fillText(c.name, cx, cy);
    const p = parsed[k];
    const value = !anyLimits ? '…' : p === null ? '–' : perMinute ? p.limit : c.text!;
    ctx.textAlign = 'right';
    ctx.font = font(10, 'bold');
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
    drawCircle(ctx, dotX, y, r, allBlocked ? RATE_LIMITED_COLOR : colors[i]!);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(nameSize, 'bold');
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
      x = drawStatus(ctx, x, y, right, `${who} rate limit`, PROVIDER_LIMIT_COLOR, 'provider');
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
  ctx.font = font(10, 'bold');
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
  ctx.font = font(9);
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
  ctx.font = font(7, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText('i', ix, y + 0.5);
  ctx.font = font(9, 'bold');
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

/**
 * One of `ids`, chosen with probability proportional to `weights`, using `hash` as the
 * random draw so the same request always gets the same answer. Even shares when no
 * replica has served anything recently.
 */
function pickReplica(ids: number[], weights: number[], hash: number): number {
  const total = weights.reduce((a, w) => a + Math.max(w, 0), 0);
  if (total <= 0) return ids[hash % ids.length]!;
  let u = ((hash % 10007) / 10007) * total;
  for (let i = 0; i < ids.length; i++) {
    u -= Math.max(weights[i]!, 0);
    if (u < 0) return ids[i]!;
  }
  return ids[ids.length - 1]!;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function drawCurve(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 2) {
  const cp1x = x1 + (x2 - x1) * 0.4;
  const cp2x = x1 + (x2 - x1) * 0.6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cp1x, y1, cp2x, y2, x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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


function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, weight: string = 'normal') {
  ctx.font = font(size, weight === 'normal' ? '' : weight);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}
