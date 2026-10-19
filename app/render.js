// Stroke rendering shared by the live canvas, thumbnails and exports.
// A stroke is { t: 'pen' | 'marker', c: color, w: width (world units), p: [x, y, pressure, ...] }

export const FRAME_SIZES = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
};

export const PAPER = '#ffffff';
export const BOARD_PAPER = '#fbfaf6';

const widthAt = (s, pr) => (s.t === 'marker' ? s.w : s.w * (0.25 + 1.5 * pr));

export function drawStroke(ctx, s) {
  const p = s.p;
  const n = p.length / 3;
  if (!n) return;
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.t === 'marker') {
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (p[i * 3] + p[i * 3 + 3]) / 2;
      const my = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
      ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx, my);
    }
    if (n > 1) ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], widthAt(s, p[2]) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Pressure-varying pen: smoothed quadratic segments between midpoints.
  let sx = p[0];
  let sy = p[1];
  for (let i = 1; i < n; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const last = i === n - 1;
    const ex = last ? x : (x + p[i * 3 + 3]) / 2;
    const ey = last ? y : (y + p[i * 3 + 4]) / 2;
    ctx.lineWidth = widthAt(s, p[i * 3 + 2]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    if (last) ctx.lineTo(ex, ey);
    else ctx.quadraticCurveTo(x, y, ex, ey);
    ctx.stroke();
    sx = ex;
    sy = ey;
  }
}

export function strokeBounds(s) {
  if (s.b) return s.b;
  const p = s.p;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const pad = s.w * 1.8;
  // Non-enumerable so it is not saved to IndexedDB / JSON.
  Object.defineProperty(s, 'b', { value: [x0 - pad, y0 - pad, x1 + pad, y1 + pad], enumerable: false });
  return s.b;
}

export function drawStrokes(ctx, strokes, viewRect) {
  for (const s of strokes) {
    if (viewRect) {
      const b = strokeBounds(s);
      if (b[2] < viewRect[0] || b[0] > viewRect[2] || b[3] < viewRect[1] || b[1] > viewRect[3]) continue;
    }
    drawStroke(ctx, s);
  }
}

export function contentBounds(strokes) {
  if (!strokes.length) return null;
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) {
    const sb = strokeBounds(s);
    b = [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])];
  }
  return b;
}

// Does the eraser circle (x, y, r) touch the stroke?
export function hitStroke(s, x, y, r) {
  const b = strokeBounds(s);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const p = s.p;
  const rr = r + s.w / 2;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= rr;
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], bx = p[i], by = p[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= rr) return true;
  }
  return false;
}

// Render one frame into a new canvas at `scale` (1 = native 1920x1080 / 1080x1920).
export function renderFrame(frame, aspect, scale) {
  const { w, h } = FRAME_SIZES[aspect];
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  drawStrokes(ctx, frame.strokes);
  return c;
}
