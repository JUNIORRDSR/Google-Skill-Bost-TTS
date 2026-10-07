importScripts('/shared/defaults.js');

const OFFSCREEN_URL = 'offscreen/neural.html';

async function syncBadge() {
  try {
    const { enabled = globalThis.SBN_DEFAULTS.enabled } = await chrome.storage.sync.get('enabled');
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
    await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  } catch {
    // sin distintivo no pasa nada
  }
}

// Documento offscreen donde corre la voz neural (Supertonic 3).
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Generar y reproducir la voz neural de la transcripción.',
    });
  } catch (err) {
    // Dos peticiones simultáneas: la segunda falla porque el documento ya existe.
    if (!String(err?.message).includes('single offscreen')) throw err;
  }
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // ya estaba cerrado
  }
}

// Completar ajustes que falten (instalación nueva o actualización con opciones nuevas).
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stored = await chrome.storage.sync.get(null);
    await chrome.storage.sync.set({ ...globalThis.SBN_DEFAULTS, ...stored });
  } catch (err) {
    console.error('[Skills Narrador] No se pudieron guardar los ajustes iniciales:', err);
  }
  await syncBadge();
});

chrome.runtime.onStartup.addListener(syncBadge);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sbn:neural-ensure') {
    (async () => {
      try {
        await ensureOffscreen();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === 'sbn:neural-idle') {
    closeOffscreen();
  } else if (msg?.type === 'sbn:neural-status' && msg.status?.state === 'ready') {
    chrome.storage.local.set({ neuralCached: true }).catch(() => {});
  }
  return undefined;
});

// Atajo de teclado: activar/desactivar el narrador.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-narrator') return;
  try {
    const { enabled = globalThis.SBN_DEFAULTS.enabled } = await chrome.storage.sync.get('enabled');
    await chrome.storage.sync.set({ enabled: !enabled });
  } catch (err) {
    console.error('[Skills Narrador] No se pudo cambiar el estado:', err);
  }
});

// Distintivo "OFF" sincronizado aunque el cambio venga del popup o del panel flotante.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'enabled' in changes) syncBadge();
});
