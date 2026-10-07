// Motor Supertonic 3 (ONNX Runtime Web: WebGPU, con CPU/WASM multi-hilo de respaldo).
// Port del pipeline oficial: supertone-inc/supertonic, web/helper.js (MIT).
// Modelo: Supertone/supertonic-3 (OpenRAIL-M), descargado una vez y guardado en Cache Storage.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';

const REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const MODEL_BASE = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${REVISION}`;
const CACHE_NAME = `supertonic3-${REVISION.slice(0, 7)}`;
const FILES = {
  cfg: { path: 'onnx/tts.json', size: 8253 },
  indexer: { path: 'onnx/unicode_indexer.json', size: 277676 },
  dp: { path: 'onnx/duration_predictor.onnx', size: 3700147 },
  enc: { path: 'onnx/text_encoder.onnx', size: 36416150 },
  est: { path: 'onnx/vector_estimator.onnx', size: 256534781 },
  voc: { path: 'onnx/vocoder.onnx', size: 101424195 },
};
const LANGS = new Set(['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi']);

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
// Hilos WASM (respaldo sin GPU): solo funcionan en el hilo principal; dentro de un Worker
// ORT se bloquea al crear el pool. Requieren aislamiento cross-origin (COOP/COEP).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

let model = null; // { cfg, indexer, dp, enc, est, voc, backend }
let loading = null;
const styles = new Map(); // id de voz -> { ttl, dp }

// ---------- Descarga con caché ----------

async function cachedBuffer(path, onBytes) {
  const url = `${MODEL_BASE}/${path}`;
  const cache = await caches.open(CACHE_NAME);
  let res = await cache.match(url);
  if (res) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }
  res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${path}`);
  // Guardar en caché mientras se cuenta el progreso, y releer: evita duplicar en memoria.
  const counter = new TransformStream({
    transform(chunk, ctl) {
      onBytes(chunk.byteLength);
      ctl.enqueue(chunk);
    },
  });
  await cache.put(url, new Response(res.body.pipeThrough(counter), { headers: { 'content-type': 'application/octet-stream' } }));
  return (await cache.match(url)).arrayBuffer();
}

async function cachedJson(path, onBytes) {
  return JSON.parse(new TextDecoder().decode(await cachedBuffer(path, onBytes)));
}

export function loadModel(onProgress) {
  loading ??= doLoad(onProgress).catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

async function doLoad(onProgress) {
  const total = Object.values(FILES).reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  let lastPost = 0;
  const onBytes = (n) => {
    loaded += n;
    const now = performance.now();
    if (now - lastPost > 250 || loaded >= total) {
      lastPost = now;
      onProgress?.(Math.min(loaded, total), total);
    }
  };

  const cfg = await cachedJson(FILES.cfg.path, onBytes);
  const indexer = await cachedJson(FILES.indexer.path, onBytes);
  const bytes = {};
  for (const key of ['dp', 'enc', 'est', 'voc']) bytes[key] = new Uint8Array(await cachedBuffer(FILES[key].path, onBytes));

  const create = async (ep) => {
    const opts = { executionProviders: [ep], graphOptimizationLevel: 'all' };
    const sessions = {};
    for (const key of ['dp', 'enc', 'est', 'voc']) sessions[key] = await ort.InferenceSession.create(bytes[key], opts);
    return sessions;
  };

  let sessions = null;
  let backend = 'wasm';
  if (await hasGpu()) {
    try {
      sessions = await create('webgpu');
      backend = 'webgpu';
    } catch (err) {
      console.warn('[Supertonic] WebGPU no disponible, se usa la CPU:', err);
    }
  }
  sessions ??= await create('wasm');
  model = { cfg, indexer, ...sessions, backend };

  // Calentamiento: la primera inferencia compila shaders/kernels y es varias veces más lenta.
  await synthesize({ text: 'Hola, esto es una prueba de voz.', lang: 'es', voice: 'F1', speed: 1, steps: 2 });
}

async function hasGpu() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function loadStyle(voice) {
  if (styles.has(voice)) return styles.get(voice);
  const json = await cachedJson(`voice_styles/${voice}.json`, () => {});
  const tensor = (s) => new ort.Tensor('float32', Float32Array.from(s.data.flat(Infinity)), s.dims);
  const style = { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) };
  styles.set(voice, style);
  return style;
}

