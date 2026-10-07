const DEFAULTS = globalThis.SBN_DEFAULTS;
const $ = (id) => document.getElementById(id);

const CHECKS = ['enabled', 'muteOriginal', 'adaptiveRate', 'showOverlay'];
const RANGES = {
  rate: (v) => `${fmt(v)}×`,
  maxRate: (v) => `${fmt(v)}×`,
  pitch: (v) => fmt(v),
  volume: (v) => `${Math.round(v * 100)} %`,
};

const NEURAL_VOICES = [
  ['F1', 'Femenina 1'], ['F2', 'Femenina 2'], ['F3', 'Femenina 3'], ['F4', 'Femenina 4'], ['F5', 'Femenina 5'],
  ['M1', 'Masculina 1'], ['M2', 'Masculina 2'], ['M3', 'Masculina 3'], ['M4', 'Masculina 4'], ['M5', 'Masculina 5'],
];
const SAMPLE = 'Hola. Así sonará la transcripción mientras ves el video del curso.';

let settings = { ...DEFAULTS };
let pageLang = 'es';
let activeTabId = null;
let neural = null; // último estado del documento offscreen (null = no está en marcha)

function fmt(n) {
  return Number(n).toLocaleString('es', { maximumFractionDigits: 2 });
}

async function save(patch) {
  settings = { ...settings, ...patch };
  try {
    await chrome.storage.sync.set(patch);
  } catch (err) {
    console.error('No se pudo guardar:', err);
  }
}

// ---------- Voces ----------

function voiceLabel(v) {
  const lang = v.lang.replace('_', '-');
  return `${v.name} (${lang})${v.localService ? '' : ' · en línea'}`;
}

function fillVoices() {
  const voices = speechSynthesis.getVoices();
  const select = $('voice');
  const base = pageLang.toLowerCase().split('-')[0];
  const showAll = $('allVoices').checked;
  const list = voices
    .filter((v) => showAll || v.lang.toLowerCase().startsWith(base) || v.voiceURI === settings.voiceURI)
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));

  select.replaceChildren();
  select.append(new Option('Automática (la mejor disponible)', ''));
  for (const v of list) select.append(new Option(voiceLabel(v), v.voiceURI));
  select.value = list.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
  if (!list.length && voices.length) {
    select.append(new Option(`No hay voces para "${base}" — activa "todos los idiomas"`, '__none', false, false));
    select.lastElementChild.disabled = true;
  }
}

function testVoice() {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(SAMPLE);
  const voice = globalThis.SBN_pickVoice(speechSynthesis.getVoices(), settings.voiceURI, pageLang);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = pageLang;
  }
  u.rate = settings.rate;
  u.pitch = settings.pitch;
  u.volume = settings.volume;
  speechSynthesis.speak(u);
}

// ---------- Voz neural (Supertonic 3) ----------

function langCode() {
  return pageLang.toLowerCase().split('-')[0];
}

async function ensureNeural() {
  const res = await chrome.runtime.sendMessage({ type: 'sbn:neural-ensure' });
  if (!res?.ok) throw new Error(res?.error || 'No se pudo iniciar la voz neural');
}

async function testNeural() {
  try {
    await ensureNeural();
    await chrome.runtime.sendMessage({
      type: 'sbn:neural-test',
      text: SAMPLE,
      lang: langCode(),
      voice: settings.neuralVoice,
      steps: settings.neuralSteps,
      speed: settings.rate,
      volume: settings.volume,
    });
  } catch (err) {
    neural = { state: 'error', error: String(err?.message || err) };
  }
  refreshNeural();
}

async function refreshNeural() {
  if (settings.engine !== 'supertonic') return;
  try {
    neural = (await chrome.runtime.sendMessage({ type: 'sbn:neural-query' })) ?? null;
  } catch {
    neural = null; // el documento offscreen no está abierto
  }
  renderNeural();
}

const mb = (bytes) => Math.round(bytes / 1048576);

async function renderNeural() {
  const text = $('neuralText');
  const action = $('neuralAction');
  const bar = $('neuralProgress');
  action.hidden = true;
  bar.hidden = true;
  let state = 'idle';
  if (neural?.state === 'ready') {
    state = 'ok';
    text.textContent = `Lista · se genera en tu equipo (${neural.backend})`;
  } else if (neural?.state === 'loading') {
    state = 'busy';
    if (neural.total && neural.loaded < neural.total) {
      text.textContent = `Descargando ${mb(neural.loaded)} de ${mb(neural.total)} MB (solo la primera vez)`;
      bar.hidden = false;
      bar.value = neural.loaded / neural.total;
    } else {
      text.textContent = 'Preparando la voz neural…';
    }
  } else if (neural?.state === 'error') {
    state = 'error';
    text.textContent = `No se pudo cargar: ${neural.error}`;
    action.textContent = 'Reintentar';
    action.hidden = false;
  } else {
    let cached = false;
    try {
      ({ neuralCached: cached = false } = await chrome.storage.local.get('neuralCached'));
    } catch {
      // sin datos
    }
    text.textContent = cached ? 'Descargada · se activa al abrir un video' : 'Se descargará (≈380 MB) al abrir un video';
    if (!cached) {
      action.textContent = 'Descargar ahora';
      action.hidden = false;
    }
  }
  $('neuralStatus').dataset.state = state;
}

