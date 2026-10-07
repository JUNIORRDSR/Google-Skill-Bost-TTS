// Orquestador: une transcripción, reloj del video, motor de voz y panel flotante.
(() => {
  const SBN = globalThis.SBN;
  if (!SBN || SBN.started) return;
  SBN.started = true;

  const DEFAULTS = globalThis.SBN_DEFAULTS;
  const YT_ORIGIN = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com$/;
  const TICK_MS = 200;
  const SCAN_MS = 1500;
  const STALE_MS = 3000; // sin noticias del video en este tiempo -> plan B (resaltado)
  const SEEK_JUMP = 1.2; // salto de tiempo (s) que se considera un "seek"
  const BUFFER_GRACE_MS = 800; // no pausar la voz por microcortes de buffering

  let settings = { ...DEFAULTS };
  const tracker = new SBN.TranscriptTracker();

  // Reloj del video, alimentado por el iframe de YouTube o por un <video> HTML5.
  const clock = { kind: null, t: 0, rate: 1, duration: NaN, playing: false, ended: false, buffering: false, at: 0 };
  let ytFrame = null; // { source, origin }
  const html5 = { el: null, mutedByUs: false };

  let mode = 'none'; // 'video' | 'highlight' | 'none'
  let lastHandledKey = null; // párrafo (segundo de inicio) que ya se mandó a la voz
  let lastHighlightKey; // undefined = aún no se ha observado ningún resaltado
  let wasPlaying = false;
  let notPlayingSince = 0;
  const activatedAt = new Map(); // párrafo -> instante (performance.now) en que se activó
  const prefetched = new Set(); // párrafos ya enviados a pre-generar con la voz neural
  const PREFETCH_AHEAD = 2;
  let narratorState = { status: 'idle', key: null, queued: 0, rate: settings.rate };
  let lastViewKey = '';

  const narrator = new SBN.Narrator({
    getBudget,
    onState: (state) => {
      narratorState = state;
      render();
    },
  });

  const overlay = new SBN.Overlay({
    onToggle: () => save({ enabled: !settings.enabled }),
    onMute: () => save({ muteOriginal: !settings.muteOriginal }),
    onRepeat: repeatCurrent,
  });

  // ---------- Reloj del video ----------

  function clockFresh() {
    return clock.kind !== null && performance.now() - clock.at < STALE_MS;
  }

  function videoNow() {
    return clock.playing ? clock.t + ((performance.now() - clock.at) / 1000) * clock.rate : clock.t;
  }

  function ingest(report, kind) {
    const wall = performance.now();
    const playing = !report.paused && !report.ended && !report.buffering;
    let seek = false;
    if (clock.kind === kind && wall - clock.at < STALE_MS) {
      // Rango plausible sin salto. Si la reproducción se pausó/reanudó entre dos reportes
      // (con la pestaña oculta llegan cada ~1 s) el tiempo real cae en cualquier punto intermedio.
      const elapsed = (wall - clock.at) / 1000;
      const end = Number.isFinite(report.duration) ? report.duration : Infinity;
      const predicted = Math.min(videoNow(), end);
      const lo = (clock.playing && playing ? predicted : clock.t) - SEEK_JUMP;
      const hi = clock.t + elapsed * Math.max(clock.rate, report.rate || 1) + SEEK_JUMP;
      seek = report.t < lo || report.t > hi;
    }
    clock.kind = kind;
    clock.t = report.t;
    clock.rate = report.rate || 1;
    clock.duration = report.duration;
    clock.ended = Boolean(report.ended);
    clock.buffering = Boolean(report.buffering);
    clock.playing = playing;
    clock.at = wall;
    if (seek) resetPlayback();
  }

  function wantMute() {
    return settings.enabled && settings.muteOriginal && tracker.found;
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__sbn !== 'yt-time' || !YT_ORIGIN.test(e.origin)) return;
    const want = wantMute();
    if (d.want !== want) e.source.postMessage({ __sbn: 'yt-cmd', mute: want }, e.origin);
    // Con varios reproductores, no cambiar de reloj mientras el actual está sonando.
    if (ytFrame && ytFrame.source !== e.source && clock.kind === 'youtube' && clockFresh() && clock.playing && d.paused) return;
    ytFrame = { source: e.source, origin: e.origin };
    ingest(d, 'youtube');
  });

  function pushMute() {
    if (ytFrame) ytFrame.source.postMessage({ __sbn: 'yt-cmd', mute: wantMute() }, ytFrame.origin);
    applyHtml5Mute();
  }

  function applyHtml5Mute() {
    const v = html5.el;
    if (!v) return;
    if (wantMute() && !v.muted) {
      v.muted = true;
      html5.mutedByUs = true;
    } else if (!wantMute() && html5.mutedByUs) {
      v.muted = false;
      html5.mutedByUs = false;
    }
  }

  function pollHtml5() {
    if (clock.kind === 'youtube' && clockFresh()) return;
    const v = tracker.primaryVideo();
    // Un <video> que nunca se reprodujo no sirve de reloj (puede ser ajeno al curso).
    if (!v || (v.paused && v.currentTime === 0 && !v.played?.length)) return;
    if (html5.el !== v) {
      if (html5.el && html5.mutedByUs) html5.el.muted = false;
      html5.el = v;
      html5.mutedByUs = false;
    }
    applyHtml5Mute();
    ingest(
      {
        t: v.currentTime,
        paused: v.paused,
        ended: v.ended,
        buffering: !v.paused && v.readyState < 3,
        rate: v.playbackRate,
        duration: v.duration,
      },
      'html5',
    );
  }

  // ---------- Sincronización ----------

  function resetPlayback() {
    narrator.stop(); // también descarta lo pre-generado pendiente
    lastHandledKey = null;
    activatedAt.clear();
    prefetched.clear();
  }

  // Pide audio neural del párrafo indicado y de los siguientes, para que suene sin espera.
  function prefetchFrom(key, includeCurrent) {
    if (settings.engine !== 'supertonic' || key === null) return;
    const keys = includeCurrent ? [key] : [];
    for (let k = key, i = 0; i < PREFETCH_AHEAD; i++) {
      k = tracker.nextKey(k);
      if (k === null) break;
      keys.push(k);
    }
    const missing = keys.filter((k) => !prefetched.has(k));
    if (!missing.length) return;
    if (narrator.prefetch(missing.map(itemFor))) missing.forEach((k) => prefetched.add(k));
  }

  function itemFor(key) {
    return { key, text: tracker.textOf(key) };
  }

  function startParagraph(key) {
    const fresh = lastHandledKey === null;
    const sequential = !fresh && tracker.nextKey(lastHandledKey) === key;
    lastHandledKey = key;
    activatedAt.set(key, performance.now());
    if (!tracker.textOf(key)) return;
    prefetched.add(key); // play() se encarga de este párrafo
    narrator.play(itemFor(key), { interrupt: !sequential || settings.onParagraphChange === 'interrupt' });
    prefetchFrom(key, false);
  }

  // Segundos reales que quedan hasta que empiece el párrafo siguiente.
  function getBudget(key) {
    const fresh = clockFresh();
    const next = tracker.nextKey(key);
    const end = next ?? (fresh && Number.isFinite(clock.duration) ? clock.duration : null);
    if (end === null) return null;
    if (fresh) return (end - videoNow()) / (clock.rate || 1);
    const at = activatedAt.get(key);
    if (at === undefined) return null;
    return end - key - (performance.now() - at) / 1000;
  }

  function videoTick() {
    const now = performance.now();
    // Antes de dar play (o en pausa) ir preparando el párrafo actual y los siguientes.
    if (narrator.status === 'idle') prefetchFrom(tracker.keyAt(videoNow() + 0.1) ?? tracker.keys[0], true);
    if (!clock.playing) {
      if (clock.ended) return; // dejar que termine de leer el último párrafo
      if (!notPlayingSince) notPlayingSince = now;
      const grace = clock.buffering ? BUFFER_GRACE_MS : 0;
      if (wasPlaying && now - notPlayingSince >= grace) {
        narrator.pause();
        wasPlaying = false;
      }
      return;
    }
    notPlayingSince = 0;
    if (!wasPlaying) {
      narrator.resume();
      wasPlaying = true;
    }
    const key = tracker.keyAt(videoNow() + 0.1);
    if (key !== null && key !== lastHandledKey) startParagraph(key);
  }

  function highlightTick() {
    if (narrator.status === 'idle') prefetchFrom(lastHighlightKey ?? tracker.keys[0] ?? null, true);
    const key = tracker.highlightedKey();
    if (key === null || key === lastHighlightKey) return;
    const first = lastHighlightKey === undefined;
    lastHighlightKey = key;
    // Sin reloj no sabemos si el video ya se reproduce: el primer resaltado solo se registra.
    if (first) {
      lastHandledKey = key;
      return;
    }
    startParagraph(key);
  }

  function tick() {
    pollHtml5();
    let next = 'none';
    if (settings.enabled && tracker.found) next = clockFresh() ? 'video' : 'highlight';
    if (next !== mode) {
      if (next === 'highlight') lastHighlightKey = undefined;
      // Al recuperar el reloj, leer el párrafo en curso si la voz está libre.
      if (next === 'video' && narrator.status === 'idle') lastHandledKey = null;
      mode = next;
      render();
    }
    if (mode === 'video') videoTick();
    else if (mode === 'highlight') highlightTick();
  }

  function rescan() {
    if (tracker.scan()) {
      resetPlayback();
      lastHighlightKey = undefined;
    }
    narrator.lang = document.documentElement.lang || narrator.lang;
    render();
  }

  function currentKey() {
    if (clockFresh()) return tracker.keyAt(videoNow() + 0.1) ?? tracker.keys[0] ?? null;
    return tracker.highlightedKey() ?? lastHandledKey ?? tracker.keys[0] ?? null;
  }

  function repeatCurrent() {
    if (!settings.enabled) return;
    const key = currentKey();
    if (key === null) return;
    narrator.stop();
    lastHandledKey = key;
    activatedAt.set(key, performance.now());
    narrator.play(itemFor(key), { interrupt: true });
  }

  // ---------- Ajustes ----------

  async function save(patch) {
    try {
      await chrome.storage.sync.set(patch); // onChanged aplicará el cambio
    } catch {
      applySettings(patch); // contexto de la extensión invalidado (p. ej. tras recargarla)
    }
  }

  function applySettings(patch) {
    const wasEnabled = settings.enabled;
    // La caché de audio neural depende de la voz y la calidad.
    if (['engine', 'neuralVoice', 'neuralSteps'].some((k) => k in patch && patch[k] !== settings[k])) prefetched.clear();
    settings = { ...settings, ...patch };
    narrator.configure(settings);
    if (wasEnabled && !settings.enabled) resetPlayback();
    if (!wasEnabled && settings.enabled) {
      lastHandledKey = null;
      lastHighlightKey = undefined;
      wasPlaying = false;
    }
    pushMute();
    render();
  }

  // ---------- Panel ----------

  function buildView() {
    const total = tracker.keys.length;
    let status;
    let warn = false;
    let speaking = false;
    if (!settings.enabled) {
      status = 'Desactivado';
    } else if (!narrator.supported) {
      status = 'Este navegador no tiene síntesis de voz';
      warn = true;
    } else if (narratorState.status === 'blocked') {
      status = 'Haz clic en la página para permitir la voz';
      warn = true;
    } else if (narratorState.status === 'speaking') {
      speaking = true;
      const rate = narratorState.rate.toLocaleString('es', { maximumFractionDigits: 2 });
      status = `Leyendo ${tracker.indexOf(narratorState.key) + 1}/${total} · ${rate}×`;
    } else if (narratorState.status === 'paused') {
      status = 'En pausa';
    } else {
      status = mode === 'highlight' ? 'Listo · siguiendo el resaltado' : 'Listo · reproduce el video';
    }
    return { enabled: settings.enabled, muteOriginal: settings.muteOriginal, status, warn, speaking, ...neuralDetail() };
  }

  // Línea secundaria del panel: estado de la voz neural.
  function neuralDetail() {
    if (!settings.enabled || settings.engine !== 'supertonic') return { detail: '' };
    const n = narratorState.neural || {};
    if (n.state === 'ready') return { detail: `Voz neural Supertonic · ${n.backend || ''}`.trim() };
    if (n.state === 'error') return { detail: 'Voz neural no disponible · voz del sistema', detailWarn: true };
    if (n.state === 'loading' && n.total && n.loaded < n.total) {
      return { detail: `Descargando voz neural · ${Math.floor((100 * n.loaded) / n.total)} %` };
    }
    if (n.state === 'loading') return { detail: 'Preparando voz neural…' };
    return { detail: 'Conectando voz neural…' };
  }

  function render() {
    if (!tracker.found || !settings.showOverlay) {
      overlay.hide();
      lastViewKey = '';
      return;
    }
    const view = buildView();
    const key = JSON.stringify(view);
    if (key === lastViewKey && overlay.host?.isConnected) return;
    lastViewKey = key;
    overlay.render(view);
  }

  function statusPayload() {
    const key = narratorState.key ?? currentKey();
    return {
      found: true,
      total: tracker.keys.length,
      index: key === null ? 0 : tracker.indexOf(key) + 1,
      mode,
      narrator: narratorState.status,
      enabled: settings.enabled,
      lang: narrator.lang,
      engine: settings.engine,
      neural: narratorState.neural ?? null,
    };
  }

  // ---------- Arranque ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!tracker.found) return; // responde el frame que tiene la transcripción
    if (msg?.type === 'sbn:status') {
      sendResponse(statusPayload());
    } else if (msg?.type === 'sbn:repeat') {
      repeatCurrent();
      sendResponse({ ok: true, ...statusPayload() });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const [k, { newValue }] of Object.entries(changes)) patch[k] = newValue ?? DEFAULTS[k];
    applySettings(patch);
  });

  // Chrome solo permite hablar tras una interacción del usuario con la página.
  const unblock = () => narrator.unblock();
  document.addEventListener('pointerdown', unblock, true);
  document.addEventListener('keydown', unblock, true);
  window.addEventListener('pagehide', () => window.speechSynthesis?.cancel());

  (async () => {
    try {
      settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
    } catch {
      // se usan los valores por defecto
    }
    narrator.configure(settings);
    rescan();
    setInterval(rescan, SCAN_MS);
    setInterval(tick, TICK_MS);
  })();
})();
