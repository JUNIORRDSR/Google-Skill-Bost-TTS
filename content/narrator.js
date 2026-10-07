// Motor de voz: cola de párrafos, troceado en frases, velocidad adaptativa y pausa/reanudación.
// Habla con la voz neural (Supertonic 3) cuando está lista; mientras tanto, o si falla,
// con la voz del sistema (Web Speech API).
(() => {
  const SBN = (globalThis.SBN ??= {});
  const synth = window.speechSynthesis;

  const MAX_CHUNK = 180; // las voces de red de Google se cortan en utterances largas
  const DEFAULT_CPS = 14; // caracteres por segundo a velocidad 1.0 (se aprende con el uso)
  const NEURAL_CPS = 12; // Supertonic habla algo más pausado que las voces del sistema
  const MAX_QUEUE = 2;

  function splitIntoChunks(text) {
    const sentences = text.split(/(?<=[.!?…;:])\s+/).filter(Boolean);
    const pieces = [];
    for (const s of sentences) {
      if (s.length <= MAX_CHUNK) {
        pieces.push(s);
        continue;
      }
      let buf = '';
      for (const word of s.split(/\s+/)) {
        if (buf && buf.length + word.length + 1 > MAX_CHUNK) {
          pieces.push(buf);
          buf = word;
        } else {
          buf = buf ? `${buf} ${word}` : word;
        }
      }
      if (buf) pieces.push(buf);
    }
    // Juntar frases cortas: cada utterance tiene una pequeña latencia de arranque.
    const chunks = [];
    for (const p of pieces) {
      const last = chunks[chunks.length - 1];
      if (last && last.length + p.length + 1 <= MAX_CHUNK) chunks[chunks.length - 1] = `${last} ${p}`;
      else chunks.push(p);
    }
    return chunks;
  }

  class Narrator {
    constructor({ getBudget, onState }) {
      this.getBudget = getBudget; // (key) => segundos reales hasta que empiece el siguiente párrafo, o null
      this.onState = onState;
      this.settings = { ...globalThis.SBN_DEFAULTS };
      this.lang = document.documentElement.lang || 'es';
      this.voices = synth ? synth.getVoices() : [];
      this.neural = new SBN.NeuralEngine(() => this._emit());
      this.queue = [];
      this.current = null; // { item, chunks, pos }
      this.paused = false;
      this.blocked = false; // Chrome exige una interacción previa con la página para hablar
      this.gen = 0; // invalida callbacks de utterances canceladas
      this.utterance = null; // referencia viva: Chrome pierde eventos si el objeto se recolecta
      this.lastCancel = 0;
      this.rate = this.settings.rate;
      this.speakingNeural = false;
      this.cps = {};
      this._saveCpsTimer = 0;

      if (synth) {
        synth.addEventListener('voiceschanged', () => {
          this.voices = synth.getVoices();
        });
      }
      this._loadCps();
    }

    get supported() {
      return Boolean(synth) || this.settings.engine === 'supertonic';
    }

    get busy() {
      return Boolean(this.current);
    }

    get status() {
      if (this.blocked) return 'blocked';
      if (this.current) return this.paused ? 'paused' : 'speaking';
      return 'idle';
    }

    configure(settings) {
      this.settings = { ...this.settings, ...settings };
      if (this.settings.engine !== 'supertonic') this.neural.stop();
      else if (this.current) this.neural.start(); // reconectar ya, no al siguiente párrafo
    }

    play(item, { interrupt }) {
      if (!item.text) return;
      if (this.settings.engine === 'supertonic') this.neural.start();
      if (interrupt || !this.current) {
        this._cancelSpeech();
        this.queue = [];
        this._start(item);
        return;
      }
      this.queue.push(item);
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this._emit();
    }

    // Pre-genera audio neural de los párrafos que vienen. Devuelve false si aún no se pudo enviar.
    prefetch(items) {
      if (this.settings.engine !== 'supertonic') return false;
      this.neural.start();
      if (!this.neural.connected) return false;
      const texts = items.filter((i) => i?.text).flatMap((i) => splitIntoChunks(i.text));
      if (texts.length) this.neural.prefetch(texts, this._neuralParams(this.settings.rate));
      return true;
    }

    stop() {
      this.queue = [];
      this.current = null;
      this.paused = false;
      this.blocked = false;
      this._cancelSpeech(true);
      this._emit();
    }

    pause() {
      if (this.paused) return;
      this.paused = true;
      // pause()/resume() de speechSynthesis falla con voces de red: se cancela
      // y al reanudar se repite la frase en curso (con la voz neural sale de la caché).
      if (this.current) this._cancelSpeech();
      this._emit();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      if (this.current) this._speakChunk();
      this._emit();
    }

    // Tras un clic del usuario, reintentar si Chrome bloqueó la voz.
    unblock() {
      if (!this.blocked) return;
      this.blocked = false;
      if (this.current && !this.paused) this._speakChunk();
      this._emit();
    }

    _start(item) {
      this.current = { item, chunks: splitIntoChunks(item.text), pos: 0 };
      if (!this.paused) this._speakChunk();
      if (this._useNeural()) this.neural.prefetch(this.current.chunks.slice(1), this._neuralParams(this.settings.rate));
      this._emit();
    }

    _cancelSpeech(dropPrefetch = false) {
      this.gen++;
      this.utterance = null;
      if (synth && (synth.speaking || synth.pending)) {
        synth.cancel();
        this.lastCancel = performance.now();
      }
      this.neural.cancel(dropPrefetch);
    }

    _useNeural() {
      return this.settings.engine === 'supertonic' && this.neural.ready;
    }

    _neuralParams(speed) {
      return {
        lang: (this.lang || 'es').toLowerCase().split('-')[0],
        voice: this.settings.neuralVoice,
        steps: this.settings.neuralSteps,
        speed,
        volume: this.settings.volume,
      };
    }

    _voiceKey(neural) {
      if (neural) return `supertonic:${this.settings.neuralVoice}`;
      return this._voice()?.voiceURI || 'default';
    }

    _voice() {
      if (!this.voices.length && synth) this.voices = synth.getVoices();
      return globalThis.SBN_pickVoice(this.voices, this.settings.voiceURI, this.lang);
    }

    _cpsAt1(neural) {
      return this.cps[this._voiceKey(neural)] || (neural ? NEURAL_CPS : DEFAULT_CPS);
    }

    _rateFor(item, remainingChars, neural) {
      const { rate: base, maxRate, adaptiveRate } = this.settings;
      const top = Math.max(base, maxRate);
      if (!adaptiveRate) return base;
      const budget = this.getBudget(item.key);
      if (budget == null) return base;
      if (budget <= 0.6) return top;
      const needed = remainingChars / (budget * 0.92) / this._cpsAt1(neural);
      return Math.round(Math.min(top, Math.max(base, needed)) * 100) / 100;
    }

    _speakChunk() {
      const cur = this.current;
      if (!cur || this.paused || this.blocked) return;

      if (cur.pos >= cur.chunks.length) {
        this.current = null;
        const next = this.queue.shift();
        if (next) this._start(next);
        else this._emit();
        return;
      }

      // Si la voz neural falló en esta frase, repetirla con la voz del sistema.
      const neural = this._useNeural() && cur.browserAt !== cur.pos;
      if (!neural && !synth) return;
      const text = cur.chunks[cur.pos];
      const remaining = cur.chunks.slice(cur.pos).reduce((n, c) => n + c.length, 0);
      const rate = this._rateFor(cur.item, remaining, neural);
      const cpsKey = this._voiceKey(neural);

      const gen = ++this.gen;
      let startedAt = 0;
      const expectedMs = (text.length / (this._cpsAt1(neural) * rate)) * 1000;
      const advance = () => {
        cur.pos++;
        this._speakChunk();
      };
      const watchdog = setTimeout(
        () => {
          // Chrome a veces se queda "hablando" sin emitir onend: forzar avance.
          if (gen !== this.gen) return;
          this._cancelSpeech();
          advance();
        },
        expectedMs * 3 + (neural ? 15000 : 6000),
      );

      const handlers = {
        onstart: () => {
          if (gen === this.gen) startedAt = performance.now();
        },
        onend: () => {
          if (gen !== this.gen) return;
          clearTimeout(watchdog);
          if (startedAt) this._learn(cpsKey, text.length, performance.now() - startedAt, rate);
          advance();
        },
        onerror: (error) => {
          if (gen !== this.gen) return;
          clearTimeout(watchdog);
          if (error === 'interrupted' || error === 'canceled') return;
          if (error === 'not-allowed') {
            this.blocked = true;
            this._emit();
            return;
          }
          // La voz neural se desconectó o falló: repetir esta frase con la voz del sistema.
          if (neural) {
            if (error !== 'disconnected' && error !== 'stopped') console.warn('[Skills Narrador] Voz neural:', error);
            cur.browserAt = cur.pos;
            this._speakChunk();
            return;
          }
          console.warn('[Skills Narrador] Error de voz:', error);
          advance();
        },
      };

      this.rate = rate;
      this.speakingNeural = neural;
      if (neural) this.neural.speak({ text, ...this._neuralParams(rate) }, handlers);
      else this._speakBrowser(text, rate, gen, handlers);
      this._emit();
    }

    _speakBrowser(text, rate, gen, handlers) {
      const voice = this._voice();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = this.lang;
      }
      u.rate = rate;
      u.pitch = this.settings.pitch;
      u.volume = this.settings.volume;
      u.onstart = handlers.onstart;
      u.onend = handlers.onend;
      u.onerror = (e) => handlers.onerror(e.error);
      this.utterance = u;
      const speak = () => {
        if (gen !== this.gen) return;
        if (synth.paused) synth.resume();
        synth.speak(u);
      };
      // Hablar justo después de cancel() a veces se descarta en Chrome.
      if (performance.now() - this.lastCancel < 120) setTimeout(speak, 120);
      else speak();
    }

    _learn(key, chars, ms, rate) {
      if (chars < 20 || ms < 800) return;
      const sample = chars / (ms / 1000) / rate;
      if (sample < 6 || sample > 30) return;
      const prev = this.cps[key] || (key.startsWith('supertonic:') ? NEURAL_CPS : DEFAULT_CPS);
      this.cps[key] = Math.round((prev * 0.7 + sample * 0.3) * 100) / 100;
      clearTimeout(this._saveCpsTimer);
      this._saveCpsTimer = setTimeout(() => {
        try {
          chrome.storage.local.set({ cpsByVoice: this.cps }).catch(() => {});
        } catch {
          // contexto de la extensión invalidado
        }
      }, 3000);
    }

    async _loadCps() {
      try {
        const { cpsByVoice } = await chrome.storage.local.get('cpsByVoice');
        if (cpsByVoice) this.cps = { ...cpsByVoice, ...this.cps };
      } catch {
        // sin datos aprendidos: se usa el valor por defecto
      }
    }

    _emit() {
      this.onState?.({
        status: this.status,
        key: this.current?.item.key ?? null,
        queued: this.queue.length,
        rate: this.rate,
        neuralVoice: this.speakingNeural,
        neural: this.neural.status,
      });
    }
  }

  SBN.Narrator = Narrator;
  SBN.splitIntoChunks = splitIntoChunks;
})();
