/* global chrome */
(function () {
  'use strict';

  if (globalThis.__searchListingCaptureLoaded) return;
  globalThis.__searchListingCaptureLoaded = true;

  const STATE_KEY = '__searchListingCaptureState';

  function detectEngine() {
    const host = location.hostname.toLowerCase();
    if (host.includes('google.')) return 'google';
    if (host.includes('bing.com')) return 'bing';
    if (host.includes('yahoo.com')) return 'yahoo';
    if (host.includes('duckduckgo.com')) return 'duckduckgo';
    return null;
  }

  function defaultState() {
    return {
      running: false,
      passTimerId: null,
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

  function normalizeUrl(value) {
    if (!value) return '';
    let u = normalizeText(value);
    // Remove breadcrumb arrows like " › something"
    const parts = u.split(' › ');
    return parts[0] || u;
  }

  function looksLikeUrl(text) {
    return /^https?:\/\//i.test(text);
  }

  function schedulePass(delayMs) {
    const st = state();
    if (!st.running) return;
    if (st.passTimerId) clearTimeout(st.passTimerId);
    st.passTimerId = setTimeout(() => {
      runCapturePass().catch(() => {});
    }, typeof delayMs === 'number' ? delayMs : 350);
  }

  function attachAutoCapture() {
    const st = state();
    if (st.observer) return;
    const root = document.body || document.documentElement;
    st.observer = new MutationObserver(() => {
      schedulePass(250);
    });
    st.observer.observe(root, { childList: true, subtree: true });
    window.addEventListener('scroll', () => schedulePass(250), true);
  }

  function detachAutoCapture() {
    const st = state();
    if (st.observer) {
      st.observer.disconnect();
      st.observer = null;
    }
  }

  function getSearchTerm() {
    const input = document.querySelector('input[name="q"], input[type="search"], textarea[name="q"]');
    if (input) {
      const value = normalizeText(input.value || input.getAttribute('value'));
      if (value) return value;
    }
    try {
      const u = new URL(location.href);
      const q = normalizeText(u.searchParams.get('q'));
      if (q) return q;
    } catch (_) {}
    return '';
  }

  // ====== Google ======
  function extractGoogleResults() {
    const results = [];
    const containers = document.querySelectorAll('.g, #search .MjjYud > div, #search div[data-snc], .rc');

    for (const container of containers) {
      // Skip ads and non-organic
      if (container.closest('.commercial-unit, .uEiDre, [data-text-ad]')) continue;

      let title = '';
      const titleEl = container.querySelector('h3.LC20lb, h3, h2 a');
      if (titleEl) title = normalizeText(titleEl.textContent);

      // Prefer actual href over cite text so URLs stay unique
      let url = '';
      const linkEl = container.querySelector('a[jsname="UWckNb"], a[href^="http"], h3 a[href^="http"]');
      if (linkEl) url = normalizeUrl(linkEl.href);
      if (!url) {
        const citeEl = container.querySelector('cite');
        if (citeEl) url = normalizeUrl(citeEl.textContent);
      }

      if (!url || !looksLikeUrl(url)) continue;

      results.push({ name: title, url, source: 'google_search' });
    }
    return results;
  }

  // ====== Bing ======
  function extractBingResults() {
    const results = [];
    const containers = document.querySelectorAll('li.b_algo');

    for (const container of containers) {
      let title = '';
      const titleEl = container.querySelector('h2 a');
      if (titleEl) title = normalizeText(titleEl.textContent);

      // Prefer actual href over cite text so URLs stay unique
      let url = '';
      const linkEl = container.querySelector('h2 a[href]');
      if (linkEl) url = normalizeUrl(linkEl.href);
      if (!url) {
        const citeEl = container.querySelector('.b_attribution cite');
        if (citeEl) url = normalizeUrl(citeEl.textContent);
      }

      if (!url || !looksLikeUrl(url)) continue;

      results.push({ name: title, url, source: 'bing_search' });
    }
    return results;
  }

  // ====== Yahoo ======
  function extractYahooResults() {
    const results = [];
    const containers = document.querySelectorAll('.algo, li .algo');

    for (const container of containers) {
      let title = '';
      const titleEl = container.querySelector('h3.title, h3');
      if (titleEl) title = normalizeText(titleEl.textContent);

      let url = '';
      // Yahoo shows URL text inside the title link area
      const linkEl = container.querySelector('.compTitle a[href]');
      if (linkEl) {
        // Look for text nodes that look like URLs
        const allText = normalizeText(linkEl.textContent);
        const lines = allText.split(/\s+/).filter(Boolean);
        for (const line of lines) {
          if (looksLikeUrl(line)) {
            url = normalizeUrl(line);
            break;
          }
        }
      }
      // Fallback: any https in the container
      if (!url) {
        const match = normalizeText(container.textContent).match(/(https?:\/\/[^\s]+)/);
        if (match) url = normalizeUrl(match[1]);
      }

      if (!url || !looksLikeUrl(url)) continue;

      results.push({ name: title, url, source: 'yahoo_search' });
    }
    return results;
  }

  // ====== DuckDuckGo ======
  function extractDDGResults() {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="result"], article[data-nrn="result"]');

    for (const article of articles) {
      let title = '';
      let titleLink = null;

      const titleSpan = article.querySelector('h2 a span');
      if (titleSpan) {
        title = normalizeText(titleSpan.textContent);
        titleLink = titleSpan.closest('a');
      }
      if (!title) {
        const titleEl = article.querySelector('a[data-testid="result-title-a"]');
        if (titleEl) {
          title = normalizeText(titleEl.textContent);
          titleLink = titleEl;
        }
      }

      let url = '';
      const urlEl = article.querySelector('a[data-testid="result-extras-url-link"]');
      if (urlEl) {
        // Use actual href first so URLs stay unique (textContent shows breadcrumbs)
        url = normalizeUrl(urlEl.href || urlEl.textContent);
      }
      if (!url && titleLink) {
        url = normalizeUrl(titleLink.href);
      }

      if (!url || !looksLikeUrl(url)) continue;

      results.push({ name: title, url, source: 'duckduckgo_search' });
    }
    return results;
  }

  function extractAllResults() {
    const engine = detectEngine();
    switch (engine) {
      case 'google': return extractGoogleResults();
      case 'bing': return extractBingResults();
      case 'yahoo': return extractYahooResults();
      case 'duckduckgo': return extractDDGResults();
      default: return [];
    }
  }

  // ====== Persistence ======
  function resultKey(rec) {
    return normalizeText(rec.url).toLowerCase();
  }

  async function persist(rows) {
    const existing = await chrome.storage.local.get(['searchListingData']);
    const prev = Array.isArray(existing.searchListingData) ? existing.searchListingData : [];
    const byKey = new Map();
    for (const row of prev) byKey.set(resultKey(row), row);

    let added = 0;
    let updated = 0;
    for (const row of rows) {
      const key = resultKey(row);
      if (!key) continue;
      const old = byKey.get(key);
      if (!old) {
        byKey.set(key, row);
        added += 1;
      } else {
        const merged = { ...old };
        if (row.name && !merged.name) merged.name = row.name;
        if (row.source && !merged.source) merged.source = row.source;
        merged.capturedAt = row.capturedAt;
        if (JSON.stringify(merged) !== JSON.stringify(old)) {
          byKey.set(key, merged);
          updated += 1;
        }
      }
    }

    const mergedRows = Array.from(byKey.values());
    await chrome.storage.local.set({
      searchListingData: mergedRows,
      searchListingUpdatedAt: Date.now(),
      searchListingSearchTerm: getSearchTerm() || 'search-listing'
    });
    return { total: mergedRows.length, added, updated };
  }

  async function runCapturePass() {
    const engine = detectEngine();
    if (!engine) {
      return { added: 0, updated: 0, total: 0, warning: 'Not on a supported search engine page' };
    }

    const rows = extractAllResults();
    const batch = rows.map(r => ({
      source: r.source,
      capturedAt: new Date().toISOString(),
      name: r.name,
      url: r.url,
      pageUrl: location.href,
      pageTitle: document.title || ''
    }));

    let persisted = { total: 0, added: 0, updated: 0 };
    if (batch.length) {
      persisted = await persist(batch);
    } else {
      const existing = await chrome.storage.local.get(['searchListingData']);
      persisted.total = Array.isArray(existing.searchListingData) ? existing.searchListingData.length : 0;
    }

    chrome.runtime.sendMessage({ action: 'capturedDataUpdated', source: 'search_listing', total: persisted.total, added: persisted.added, updated: persisted.updated }, () => {
      if (chrome.runtime.lastError) { /* popup closed */ }
    });

    return persisted;
  }

  async function startCapture() {
    const st = state();
    if (st.running) {
      const existing = await chrome.storage.local.get(['searchListingData']);
      return { running: true, total: Array.isArray(existing.searchListingData) ? existing.searchListingData.length : 0 };
    }
    st.running = true;
    await chrome.storage.local.set({ searchListingRunning: true, searchListingUpdatedAt: Date.now() });
    attachAutoCapture();
    await runCapturePass();
    const existing = await chrome.storage.local.get(['searchListingData']);
    return { running: true, total: Array.isArray(existing.searchListingData) ? existing.searchListingData.length : 0 };
  }

  async function stopCapture() {
    const st = state();
    st.running = false;
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
      st.passTimerId = null;
    }
    detachAutoCapture();
    await chrome.storage.local.set({ searchListingRunning: false, searchListingUpdatedAt: Date.now() });
    const existing = await chrome.storage.local.get(['searchListingData']);
    return { running: false, total: Array.isArray(existing.searchListingData) ? existing.searchListingData.length : 0 };
  }

  async function clearCapture() {
    await chrome.storage.local.set({ searchListingData: [], searchListingUpdatedAt: Date.now() });
    return { total: 0 };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'searchListingStart') {
      startCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'searchListingStop') {
      stopCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'searchListingRefresh') {
      runCapturePass().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'searchListingClear') {
      clearCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'searchListingStatus') {
      chrome.storage.local.get(['searchListingData', 'searchListingRunning']).then((s) => {
        sendResponse({
          running: Boolean(s.searchListingRunning),
          total: Array.isArray(s.searchListingData) ? s.searchListingData.length : 0
        });
      });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['searchListingRunning']).then((s) => {
    if (s.searchListingRunning) {
      startCapture().catch(() => {});
    }
  }).catch(() => {});
})();
