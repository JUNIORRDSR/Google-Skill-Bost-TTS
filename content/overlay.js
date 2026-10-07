// Panel flotante dentro de la página (Shadow DOM para no heredar ni romper estilos).
(() => {
  const SBN = (globalThis.SBN ??= {});

  const ICONS = {
    speaker:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    videoMuted:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    videoSound:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    repeat:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6.5 3.5V7.5h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    minimize:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      font: 13px/1.4 "Google Sans Text", "Google Sans", Roboto, system-ui, sans-serif;
      color: #1f1f1f; -webkit-font-smoothing: antialiased;
    }
    .card {
      width: 280px; padding: 12px 14px 12px; border-radius: 16px; background: #fff;
      box-shadow: 0 1px 2px rgba(60,64,67,.3), 0 4px 14px rgba(60,64,67,.16);
      transform-origin: bottom right; animation: in .18s cubic-bezier(.2,0,0,1);
    }
    @keyframes in { from { opacity: 0; transform: scale(.96) translateY(4px); } }
    .head { display: flex; align-items: center; gap: 10px; }
    .badge {
      width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
      background: #e8f0fe; color: #1a73e8; flex: none;
    }
    .badge svg { width: 20px; height: 20px; }
    .title { flex: 1; min-width: 0; }
    .name { font-weight: 500; font-size: 14px; font-family: "Google Sans", Roboto, system-ui, sans-serif; }
    .status { color: #5f6368; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status.warn, .detail.warn { color: #b3261e; }
    .detail { margin-top: 8px; color: #5f6368; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bars { display: inline-flex; gap: 2px; align-items: flex-end; height: 10px; margin-right: 6px; vertical-align: -1px; }
    .bars i { width: 2px; height: 100%; background: #1a73e8; border-radius: 1px; transform-origin: bottom; animation: eq .9s ease-in-out infinite; }
    .bars i:nth-child(2) { animation-delay: -.3s; }
    .bars i:nth-child(3) { animation-delay: -.6s; }
    @keyframes eq { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }
    .switch {
      position: relative; width: 36px; height: 20px; border-radius: 10px; border: 0; padding: 0;
      background: #dadce0; cursor: pointer; flex: none; transition: background .15s;
    }
    .switch::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s cubic-bezier(.2,0,0,1);
    }
    .switch[aria-checked="true"] { background: #1a73e8; }
    .switch[aria-checked="true"]::after { transform: translateX(16px); }
    .icon-btn {
      width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: #5f6368;
      display: grid; place-items: center; cursor: pointer; flex: none; margin-right: -6px;
    }
    .icon-btn:hover { background: #f1f3f4; }
    .icon-btn svg { width: 20px; height: 20px; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px 0 8px;
      border: 1px solid #dadce0; border-radius: 8px; background: #fff; color: #3c4043; cursor: pointer;
      font: 500 12px/1 "Google Sans", Roboto, system-ui, sans-serif;
    }
    .chip:hover { background: #f8f9fa; }
    .chip svg { width: 18px; height: 18px; }
    .chip[aria-pressed="true"] { background: #e8f0fe; border-color: #e8f0fe; color: #174ea6; }
    .chip:disabled { opacity: .5; cursor: default; }
    .fab {
      position: relative; width: 48px; height: 48px; border-radius: 16px; border: 0; cursor: pointer;
      background: #fff; color: #1a73e8; display: grid; place-items: center;
      box-shadow: 0 1px 2px rgba(60,64,67,.3), 0 4px 14px rgba(60,64,67,.16);
    }
    .fab svg { width: 24px; height: 24px; }
    .fab .dot {
      position: absolute; top: 9px; right: 9px; width: 8px; height: 8px; border-radius: 50%;
      background: #9aa0a6; border: 2px solid #fff;
    }
    .fab .dot.on { background: #1e8e3e; }
    button:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) {
      .card, .bars i { animation: none; }
      .switch, .switch::after { transition: none; }
    }
  `;

  class Overlay {
    constructor({ onToggle, onMute, onRepeat }) {
      this.handlers = { onToggle, onMute, onRepeat };
      this.host = null;
      this.minimized = false;
      this.view = null;
      this._restoreMinimized();
    }

    _mount() {
      if (this.host?.isConnected) return;
      this.host = document.createElement('skills-narrador-overlay');
      const root = this.host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>${CSS}</style>
        <div class="wrap">
          <div class="card" part="card">
            <div class="head">
              <div class="badge">${ICONS.speaker}</div>
              <div class="title">
                <div class="name">Narrador</div>
                <div class="status" aria-live="polite"></div>
              </div>
              <button class="switch" role="switch" aria-label="Activar narrador"></button>
              <button class="icon-btn min" title="Minimizar" aria-label="Minimizar">${ICONS.minimize}</button>
            </div>
            <div class="detail" hidden></div>
            <div class="actions">
              <button class="chip mute" title="Silenciar el audio original del video"></button>
              <button class="chip repeat" title="Volver a leer el párrafo actual">${ICONS.repeat}<span>Repetir</span></button>
            </div>
          </div>
          <button class="fab" title="Narrador" aria-label="Abrir narrador" hidden>${ICONS.speaker}<span class="dot"></span></button>
        </div>`;
      this.el = {
        card: root.querySelector('.card'),
        status: root.querySelector('.status'),
        detail: root.querySelector('.detail'),
        toggle: root.querySelector('.switch'),
        min: root.querySelector('.min'),
        mute: root.querySelector('.mute'),
        repeat: root.querySelector('.repeat'),
        fab: root.querySelector('.fab'),
        dot: root.querySelector('.dot'),
      };
      this.el.toggle.addEventListener('click', () => this.handlers.onToggle());
      this.el.mute.addEventListener('click', () => this.handlers.onMute());
      this.el.repeat.addEventListener('click', () => this.handlers.onRepeat());
      this.el.min.addEventListener('click', () => this._setMinimized(true));
      this.el.fab.addEventListener('click', () => this._setMinimized(false));
      // documentElement sobrevive a los reemplazos de <body> que hacen algunas SPA.
      document.documentElement.appendChild(this.host);
    }

    hide() {
      this.host?.remove();
    }

    render(view) {
      this._mount();
      this.view = view;
      const { el } = this;
      el.card.hidden = this.minimized;
      el.fab.hidden = !this.minimized;

      el.toggle.setAttribute('aria-checked', String(view.enabled));
      el.toggle.title = view.enabled ? 'Desactivar narrador' : 'Activar narrador';

      el.status.classList.toggle('warn', Boolean(view.warn));
      el.status.textContent = view.status;
      if (view.speaking) el.status.insertAdjacentHTML('afterbegin', '<span class="bars"><i></i><i></i><i></i></span>');
      el.detail.hidden = !view.detail;
      el.detail.textContent = view.detail || '';
      el.detail.classList.toggle('warn', Boolean(view.detailWarn));

      el.mute.setAttribute('aria-pressed', String(view.muteOriginal));
      el.mute.innerHTML = view.muteOriginal
        ? `${ICONS.videoMuted}<span>Video silenciado</span>`
        : `${ICONS.videoSound}<span>Audio del video</span>`;
      el.repeat.disabled = !view.enabled;

      el.dot.classList.toggle('on', view.enabled);
      el.fab.title = `Narrador · ${view.status}`;
    }

    _setMinimized(value) {
      this.minimized = value;
      try {
        chrome.storage.local.set({ overlayMinimized: value }).catch(() => {});
      } catch {
        // contexto de la extensión invalidado: solo se pierde el recuerdo del estado
      }
      if (this.view) this.render(this.view);
    }

    async _restoreMinimized() {
      try {
        const { overlayMinimized } = await chrome.storage.local.get('overlayMinimized');
        this.minimized = Boolean(overlayMinimized);
        if (this.view) this.render(this.view);
      } catch {
        // valor por defecto: expandido
      }
    }
  }

  SBN.Overlay = Overlay;
})();
