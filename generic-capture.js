/* global chrome */
(function () {
  'use strict';

  if (globalThis.__genericCaptureLoaded) return;
  globalThis.__genericCaptureLoaded = true;

  const STATE_KEY = '__genericCaptureState';

  function defaultState() {
    return {
      running: false,
      timerId: null,
      passTimerId: null,
      seenKeys: new Set(),
      onScroll: null,
      observer: null
    };
  }

  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = defaultState();
  }

  function state() {
    return globalThis[STATE_KEY];
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(value, size) {
    if (!value) return '';
    const s = String(value);
    if (s.length <= size) return s;
    return s.slice(0, size);
  }

  function scheduleCapturePass(delayMs) {
    const st = state();
    if (!st.running) return;
    if (st.passTimerId) clearTimeout(st.passTimerId);
    st.passTimerId = setTimeout(() => {
      runCapturePass().catch(() => {});
    }, typeof delayMs === 'number' ? delayMs : 300);
  }

  function detachListeners() {
    const st = state();
    if (st.onScroll) {
      window.removeEventListener('scroll', st.onScroll, true);
    }
    if (st.observer) {
      st.observer.disconnect();
    }
    st.onScroll = null;
    st.observer = null;
  }

  function attachListeners() {
    const st = state();
    if (st.onScroll) return;

    st.onScroll = function () {
      scheduleCapturePass(250);
    };
    window.addEventListener('scroll', st.onScroll, true);

    st.observer = new MutationObserver(function () {
      scheduleCapturePass(250);
    });
    st.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function keyOf(item) {
    if (item.type === 'link') {
      return `link|${item.href}|${item.linkText}|${item.context}`;
    }
    return `text|${item.text}|${item.context}|${item.tag}`;
  }

  function extractLinks() {
    const items = [];
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const a of links) {
      const href = a.href || '';
      if (!href) continue;
      const linkText = normalizeText(a.textContent || a.getAttribute('aria-label') || '');
      const context = normalizeText(a.closest('section, article, main, nav, header, footer, div')?.textContent || '').slice(0, 220);
      items.push({
        source: 'generic_capture',
        capturedAt: new Date().toISOString(),
        type: 'link',
        href,
        linkText: truncate(linkText, 500),
        text: truncate(linkText, 500),
        tag: 'a',
        context,
        pageTitle: document.title || '',
        pageUrl: location.href
      });
    }
    return items;
  }

  function extractTextBlocks() {
    const items = [];
    const selectors = 'h1,h2,h3,h4,h5,h6,p,li,span,article,section,blockquote,td,th';
    const nodes = Array.from(document.querySelectorAll(selectors));
    for (const el of nodes) {
      if (!el || !el.textContent) continue;
      const text = normalizeText(el.textContent);
      if (!text || text.length < 8) continue;
      if (text.length > 1200) continue;
      items.push({
        source: 'generic_capture',
        capturedAt: new Date().toISOString(),
        type: 'text',
        text: truncate(text, 1200),
        href: '',
        linkText: '',
        tag: el.tagName.toLowerCase(),
        context: '',
        pageTitle: document.title || '',
        pageUrl: location.href
      });
    }
    return items;
  }

  async function persist(items) {
    const existing = await chrome.storage.local.get(['genericCapturedData']);
    const prev = Array.isArray(existing.genericCapturedData) ? existing.genericCapturedData : [];

    const byKey = new Map();
    for (const row of prev) {
      byKey.set(keyOf(row), row);
    }

    let added = 0;
    for (const row of items) {
      const k = keyOf(row);
      if (!k || byKey.has(k)) continue;
      byKey.set(k, row);
      added += 1;
    }

    const merged = Array.from(byKey.values());
    await chrome.storage.local.set({
      genericCapturedData: merged,
      genericCapturedUpdatedAt: Date.now(),
      genericPageLabel: document.title || location.hostname || 'generic-capture'
    });

    return { total: merged.length, added, updated: 0 };
  }

  async function runCapturePass() {
    const links = extractLinks();
    const texts = extractTextBlocks();
    const all = links.concat(texts);
    const result = await persist(all);
    return result;
  }

  async function startCapture() {
    const st = state();
    if (st.running) {
      const existing = await chrome.storage.local.get(['genericCapturedData']);
      return { running: true, total: Array.isArray(existing.genericCapturedData) ? existing.genericCapturedData.length : 0 };
    }
    st.running = true;
    await chrome.storage.local.set({ genericCaptureRunning: true, genericCapturedUpdatedAt: Date.now() });
    attachListeners();
    await runCapturePass();
    st.timerId = setInterval(() => {
      runCapturePass().catch(() => {});
    }, 1500);
    const existing = await chrome.storage.local.get(['genericCapturedData']);
    return { running: true, total: Array.isArray(existing.genericCapturedData) ? existing.genericCapturedData.length : 0 };
  }

  async function stopCapture() {
    const st = state();
    st.running = false;
    if (st.timerId) {
      clearInterval(st.timerId);
      st.timerId = null;
    }
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
      st.passTimerId = null;
    }
    detachListeners();
    await chrome.storage.local.set({ genericCaptureRunning: false, genericCapturedUpdatedAt: Date.now() });
    const existing = await chrome.storage.local.get(['genericCapturedData']);
    return { running: false, total: Array.isArray(existing.genericCapturedData) ? existing.genericCapturedData.length : 0 };
  }

  async function clearCapture() {
    state().seenKeys.clear();
    await chrome.storage.local.set({ genericCapturedData: [], genericCapturedUpdatedAt: Date.now() });
    return { total: 0 };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'genericCaptureStart') {
      startCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'genericCaptureStop') {
      stopCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'genericCaptureRefresh') {
      runCapturePass().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'genericCaptureClear') {
      clearCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['genericCaptureRunning']).then((s) => {
    if (s.genericCaptureRunning) {
      startCapture().catch(() => {});
    }
  }).catch(() => {});
})();
