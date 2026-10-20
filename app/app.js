import { FRAME_SIZES, PAPER, BOARD_PAPER, drawStroke, drawStrokes, hitStroke, renderFrame } from './render.js';
import { exportStrip, exportAiPack, exportBoard, toBlob, safeName } from './export.js';
import { saveDoc, loadDoc, deleteDoc, listDocs } from './store.js';
import { parseCommands, createVoice, voiceSupported } from './voice.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const cache = document.createElement('canvas');
const cctx = cache.getContext('2d');
const onionCanvas = document.createElement('canvas');

const COLORS = ['#111111', '#e8505b', '#2f6fe4', '#1f9d55', '#f29e1f', '#ffffff'];
const SIZES = { pen: [2, 4, 7, 14], marker: [10, 18, 30, 48], eraser: [8, 16, 30, 60] };
const OUTSIDE = '#2a2d34';

const settings = Object.assign(
  { fingerDraws: true, pressure: true, thumbsOpen: true, color: COLORS[0], tool: 'pen', size: { pen: 1, marker: 1, eraser: 1 } },
  safeJSON(localStorage.getItem('framepad.settings'))
);
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
const saveSettings = () => localStorage.setItem('framepad.settings', JSON.stringify(settings));

let doc = null;
let frameIdx = 0;
let view = { x: 0, y: 0, s: 1 };
let dpr = 1;
let onion = false;
let penSeen = false;
let lastPenTime = -1e9;
let dirty = true;          // cache needs re-render
let cacheView = null;      // view the cache was rendered at
let rafPending = false;
let hover = null;          // { x, y } screen pos of hovering pen
const history = new WeakMap(); // page -> { undo: [], redo: [] }

// ---------- model helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const newFrame = () => ({ id: uid(), strokes: [] });

function newDoc(kind, aspect) {
  const n = new Date();
  const z = (v) => String(v).padStart(2, '0');
  const stamp = `${n.getFullYear()}-${z(n.getMonth() + 1)}-${z(n.getDate())} ${z(n.getHours())}-${z(n.getMinutes())}`;
  return kind === 'board'
    ? { id: uid(), name: `Board ${stamp}`, mode: 'board', board: { strokes: [], view: null }, updated: Date.now() }
    : { id: uid(), name: `Storyboard ${stamp}`, mode: 'frames', aspect, frames: [newFrame()], updated: Date.now() };
}

const page = () => (doc.mode === 'board' ? doc.board : doc.frames[frameIdx]);
const frameSize = () => FRAME_SIZES[doc.aspect];
function hist(p = page()) {
  if (!history.has(p)) history.set(p, { undo: [], redo: [] });
  return history.get(p);
}
function setStrokes(next, p = page()) {
  const h = hist(p);
  h.undo.push(p.strokes);
  if (h.undo.length > 200) h.undo.shift();
  h.redo.length = 0;
  p.strokes = next;
  changed();
}
function undo() {
  const p = page(), h = hist(p);
  if (!h.undo.length) return toast('Nothing to undo');
  h.redo.push(p.strokes);
  p.strokes = h.undo.pop();
  changed();
}
function redo() {
  const p = page(), h = hist(p);
  if (!h.redo.length) return toast('Nothing to redo');
  h.undo.push(p.strokes);
  p.strokes = h.redo.pop();
  changed();
}

let saveTimer;
function changed() {
  dirty = true;
  requestRender();
  updateUndoButtons();
  scheduleThumbs();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 600);
}
async function persist() {
  if (!doc) return;
  doc.updated = Date.now();
  if (doc.mode === 'board') doc.board.view = { ...view };
  try {
    await saveDoc(doc);
    localStorage.setItem('framepad.last', doc.id);
  } catch (e) {
    toast('Saving failed: ' + e.message);
  }
}
document.addEventListener('visibilitychange', () => document.hidden && persist());
window.addEventListener('pagehide', () => persist());

// ---------- view ----------
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  $('#toast').style.top = `${$('#topbar').getBoundingClientRect().bottom + 10}px`;
  for (const c of [canvas, cache]) {
    c.width = Math.round(innerWidth * dpr);
    c.height = Math.round(innerHeight * dpr);
  }
  if (doc && doc.mode === 'frames') fitFrame();
  dirty = true;
  requestRender();
}
window.addEventListener('resize', resize);

