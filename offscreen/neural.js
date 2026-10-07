// Documento offscreen: ejecuta Supertonic 3, mantiene una caché de audio y reproduce
// lo que pide cada pestaña. Las pestañas se conectan con un Port ("sbn-neural").
import * as engine from './supertonic.js';

const PORT_NAME = 'sbn-neural';
const CACHE_LIMIT = 40; // fragmentos de audio guardados (≈ 1 MB cada uno)
const IDLE_CLOSE_MS = 5 * 60 * 1000; // sin pestañas conectadas: liberar memoria

const status = { state: 'idle', loaded: 0, total: 0, backend: null, error: null };
const audioCache = new Map(); // clave -> { promise, url, speed, duration, job, inUse }
const jobs = []; // síntesis pendientes
const players = new Map(); // port -> Player
let busy = false;
let ownerSeq = 0;
let idleTimer = 0;
let lastBroadcast = 0;

// ---------- Estado ----------

function broadcast(force = false) {
  const now = performance.now();
  if (!force && now - lastBroadcast < 300) return;
  lastBroadcast = now;
  const snapshot = { ...status };
  for (const port of players.keys()) port.postMessage({ type: 'status', status: snapshot });
  chrome.runtime.sendMessage({ type: 'sbn:neural-status', status: snapshot }).catch(() => {});
}

function setStatus(patch, force = true) {
  Object.assign(status, patch);
  broadcast(force);
}

async function init() {
  if (status.state === 'loading' || status.state === 'ready') return;
  setStatus({ state: 'loading', error: null });
  try {
    await engine.loadModel((loaded, total) => setStatus({ loaded, total }, false));
    setStatus({ state: 'ready', backend: engine.backend(), loaded: status.total });
    pump();
  } catch (err) {
    setStatus({ state: 'error', error: String(err?.message || err) });
    for (const job of jobs.splice(0)) job.reject(err);
  }
}

// ---------- Síntesis con caché y prioridad ----------

function cacheKey({ text, lang, voice, steps }) {
  return `${voice}|${lang}|${steps}|${text}`;
}

function synth(params, { priority, owner }) {
  const key = cacheKey(params);
  let entry = audioCache.get(key);
  if (entry) {
    audioCache.delete(key); // LRU: mover al final
    audioCache.set(key, entry);
    if (priority && entry.job) entry.job.priority = true;
    return entry.promise;
  }
  entry = { url: null, speed: params.speed, duration: 0, job: null, inUse: 0 };
  entry.promise = new Promise((resolve, reject) => {
    entry.job = { params, priority, owner, resolve, reject, entry, key };
    jobs.push(entry.job);
  });
  entry.promise.catch(() => audioCache.delete(key));
  audioCache.set(key, entry);
  evict();
  pump();
  return entry.promise;
}

function evict() {
  for (const [key, entry] of audioCache) {
    if (audioCache.size <= CACHE_LIMIT) break;
    if (entry.job || entry.inUse) continue;
    URL.revokeObjectURL(entry.url);
    audioCache.delete(key);
  }
}

// Descartar lo pre-generado de una pestaña que ya no lo necesita (p. ej. tras un salto).
function dropJobs(owner) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i];
    if (job.owner !== owner || job.priority) continue;
    jobs.splice(i, 1);
    audioCache.delete(job.key);
    job.reject(new Error('descartado'));
  }
}

async function pump() {
  if (busy || status.state !== 'ready' || !jobs.length) return;
  let i = jobs.findIndex((j) => j.priority);
  if (i < 0) i = 0;
  const [job] = jobs.splice(i, 1);
  busy = true;
  try {
    const { text, lang, voice, speed, steps } = job.params;
    const res = await engine.synthesize({ text, lang, voice, speed, steps: steps > 0 ? steps : engine.defaultSteps() });
    job.entry.url = URL.createObjectURL(new Blob([wavFile(res.wav, res.sampleRate)], { type: 'audio/wav' }));
    job.entry.duration = res.duration;
    job.entry.job = null;
    job.resolve(job.entry);
  } catch (err) {
    job.entry.job = null;
    job.reject(err);
  } finally {
    busy = false;
    pump();
  }
}

function wavFile(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ascii = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return buf;
}

// ---------- Reproducción ----------

class Player {
  constructor(post) {
    this.post = post;
    this.id = ++ownerSeq;
    this.audio = null;
    this.release = null;
    this.token = null;
  }

  async speak(m) {
    this.stop();
    const token = (this.token = m.id);
    let entry;
    try {
      entry = await synth(m, { priority: true, owner: this.id });
    } catch (err) {
      if (this.token === token) this.post({ type: 'error', id: m.id, error: String(err?.message || err) });
      return;
    }
    if (this.token !== token) return; // cancelado mientras se sintetizaba

    const audio = new Audio(entry.url);
    audio.preservesPitch = true;
    // Si el fragmento se pre-generó a otra velocidad, se ajusta sin cambiar el tono.
    audio.playbackRate = Math.min(3, Math.max(0.5, m.speed / entry.speed));
    audio.volume = Math.min(1, Math.max(0, m.volume ?? 1));
    entry.inUse++;
    let released = false;
    const release = () => {
      if (!released) entry.inUse--;
      released = true;
    };
    const finish = (msg) => {
      if (this.audio !== audio) return;
      this.audio = null;
      release();
      this.post(msg);
    };
    audio.addEventListener('playing', () => this.audio === audio && this.post({ type: 'start', id: m.id }), { once: true });
    audio.addEventListener('ended', () => finish({ type: 'end', id: m.id }));
    audio.addEventListener('error', () => finish({ type: 'error', id: m.id, error: 'No se pudo reproducir el audio' }));
    this.audio = audio;
    this.release = release;
    try {
      await audio.play();
    } catch (err) {
      finish({ type: 'error', id: m.id, error: String(err?.message || err) });
    }
  }

  stop() {
    this.token = null;
    const audio = this.audio;
    if (!audio) return;
    this.audio = null;
    audio.pause();
    audio.removeAttribute('src');
    this.release?.();
  }
}

// ---------- Conexiones ----------

function checkIdle() {
  clearTimeout(idleTimer);
  if (players.size) return;
  idleTimer = setTimeout(() => {
    if (players.size) return;
    if (status.state === 'loading') checkIdle(); // no cortar una descarga en curso
    else chrome.runtime.sendMessage({ type: 'sbn:neural-idle' }).catch(() => {});
  }, IDLE_CLOSE_MS);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const player = new Player((msg) => port.postMessage(msg));
  players.set(port, player);
  checkIdle();
  port.postMessage({ type: 'status', status: { ...status } });

  port.onMessage.addListener((m) => {
    if (m.type === 'speak') {
      player.speak(m);
    } else if (m.type === 'cancel') {
      player.stop();
      if (m.dropPrefetch) dropJobs(player.id);
    } else if (m.type === 'prefetch') {
      for (const text of m.texts) synth({ ...m, text }, { priority: false, owner: player.id }).catch(() => {});
    }
  });
  port.onDisconnect.addListener(() => {
    player.stop();
    dropJobs(player.id);
    players.delete(port);
    checkIdle();
  });
  init();
});

const testPlayer = new Player(() => {});
let testSeq = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sbn:neural-query') {
    sendResponse({ ...status });
  } else if (msg?.type === 'sbn:neural-retry') {
    init();
    sendResponse({ ...status });
  } else if (msg?.type === 'sbn:neural-test') {
    init();
    testPlayer.speak({ ...msg, id: `test-${++testSeq}` });
    sendResponse({ ok: true });
  }
});

init();
checkIdle();
