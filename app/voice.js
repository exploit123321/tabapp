// Voice commands: Web Speech API recognition + a small command parser.

const NUMBERS = {
  one: 1, won: 1, first: 1,
  two: 2, to: 2, too: 2, second: 2,
  three: 3, tree: 3, free: 3, third: 3,
  four: 4, for: 4, fore: 4, fourth: 4,
  five: 5, fifth: 5,
  six: 6, sex: 6, sixth: 6,
  seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
export const COLOR_NAMES = { black: 1, red: 2, blue: 3, green: 4, orange: 5, yellow: 5, white: 6 };

function num(tok) {
  if (tok == null) return null;
  const m = tok.match(/^#?(\d+)(st|nd|rd|th)?$/);
  if (m) return +m[1];
  return NUMBERS[tok] ?? null;
}

/**
 * Turn a phrase into commands, e.g. "colour 2 and next frame" ->
 * [{ cmd: 'color', n: 2 }, { cmd: 'next' }]. Unknown words are skipped.
 */
export function parseCommands(text) {
  const t = text
    .toLowerCase()
    .replace(/colour/g, 'color')
    .replace(/[^\w#\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  const isFrameWord = (w) => w === 'frame' || w === 'page' || w === 'slide';
  for (let i = 0; i < t.length; i++) {
    const w = t[i], n1 = t[i + 1], n2 = t[i + 2];
    const skipFrameWord = () => { if (isFrameWord(t[i + 1])) i++; };
    if (w === 'color' && num(n1) != null) { out.push({ cmd: 'color', n: num(n1) }); i++; }
    else if (w === 'color' && COLOR_NAMES[n1]) { out.push({ cmd: 'color', n: COLOR_NAMES[n1] }); i++; }
    else if (COLOR_NAMES[w]) out.push({ cmd: 'color', n: COLOR_NAMES[w] });
    else if (w === 'size' && num(n1) != null) { out.push({ cmd: 'size', n: num(n1) }); i++; }
    else if (['bigger', 'thicker', 'larger'].includes(w)) out.push({ cmd: 'sizeStep', n: 1 });
    else if (['smaller', 'thinner'].includes(w)) out.push({ cmd: 'sizeStep', n: -1 });
    else if (w === 'undo' || w === 'redo') {
      const n = num(n1);
      out.push({ cmd: w, n: n && n <= 20 ? n : 1 });
      if (n) { i++; if (t[i + 1] === 'times') i++; }
    }
    else if (w === 'next' || w === 'forward') { out.push({ cmd: 'next' }); skipFrameWord(); }
    else if (w === 'previous' || w === 'prev' || w === 'back') { out.push({ cmd: 'prev' }); skipFrameWord(); }
    else if ((w === 'new' || w === 'add' || w === 'insert') && (isFrameWord(n1) || isFrameWord(n2))) { out.push({ cmd: 'insert' }); i += isFrameWord(n1) ? 1 : 2; }
    else if (w === 'delete' || w === 'remove') { out.push({ cmd: 'delete' }); if (n1 === 'this') i++; skipFrameWord(); }
    else if (w === 'duplicate' || (w === 'copy' && isFrameWord(n1))) { out.push({ cmd: 'duplicate' }); skipFrameWord(); }
    else if ((w === 'first' || w === 'last') && isFrameWord(n1)) { out.push({ cmd: 'goto', n: w === 'first' ? 1 : Infinity }); i++; }
    else if (isFrameWord(w) && num(n1) != null) { out.push({ cmd: 'goto', n: num(n1) }); i++; }
    else if (w === 'pen' || w === 'pencil') out.push({ cmd: 'tool', tool: 'pen' });
    else if (w === 'highlighter' || w === 'marker') out.push({ cmd: 'tool', tool: 'marker' });
    else if (w === 'eraser' || w === 'rubber' || w === 'erase') out.push({ cmd: 'tool', tool: 'eraser' });
    else if (w === 'onion') {
      let on = null;
      for (const k of [n1, n2]) if (k === 'on' || k === 'off') on = k === 'on';
      out.push({ cmd: 'onion', on });
      while (['skin', 'on', 'off'].includes(t[i + 1])) i++;
    }
    else if ((w === 'show' || w === 'open' || w === 'hide' || w === 'close') && (n1 === 'preview' || n1 === 'previews')) {
      out.push({ cmd: 'previews', on: w === 'show' || w === 'open' }); i++;
    }
    else if (w === 'clear') { out.push({ cmd: 'clear' }); skipFrameWord(); if (t[i + 1] === 'board') i++; }
    else if (w === 'export') out.push({ cmd: 'export' });
    else if ((w === 'stop' && (n1 === 'listening' || n1 === 'voice')) || ((w === 'mic' || w === 'microphone') && n1 === 'off')) { out.push({ cmd: 'stopVoice' }); i++; }
    else if ((w === 'reset' && n1 === 'view') || w === 'fit') { out.push({ cmd: 'fit' }); if (n1 === 'view') i++; }
  }
  return out;
}

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const voiceSupported = !!SR;

/**
 * Continuous listener. Android Chrome ends a recognition session after each pause,
 * so it is restarted automatically until stop() is called.
 * onPhrase(alternatives: string[]), onState(listening: boolean, error?: string)
 */
export function createVoice({ lang = 'en-US', onPhrase, onState }) {
  if (!SR) return null;
  let rec = null;
  let wanted = false;
  let timer = 0;
  let failures = 0;

  function spawn() {
    if (!wanted || document.hidden) return;
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 4;
    rec.onstart = () => onState(true);
    rec.onresult = (e) => {
      failures = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onPhrase(Array.from(r, (a) => a.transcript.trim()).filter(Boolean));
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error) || ++failures > 4) {
        wanted = false;
        onState(false, e.error);
      }
    };
    rec.onend = () => {
      rec = null;
      if (wanted) timer = setTimeout(spawn, failures ? 1000 * failures : 150);
      else onState(false);
    };
    try { rec.start(); } catch { /* already started */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) rec?.abort();
    else if (wanted && !rec) spawn();
  });

  return {
    get listening() { return wanted; },
    start() { if (wanted) return; wanted = true; failures = 0; spawn(); },
    stop() { wanted = false; clearTimeout(timer); if (rec) rec.abort(); else onState(false); },
  };
}