function fitFrame() {
  const { w, h } = frameSize();
  const top = $('#topbar').getBoundingClientRect().bottom + 14;
  // The frame bar can wrap onto two rows on narrow screens; keep the strip just above it.
  const fb = $('#framebar').getBoundingClientRect();
  $('#thumbs').style.bottom = `${innerHeight - fb.top + 8}px`;
  const below = $('#thumbs').hidden ? $('#framebar') : $('#thumbs');
  const bottom = innerHeight - below.getBoundingClientRect().top + 14;
  const availW = innerWidth - 40;
  const availH = Math.max(100, innerHeight - top - bottom);
  const s = Math.min(availW / w, availH / h);
  view = { s, x: (innerWidth - w * s) / 2, y: top + (availH - h * s) / 2 };
  dirty = true;
  requestRender();
}

const toWorld = (x, y) => [(x - view.x) / view.s, (y - view.y) / view.s];
const minScale = () => (doc.mode === 'board' ? 0.05 : 0.15);
const maxScale = () => 16;

// ---------- rendering ----------
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(draw);
}

function renderCache() {
  const c = cctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (doc.mode === 'board') {
    c.fillStyle = BOARD_PAPER;
    c.fillRect(0, 0, cache.width, cache.height);
    drawDots(c);
  } else {
    c.fillStyle = OUTSIDE;
    c.fillRect(0, 0, cache.width, cache.height);
  }
  c.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y);
  const vr = [...toWorld(0, 0), ...toWorld(innerWidth, innerHeight)];
  if (doc.mode === 'frames') {
    const { w, h } = frameSize();
    c.save();
    c.shadowColor = '#0008';
    c.shadowBlur = 30 / view.s;
    c.fillStyle = PAPER;
    c.fillRect(0, 0, w, h);
    c.restore();
    c.save();
    c.beginPath();
    c.rect(0, 0, w, h);
    c.clip();
    if (onion && frameIdx > 0) {
      // Draw the previous frame opaque offscreen, then blend it in faintly (avoids dotted joints).
      onionCanvas.width = cache.width;
      onionCanvas.height = cache.height;
      const o = onionCanvas.getContext('2d');
      o.setTransform(c.getTransform());
      drawStrokes(o, doc.frames[frameIdx - 1].strokes, vr);
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 0.2;
      c.drawImage(onionCanvas, 0, 0);
      c.restore();
    }
    drawStrokes(c, page().strokes, vr);
    c.restore();
  } else {
    drawStrokes(c, page().strokes, vr);
  }
  dirty = false;
  cacheView = { ...view };
}

function drawDots(c) {
  let step = 40;
  while (step * view.s < 14) step *= 4;
  const r = Math.max(1, 1.1 * dpr);
  c.fillStyle = '#c9c6bb';
  const [x0, y0] = toWorld(0, 0);
  const [x1, y1] = toWorld(innerWidth, innerHeight);
  for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      c.fillRect((x * view.s + view.x) * dpr - r / 2, (y * view.s + view.y) * dpr - r / 2, r, r);
    }
  }
}

function draw() {
  rafPending = false;
  if (!doc) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (gesture && cacheView && dirty) {
    // While panning/zooming, transform the last bitmap instead of re-rendering every stroke.
    ctx.fillStyle = doc.mode === 'board' ? BOARD_PAPER : OUTSIDE;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const r = view.s / cacheView.s;
    ctx.setTransform(r, 0, 0, r, dpr * (view.x - cacheView.x * r), dpr * (view.y - cacheView.y * r));
    ctx.drawImage(cache, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    if (dirty) renderCache();
    ctx.drawImage(cache, 0, 0);
  }

  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y);
  if (live && !live.erasing && live.stroke.p.length) {
    ctx.save();
    if (doc.mode === 'frames') {
      const { w, h } = frameSize();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
    }
    drawStroke(ctx, live.stroke);
    ctx.restore();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cursor = live && live.erasing ? live.cursor : hover;
  if (cursor) {
    const erasing = (live && live.erasing) || cursor.erase || settings.tool === 'eraser';
    ctx.beginPath();
    if (erasing) {
      ctx.arc(cursor.x, cursor.y, eraserRadiusPx(), 0, Math.PI * 2);
      ctx.strokeStyle = '#e8505b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const r = Math.max(2, SIZES[settings.tool][settings.size[settings.tool]] / 2);
      ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
      ctx.fillStyle = settings.color;
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0006';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

const eraserRadiusPx = () => SIZES.eraser[settings.size.eraser];

// ---------- input ----------
const touches = new Map(); // pointerId -> {x, y}
let live = null;     // active stroke / erase: { id, stroke, erasing, removed, startTime, type }
let gesture = null;  // { c0, d0, view0, startTime, maxTouches, moved }

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'pen') { notePen(); lastPenTime = performance.now(); }

  if (e.pointerType === 'touch') {
    // Palm rejection: ignore touches while the pen draws or hovers (and just after).
    if ((live && live.type === 'pen') || performance.now() - lastPenTime < 400) return;
    if (live && live.type === 'touch') {
      // A second finger arrived: the first one was the start of a gesture, not a stroke.
      const first = { x: live.startX, y: live.startY };
      const firstId = live.id;
      cancelLive();
      touches.set(firstId, first);
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(e.pointerId);
    if (touches.size === 1 && settings.fingerDraws && !gesture) {
      touches.delete(e.pointerId);
      startLive(e, 'touch');
      return;
    }
    startGesture();
    return;
  }

  if (e.pointerType === 'mouse' && e.button === 1) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
    return;
  }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // Pen takes priority over any finger gesture in progress.
  if (gesture) endGesture(true);
  capture(e.pointerId);
  startLive(e, e.pointerType);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'pen') lastPenTime = performance.now();
  if (live && e.pointerId === live.id) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs.length ? evs : [e]) moveLive(ce);
    requestRender();
    return;
  }
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moveGesture();
    return;
  }
  if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
    hover = { x: e.clientX, y: e.clientY, erase: isEraseButton(e) };
    requestRender();
  }
});

