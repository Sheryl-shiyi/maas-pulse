import { useRef, useEffect, useCallback } from 'react';
import type { ModelState, UserState, ActiveRequest } from '../types';

const USER_COLORS = ['#42a5f5', '#66bb6a', '#ffa726', '#ab47bc', '#ef5350', '#26c6da', '#ec407a', '#8d6e63'];
const STATUS_COLORS: Record<string, string> = { healthy: '#4caf50', busy: '#ff9800', overloaded: '#f44336' };
const RATE_LIMITED_COLOR = '#333333';

interface TopologyProps {
  users: UserState[];
  models: ModelState[];
  activeRequests: ActiveRequest[];
}

export function Topology({ users, models, activeRequests }: TopologyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const propsRef = useRef({ users, models, activeRequests });
  propsRef.current = { users, models, activeRequests };

  const getLayout = useCallback((w: number, h: number) => {
    const userX = w * 0.13;
    const gatewayX = w * 0.48;
    const modelX = w * 0.84;
    const gatewayY = h * 0.5;

    const userPositions = users.map((_, i) => ({
      x: userX,
      y: (h * (i + 1)) / (users.length + 1),
    }));

    const modelPositions = models.map((_, i) => ({
      x: modelX,
      y: (h * (i + 1)) / (models.length + 1),
    }));

    return { userX, gatewayX, gatewayY, modelX, userPositions, modelPositions };
  }, [users.length, models.length]);

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
      const { users, models, activeRequests } = propsRef.current;
      const w = canvas!.width / devicePixelRatio;
      const h = canvas!.height / devicePixelRatio;
      const layout = getLayout(w, h);

      ctx.clearRect(0, 0, w, h);

      // Draw edges (user → gateway)
      for (const uPos of layout.userPositions) {
        drawCurve(ctx, uPos.x, uPos.y, layout.gatewayX, layout.gatewayY, '#1e293b');
      }
      // Draw edges (gateway → model)
      for (const mPos of layout.modelPositions) {
        drawCurve(ctx, layout.gatewayX, layout.gatewayY, mPos.x, mPos.y, '#1e293b');
      }

      // Draw particles
      const now = performance.now();
      for (const req of activeRequests) {
        const elapsed = now - req.startTime;
        const userIdx = users.findIndex(u => u.name === req.user);
        const modelIdx = models.findIndex(m => m.name === req.model);
        if (userIdx < 0 || modelIdx < 0) continue;

        const uPos = layout.userPositions[userIdx]!;
        const mPos = layout.modelPositions[modelIdx]!;
        const color = USER_COLORS[userIdx % USER_COLORS.length]!;

        let pos: { x: number; y: number } | null = null;
        const segmentDuration = 800;

        if (req.phase === 'to_gateway') {
          const t = Math.min(elapsed / segmentDuration, 1);
          pos = getCurvePoint(uPos.x, uPos.y, layout.gatewayX, layout.gatewayY, t);
        } else if (req.phase === 'to_model') {
          const t = Math.min(elapsed / segmentDuration, 1);
          pos = getCurvePoint(layout.gatewayX, layout.gatewayY, mPos.x, mPos.y, t);
        } else if (req.phase === 'returning') {
          const t = Math.min(elapsed / (segmentDuration * 2), 1);
          if (t < 0.5) {
            pos = getCurvePoint(mPos.x, mPos.y, layout.gatewayX, layout.gatewayY, t * 2);
          } else {
            pos = getCurvePoint(layout.gatewayX, layout.gatewayY, uPos.x, uPos.y, (t - 0.5) * 2);
          }
        }

        if (pos) {
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // Draw gateway node
      drawHexagon(ctx, layout.gatewayX, layout.gatewayY, 42, '#ff9800');
      drawText(ctx, 'MaaS', layout.gatewayX, layout.gatewayY + 1, '#fff', 15, 'bold');
      drawText(ctx, 'Gateway', layout.gatewayX, layout.gatewayY + 58, '#94a3b8', 13);

      // Draw user nodes
      const userRadius = 34;
      for (let i = 0; i < users.length; i++) {
        const user = users[i]!;
        const pos = layout.userPositions[i]!;
        const color = user.rateLimited ? RATE_LIMITED_COLOR : USER_COLORS[i % USER_COLORS.length]!;
        drawCircle(ctx, pos.x, pos.y, userRadius, color);
        const fontSize = user.displayName.length > 8 ? 11 : 13;
        drawText(ctx, user.displayName, pos.x, pos.y + 1, '#fff', fontSize, 'bold');

        let labelY = pos.y + userRadius + 16;
        if (user.rateLimit) {
          drawText(ctx, user.rateLimit, pos.x, labelY, 'rgba(148,163,184,0.8)', 11);
          labelY += 16;
        }
        if (user.rateLimited) {
          drawText(ctx, 'BLOCKED', pos.x, labelY, '#f44336', 12, 'bold');
        }
      }

      // Draw model nodes
      const modelRectW = 150;
      const modelRectH = 56;
      for (let i = 0; i < models.length; i++) {
        const model = models[i]!;
        const pos = layout.modelPositions[i]!;
        const statusColor = STATUS_COLORS[model.status] || '#4caf50';
        drawRoundedRect(ctx, pos.x - modelRectW / 2, pos.y - modelRectH / 2, modelRectW, modelRectH, 10, statusColor);
        drawText(ctx, model.displayName, pos.x, pos.y - 8, '#fff', 13, 'bold');
        if (model.type === 'internal') {
          drawText(ctx, `Q:${model.queueDepth} KV:${model.kvCachePercent}%`, pos.x, pos.y + 12, 'rgba(255,255,255,0.7)', 11);
        } else {
          drawText(ctx, 'external', pos.x, pos.y + 12, 'rgba(255,255,255,0.7)', 11);
        }
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [getLayout]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
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
