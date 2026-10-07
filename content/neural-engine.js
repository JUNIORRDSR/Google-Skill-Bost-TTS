// Cliente de la voz neural: habla con el documento offscreen (Supertonic 3) por un Port.
(() => {
  const SBN = (globalThis.SBN ??= {});
  const PORT_NAME = 'sbn-neural';
  const RETRY_MS = 5000;

  class NeuralEngine {
    constructor(onStatus) {
      this.onStatus = onStatus;
      this.port = null;
      this.connecting = null;
      this.wanted = false;
      this.status = { state: 'off' };
      this.handlers = new Map(); // id -> { onstart, onend, onerror }
      this.seq = 0;
      this.retryTimer = 0;
    }

    get connected() {
      return Boolean(this.port);
    }

    get ready() {
      return Boolean(this.port) && this.status.state === 'ready';
    }

    start() {
      this.wanted = true;
      if (this.port || this.connecting) return;
      this.connecting = this._connect().finally(() => {
        this.connecting = null;
      });
    }

    stop() {
      this.wanted = false;
      clearTimeout(this.retryTimer);
      const port = this.port;
      this.port = null;
      try {
        port?.disconnect();
      } catch {
        // ya desconectado
      }
      this._failAll('stopped');
      this._setStatus({ state: 'off' });
    }

    speak(params, handlers) {
      const id = ++this.seq;
      this.handlers.set(id, handlers);
      try {
        this.port.postMessage({ type: 'speak', id, ...params });
      } catch {
        // Puerto muerto sin onDisconnect: darlo por perdido para que se use la voz del sistema.
        this.handlers.delete(id);
        this.port = null;
        this._setStatus({ state: 'off' });
        this._retry();
        handlers.onerror?.('disconnected');
      }
    }

    cancel(dropPrefetch = false) {
      this.handlers.clear();
      this._post({ type: 'cancel', dropPrefetch });
    }

    prefetch(texts, params) {
      this._post({ type: 'prefetch', texts, ...params });
    }

    async _connect() {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'sbn:neural-ensure' });
        if (!res?.ok) throw new Error(res?.error || 'el service worker no respondió');
        if (!this.wanted) return;
        const port = chrome.runtime.connect({ name: PORT_NAME });
        this.port = port;
        port.onMessage.addListener((m) => this._onMessage(m));
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (this.port !== port) return;
          this.port = null;
          this._failAll('disconnected');
          this._setStatus({ state: 'off' });
          this._retry();
        });
      } catch (err) {
        this._setStatus({ state: 'error', error: String(err?.message || err) });
        this._retry();
      }
    }

    _retry() {
      // Sin chrome.runtime.id la extensión se recargó: este script quedó huérfano.
      if (!this.wanted || !chrome.runtime?.id) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.start(), RETRY_MS);
    }

    _onMessage(m) {
      if (m.type === 'status') {
        this._setStatus(m.status);
        return;
      }
      const h = this.handlers.get(m.id);
      if (!h) return;
      if (m.type === 'start') {
        h.onstart?.();
      } else if (m.type === 'end') {
        this.handlers.delete(m.id);
        h.onend?.();
      } else if (m.type === 'error') {
        this.handlers.delete(m.id);
        h.onerror?.(m.error);
      }
    }

    _post(msg) {
      try {
        this.port?.postMessage(msg);
      } catch {
        // el onDisconnect se encarga
      }
    }

    _failAll(reason) {
      const pending = [...this.handlers.values()];
      this.handlers.clear();
      for (const h of pending) h.onerror?.(reason);
    }

    _setStatus(status) {
      this.status = { ...status };
      this.onStatus?.(this.status);
    }
  }

  SBN.NeuralEngine = NeuralEngine;
})();