const finishPointer = (e) => {
  if (e.pointerType === 'pen') lastPenTime = performance.now();
  if (live && e.pointerId === live.id) {
    e.type === 'pointercancel' ? cancelLive() : endLive();
    return;
  }
  if (touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    if (touches.size === 0) endGesture();
    else startGesture(true);
  }
};
canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', finishPointer);
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch' && !live) { hover = null; requestRender(); }
});

const capture = (id) => { try { canvas.setPointerCapture(id); } catch {} };

// Lenovo / USI / Wacom pens: side button sets bit 2, eraser end sets bit 32.
const isEraseButton = (e) => e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || e.button === 5);

function notePen() {
  if (penSeen) return;
  penSeen = true;
  $('#pen-status').hidden = false;
  if (settings.fingerDraws) {
    settings.fingerDraws = false;
    saveSettings();
    toast('Pen detected — fingers now pan & zoom (change in ⋯ settings)');
  }
}

function pressureOf(e) {
  if (e.pointerType !== 'pen' || !settings.pressure) return 0.5;
  return Math.max(0.05, Math.min(1, e.pressure || 0.5));
}

function startLive(e, type) {
  const erasing = settings.tool === 'eraser' || isEraseButton(e);
  const tool = erasing ? 'eraser' : settings.tool;
  live = {
    id: e.pointerId,
    type,
    erasing,
    startX: e.clientX,
    startY: e.clientY,
    startTime: performance.now(),
    removed: null,
    lastPr: pressureOf(e),
    cursor: { x: e.clientX, y: e.clientY },
    stroke: { t: tool, c: settings.color, w: SIZES[tool][settings.size[tool]] / view.s, p: [] },
  };
  hover = null;
  moveLive(e);
  requestRender();
}

function moveLive(e) {
  const [x, y] = toWorld(e.clientX, e.clientY);
  if (live.erasing) {
    live.cursor = { x: e.clientX, y: e.clientY };
    const r = eraserRadiusPx() / view.s;
    const src = page().strokes;
    // Sample along the path since the last event so fast flicks don't skip strokes.
    const [px, py] = live.last || [x, y];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (r * 0.7)));
    const kept = src.filter((s) => {
      for (let i = 1; i <= steps; i++) if (hitStroke(s, px + ((x - px) * i) / steps, py + ((y - py) * i) / steps, r)) return false;
      return true;
    });
    live.last = [x, y];
    if (kept.length !== src.length) {
      live.removed = true;
      // Show erasure live without committing to history yet.
      live.original = live.original || page().strokes;
      page().strokes = kept;
      dirty = true;
    }
    return;
  }
  const p = live.stroke.p;
  const n = p.length;
  if (n && Math.hypot(p[n - 3] - x, p[n - 2] - y) < 0.7 / view.s) return;
  const pr = live.lastPr * 0.55 + pressureOf(e) * 0.45;
  live.lastPr = pr;
  p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(pr * 100) / 100);
}

function endLive() {
  const l = live;
  live = null;
  if (l.erasing) {
    if (l.removed) {
      const p = page();
      const kept = p.strokes;
      p.strokes = l.original;
      setStrokes(kept);
    }
    requestRender();
    return;
  }
  if (l.stroke.p.length) setStrokes([...page().strokes, l.stroke]);
  requestRender();
}

function cancelLive() {
  if (!live) return;
  if (live.erasing && live.original) { page().strokes = live.original; dirty = true; }
  live = null;
  requestRender();
}

