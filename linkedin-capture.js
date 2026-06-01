/* global chrome */
(function () {
  'use strict';

  if (globalThis.__linkedinCaptureLoaded) return;
  globalThis.__linkedinCaptureLoaded = true;

  const STATE_KEY = '__linkedinCaptureState';

  function defaultState() {
    return {
      running: false,
      timerId: null,
      passTimerId: null,
      seenKeys: new Set(),
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

  function truncate(value, max) {
    const text = normalizeText(value);
    if (text.length <= max) return text;
    return text.slice(0, max);
  }

  function normalizeLinkedInCompanyUrl(url) {
    const raw = normalizeText(url);
    if (!raw) return '';
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();
      let path = u.pathname || '';

      // Keep canonical company path only.
      const m = path.match(/\/company\/([^/]+)/i);
      if (m && m[1]) {
        path = `/company/${m[1]}/`;
      }

      path = path.replace(/\/+$/, '/') || '/';
      return `https://${host}${path}`.toLowerCase();
    } catch (_) {
      return raw.toLowerCase();
    }
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
    const root = getPrimaryContentRoot() || document.body || document.documentElement;
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
    const selectors = [
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[type="text"]'
    ];
    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (!input) continue;
      const value = normalizeText(input.value || input.getAttribute('value'));
      if (value) return value;
    }
    try {
      const u = new URL(location.href);
      const keywords = normalizeText(u.searchParams.get('keywords'));
      if (keywords) return keywords;
    } catch (_) {}
    return '';
  }

  function getPrimaryContentRoot() {
    return (
      document.querySelector('section[aria-label="Primary content"]') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function getCards() {
    const root = getPrimaryContentRoot();
    if (!root) return [];
    return Array.from(root.querySelectorAll('div[role="listitem"][componentkey], div[role="listitem"]'));
  }

  function uniq(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
  }

  function looksLikeFollowers(text) {
    return /followers?/i.test(text || '');
  }

  function looksLikeConnectionInsight(text) {
    return /(works here|connections? follow|follows? this page|in network)/i.test(text || '');
  }

  function isLikelyLocation(text) {
    if (!text) return false;
    if (looksLikeFollowers(text) || looksLikeConnectionInsight(text)) return false;
    if (/^[A-Z\s]{4,},\s*[A-Z\s]{2,}$/i.test(text)) return true;
    if (/,/.test(text)) return true;
    return false;
  }

  function extractFollowers(card) {
    const textPool = uniq(
      Array.from(card.querySelectorAll('span, p, a'))
        .map((el) => normalizeText(el.textContent))
    );
    for (const text of textPool) {
      const m = text.match(/(\d[\d.,]*\s*[KMB]?\+?\s*followers?)/i);
      if (m && m[1]) return normalizeText(m[1]);
    }
    return '';
  }

  function extractConnectionInsight(card) {
    const anchors = Array.from(card.querySelectorAll('a'));
    for (const a of anchors) {
      const txt = normalizeText(a.textContent);
      if (looksLikeConnectionInsight(txt)) return truncate(txt, 500);
    }
    const paras = Array.from(card.querySelectorAll('p, span'));
    for (const p of paras) {
      const txt = normalizeText(p.textContent);
      if (looksLikeConnectionInsight(txt)) return truncate(txt, 500);
    }
    return '';
  }

  function extractIndustryAndLocation(card, name) {
    const spans = uniq(Array.from(card.querySelectorAll('p span')).map((el) => normalizeText(el.textContent)));
    const filtered = spans.filter((text) => {
      if (!text) return false;
      if (text === name) return false;
      if (text.length < 2) return false;
      if (looksLikeFollowers(text)) return false;
      if (looksLikeConnectionInsight(text)) return false;
      if (/^follow$/i.test(text)) return false;
      if (text.length > 180) return false;
      return true;
    });

    let industry = '';
    let location = '';

    for (const text of filtered) {
      if (!industry && !isLikelyLocation(text)) {
        industry = text;
        continue;
      }
      if (!location && isLikelyLocation(text)) {
        location = text;
      }
    }

    if (!industry && filtered.length) industry = filtered[0];
    if (!location && filtered.length > 1) {
      location = filtered.find((t) => t !== industry) || '';
    }

    return { industry: truncate(industry, 500), location: truncate(location, 500) };
  }

  function extractDescription(card, name, industry, location, followers) {
    const paragraphs = uniq(
      Array.from(card.querySelectorAll('p'))
        .map((p) => normalizeText(p.textContent))
        .filter(Boolean)
    );
    const candidates = paragraphs.filter((txt) => {
      if (!txt) return false;
      if (txt === name || txt === industry || txt === location || txt === followers) return false;
      if (looksLikeFollowers(txt)) return false;
      if (looksLikeConnectionInsight(txt)) return false;
      return txt.length > 60;
    });
    const desc = candidates.sort((a, b) => b.length - a.length)[0] || '';
    return truncate(desc, 1200);
  }

  function extractCard(card) {
    const componentKey = normalizeText(card.getAttribute('componentkey') || '');
    const linkEl = card.querySelector('a[href*="/company/"]');
    const companyUrl = normalizeLinkedInCompanyUrl(linkEl ? linkEl.href : '');
    const name = truncate(linkEl?.textContent || card.querySelector('h3')?.textContent || card.getAttribute('aria-label') || '', 500);

    const details = extractIndustryAndLocation(card, name);
    const industry = details.industry;
    const locationText = details.location;
    const followersText = extractFollowers(card);
    const description = extractDescription(card, name, industry, locationText, followersText);
    const verified = card.querySelector('[aria-label*="Verified"]') ? 'true' : 'false';
    const logo = card.querySelector('img[src]')?.src || '';
    const connectionInsight = extractConnectionInsight(card);

    return {
      source: 'linkedin_companies',
      capturedAt: new Date().toISOString(),
      componentKey,
      name,
      industry,
      location: locationText,
      followers: followersText,
      companyUrl,
      verified,
      connectionInsight,
      description,
      logo,
      pageUrl: location.href,
      pageTitle: document.title || ''
    };
  }

  function keyOf(rec) {
    return normalizeLinkedInCompanyUrl(rec.companyUrl) || rec.componentKey || normalizeText(rec.name).toLowerCase();
  }

  function mergeRecords(base, incoming) {
    const out = { ...base };
    for (const [k, v] of Object.entries(incoming || {})) {
      if (v == null || v === '') continue;
      if (out[k] == null || out[k] === '' || (k === 'capturedAt')) {
        out[k] = v;
      }
      if (k === 'description' && String(v).length > String(out[k] || '').length) {
        out[k] = v;
      }
    }
    return out;
  }

  async function dedupeExistingData() {
    const existing = await chrome.storage.local.get(['linkedinCapturedData']);
    const prev = Array.isArray(existing.linkedinCapturedData) ? existing.linkedinCapturedData : [];
    if (!prev.length) return { total: 0, removed: 0 };

    const byKey = new Map();
    for (const row of prev) {
      const key = keyOf(row);
      if (!key) continue;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, row);
      } else {
        byKey.set(key, mergeRecords(current, row));
      }
    }

    const deduped = Array.from(byKey.values());
    const removed = Math.max(0, prev.length - deduped.length);
    if (removed > 0) {
      await chrome.storage.local.set({
        linkedinCapturedData: deduped,
        linkedinCapturedUpdatedAt: Date.now()
      });
    }
    return { total: deduped.length, removed };
  }

  async function persist(rows) {
    const existing = await chrome.storage.local.get(['linkedinCapturedData']);
    const prev = Array.isArray(existing.linkedinCapturedData) ? existing.linkedinCapturedData : [];
    const byKey = new Map();
    for (const row of prev) byKey.set(keyOf(row), row);

    let added = 0;
    let updated = 0;
    for (const row of rows) {
      const key = keyOf(row);
      if (!key) continue;
      const old = byKey.get(key);
      if (!old) {
        byKey.set(key, row);
        added += 1;
      } else {
        const merged = { ...old };
        for (const [k, v] of Object.entries(row)) {
          if (v != null && v !== '' && (merged[k] == null || merged[k] === '' || k === 'capturedAt')) {
            merged[k] = v;
          }
        }
        if (JSON.stringify(merged) !== JSON.stringify(old)) {
          byKey.set(key, merged);
          updated += 1;
        }
      }
    }

    const mergedRows = Array.from(byKey.values());
    await chrome.storage.local.set({
      linkedinCapturedData: mergedRows,
      linkedinCapturedUpdatedAt: Date.now(),
      linkedinSearchTerm: getSearchTerm() || 'linkedin-results'
    });
    return { total: mergedRows.length, added, updated };
  }

  async function runCapturePass() {
    const cards = getCards();
    const batch = [];
    const seenPass = new Set();
    for (const card of cards) {
      const rec = extractCard(card);
      const key = keyOf(rec);
      if (!key || seenPass.has(key)) continue;
      seenPass.add(key);
      batch.push(rec);
    }

    let persisted = { total: 0, added: 0, updated: 0 };
    if (batch.length) {
      persisted = await persist(batch);
    } else {
      const existing = await chrome.storage.local.get(['linkedinCapturedData']);
      persisted.total = Array.isArray(existing.linkedinCapturedData) ? existing.linkedinCapturedData.length : 0;
    }

    return persisted;
  }

  async function startCapture() {
    const st = state();
    await dedupeExistingData();
    if (st.running) {
      const existing = await chrome.storage.local.get(['linkedinCapturedData']);
      return { running: true, total: Array.isArray(existing.linkedinCapturedData) ? existing.linkedinCapturedData.length : 0 };
    }
    st.running = true;
    await chrome.storage.local.set({ linkedinCaptureRunning: true, linkedinCapturedUpdatedAt: Date.now() });
    attachAutoCapture();
    await runCapturePass();
    st.timerId = setInterval(() => {
      runCapturePass().catch(() => {});
    }, 1500);
    const existing = await chrome.storage.local.get(['linkedinCapturedData']);
    return { running: true, total: Array.isArray(existing.linkedinCapturedData) ? existing.linkedinCapturedData.length : 0 };
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
    detachAutoCapture();
    await chrome.storage.local.set({ linkedinCaptureRunning: false, linkedinCapturedUpdatedAt: Date.now() });
    const existing = await chrome.storage.local.get(['linkedinCapturedData']);
    return { running: false, total: Array.isArray(existing.linkedinCapturedData) ? existing.linkedinCapturedData.length : 0 };
  }

  async function clearCapture() {
    await chrome.storage.local.set({ linkedinCapturedData: [], linkedinCapturedUpdatedAt: Date.now() });
    return { total: 0 };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'linkedinCaptureStart') {
      startCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'linkedinCaptureStop') {
      stopCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'linkedinCaptureRefresh') {
      runCapturePass().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'linkedinCaptureClear') {
      clearCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'linkedinCaptureDedupe') {
      dedupeExistingData().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['linkedinCaptureRunning']).then((s) => {
    dedupeExistingData().catch(() => {});
    if (s.linkedinCaptureRunning) {
      startCapture().catch(() => {});
    }
  }).catch(() => {});
})();
