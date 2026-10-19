// Exports: long strip PNG(s) and an "AI pack" ZIP with numbered frames + vision-sized contact sheets.
import { FRAME_SIZES, BOARD_PAPER, renderFrame, contentBounds, drawStrokes } from './render.js';
import { makeZip } from './zip.js';

// Conservative limits so mobile Chrome can allocate the canvas.
const MAX_SIDE = 16000;
const MAX_AREA = 90_000_000;
// Most vision models downscale beyond ~1568px long edge / ~1.15 MP, so sheets stay within that.
const AI_LONG_EDGE = 1568;
const AI_AREA = 1_150_000;

const pad2 = (n, total) => String(n).padStart(Math.max(2, String(total).length), '0');
const safeName = (s) => (s || 'untitled').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'untitled';

export const toBlob = (canvas) => new Promise((r) => canvas.toBlob(r, 'image/png'));

function label(ctx, text, x, y, size, color = '#111', align = 'left') {
  ctx.font = `700 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

// Draw a frame cell: number band on top, frame below, thin border.
function drawCell(ctx, frameCanvas, x, y, cw, ch, band, num, total) {
  ctx.fillStyle = '#1f2430';
  ctx.fillRect(x, y, cw, band);
  label(ctx, `${num} / ${total}`, x + band * 0.4, y + band / 2, Math.round(band * 0.6), '#fff');
  ctx.drawImage(frameCanvas, x, y + band, cw, ch);
  ctx.strokeStyle = '#1f2430';
  ctx.lineWidth = Math.max(2, band * 0.06);
  ctx.strokeRect(x, y, cw, ch + band);
}

function arrow(ctx, cx, cy, size, dir) {
  ctx.save();
  ctx.translate(cx, cy);
  if (dir === 'down') ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#e8505b';
  ctx.beginPath();
  ctx.moveTo(-size * 0.5, -size * 0.18);
  ctx.lineTo(size * 0.1, -size * 0.18);
  ctx.lineTo(size * 0.1, -size * 0.42);
  ctx.lineTo(size * 0.5, 0);
  ctx.lineTo(size * 0.1, size * 0.42);
  ctx.lineTo(size * 0.1, size * 0.18);
  ctx.lineTo(-size * 0.5, size * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Layout `count` cells of aspect fw:fh into the strip; returns canvas size + cell positions.
function stripLayout(count, fw, fh, band, gap, dir, cols) {
  const cellH = fh + band;
  const pos = [];
  let W, H;
  if (dir === 'horizontal') {
    for (let i = 0; i < count; i++) pos.push([gap + i * (fw + gap), gap]);
    W = gap + count * (fw + gap);
    H = cellH + gap * 2;
  } else if (dir === 'vertical') {
    for (let i = 0; i < count; i++) pos.push([gap, gap + i * (cellH + gap)]);
    W = fw + gap * 2;
    H = gap + count * (cellH + gap);
  } else {
    const rows = Math.ceil(count / cols);
    for (let i = 0; i < count; i++) pos.push([gap + (i % cols) * (fw + gap), gap + Math.floor(i / cols) * (cellH + gap)]);
    W = gap + cols * (fw + gap);
    H = gap + rows * (cellH + gap);
  }
  return { W, H, pos };
}

/**
 * Build strip images. If the whole strip doesn't fit a safe canvas at the requested
 * scale, it is split into consecutive parts (part 1 = frames 1..k, etc.).
 * Returns [{ name, blob, from, to }].
 */
export async function exportStrip(doc, { dir = 'auto', scale = 1, minScale = 0.5 } = {}) {
  const frames = doc.frames;
  const total = frames.length;
  const { w, h } = FRAME_SIZES[doc.aspect];
  if (dir === 'auto') dir = doc.aspect === '9:16' ? 'horizontal' : 'vertical';
  const cols = dir === 'grid' ? Math.ceil(Math.sqrt(total * (h / w))) || 1 : 0;

  const sizeFor = (count, s) => {
    const fw = Math.round(w * s), fh = Math.round(h * s);
    const band = Math.round(Math.max(fw, fh) * 0.045);
    const gap = Math.round(band * (dir === 'grid' ? 0.6 : 1.3));
    return { fw, fh, band, gap, ...stripLayout(count, fw, fh, band, gap, dir, Math.min(cols, count)) };
  };
  const fits = (L) => L.W <= MAX_SIDE && L.H <= MAX_SIDE && L.W * L.H <= MAX_AREA;

  // Shrink scale toward minScale first; split into parts only if still too big.
  let s = scale;
  while (!fits(sizeFor(total, s)) && s > minScale) s = Math.max(minScale, s * 0.85);
  let perPart = total;
  while (perPart > 1 && !fits(sizeFor(perPart, s))) perPart--;

  const parts = Math.ceil(total / perPart);
  perPart = Math.ceil(total / parts); // balance the parts (e.g. 15 + 15 instead of 26 + 4)
  const out = [];
  const base = safeName(doc.name);
  for (let part = 0; part < parts; part++) {
    const from = part * perPart;
    const to = Math.min(total, from + perPart);
    const L = sizeFor(to - from, s);
    const c = document.createElement('canvas');
    c.width = L.W;
    c.height = L.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eceef2';
    ctx.fillRect(0, 0, L.W, L.H);
    for (let i = from; i < to; i++) {
      const [x, y] = L.pos[i - from];
      drawCell(ctx, renderFrame(frames[i], doc.aspect, s), x, y, L.fw, L.fh, L.band, i + 1, total);
      if (i < to - 1 && dir !== 'grid') {
        if (dir === 'horizontal') arrow(ctx, x + L.fw + L.gap / 2, y + L.band + L.fh / 2, L.gap * 0.8, 'right');
        else arrow(ctx, x + L.fw / 2, y + L.fh + L.band + L.gap / 2, L.gap * 0.8, 'down');
      }
    }
    const suffix = parts > 1 ? `_part${part + 1}of${parts}_frames${pad2(from + 1, total)}-${pad2(to, total)}` : '';
    out.push({ name: `${base}_strip${suffix}.png`, blob: await toBlob(c), from: from + 1, to });
  }
  return out;
}

// Pick a grid (cols x rows) for k cells that gives the biggest cells within the AI budget.
function sheetGrid(k, fw, fh) {
  let best = null;
  for (let cols = 1; cols <= k; cols++) {
    const rows = Math.ceil(k / cols);
    // cell width cw, height = cw*fh/fw + band, band = 0.08*cw-ish; header ~ 0.05*W
    const aspectH = fh / fw + 0.09;
    const unitW = cols * 1.04;
    const unitH = rows * (aspectH + 0.04) + 0.12;
    let cw = AI_LONG_EDGE / Math.max(unitW, unitH);
    const area = unitW * unitH * cw * cw;
    if (area > AI_AREA) cw *= Math.sqrt(AI_AREA / area);
    if (!best || cw > best.cw) best = { cols, rows, cw: Math.floor(cw) };
  }
  return best;
}

async function renderSheet(doc, from, to, sheetNo, sheetTotal, perSheet) {
  const total = doc.frames.length;
  const { w, h } = FRAME_SIZES[doc.aspect];
  // Same grid on every sheet (the last one may have empty cells) so they read consistently.
  const g = sheetGrid(Math.min(perSheet, total), w, h);
  const cw = g.cw;
  const ch = Math.round(cw * (h / w));
  const band = Math.round(cw * 0.09);
  const gap = Math.round(cw * 0.04);
  const header = Math.round(cw * 0.12);
  const W = g.cols * (cw + gap) + gap;
  const H = header + g.rows * (ch + band + gap) + gap;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#eceef2';
  ctx.fillRect(0, 0, W, H);
  const title = `${doc.name} — sheet ${sheetNo}/${sheetTotal} — frames ${from + 1}–${to} of ${total} — read left→right, top→bottom`;
  let hs = Math.round(header * 0.42);
  ctx.font = `700 ${hs}px system-ui, sans-serif`;
  while (hs > 9 && ctx.measureText(title).width > W - gap * 2) ctx.font = `700 ${--hs}px system-ui, sans-serif`;
  label(ctx, title, gap, header / 2, hs);
  const scale = cw / w;
  for (let i = from; i < to; i++) {
    const j = i - from;
    const x = gap + (j % g.cols) * (cw + gap);
    const y = header + Math.floor(j / g.cols) * (ch + band + gap);
    drawCell(ctx, renderFrame(doc.frames[i], doc.aspect, Math.min(1, scale * 1.5)), x, y, cw, ch, band, i + 1, total);
  }
  return toBlob(c);
}

// Individual full-res frame with its sequence number burned into a top band.
async function renderNumberedFrame(doc, i) {
  const total = doc.frames.length;
  const f = renderFrame(doc.frames[i], doc.aspect, 1);
  const band = Math.round(Math.max(f.width, f.height) * 0.04);
  const c = document.createElement('canvas');
  c.width = f.width;
  c.height = f.height + band;
  const ctx = c.getContext('2d');
  drawCell(ctx, f, 0, 0, f.width, f.height, band, i + 1, total);
  const next = i + 1 < total ? `next: ${i + 2}` : 'end';
  label(ctx, `${doc.name} · ${next}`, f.width - band * 0.4, band / 2, Math.round(band * 0.45), '#b8c0d0', 'right');
  return toBlob(c);
}

/**
 * AI pack: everything a vision model (or a person) needs to read the sequence.
 *  - sheets/: contact sheets sized to avoid model-side downscaling (perSheet frames each)
 *  - frames/: every frame at full resolution, numbered "N / total"
 *  - strip PNG(s)
 *  - SEQUENCE.md + sequence.json describing order
 */
export async function exportAiPack(doc, { perSheet = 4, includeStrip = true, includeFrames = true, onProgress } = {}) {
  const total = doc.frames.length;
  const base = safeName(doc.name);
  const files = [];
  const sheets = [];
  const sheetTotal = Math.ceil(total / perSheet);
  let done = 0;
  const steps = sheetTotal + (includeFrames ? total : 0) + (includeStrip ? 1 : 0);
  const tick = () => onProgress && onProgress(++done / steps);

  for (let sIdx = 0; sIdx < sheetTotal; sIdx++) {
    const from = sIdx * perSheet;
    const to = Math.min(total, from + perSheet);
    const name = `sheets/sheet_${pad2(sIdx + 1, sheetTotal)}_frames_${pad2(from + 1, total)}-${pad2(to, total)}.png`;
    const blob = await renderSheet(doc, from, to, sIdx + 1, sheetTotal, perSheet);
    files.push({ name, data: blob });
    sheets.push({ file: name, blob, frames: [from + 1, to] });
    tick();
  }
  const frameFiles = [];
  for (let i = 0; includeFrames && i < total; i++) {
    const name = `frames/frame_${pad2(i + 1, total)}_of_${pad2(total, total)}.png`;
    files.push({ name, data: await renderNumberedFrame(doc, i) });
    frameFiles.push(name);
    tick();
  }
  let strips = [];
  if (includeStrip) {
    strips = await exportStrip(doc, { scale: 1 });
    for (const s of strips) files.push({ name: s.name, data: s.blob });
    tick();
  }

  const { w, h } = FRAME_SIZES[doc.aspect];
  const manifest = {
    title: doc.name,
    aspect: doc.aspect,
    frameSize: [w, h],
    frameCount: total,
    order: frameFiles,
    sheets: sheets.map((s) => ({ file: s.file, frames: s.frames, layout: 'left-to-right, top-to-bottom' })),
    strips: strips.map((s) => ({ file: s.name, frames: [s.from, s.to] })),
    exportedAt: new Date().toISOString(),
  };
  const md = [
    `# ${doc.name}`,
    '',
    `Storyboard of **${total} frames** (${doc.aspect}, ${w}×${h} px each). Frames are meant to be read **in order, 1 → ${total}**.`,
    'Every image has its frame number burned in as "N / total" in the dark band above it.',
    '',
    '## Best way to show this to an AI',
    `Attach the files in \`sheets/\` in order (${sheetTotal} image${sheetTotal > 1 ? 's' : ''}). Each sheet is sized to stay under typical vision-model limits (≤${AI_LONG_EDGE}px long edge), so nothing gets downscaled into mush.`,
    'Use `frames/` when one frame needs full detail, or the strip PNG for a single overview image.',
    '',
    '## Sheets',
    ...sheets.map((s) => `- \`${s.file}\` → frames ${s.frames[0]}–${s.frames[1]}`),
    '',
    '## Frame order',
    ...frameFiles.map((f, i) => `${i + 1}. \`${f}\``),
    '',
    strips.length ? '## Strip' : '',
    ...strips.map((s) => `- \`${s.name}\` → frames ${s.from}–${s.to}`),
    '',
  ].join('\n');
  files.unshift({ name: 'SEQUENCE.md', data: md }, { name: 'sequence.json', data: JSON.stringify(manifest, null, 2) });

  if (!includeFrames && !includeStrip) return { sheets: sheets.map((s) => new File([s.blob], s.file.split('/').pop(), { type: 'image/png' })) };
  const zip = await makeZip(files.map((f) => ({ ...f, name: `${base}/${f.name}` })));
  return { zip, zipName: `${base}_ai_pack.zip`, sheets: sheets.map((s) => new File([s.blob], s.file.split('/').pop(), { type: 'image/png' })) };
}

// Board: export content bounds as one PNG (scaled down if huge).
export async function exportBoard(doc) {
  const b = contentBounds(doc.board.strokes);
  if (!b) return null;
  const pad = 60;
  const bw = b[2] - b[0] + pad * 2;
  const bh = b[3] - b[1] + pad * 2;
  let s = 2;
  while ((bw * s > MAX_SIDE || bh * s > MAX_SIDE || bw * bh * s * s > MAX_AREA) && s > 0.05) s *= 0.8;
  const c = document.createElement('canvas');
  c.width = Math.ceil(bw * s);
  c.height = Math.ceil(bh * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = BOARD_PAPER;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(s, 0, 0, s, (-b[0] + pad) * s, (-b[1] + pad) * s);
  drawStrokes(ctx, doc.board.strokes);
  return { name: `${safeName(doc.name)}_board.png`, blob: await toBlob(c) };
}

export { safeName };