// ---------- Texto ----------

const REPLACEMENTS = [
  ['–', '-'], ['‑', '-'], ['—', '-'], ['_', ' '], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['´', "'"], ['`', "'"], ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '], ['#', ' '], ['→', ' '], ['←', ' '],
];
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

function preprocess(text, lang) {
  let t = text.normalize('NFKD').replace(EMOJI, '');
  for (const [a, b] of REPLACEMENTS) t = t.replaceAll(a, b);
  t = t
    .replace(/[♥☆♡©\\]/g, '')
    .replaceAll('@', lang === 'es' ? ' arroba ' : ' at ')
    .replace(/ ([,.!?;:'])/g, '$1')
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(t)) t += '.';
  return `<${lang}>${t}</${lang}>`;
}

function textIds(text, indexer) {
  // Igual que el original: índice por unidad UTF-16 sobre su code point.
  const ids = new BigInt64Array(text.length);
  for (let j = 0; j < text.length; j++) {
    const cp = text.codePointAt(j);
    ids[j] = BigInt(cp < indexer.length ? indexer[cp] : -1);
  }
  return ids;
}

function randn(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(0.0001, Math.random());
    out[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
  }
  return out;
}

// ---------- Síntesis ----------

export async function synthesize({ text, lang, voice, speed, steps }) {
  const { cfg, indexer, dp, enc, est, voc } = model;
  const code = LANGS.has(lang) ? lang : 'en';
  const style = await loadStyle(voice);

  const ids = textIds(preprocess(text, code), indexer);
  const len = ids.length;
  const idsT = new ort.Tensor('int64', ids, [1, len]);
  const textMask = new ort.Tensor('float32', new Float32Array(len).fill(1), [1, 1, len]);

  const { duration } = await dp.run({ text_ids: idsT, style_dp: style.dp, text_mask: textMask });
  const seconds = duration.data[0] / Math.max(0.5, Math.min(2, speed));
  const { text_emb: textEmb } = await enc.run({ text_ids: idsT, style_ttl: style.ttl, text_mask: textMask });

  const sr = cfg.ae.sample_rate;
  const wavLen = Math.floor(seconds * sr);
  const chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
  const latentLen = Math.max(1, Math.ceil(wavLen / chunk));
  const latentDim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
  const totalStep = new ort.Tensor('float32', new Float32Array([steps]), [1]);

  let xt = randn(latentDim * latentLen);
  for (let step = 0; step < steps; step++) {
    const out = await est.run({
      noisy_latent: new ort.Tensor('float32', xt, [1, latentDim, latentLen]),
      text_emb: textEmb,
      style_ttl: style.ttl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
      total_step: totalStep,
    });
    xt = out.denoised_latent.data;
  }

  const { wav_tts: wavT } = await voc.run({ latent: new ort.Tensor('float32', xt, [1, latentDim, latentLen]) });
  const wav = wavT.data.slice(0, Math.min(wavT.data.length, wavLen));
  return { wav, sampleRate: sr, duration: wav.length / sr };
}

export function backend() {
  if (!model) return null;
  return model.backend === 'webgpu' ? 'GPU' : `CPU · ${ort.env.wasm.numThreads} hilos`;
}

// Pasos de difusión según el hardware: más pasos = voz más limpia pero más lenta.
export function defaultSteps() {
  return model?.backend === 'webgpu' ? 8 : 3;
}

export function isLoaded() {
  return Boolean(model);
}
