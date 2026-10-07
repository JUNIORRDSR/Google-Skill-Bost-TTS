// Se ejecuta dentro del iframe de YouTube incrustado en Google Skills.
// Informa a la página del tiempo/pausa/velocidad del video y aplica el silencio
// del audio original cuando el narrador lo pide.
(() => {
  if (window.top === window) return;

  const ALLOWED = /^https:\/\/(?:[a-z0-9-]+\.)*(?:skills\.google|cloudskillsboost\.google|qwiklabs\.com)$/i;
  const parentOrigin = location.ancestorOrigins?.[0];
  if (!parentOrigin || !ALLOWED.test(parentOrigin)) return;

  let video = null;
  let want = false; // ¿el narrador quiere el video silenciado?
  let mutedByUs = false;

  function applyMute() {
    if (!video) return;
    if (want && !video.muted) {
      video.muted = true;
      mutedByUs = true;
    } else if (!want && mutedByUs) {
      video.muted = false;
      mutedByUs = false;
    }
  }

  function report() {
    if (!video) return;
    window.parent.postMessage(
      {
        __sbn: 'yt-time',
        t: video.currentTime,
        paused: video.paused,
        ended: video.ended,
        buffering: !video.paused && video.readyState < 3,
        rate: video.playbackRate,
        duration: video.duration,
        muted: video.muted,
        want,
      },
      parentOrigin,
    );
  }

  function bind(v) {
    if (video === v) return;
    video = v;
    mutedByUs = false;
    for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'ended', 'waiting', 'playing']) {
      v.addEventListener(ev, report);
    }
    applyMute();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== parentOrigin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__sbn !== 'yt-cmd') return;
    if (typeof d.mute === 'boolean') {
      want = d.mute;
      applyMute();
      report();
    }
  });

  setInterval(() => {
    const v = document.querySelector('video');
    if (v) bind(v);
    if (!video) return;
    applyMute(); // YouTube puede restaurar su propio estado de volumen
    report();
  }, 250);
})();