function applyEngineUI() {
  const neuralOn = settings.engine === 'supertonic';
  for (const b of document.querySelectorAll('.segmented [data-engine]')) {
    b.setAttribute('aria-checked', String(b.dataset.engine === settings.engine));
  }
  $('neuralPanel').hidden = !neuralOn;
  $('browserPanel').hidden = neuralOn;
  $('pitchRow').hidden = neuralOn; // Supertonic no tiene control de tono
  if (neuralOn) refreshNeural();
}

// ---------- Estado de la pestaña ----------

function showStatus(state, title, detail = '') {
  $('status').dataset.state = state;
  $('statusTitle').textContent = title;
  $('statusDetail').textContent = detail;
}

function describe(res) {
  const where = res.mode === 'highlight' ? 'según el resaltado' : 'sincronizado';
  const reading =
    res.narrator === 'speaking'
      ? `Párrafo ${res.index} de ${res.total}`
      : res.narrator === 'paused'
        ? 'En pausa'
        : res.narrator === 'blocked'
          ? 'Haz clic en la página para permitir la voz'
          : `${res.total} párrafos`;
  return res.enabled ? `${reading} · ${where}` : `${res.total} párrafos · narrador desactivado`;
}

async function refreshStatus() {
  if (activeTabId === null) return;
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, { type: 'sbn:status' });
    if (!res?.found) throw new Error('sin transcripción');
    if (res.lang && res.lang !== pageLang) {
      pageLang = res.lang;
      fillVoices();
    }
    showStatus('ok', 'Transcripción detectada', describe(res));
    $('repeat').disabled = !res.enabled;
  } catch {
    showStatus(
      'missing',
      'No hay transcripción en esta pestaña',
      'Abre un video de Google Skills con la transcripción visible. Si acabas de instalar la extensión, recarga la página.',
    );
    $('repeat').disabled = true;
  }
}

// ---------- Inicio ----------

async function init() {
  try {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
  } catch {
    // valores por defecto
  }

  for (const id of CHECKS) {
    $(id).checked = Boolean(settings[id]);
    $(id).addEventListener('change', (e) => {
      save({ [id]: e.target.checked });
      if (id === 'adaptiveRate') $('maxRateRow').hidden = !e.target.checked;
      if (id === 'enabled') setTimeout(refreshStatus, 150);
    });
  }
  $('maxRateRow').hidden = !settings.adaptiveRate;

  for (const [id, format] of Object.entries(RANGES)) {
    const input = $(id);
    const out = $(`${id}Out`);
    input.value = settings[id];
    out.textContent = format(settings[id]);
    input.addEventListener('input', () => {
      out.textContent = format(Number(input.value));
    });
    input.addEventListener('change', () => save({ [id]: Number(input.value) }));
  }

  $('onParagraphChange').value = settings.onParagraphChange;
  $('onParagraphChange').addEventListener('change', (e) => save({ onParagraphChange: e.target.value }));

  $('voice').addEventListener('change', (e) => save({ voiceURI: e.target.value }));
  $('allVoices').addEventListener('change', fillVoices);
  speechSynthesis.addEventListener('voiceschanged', fillVoices);
  fillVoices();

  for (const [id, label] of NEURAL_VOICES) $('neuralVoice').append(new Option(label, id));
  $('neuralVoice').value = settings.neuralVoice;
  $('neuralVoice').addEventListener('change', (e) => save({ neuralVoice: e.target.value }));
  $('neuralSteps').value = String(settings.neuralSteps);
  $('neuralSteps').addEventListener('change', (e) => save({ neuralSteps: Number(e.target.value) }));
  for (const btn of document.querySelectorAll('.test')) {
    btn.addEventListener('click', () => (settings.engine === 'supertonic' ? testNeural() : testVoice()));
  }
  for (const b of document.querySelectorAll('.segmented [data-engine]')) {
    b.addEventListener('click', async () => {
      await save({ engine: b.dataset.engine });
      applyEngineUI();
    });
  }
  $('neuralAction').addEventListener('click', async () => {
    try {
      await ensureNeural();
      await chrome.runtime.sendMessage({ type: 'sbn:neural-retry' });
    } catch {
      // se mostrará el error en el siguiente refresco
    }
    refreshNeural();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'sbn:neural-status') return;
    neural = msg.status;
    renderNeural();
  });
  applyEngineUI();

  $('repeat').addEventListener('click', async () => {
    if (activeTabId === null) return;
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'sbn:repeat' });
    } catch {
      // la pestaña ya no tiene la transcripción
    }
    refreshStatus();
  });

  $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  try {
    const [cmd] = (await chrome.commands.getAll()).filter((c) => c.name === 'toggle-narrator');
    $('shortcut').textContent = cmd?.shortcut ? `Atajo: ${cmd.shortcut}` : 'Atajo: sin asignar';
  } catch {
    // sin información del atajo
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
  } catch {
    activeTabId = null;
  }
  await refreshStatus();
  setInterval(() => {
    refreshStatus();
    refreshNeural();
  }, 1000);
}

init();
