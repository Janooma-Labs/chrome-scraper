/* global chrome */
(function () {
  'use strict';

  if (globalThis.__bingPlacesCaptureLoaded) return;
  globalThis.__bingPlacesCaptureLoaded = true;

  const STATE_KEY = '__bingPlacesCaptureState';

  function isBingMapsPage() {
    return location.hostname.includes('bing.com') && location.pathname.toLowerCase().includes('/maps');
  }

  function defaultState() {
    return {
      running: false,
      timerId: null,
      passTimerId: null,
      scrollContainer: null,
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

  function scheduleCapturePass(delayMs) {
    const st = state();
    if (!st.running) return;
    if (st.passTimerId) clearTimeout(st.passTimerId);
    st.passTimerId = setTimeout(() => {
      runCapturePass().catch(() => {});
    }, typeof delayMs === 'number' ? delayMs : 300);
  }

  function getListContainer() {
    return document.querySelector('ul[role="list"], .mapsListContainer, #paneContainer, .b_suppModule') || null;
  }

  function detachAutoCaptureListeners() {
    const st = state();
    if (st.scrollContainer && st.onScroll) {
      st.scrollContainer.removeEventListener('scroll', st.onScroll, true);
    }
    if (st.observer) {
      st.observer.disconnect();
    }
    st.scrollContainer = null;
    st.onScroll = null;
    st.observer = null;
  }

  function attachAutoCaptureListeners(container) {
    const st = state();
    const target = container || getListContainer();
    if (!target) return;

    if (st.scrollContainer !== target) {
      detachAutoCaptureListeners();
      st.scrollContainer = target;
      st.onScroll = function () {
        scheduleCapturePass(250);
      };
      target.addEventListener('scroll', st.onScroll, true);
      st.observer = new MutationObserver(function () {
        scheduleCapturePass(250);
      });
      st.observer.observe(target, { childList: true, subtree: true });
    }
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function getCurrentSearchTerm() {
    const selectors = [
      'input[type="search"]',
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'form input[type="text"]'
    ];
    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (!input) continue;
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

  function parseEntityJson(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function extractRatingAndScale(card) {
    const text = normalizeText(card.querySelector('.l_rev_pirs')?.textContent || '');
    if (!text) return { rating: '', ratingScale: '' };

    const fraction = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (fraction) {
      return {
        rating: fraction[1],
        ratingScale: fraction[2]
      };
    }

    const simple = text.match(/(\d+(?:\.\d+)?)/);
    if (!simple) return { rating: '', ratingScale: '' };

    return {
      rating: simple[1],
      ratingScale: ''
    };
  }

  function extractReviewCountFromText(value) {
    const text = normalizeText(value);
    if (!text) return '';
    if (/^(review|reviews)$/i.test(text)) return '';

    let match = text.match(/\b([\d,]+)\s*reviews?\b/i);
    if (match && match[1]) return match[1].replace(/,/g, '');

    match = text.match(/\((\d[\d,]*)\)/);
    if (match && match[1]) return match[1].replace(/,/g, '');

    match = text.match(/^\d[\d,]*$/);
    if (match) return text.replace(/,/g, '');

    return '';
  }

  function deepFindReviewCount(value, depth) {
    if (depth > 6 || value == null) return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === 'string') {
      return extractReviewCountFromText(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = deepFindReviewCount(item, depth + 1);
        if (found) return found;
      }
      return '';
    }

    if (typeof value === 'object') {
      for (const [key, val] of Object.entries(value)) {
        if (/review/i.test(key)) {
          const foundDirect = deepFindReviewCount(val, depth + 1);
          if (foundDirect) return foundDirect;
        }
      }
      for (const val of Object.values(value)) {
        const foundNested = deepFindReviewCount(val, depth + 1);
        if (foundNested) return foundNested;
      }
    }

    return '';
  }

  function extractReviews(card, entity, entityObj) {
    const candidates = [
      normalizeText(entity.reviewCount || ''),
      normalizeText(entity.reviewCounts || ''),
      normalizeText(entity.ratingCount || ''),
      normalizeText(entity.reviewsText || ''),
      normalizeText(card.querySelector('.l_rev_pirs')?.textContent || ''),
      normalizeText(card.querySelector('[class*="review"]')?.textContent || ''),
      normalizeText(card.querySelector('[aria-label*="review" i]')?.getAttribute('aria-label') || ''),
      normalizeText(card.querySelector('[title*="review" i]')?.getAttribute('title') || ''),
      normalizeText(card.textContent || ''),
      normalizeText(entity.infoboxHtml || '')
    ].filter(Boolean);

    for (const c of candidates) {
      const extracted = extractReviewCountFromText(c);
      if (extracted) return extracted;
    }

    const deep = deepFindReviewCount(entityObj, 0);
    if (deep && !/^(review|reviews)$/i.test(deep)) {
      return deep;
    }

    return '';
  }

  function extractCardRecord(card) {
    const entityRaw = card.getAttribute('data-entity');
    const entityObj = parseEntityJson(entityRaw) || {};
    const entity = entityObj.entity || {};
    const geometry = entityObj.geometry || {};
    const routable = entityObj.routablePoint || {};

    const name = normalizeText(entity.title || card.getAttribute('data-n') || card.querySelector('.l_magTitle')?.textContent);
    const address = normalizeText(entity.address || card.querySelector('.b_factrow')?.textContent);
    const category = normalizeText(entity.primaryCategoryName || card.getAttribute('data-type'));
    const phone = normalizeText(entity.phone || card.querySelector('.longNum')?.textContent);
    const website = normalizeText(entity.website || '');
    const imageUrl = normalizeText(entity.imageUrl || card.querySelector('img')?.src || '');
    const openStatus = normalizeText(entity.openStatus || '');
    const openHoursText = normalizeText(entity.openHoursText || card.querySelector('.opHours')?.textContent || '');
    const ratingMeta = extractRatingAndScale(card);
    const reviewsText = extractReviews(card, entity, entityObj);
    const id = normalizeText((entity.id || card.getAttribute('id') || '').replace(/^ypid:/i, ''));
    const sourceType = normalizeText(entity.entryName || card.getAttribute('data-type') || 'Business');

    const latitude = String(
      routable.latitude ?? geometry.y ?? ''
    );
    const longitude = String(
      routable.longitude ?? geometry.x ?? ''
    );

    return {
      source: 'bing_places',
      capturedAt: new Date().toISOString(),
      placeId: id,
      name,
      rating: ratingMeta.rating,
      reviewCount: reviewsText,
      reviews: reviewsText,
      ratingScale: ratingMeta.ratingScale,
      category,
      address,
      phone,
      website,
      placeUrl: location.href,
      imageUrl,
      latitude,
      longitude,
      openStatus,
      openHoursText,
      sourceType,
      rawEntityJson: entityObj
    };
  }

  function getCards() {
    return Array.from(document.querySelectorAll('.b_maglistcard[data-entity], li[id^="listingItem_"] .b_maglistcard[data-entity]'));
  }

  function keyOf(row) {
    return row.placeId || `${row.name}|${row.address}`;
  }

  function mergePreferNew(oldRow, newRow) {
    const out = { ...oldRow };
    for (const [k, v] of Object.entries(newRow)) {
      if (v == null || v === '') continue;
      if (out[k] == null || out[k] === '') out[k] = v;
      if (k === 'capturedAt') out[k] = v;
      if (k === 'website' && !out.website) out.website = v;
    }
    return out;
  }

  async function persist(rows) {
    const existing = await chrome.storage.local.get(['bingPlacesData']);
    const prev = Array.isArray(existing.bingPlacesData) ? existing.bingPlacesData : [];
    const byKey = new Map();
    for (const r of prev) {
      const k = keyOf(r);
      if (k) byKey.set(k, r);
    }

    let added = 0;
    let updated = 0;
    for (const r of rows) {
      const k = keyOf(r);
      if (!k) continue;
      const old = byKey.get(k);
      if (!old) {
        byKey.set(k, r);
        added += 1;
      } else {
        const merged = mergePreferNew(old, r);
        if (JSON.stringify(old) !== JSON.stringify(merged)) {
          byKey.set(k, merged);
          updated += 1;
        }
      }
    }

    const mergedRows = Array.from(byKey.values());
    await chrome.storage.local.set({
      bingPlacesData: mergedRows,
      bingPlacesUpdatedAt: Date.now()
    });
    return { total: mergedRows.length, added, updated };
  }

  async function runCapturePass() {
    if (!isBingMapsPage()) {
      return { added: 0, updated: 0, total: 0, warning: 'Not on Bing Maps page' };
    }

    const container = getListContainer();
    attachAutoCaptureListeners(container);
    const cards = getCards();
    const batch = [];
    const seen = new Set();
    for (const card of cards) {
      const rec = extractCardRecord(card);
      const k = keyOf(rec);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      batch.push(rec);
    }

    let persisted = { total: 0, added: 0, updated: 0 };
    if (batch.length) {
      persisted = await persist(batch);
    } else {
      const existing = await chrome.storage.local.get(['bingPlacesData']);
      persisted.total = Array.isArray(existing.bingPlacesData) ? existing.bingPlacesData.length : 0;
    }

    if (container && 'scrollTop' in container) {
      container.scrollTop = container.scrollTop + Math.max(400, Math.floor((container.clientHeight || 500) * 0.7));
    }

    const searchTerm = getCurrentSearchTerm();
    if (searchTerm) {
      await chrome.storage.local.set({ bingPlacesSearchTerm: searchTerm });
    }

    chrome.runtime.sendMessage({ action: 'capturedDataUpdated', source: 'bing_places', total: persisted.total, added: persisted.added, updated: persisted.updated }, () => {
      if (chrome.runtime.lastError) {
        // ignore — popup may be closed
      }
    });

    return { ...persisted, searchTerm };
  }

  async function startCapture() {
    const st = state();
    if (st.running) {
      const existing = await chrome.storage.local.get(['bingPlacesData']);
      return { running: true, total: Array.isArray(existing.bingPlacesData) ? existing.bingPlacesData.length : 0 };
    }

    st.running = true;
    await chrome.storage.local.set({ bingPlacesRunning: true, bingPlacesUpdatedAt: Date.now() });
    await runCapturePass();
    attachAutoCaptureListeners(getListContainer());

    const existing = await chrome.storage.local.get(['bingPlacesData']);
    return { running: true, total: Array.isArray(existing.bingPlacesData) ? existing.bingPlacesData.length : 0 };
  }

  async function stopCapture() {
    const st = state();
    st.running = false;
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
      st.passTimerId = null;
    }
    detachAutoCaptureListeners();
    await chrome.storage.local.set({ bingPlacesRunning: false, bingPlacesUpdatedAt: Date.now() });
    const existing = await chrome.storage.local.get(['bingPlacesData']);
    return { running: false, total: Array.isArray(existing.bingPlacesData) ? existing.bingPlacesData.length : 0 };
  }

  async function clearCapture() {
    await chrome.storage.local.set({ bingPlacesData: [], bingPlacesUpdatedAt: Date.now() });
    return { total: 0 };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'bingPlacesStart') {
      startCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'bingPlacesStop') {
      stopCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'bingPlacesRefresh') {
      runCapturePass().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'bingPlacesClear') {
      clearCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'bingPlacesStatus') {
      chrome.storage.local.get(['bingPlacesData', 'bingPlacesRunning']).then((s) => {
        sendResponse({
          running: Boolean(s.bingPlacesRunning),
          total: Array.isArray(s.bingPlacesData) ? s.bingPlacesData.length : 0,
          isMaps: isBingMapsPage()
        });
      });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['bingPlacesRunning']).then((s) => {
    if (s.bingPlacesRunning) {
      startCapture().catch(() => {});
    }
  }).catch(() => {});
})();