function centroid() {
  let x = 0, y = 0;
  for (const t of touches.values()) { x += t.x; y += t.y; }
  return { x: x / touches.size, y: y / touches.size };
}
function spread(c) {
  if (touches.size < 2) return 0;
  let d = 0;
  for (const t of touches.values()) d += Math.hypot(t.x - c.x, t.y - c.y);
  return d / touches.size;
}

function startGesture(rebase = false) {
  const c = centroid();
  const prev = gesture;
  gesture = {
    c0: c,
    d0: spread(c),
    view0: { ...view },
    startTime: prev && rebase ? prev.startTime : performance.now(),
    maxTouches: Math.max(touches.size, prev ? prev.maxTouches : 0),
    moved: prev ? prev.moved : false,
  };
}

function moveGesture() {
  if (!gesture) return;
  const c = centroid();
  const g = gesture;
  let s = g.view0.s;
  const d = spread(c);
  if (g.d0 > 10 && d > 0) s = Math.min(maxScale(), Math.max(minScale(), g.view0.s * (d / g.d0)));
  const wx = (g.c0.x - g.view0.x) / g.view0.s;
  const wy = (g.c0.y - g.view0.y) / g.view0.s;
  view = { s, x: c.x - wx * s, y: c.y - wy * s };
  if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > 12 || Math.abs(d - g.d0) > 12) g.moved = true;
  dirty = true;
  requestRender();
}

function endGesture(silent = false) {
  const g = gesture;
  gesture = null;
  touches.clear();
  if (!silent && g && !g.moved && performance.now() - g.startTime < 350) {
    if (g.maxTouches === 2) undo();
    else if (g.maxTouches === 3) redo();
  }
  dirty = true;
  requestRender();
  if (doc.mode === 'board') { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 1500); }
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const s = Math.min(maxScale(), Math.max(minScale(), view.s * Math.exp(-e.deltaY * 0.01)));
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    view = { s, x: e.clientX - wx * s, y: e.clientY - wy * s };
  } else {
    view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
  }
  dirty = true;
  requestRender();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('dialog, input, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (doc && doc.mode === 'frames' && e.key === 'ArrowLeft') goFrame(frameIdx - 1);
  else if (doc && doc.mode === 'frames' && e.key === 'ArrowRight') nextFrame();
  else if (mod || e.altKey) return;
  else if (e.key >= '1' && e.key <= String(COLORS.length)) setColor(COLORS[+e.key - 1]);
  else if (doc && doc.mode === 'frames' && e.key.toLowerCase() === 'n') $('#btn-insert').click();
  else if (doc && doc.mode === 'frames' && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); $('#btn-del').click(); }
  else if (e.key.toLowerCase() === 'v') toggleVoice();
  else if (e.key === 'p') setTool('pen');
  else if (e.key === 'h') setTool('marker');
  else if (e.key === 'e') setTool('eraser');
});

// ---------- frames ----------
function goFrame(i) {
  if (!doc || doc.mode !== 'frames') return;
  const n = Math.max(0, Math.min(doc.frames.length - 1, i));
  if (n === frameIdx) return;
  cancelLive();
  frameIdx = n;
  frameChanged();
}
function nextFrame() {
  if (frameIdx === doc.frames.length - 1) {
    doc.frames.push(newFrame());
    frameIdx++;
    toast(`New frame ${frameIdx + 1}`);
    frameChanged(true);
  } else goFrame(frameIdx + 1);
}
function frameChanged(structural = false) {
  fitFrame();
  updateFrameUI();
  updateUndoButtons();
  scheduleThumbs();
  if (structural) changed();
}
function updateFrameUI() {
  if (doc.mode !== 'frames') return;
  const n = doc.frames.length;
  $('#frame-label').textContent = `${frameIdx + 1} / ${n}`;
  $('#btn-prev').disabled = frameIdx === 0;
  const atEnd = frameIdx === n - 1;
  $('#btn-next').classList.toggle('add', atEnd);
  $('#btn-next').innerHTML = atEnd
    ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
  $('#btn-next').title = atEnd ? 'Add new frame (→)' : 'Next frame (→)';
  $('#btn-move-l').disabled = frameIdx === 0;
  $('#btn-move-r').disabled = atEnd;
  $('#btn-aspect').textContent = doc.aspect;
  $('#btn-onion').classList.toggle('active', onion);
}

