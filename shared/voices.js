// Elección de voz compartida por el content script y el popup.
globalThis.SBN_pickVoice = (voices, voiceURI, lang) => {
  const norm = (l) => (l || '').toLowerCase().replace('_', '-');
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen) return chosen;
  }
  const want = norm(lang) || 'es';
  const base = want.split('-')[0];
  const candidates = voices.filter((v) => norm(v.lang).startsWith(base));
  if (!candidates.length) return null;
  // Preferir voces naturales (Edge) o de Google, y el dialecto exacto de la página.
  const score = (v) =>
    (/natural|neural|online/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 3 : 0) + (norm(v.lang) === want ? 1 : 0);
  return candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
};
