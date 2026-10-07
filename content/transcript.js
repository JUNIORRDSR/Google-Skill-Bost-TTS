// Detección de la transcripción de Google Skills: filas con marca de tiempo + texto.
// No depende de clases CSS concretas: busca marcas "00:07" en todo el DOM (incluido
// Shadow DOM) y agrupa las filas que comparten contenedor y van en orden ascendente.
(() => {
  const SBN = (globalThis.SBN ??= {});

  const TS_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;
  const SKIP = new Set(['script', 'style', 'template', 'noscript', 'svg', 'video', 'audio', 'iframe', 'canvas', 'select']);
  const INLINE = new Set(['b', 'i', 'em', 'strong', 'u', 'sup', 'sub', 'mark', 'small', 'abbr', 'code', 'q', 's']);
  const HINT_RE = /(?:^|[-_])(?:active|current|selected|highlight(?:ed)?|playing)$/i;
  const ARIA_ON = new Set(['true', 'page', 'step', 'location', 'time']);

  function parseTimestamp(text) {
    const m = TS_RE.exec(text.trim());
    if (!m) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    // Los content scripts pueden entrar también en shadow roots cerrados.
    if (el.localName.includes('-') && globalThis.chrome?.dom?.openOrClosedShadowRoot) {
      try {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Padre "plano": cruza del shadow root a su host.
  function parentOf(node) {
    const p = node.parentNode;
    if (!p || p.nodeType === Node.DOCUMENT_NODE) return null;
    if (p.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return p.host || null;
    return p;
  }

  function scanRoot(root, stamps, videos) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE && SKIP.has(node.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = node.data;
        if (data.length > 12 || !data.includes(':')) continue;
        const sec = parseTimestamp(data);
        const el = node.parentElement ?? node.parentNode?.host;
        if (sec !== null && el) stamps.push({ el, sec, label: data.trim() });
      } else {
        const sr = shadowOf(node);
        if (sr) scanRoot(sr, stamps, videos);
      }
    }
    for (const v of root.querySelectorAll('video')) videos.push(v);
  }

  function ancestors(el, depth) {
    const out = new Set();
    for (let n = el, i = 0; n && i < depth; n = parentOf(n), i++) out.add(n);
    return out;
  }

  // Quita marcas duplicadas dentro de la misma fila (p. ej. una copia para lectores de pantalla).
  function dedupe(stamps) {
    const kept = [];
    for (const s of stamps) {
      const near = ancestors(s.el, 4);
      const dup = kept.some((k) => k.sec === s.sec && [...ancestors(k.el, 4)].some((a) => near.has(a)));
      if (!dup) kept.push(s);
    }
    return kept;
  }

  // Fila = el ancestro más alto de la marca que no contiene ninguna otra marca.
  function buildRows(stamps) {
    const counts = new Map();
    const chains = stamps.map(({ el }) => {
      const chain = [];
      for (let n = el; n; n = parentOf(n)) {
        chain.push(n);
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      return chain;
    });
    return stamps.map((s, i) => {
      const chain = chains[i];
      let row = chain[0];
      for (let k = 1; k < chain.length && counts.get(chain[k]) === 1; k++) row = chain[k];
      return { sec: s.sec, label: s.label, row, container: parentOf(row) };
    });
  }

  function isVisible(el) {
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
  }

  // Entre todos los grupos de filas, la transcripción es el que va en orden ascendente
  // y está visible (descarta p. ej. duraciones en el menú "Contents").
  function pickGroup(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (!r.container) continue;
      if (!groups.has(r.container)) groups.set(r.container, []);
      groups.get(r.container).push(r);
    }
    let best = null;
    let bestScore = -1;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      let ascending = 0;
      for (let i = 1; i < group.length; i++) if (group[i].sec > group[i - 1].sec) ascending++;
      const sorted = ascending / (group.length - 1) >= 0.9;
      const visible = group.filter((r) => isVisible(r.row)).length;
      const score = (sorted ? 1000 : 0) + visible * 10 + group.length;
      if (score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    return bestScore >= 1000 ? best : null;
  }

  function deepText(node) {
    const parts = [];
    const visit = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push(n.data);
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.localName;
        if (SKIP.has(tag)) return;
        if (tag === 'slot') {
          const assigned = n.assignedNodes({ flatten: true });
          if (assigned.length) {
            assigned.forEach(visit);
            return;
          }
        }
        const block = !INLINE.has(tag);
        if (block) parts.push(' ');
        const sr = shadowOf(n);
        if (sr) visit(sr);
        else n.childNodes.forEach(visit);
        if (block) parts.push(' ');
      } else if (n.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        n.childNodes.forEach(visit);
      }
    };
    visit(node);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function rowText(row, label) {
    let text = (row.innerText || '').replace(/\s+/g, ' ').trim();
    // innerText no entra en Shadow DOM; si el recorrido profundo encuentra bastante más, usarlo.
    const deep = deepText(row);
    if (deep.length > text.length * 1.3 + 10) text = deep;
    return text
      .replaceAll(label, ' ')
      .replace(/^(?:[\s\-–—·:|]|(?:\d{1,2}:)?\d{1,2}:\d{2})+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasHint(row) {
    let checked = 0;
    const visit = (el, depth) => {
      if (checked++ > 15) return false;
      const aria = el.getAttribute('aria-current');
      if ((aria && ARIA_ON.has(aria)) || el.getAttribute('aria-selected') === 'true') return true;
      for (const c of el.classList) if (HINT_RE.test(c)) return true;
      if (depth >= 2) return false;
      for (const k of el.children) if (visit(k, depth + 1)) return true;
      return false;
    };
    return visit(row, 0);
  }

  // Firma visual de una fila; la fila resaltada es la que se sale del patrón común.
  function signature(row) {
    const parts = [];
    let count = 0;
    const visit = (el, depth) => {
      if (count++ > 12) return;
      const cs = getComputedStyle(el);
      parts.push(cs.backgroundColor, cs.borderLeftColor, cs.borderLeftWidth, cs.color, cs.fontWeight, cs.boxShadow);
      if (depth >= 2) return;
      const kids = shadowOf(el)?.children ?? el.children;
      for (const k of kids) visit(k, depth + 1);
    };
    visit(row, 0);
    return parts.join('|');
  }

  class TranscriptTracker {
    constructor() {
      this.reset();
    }

    reset() {
      this.url = location.href;
      this.items = new Map(); // segundo de inicio -> texto
      this.keys = [];
      this.rows = [];
      this.videos = [];
      this.highlightIdx = -1;
    }

    get found() {
      return this.keys.length > 0;
    }

    // Devuelve true si la transcripción cambió por completo (otra página u otro video).
    scan() {
      let replaced = false;
      if (location.href !== this.url) {
        this.reset();
        replaced = true;
      }
      const stamps = [];
      const videos = [];
      scanRoot(document, stamps, videos);
      this.videos = videos;

      const group = pickGroup(buildRows(dedupe(stamps)));
      if (!group) {
        this.rows = [];
        return replaced;
      }

      const fresh = new Map();
      for (const r of group) {
        const text = rowText(r.row, r.label);
        if (!text) continue;
        fresh.set(r.sec, fresh.has(r.sec) ? `${fresh.get(r.sec)} ${text}` : text);
      }

      let overlap = 0;
      let conflicts = 0;
      for (const [sec, text] of fresh) {
        if (!this.items.has(sec)) continue;
        overlap++;
        if (this.items.get(sec) !== text) conflicts++;
      }
      if (overlap && conflicts / overlap > 0.5) {
        this.items.clear();
        replaced = true;
      }
      for (const [sec, text] of fresh) this.items.set(sec, text);
      this.keys = [...this.items.keys()].sort((a, b) => a - b);
      this.rows = group;
      return replaced;
    }

    keyAt(t) {
      const keys = this.keys;
      let lo = 0;
      let hi = keys.length - 1;
      let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (keys[mid] <= t) {
          found = keys[mid];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return found;
    }

    indexOf(key) {
      return this.keys.indexOf(key);
    }

    nextKey(key) {
      const i = this.keys.indexOf(key);
      return i >= 0 && i + 1 < this.keys.length ? this.keys[i + 1] : null;
    }

    textOf(key) {
      return this.items.get(key) ?? '';
    }

    // Plan B cuando no hay tiempo del video: qué fila tiene el resaltado de la página.
    highlightedKey() {
      const rows = this.rows.filter((r) => r.row.isConnected);
      if (rows.length < 2) return null;

      const hinted = rows.filter((r) => hasHint(r.row));
      if (hinted.length === 1) return this._remember(rows, hinted[0]);

      if (rows.length < 3) return null;
      const i = this.highlightIdx;
      const sample = i >= 0 && i < rows.length ? rows.slice(Math.max(0, i - 6), i + 7) : rows.slice(0, 60);
      let hit = this._outlier(sample);
      // La pasada completa es cara (getComputedStyle por fila): como mucho cada 2 s.
      const now = performance.now();
      if (!hit && sample.length !== rows.length && now - (this._lastWidePass || 0) > 2000) {
        this._lastWidePass = now;
        hit = this._outlier(rows.slice(0, 150));
      }
      return hit ? this._remember(rows, hit) : null;
    }

    _outlier(rows) {
      if (rows.length < 3) return null;
      const sigs = rows.map((r) => signature(r.row));
      const freq = new Map();
      for (const s of sigs) freq.set(s, (freq.get(s) || 0) + 1);
      const unique = rows.filter((r, k) => freq.get(sigs[k]) === 1 && !r.row.matches(':hover'));
      return unique.length === 1 ? unique[0] : null;
    }

    _remember(rows, hit) {
      this.highlightIdx = rows.indexOf(hit);
      return hit.sec;
    }

    // El <video> HTML5 más grande y visible del documento (si el reproductor no es un iframe).
    primaryVideo() {
      let best = null;
      let bestArea = 0;
      for (const v of this.videos) {
        if (!v.isConnected) continue;
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          best = v;
          bestArea = area;
        }
      }
      return bestArea > 5000 ? best : null;
    }
  }

  SBN.TranscriptTracker = TranscriptTracker;
  SBN.parseTimestamp = parseTimestamp;
})();