$('#btn-prev').onclick = () => goFrame(frameIdx - 1);
$('#btn-next').onclick = nextFrame;
$('#btn-insert').onclick = () => {
  doc.frames.splice(frameIdx + 1, 0, newFrame());
  frameIdx++;
  frameChanged(true);
};
$('#btn-dup').onclick = () => {
  doc.frames.splice(frameIdx + 1, 0, { id: uid(), strokes: [...page().strokes] });
  frameIdx++;
  toast('Frame duplicated');
  frameChanged(true);
};
$('#btn-del').onclick = () => {
  if (page().strokes.length && !confirm(`Delete frame ${frameIdx + 1}?`)) return;
  if (doc.frames.length === 1) doc.frames[0] = newFrame();
  else doc.frames.splice(frameIdx, 1);
  frameIdx = Math.min(frameIdx, doc.frames.length - 1);
  frameChanged(true);
};
const moveFrame = (d) => {
  const j = frameIdx + d;
  if (j < 0 || j >= doc.frames.length) return;
  [doc.frames[frameIdx], doc.frames[j]] = [doc.frames[j], doc.frames[frameIdx]];
  frameIdx = j;
  frameChanged(true);
};
$('#btn-move-l').onclick = () => moveFrame(-1);
$('#btn-move-r').onclick = () => moveFrame(1);
$('#btn-onion').onclick = () => setOnion(!onion);
$('#btn-aspect').onclick = () => {
  const from = FRAME_SIZES[doc.aspect];
  doc.aspect = doc.aspect === '16:9' ? '9:16' : '16:9';
  const to = FRAME_SIZES[doc.aspect];
  const dx = (to.w - from.w) / 2, dy = (to.h - from.h) / 2;
  // Keep drawings centred; nothing is deleted, so switching back restores them.
  for (const f of doc.frames) {
    f.strokes = f.strokes.map((s) => ({ ...s, p: s.p.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v)) }));
    history.delete(f);
  }
  toast(`Frames are now ${doc.aspect}`);
  frameChanged(true);
};

// Thumbnails: each preview is a small canvas redrawn whenever its frame's strokes change.
const THUMB_H = 96;
function drawThumb(cv, f) {
  if (cv._frame === f && cv._strokes === f.strokes && cv._aspect === doc.aspect) return;
  const { w, h } = frameSize();
  const r = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round((THUMB_H * w) / h);
  cv.style.width = `${cw}px`;
  cv.style.height = `${THUMB_H}px`;
  cv.width = Math.round(cw * r);
  cv.height = Math.round(THUMB_H * r);
  const c = cv.getContext('2d');
  const k = cv.height / h;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = PAPER;
  c.fillRect(0, 0, cv.width, cv.height);
  c.setTransform(k, 0, 0, k, 0, 0);
  c.beginPath();
  c.rect(0, 0, w, h);
  c.clip();
  // Keep thin lines visible at thumbnail size.
  const minW = 1.2 / k;
  drawStrokes(c, f.strokes.map((st) => (st.w >= minW ? st : { ...st, w: minW })));
  cv._frame = f;
  cv._strokes = f.strokes;
  cv._aspect = doc.aspect;
}
let thumbTimer;
function scheduleThumbs() {
  if ($('#thumbs').hidden) return;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(renderThumbs, 80); // right after the stroke, so drawing stays smooth
}
function renderThumbs() {
  if (!doc || doc.mode !== 'frames' || $('#thumbs').hidden) return;
  const list = $('#thumb-list');
  doc.frames.forEach((f, i) => {
    let b = list.children[i];
    if (!b) {
      b = document.createElement('button');
      b.className = 'th';
      b.innerHTML = '<canvas></canvas><b></b>';
      b.onclick = () => goFrame([...list.children].indexOf(b));
      list.append(b);
    }
    drawThumb(b.firstElementChild, f);
    b.lastElementChild.textContent = i + 1;
    b.classList.toggle('active', i === frameIdx);
  });
  while (list.children.length > doc.frames.length) list.lastElementChild.remove();
  list.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
function setThumbsOpen(open, remember = true) {
  if (remember) { settings.thumbsOpen = open; saveSettings(); }
  const show = open && doc && doc.mode === 'frames';
  $('#thumbs').hidden = !show;
  $('#btn-thumbs').hidden = show; // the "Previews" button only shows while the strip is minimized
  if (show) renderThumbs();
  if (doc && doc.mode === 'frames') fitFrame();
}
$('#btn-thumbs').onclick = () => setThumbsOpen(true);
$('#btn-thumbs-min').onclick = () => setThumbsOpen(false);

// ---------- toolbar ----------
function buildToolbar() {
  const sw = $('#swatches');
  sw.innerHTML = '';
  for (const [i, c] of COLORS.entries()) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.title = `Colour ${i + 1} (key ${i + 1})`;
    b.onclick = () => setColor(c);
    sw.append(b);
  }
  $('#color-input').oninput = (e) => setColor(e.target.value);
  document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  updateToolbar();
}
function buildSizes() {
  const el = $('#sizes');
  el.innerHTML = '';
  SIZES[settings.tool].forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'size' + (settings.size[settings.tool] === i ? ' active' : '');
    const d = Math.max(4, Math.min(26, settings.tool === 'pen' ? v * 2 : v * 0.5));
    b.innerHTML = `<span style="width:${d}px;height:${d}px"></span>`;
    b.onclick = () => { settings.size[settings.tool] = i; saveSettings(); buildSizes(); };
    el.append(b);
  });
}
function setTool(t) { settings.tool = t; saveSettings(); updateToolbar(); }
function setColor(c) {
  settings.color = c;
  if (settings.tool === 'eraser') settings.tool = 'pen';
  saveSettings();
  updateToolbar();
}
function updateToolbar() {
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === settings.tool));
  document.querySelectorAll('#swatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === settings.color));
  buildSizes();
}
function updateUndoButtons() {
  if (!doc) return;
  const h = hist();
  $('#btn-undo').disabled = !h.undo.length;
  $('#btn-redo').disabled = !h.redo.length;
}
$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;

$('#doc-title').onclick = () => {
  const n = prompt('Name', doc.name);
  if (n && n.trim()) { doc.name = n.trim(); $('#doc-title').textContent = doc.name; persist(); }
};

// ---------- documents ----------
async function openDoc(d) {
  if (doc) await persist();
  doc = d;
  frameIdx = 0;
  $('#doc-title').textContent = doc.name;
  const frames = doc.mode === 'frames';
  $('#framebar').hidden = !frames;
  $('#thumb-list').innerHTML = '';
  setThumbsOpen(settings.thumbsOpen, false);
  if (frames) {
    fitFrame();
    updateFrameUI();
  } else {
    view = doc.board.view ? { ...doc.board.view } : { x: innerWidth / 2, y: innerHeight / 2, s: 1 };
  }
  localStorage.setItem('framepad.last', doc.id);
  dirty = true;
  updateUndoButtons();
  requestRender();
}

async function showHome() {
  const docs = (await listDocs()).sort((a, b) => b.updated - a.updated);
  const ul = $('#doc-list');
  ul.innerHTML = docs.length ? '' : '<li><span class="name"><small>No documents yet — pick a type above.</small></span></li>';
  for (const d of docs) {
    const li = document.createElement('li');
    if (doc && d.id === doc.id) li.className = 'current';
    const what = d.mode === 'board' ? 'Board' : `${d.frames.length} frame${d.frames.length > 1 ? 's' : ''} · ${d.aspect}`;
    li.innerHTML = `<button class="name"><b></b><small>${what} · ${new Date(d.updated).toLocaleString()}</small></button>
      <button class="icon" title="Rename" aria-label="Rename"><svg viewBox="0 0 24 24"><path d="M4 20l1-5L16 4l4 4L9 19z"/></svg></button>
      <button class="icon danger" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>`;
    li.querySelector('b').textContent = d.name;
    const [open, ren, del] = li.querySelectorAll('button');
    open.onclick = async () => { $('#dlg-home').close(); await openDoc(doc && d.id === doc.id ? doc : await loadDoc(d.id)); };
    ren.onclick = async () => {
      const n = prompt('Name', d.name);
      if (!n || !n.trim()) return;
      const target = doc && d.id === doc.id ? doc : d;
      target.name = n.trim();
      await saveDoc(target);
      if (target === doc) $('#doc-title').textContent = doc.name;
      showHome();
    };
    del.onclick = async () => {
      if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
      await deleteDoc(d.id);
      if (doc && d.id === doc.id) {
        doc = null;
        const rest = docs.filter((x) => x.id !== d.id);
        if (rest.length) await openDoc(rest[0]);
        else await openDoc(newDoc('frames', '16:9'));
      }
      showHome();
    };
    ul.append(li);
  }
  if (!$('#dlg-home').open) $('#dlg-home').showModal();
}
$('#btn-home').onclick = showHome;
$('#home-close').onclick = () => { if (doc) $('#dlg-home').close(); };
$('#dlg-home').addEventListener('cancel', (e) => { if (!doc) e.preventDefault(); });
document.querySelectorAll('[data-new]').forEach((b) => (b.onclick = async () => {
  const [kind, ...rest] = b.dataset.new.split(':');
  const d = newDoc(kind, rest.join(':'));
  $('#dlg-home').close();
  await openDoc(d);
  persist();
}));
$('#import-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!d.mode || (d.mode === 'frames' ? !Array.isArray(d.frames) : !d.board)) throw new Error('not a FramePad project');
    d.id = uid();
    d.updated = Date.now();
    $('#dlg-home').close();
    await openDoc(d);
    persist();
    toast('Imported');
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
};

// ---------- export ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const canShareFiles = () => {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] });
  } catch { return false; }
};

function progress(v) {
  const el = $('#export-progress');
  el.hidden = v == null;
  el.firstElementChild.style.width = `${Math.round((v || 0) * 100)}%`;
}
async function busy(btn, fn) {
  const buttons = $('#dlg-export').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  const label = btn.textContent;
  btn.textContent = 'Working…';
  progress(0);
  await new Promise((r) => setTimeout(r, 30)); // let the UI update first
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + e.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    btn.textContent = label;
    progress(null);
  }
}

$('#btn-export').onclick = async () => {
  await persist();
  const frames = doc.mode === 'frames';
  $('#export-frames').hidden = !frames;
  $('#export-board').hidden = frames;
  const share = canShareFiles();
  $('#exp-share').hidden = !share;
  $('#exp-board-share').hidden = !share;
  $('#dlg-export').showModal();
};
$('#export-close').onclick = () => $('#dlg-export').close();

// Export without trailing blank frames (the → button on the last frame tends to leave one).
function exportDoc() {
  let n = doc.frames.length;
  while (n > 1 && !doc.frames[n - 1].strokes.length) n--;
  return { ...doc, frames: doc.frames.slice(0, n) };
}

$('#exp-ai').onclick = (e) => busy(e.target, async () => {
  const { zip, zipName } = await exportAiPack(exportDoc(), { perSheet: +$('#per-sheet').value, onProgress: progress });
  download(zip, zipName);
  toast('AI pack saved to Downloads');
});
$('#exp-share').onclick = (e) => busy(e.target, async () => {
  const { sheets } = await exportAiPack(exportDoc(), { perSheet: +$('#per-sheet').value, includeStrip: false, includeFrames: false, onProgress: progress });
  await navigator.share({ files: sheets, title: doc.name, text: `${doc.name}: ${doc.frames.length} frames, in order (sheet 1 first, read left→right, top→bottom).` }).catch(() => {});
});
$('#exp-strip').onclick = (e) => busy(e.target, async () => {
  const parts = await exportStrip(exportDoc(), { dir: $('#strip-dir').value });
  for (const p of parts) download(p.blob, p.name);
  toast(parts.length > 1 ? `Strip split into ${parts.length} consecutive parts` : 'Strip saved');
});
$('#exp-frame').onclick = (e) => busy(e.target, async () => {
  const blob = await toBlob(renderFrame(page(), doc.aspect, 1));
  download(blob, `${safeName(doc.name)}_frame_${String(frameIdx + 1).padStart(2, '0')}.png`);
});
$('#exp-board').onclick = (e) => busy(e.target, async () => {
  const r = await exportBoard(doc);
  if (!r) return toast('Board is empty');
  download(r.blob, r.name);
});
$('#exp-board-share').onclick = (e) => busy(e.target, async () => {
  const r = await exportBoard(doc);
  if (!r) return toast('Board is empty');
  await navigator.share({ files: [new File([r.blob], r.name, { type: 'image/png' })], title: doc.name }).catch(() => {});
});
$('#exp-json').onclick = () => download(new Blob([JSON.stringify(doc)], { type: 'application/json' }), `${safeName(doc.name)}.framepad.json`);

// ---------- voice ----------
function setOnion(on) { onion = on; updateFrameUI(); dirty = true; requestRender(); }
function stepSize(d) {
  const t = settings.tool;
  settings.size[t] = Math.max(0, Math.min(SIZES[t].length - 1, settings.size[t] + d));
  saveSettings();
  buildSizes();
}
const framesOnly = () => doc.mode === 'frames';

// Returns a short description of what was done, or null if not applicable.
function runCommand(c) {
  switch (c.cmd) {
    case 'color':
      if (c.n < 1 || c.n > COLORS.length) return null;
      setColor(COLORS[c.n - 1]);
      return `colour ${c.n}`;
    case 'size':
      if (c.n < 1 || c.n > 4) return null;
      settings.size[settings.tool] = c.n - 1; saveSettings(); buildSizes();
      return `size ${c.n}`;
    case 'sizeStep': stepSize(c.n); return c.n > 0 ? 'bigger' : 'smaller';
    case 'undo': for (let i = 0; i < c.n; i++) undo(); return c.n > 1 ? `undo ×${c.n}` : 'undo';
    case 'redo': for (let i = 0; i < c.n; i++) redo(); return c.n > 1 ? `redo ×${c.n}` : 'redo';
    case 'tool': setTool(c.tool); return { pen: 'pen', marker: 'highlighter', eraser: 'eraser' }[c.tool];
    case 'next': if (!framesOnly()) return 'only works in frame mode'; nextFrame(); return `frame ${frameIdx + 1}`;
    case 'prev': if (!framesOnly()) return 'only works in frame mode'; goFrame(frameIdx - 1); return `frame ${frameIdx + 1}`;
    case 'goto': {
      if (!framesOnly()) return 'only works in frame mode';
      const n = Math.min(doc.frames.length, c.n);
      if (n < 1) return null;
      goFrame(n - 1);
      return `frame ${n}`;
    }
    case 'insert': if (!framesOnly()) return 'only works in frame mode'; $('#btn-insert').click(); return `new frame ${frameIdx + 1}`;
    case 'delete': if (!framesOnly()) return 'only works in frame mode'; $('#btn-del').click(); return 'delete frame';
    case 'duplicate': if (!framesOnly()) return 'only works in frame mode'; $('#btn-dup').click(); return 'duplicate';
    case 'onion': if (!framesOnly()) return 'only works in frame mode'; setOnion(c.on == null ? !onion : c.on); return `onion skin ${onion ? 'on' : 'off'}`;
    case 'previews': if (!framesOnly()) return 'only works in frame mode'; setThumbsOpen(c.on); return c.on ? 'show previews' : 'hide previews';
    case 'clear': if (!page().strokes.length) return null; setStrokes([]); return 'cleared (say “undo” to bring it back)';
    case 'export': $('#btn-export').click(); return 'export';
    case 'fit': $('#btn-fit').click(); return 'reset view';
    case 'stopVoice': voice.stop(); return 'voice off';
  }
  return null;
}

function onPhrase(alternatives) {
  if (live) return; // never act mid-stroke
  // Use the first recognition alternative that contains a command.
  for (const text of alternatives) {
    const cmds = parseCommands(text);
    if (!cmds.length) continue;
    const done = cmds.map(runCommand).filter(Boolean);
    if (done.length) { toast(`🎤 “${text}” → ${done.join(', ')}`); return; }
  }
  toast(`🎤 didn’t catch a command in “${alternatives[0] || '…'}”`);
}

const voice = createVoice({
  onPhrase,
  onState(on, err) {
    $('#btn-mic').classList.toggle('active', on || (voice && voice.listening));
    if (err === 'not-allowed' || err === 'service-not-allowed') toast('Microphone blocked — allow it for this site in Chrome settings');
    else if (err) toast(`Voice stopped (${err})`);
  },
});
function toggleVoice() {
  if (!voice) return toast('Voice commands are not supported in this browser');
  if (voice.listening) { voice.stop(); toast('Voice off'); }
  else { voice.start(); toast('🎤 Listening — try “colour 2”, “undo”, “next”'); }
  $('#btn-mic').classList.toggle('active', voice.listening);
}
$('#btn-mic').hidden = !voiceSupported;
$('#voice-help').hidden = !voiceSupported;
$('#btn-mic').onclick = toggleVoice;

// ---------- settings ----------
$('#btn-more').onclick = () => {
  $('#set-finger').checked = settings.fingerDraws;
  $('#set-pressure').checked = settings.pressure;
  $('#dlg-settings').showModal();
};
$('#set-finger').onchange = (e) => { settings.fingerDraws = e.target.checked; saveSettings(); };
$('#set-pressure').onchange = (e) => { settings.pressure = e.target.checked; saveSettings(); };
$('#settings-close').onclick = () => $('#dlg-settings').close();
$('#btn-fit').onclick = () => {
  if (doc.mode === 'frames') fitFrame();
  else { view = { x: innerWidth / 2, y: innerHeight / 2, s: 1 }; dirty = true; requestRender(); }
  $('#dlg-settings').close();
};
$('#btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen not available'));
  $('#dlg-settings').close();
};
document.addEventListener('fullscreenchange', () => setTimeout(resize, 100));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- boot ----------
async function boot() {
  buildToolbar();
  resize();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const last = localStorage.getItem('framepad.last');
  const d = last && (await loadDoc(last).catch(() => null));
  if (d) await openDoc(d);
  else showHome();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();

// For automated tests.
window.__framepad = { get doc() { return doc; }, get view() { return view; }, get frameIdx() { return frameIdx; } };
