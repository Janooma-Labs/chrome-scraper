/* global chrome */
(function () {
  'use strict';

  if (globalThis.__placesCaptureLoaded) return;
  globalThis.__placesCaptureLoaded = true;

  // IndexedDB is origin-scoped. Content scripts run on the web page origin, so they
  // cannot share an IndexedDB with the popup (chrome-extension:// origin). Route all
  // PlacesDB operations through the extension's background service worker instead.
  const PlacesDB = {
    async getAll() {
      const res = await chrome.runtime.sendMessage({ action: 'placesDB_getAll' });
      if (res && res.error) throw new Error(res.error);
      return res.rows || [];
    },
    async count() {
      const res = await chrome.runtime.sendMessage({ action: 'placesDB_count' });
      if (res && res.error) throw new Error(res.error);
      return res.count || 0;
    },
    async save(rows) {
      const res = await chrome.runtime.sendMessage({ action: 'placesDB_save', rows });
      if (res && res.error) throw new Error(res.error);
      return { total: res.total || 0, added: res.added || 0, updated: res.updated || 0 };
    },
    async clear() {
      const res = await chrome.runtime.sendMessage({ action: 'placesDB_clear' });
      if (res && res.error) throw new Error(res.error);
      return true;
    }
  };

  const STATE_KEY = '__placesCaptureState';

  function isGoogleMapsPage() {
    return location.hostname.includes('google.') && location.pathname.includes('/maps');
  }

  function isGoogleChallengePage() {
    const url = location.href.toLowerCase();
    const title = document.title.toLowerCase();
    return url.includes('/sorry') ||
      url.includes('/sorry/index') ||
      title.includes('sorry') ||
      title.includes('unusual traffic') ||
      !!document.querySelector('form[action*="/sorry"]') ||
      !!document.getElementById('captcha') ||
      !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
  }

  async function pauseForChallenge(reason) {
    const st = state();
    st.automationRunning = false;
    stopAutomationTimers();

    const queue = await loadAutomationQueue();
    if (queue) {
      queue.running = false;
      queue.challengeDetected = true;
      await saveAutomationQueue(queue);
    }
    await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });

    let records = 0;
    try { records = await PlacesDB.count(); } catch (_) {}

    let progress;
    if (queue && queue.combinations && queue.combinations.length) {
      const current = queue.currentIndex + 1;
      const total = queue.combinations.length;
      const percent = total ? Math.round((queue.currentIndex / total) * 100) : 0;
      progress = { current, total, percent, records, status: `Paused: ${reason} — complete the challenge, then click Resume` };
    } else {
      progress = { current: 0, total: 0, percent: 0, records, status: `Paused: ${reason} — complete the challenge, then click Resume` };
    }
    await chrome.storage.local.set({ googlePlacesProgress: progress });
    chrome.runtime.sendMessage({ action: 'googlePlacesProgressUpdated', progress }, () => {
      if (chrome.runtime.lastError) {}
    });
    chrome.runtime.sendMessage({ action: 'googlePlacesChallengeDetected', reason }, () => {
      if (chrome.runtime.lastError) {}
    });
  }

  function defaultState() {
    return {
      running: false,
      timerId: null,
      passTimerId: null,
      seenIds: new Set(),
      captures: [],
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
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
    }
    st.passTimerId = setTimeout(() => {
      runCapturePass().catch(() => {});
    }, typeof delayMs === 'number' ? delayMs : 300);
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
      'input#searchboxinput',
      'input[aria-label="Search Google Maps"]',
      'input[aria-label*="Search"]',
      'form input[type="text"]'
    ];

    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (!input) continue;
      const value = normalizeText(input.value || input.getAttribute('value'));
      if (value) return value;
    }

    try {
      const url = new URL(location.href);
      const q = normalizeText(url.searchParams.get('q'));
      if (q) return q;
      const pathMatch = url.pathname.match(/\/maps\/search\/([^/]+)/i);
      if (pathMatch && pathMatch[1]) return normalizeText(decodeURIComponent(pathMatch[1].replace(/\+/g, ' ')));
    } catch (_) {}

    return '';
  }

  function isLikelyAddress(text) {
    const t = normalizeText(text);
    if (!t) return false;
    if (/\b(open|closes|opens|closed|reviews?|stars?)\b/i.test(t)) return false;
    if (/,/.test(t)) return true;
    if (/\d/.test(t)) return true;
    if (/\b(road|rd|street|st|avenue|ave|nagar|gate|phase|layout|area|lane|block|city|mall)\b/i.test(t)) return true;
    return false;
  }

  function isLikelyCategory(text) {
    const t = normalizeText(text);
    if (!t) return false;
    if (/\b(open|closes|opens|closed|reviews?|stars?)\b/i.test(t)) return false;
    if (t.length > 80) return false;
    if (isLikelyAddress(t) && /,|\d/.test(t)) return false;
    return true;
  }

  function scoreAddress(text) {
    const t = normalizeText(text);
    if (!t) return 0;
    let score = 1;
    if (/,/.test(t)) score += 2;
    if (/\d/.test(t)) score += 2;
    if (/\b(road|rd|street|st|avenue|ave|nagar|gate|phase|layout|area|lane|block|city|mall)\b/i.test(t)) score += 2;
    if (/\b(open|closes|opens|closed|reviews?|stars?)\b/i.test(t)) score -= 3;
    return score;
  }

  function getListContainer() {
    const candidates = [
      'div[role="feed"]',
      'div[aria-label*="Results"]',
      'div[aria-label*="results"]',
      'div[aria-label*="Places"]',
      'div[aria-label*="places"]'
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getCards(container) {
    if (!container) return [];
    const links = Array.from(container.querySelectorAll('a[href*="/maps/place/"]'));
    const cards = [];
    const seen = new Set();
    for (const link of links) {
      const card = link.closest('div[role="article"]') || link.closest('div.Nv2PK') || link.closest('div[jsaction]') || link.parentElement;
      if (!card) continue;
      if (seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }
    return cards;
  }

  function findText(card, selectors) {
    for (const selector of selectors) {
      const el = card.querySelector(selector);
      const text = normalizeText(el && el.textContent);
      if (text) return text;
    }
    return '';
  }

  function extractHrefId(href) {
    if (!href) return '';
    const match = href.match(/\/maps\/place\/([^/?]+)/i);
    if (match && match[1]) return decodeURIComponent(match[1]);
    return href;
  }

  function placeKey(place) {
    return place.placeId || place.placeUrl || `${place.name}|${place.address}`;
  }

  function mergePreferNew(oldItem, newItem) {
    const merged = { ...oldItem };
    for (const [key, value] of Object.entries(newItem)) {
      if (value == null || value === '') continue;

      if (key === 'website') {
        const oldWebsite = merged.website || '';
        const newWebsite = value;
        if ((!oldWebsite || isGoogleOwnedUrl(oldWebsite)) && !isGoogleOwnedUrl(newWebsite)) {
          merged.website = newWebsite;
          continue;
        }
      }

      if (key === 'address') {
        const oldAddress = normalizeText(merged.address || '');
        const newAddress = normalizeText(value);
        if (!oldAddress || scoreAddress(newAddress) > scoreAddress(oldAddress)) {
          merged.address = newAddress;
          continue;
        }
      }

      if (key === 'category') {
        const oldCategory = normalizeText(merged.category || '');
        const newCategory = normalizeText(value);
        if ((!oldCategory || !isLikelyCategory(oldCategory)) && isLikelyCategory(newCategory)) {
          merged.category = newCategory;
          continue;
        }
      }

      if (merged[key] == null || merged[key] === '' || merged[key] === 'N/A') {
        merged[key] = value;
      } else if (key === 'capturedAt') {
        merged[key] = value;
      }
    }
    return merged;
  }

  function unwrapGoogleRedirect(url) {
    if (!url) return '';
    try {
      const u = new URL(url, location.href);
      if (!u.hostname.includes('google.')) return u.href;
      const q = u.searchParams.get('q') || u.searchParams.get('url');
      if (q) {
        const resolved = new URL(q, location.href);
        return resolved.href;
      }
      return u.href;
    } catch (_) {
      return url;
    }
  }

  function isGoogleOwnedUrl(url) {
    if (!url) return true;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname.toLowerCase();
      if (host.includes('google.') || host.includes('gstatic.com') || host.includes('googleusercontent.com')) {
        return true;
      }
      if (u.pathname.includes('/maps')) return true;
      return false;
    } catch (_) {
      return true;
    }
  }

  function pickWebsiteUrl(card, placeUrl) {
    const explicit = card.querySelector('a[data-value="Website"][href], a[aria-label*="Visit"][href]');
    if (explicit && explicit.href) {
      const url = unwrapGoogleRedirect(explicit.href);
      if (url && !isGoogleOwnedUrl(url) && url !== placeUrl) return url;
    }

    const anchors = Array.from(card.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const href = unwrapGoogleRedirect(a.href || '');
      if (!href || href === placeUrl) continue;
      if (href.startsWith('tel:') || href.startsWith('mailto:')) continue;
      if (isGoogleOwnedUrl(href)) continue;
      return href;
    }
    return '';
  }

  function extractCategoryAddress(card) {
    let category = '';
    let address = '';

    const rows = Array.from(card.querySelectorAll('.W4Efsd > .W4Efsd')).length
      ? Array.from(card.querySelectorAll('.W4Efsd > .W4Efsd'))
      : Array.from(card.querySelectorAll('.W4Efsd .W4Efsd'));

    for (const row of rows) {
      const spans = Array.from(row.querySelectorAll(':scope > span'));

      if (spans.length >= 1 && !category) {
        const first = normalizeText(spans[0].textContent);
        if (isLikelyCategory(first)) category = first;
      }

      if (spans.length >= 2 && !address) {
        const second = normalizeText(spans[1].textContent.replace(/^\s*·\s*/, ''));
        if (isLikelyAddress(second)) address = second;
      }

      if (!category || !address) {
        const parts = normalizeText(row.textContent)
          .split('·')
          .map(p => normalizeText(p))
          .filter(Boolean);

        for (const part of parts) {
          if (!category && isLikelyCategory(part)) category = part;
          if (!address && isLikelyAddress(part)) address = part;
        }
      }

      if (category && address) break;
    }

    return { category, address };
  }

  function extractLatLng(placeUrl) {
    if (!placeUrl) return { latitude: '', longitude: '' };

    let m = placeUrl.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m) return { latitude: m[1], longitude: m[2] };

    m = placeUrl.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
    if (m) return { latitude: m[1], longitude: m[2] };

    m = placeUrl.match(/[?&](?:ll|q)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m) return { latitude: m[1], longitude: m[2] };

    return { latitude: '', longitude: '' };
  }

  function buildPlace(card) {
    const placeLink = card.querySelector('a[href*="/maps/place/"]');
    const placeUrl = placeLink ? placeLink.href : '';
    const placeId = extractHrefId(placeUrl);

    const name = findText(card, [
      'h3',
      '[role="heading"]',
      '.qBF1Pd',
      '.fontHeadlineSmall'
    ]);

    const rating = findText(card, ['span[aria-label*="stars"]', '.MW4etd']);
    const reviewCount = findText(card, ['span[aria-label*="reviews"]', '.UY7F9']);
    const details = extractCategoryAddress(card);
    const category = details.category;
    const address = details.address;
    const phone = findText(card, ['a[href^="tel:"]', '.UsdlK']);
    const website = pickWebsiteUrl(card, placeUrl);
    const imageEl = card.querySelector('img[src]');
    const imageUrl = imageEl ? imageEl.src : '';
    const coords = extractLatLng(placeUrl);

    return {
      source: 'google_places',
      capturedAt: new Date().toISOString(),
      placeId,
      name,
      rating,
      reviewCount,
      category,
      address,
      phone,
      website,
      placeUrl,
      imageUrl,
      latitude: coords.latitude,
      longitude: coords.longitude
    };
  }

  async function persistCapture(items) {
    if (!Array.isArray(items) || !items.length) {
      try {
        const total = await PlacesDB.count();
        return { total, added: 0, updated: 0 };
      } catch (_) {
        return { total: 0, added: 0, updated: 0 };
      }
    }

    try {
      // Merge into existing records in the extension-origin DB so we keep the
      // Google-specific merging behaviour (better website, address, category).
      const existing = await PlacesDB.getAll();
      const mergedMap = new Map();
      for (const row of existing) {
        const key = placeKey(row);
        if (key) mergedMap.set(key, row);
      }

      let added = 0;
      let updated = 0;
      for (const item of items) {
        const key = placeKey(item);
        if (!key) continue;
        const old = mergedMap.get(key);
        if (old) {
          const merged = mergePreferNew(old, item);
          if (JSON.stringify(merged) !== JSON.stringify(old)) {
            updated += 1;
          }
          mergedMap.set(key, merged);
        } else {
          mergedMap.set(key, item);
          added += 1;
        }
      }

      const mergedItems = Array.from(mergedMap.values());
      const res = await PlacesDB.save(mergedItems);
      return { total: res.total, added, updated };
    } catch (err) {
      console.warn('[GooglePlaces] persist failed', err);
      return { total: 0, added: 0, updated: 0 };
    }
  }

  async function runCapturePass() {
    if (!isGoogleMapsPage()) {
      return { added: 0, total: 0, warning: 'Not on Google Maps page' };
    }

    const container = getListContainer();
    attachAutoCaptureListeners(container);
    const cards = getCards(container);
    const st = state();
    const batch = [];
    const seenInPass = new Set();

    for (const card of cards) {
      const place = buildPlace(card);
      const dedupeKey = placeKey(place);
      if (!dedupeKey) continue;
      if (seenInPass.has(dedupeKey)) continue;
      seenInPass.add(dedupeKey);
      st.seenIds.add(dedupeKey);
      batch.push(place);
      st.captures.push(place);
    }

    let total = 0;
    let added = 0;
    let updated = 0;
    if (batch.length > 0) {
      const persisted = await persistCapture(batch);
      total = persisted.total;
      added = persisted.added;
      updated = persisted.updated;
    } else {
      let records = 0;
      try { records = await PlacesDB.count(); } catch (_) {}
      total = records;
    }

    if (container) {
      container.scrollTop = container.scrollTop + Math.max(400, Math.floor(container.clientHeight * 0.7));
    }

    const searchTerm = getCurrentSearchTerm();
    if (searchTerm) {
      await chrome.storage.local.set({ googlePlacesSearchTerm: searchTerm });
    }

    chrome.runtime.sendMessage({ action: 'capturedDataUpdated', source: 'google_places', total, added, updated }, () => {
      if (chrome.runtime.lastError) {
        // ignore — popup may be closed
      }
    });

    return { added, updated, total, searchTerm };
  }

  /* ----------------- Multi-location automation ----------------- */

  function buildGoogleMapsSearchUrl(keyword, location) {
    const query = normalizeText(`${keyword} ${location}`);
    return `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  }

  function extractMapsSearchTerm(urlString) {
    try {
      const url = new URL(urlString, location.href);
      const q = normalizeText(url.searchParams.get('q'));
      if (q) return q;
      const pathMatch = url.pathname.match(/\/maps\/search\/([^/]+)/i);
      if (pathMatch && pathMatch[1]) {
        return normalizeText(decodeURIComponent(pathMatch[1].replace(/\+/g, ' ')));
      }
      return '';
    } catch (_) {
      return '';
    }
  }

  function isOnExpectedSearchUrl(expectedUrl) {
    if (!expectedUrl) return false;
    const currentTerm = extractMapsSearchTerm(window.location.href);
    const expectedTerm = extractMapsSearchTerm(expectedUrl);
    return currentTerm && expectedTerm && currentTerm === expectedTerm;
  }

  async function waitForSearchResults(timeoutMs = 15000) {
    return new Promise((resolve) => {
      let elapsed = 0;
      const interval = 400;
      const startHref = location.href;
      const timer = setInterval(() => {
        elapsed += interval;
        const container = getListContainer();
        const cards = container ? getCards(container).length : 0;
        if (cards > 0) {
          clearInterval(timer);
          resolve(true);
        } else if (elapsed >= timeoutMs || location.href !== startHref) {
          clearInterval(timer);
          resolve(false);
        }
      }, interval);
    });
  }

  async function loadAutomationQueue() {
    try {
      const res = await chrome.storage.local.get(['googlePlacesAutomationQueue']);
      return res.googlePlacesAutomationQueue || null;
    } catch (err) {
      console.warn('[GooglePlacesAutomation] load queue failed', err);
      return null;
    }
  }

  async function saveAutomationQueue(queue) {
    try {
      await chrome.storage.local.set({ googlePlacesAutomationQueue: queue });
    } catch (err) {
      console.warn('[GooglePlacesAutomation] save queue failed', err);
    }
  }

  async function sendProgressUpdate(queue, records, statusExtra) {
    if (!queue || !queue.combinations || !queue.combinations.length) return;
    const current = queue.currentIndex + 1;
    const total = queue.combinations.length;
    const percent = total ? Math.round(((queue.currentIndex) / total) * 100) : 0;
    const item = queue.combinations[queue.currentIndex];
    const status = item
      ? `Scraping "${item.keyword}" in ${item.location}${statusExtra ? ` — ${statusExtra}` : ''}`
      : 'Finishing...';
    const progress = { current, total, percent, records, status };
    await chrome.storage.local.set({ googlePlacesProgress: progress });
    chrome.runtime.sendMessage({ action: 'googlePlacesProgressUpdated', progress }, () => {
      if (chrome.runtime.lastError) {}
    });
  }

  function stopAutomationTimers() {
    const st = state();
    if (st.automationTimer) {
      clearTimeout(st.automationTimer);
      st.automationTimer = null;
    }
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
      st.passTimerId = null;
    }
    detachAutoCaptureListeners();
  }

  async function runCapturePassNoScroll() {
    if (!isGoogleMapsPage()) {
      return { added: 0, updated: 0, total: 0 };
    }
    const container = getListContainer();
    const cards = getCards(container);
    const st = state();
    const batch = [];
    const seenInPass = new Set();

    for (const card of cards) {
      const place = buildPlace(card);
      const dedupeKey = placeKey(place);
      if (!dedupeKey) continue;
      if (seenInPass.has(dedupeKey)) continue;
      seenInPass.add(dedupeKey);
      st.seenIds.add(dedupeKey);
      batch.push(place);
      st.captures.push(place);
    }

    let total = 0;
    let added = 0;
    let updated = 0;
    if (batch.length > 0) {
      const persisted = await persistCapture(batch);
      total = persisted.total;
      added = persisted.added;
      updated = persisted.updated;
    } else {
      let records = 0;
      try { records = await PlacesDB.count(); } catch (_) {}
      total = records;
    }

    const searchTerm = getCurrentSearchTerm();
    if (searchTerm) {
      await chrome.storage.local.set({ googlePlacesSearchTerm: searchTerm });
    }

    return { added, updated, total, searchTerm };
  }

  async function captureAndScrollCurrentSearch() {
    const st = state();
    if (!st.automationRunning) return;

    let queue = await loadAutomationQueue();
    if (!queue || !queue.running) {
      st.automationRunning = false;
      return;
    }

    let noNewCount = 0;
    let lastScrollTop = -1;
    let lastTotal = -1;
    let lastAdded = -1;
    let attempts = 0;
    const MAX_ATTEMPTS = 120;

    const loop = async () => {
      if (!st.automationRunning) return;
      if (isGoogleChallengePage()) {
        await pauseForChallenge('Google bot challenge detected');
        return;
      }
      if (location.pathname.includes('/maps/place/')) {
        await finishCurrentAndAdvance(queue, 'redirected to place detail while scrolling - skipping');
        return;
      }
      queue = await loadAutomationQueue();
      if (!queue || !queue.running) {
        st.automationRunning = false;
        return;
      }

      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        // Safety cap: move to next location after many attempts
        await finishCurrentAndAdvance(queue, 'max attempts reached');
        return;
      }

      const container = getListContainer();

      const res = await runCapturePassNoScroll();
      const afterTotal = res.total;
      for (let i = 0; i < res.added; i++) st.captures.push({}); // approximate count sync

      await sendProgressUpdate(queue, afterTotal, 'scrolling');
      chrome.runtime.sendMessage({ action: 'capturedDataUpdated', source: 'google_places', total: afterTotal, added: res.added, updated: res.updated }, () => {
        if (chrome.runtime.lastError) {}
      });

      const newThisPass = res.added || 0;
      const currentScrollTop = container ? container.scrollTop : 0;
      const reachedBottom = container && (container.scrollHeight - currentScrollTop - container.clientHeight <= 80);

      if (newThisPass === 0 && reachedBottom && currentScrollTop === lastScrollTop) {
        noNewCount += 1;
      } else {
        noNewCount = 0;
      }

      const bottomSettled = noNewCount >= 2;
      const noNewAndStationary = newThisPass === 0 && currentScrollTop === lastScrollTop && lastTotal === afterTotal && attempts > 1;

      if (bottomSettled || noNewAndStationary) {
        await finishCurrentAndAdvance(queue, 'end of results');
        return;
      }

      lastScrollTop = currentScrollTop;
      lastTotal = afterTotal;
      lastAdded = newThisPass;

      if (container) {
        container.scrollTop += Math.max(500, Math.floor(container.clientHeight * 0.75));
      }

      st.automationTimer = setTimeout(loop, 1200);
    };

    loop();
  }

  async function finishCurrentAndAdvance(queue, reason) {
    const st = state();
    stopAutomationTimers();

    // Re-read queue and respect a Stop that may have been issued while we were scrolling.
    const freshQueue = await loadAutomationQueue();
    if (!freshQueue || !freshQueue.running) {
      st.automationRunning = false;
      if (freshQueue) {
        freshQueue.running = false;
        await saveAutomationQueue(freshQueue);
      }
      await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });
      return;
    }
    queue = freshQueue;

    queue.currentIndex += 1;
    queue.currentSearchUrl = null;
    await saveAutomationQueue(queue);

    if (queue.currentIndex >= queue.combinations.length) {
      queue.running = false;
      await saveAutomationQueue(queue);
      await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });
      let records = 0;
      try { records = await PlacesDB.count(); } catch (_) {}
      await sendProgressUpdate(queue, records, 'completed');
      chrome.runtime.sendMessage({ action: 'automationComplete', source: 'google_places' }, () => {
        if (chrome.runtime.lastError) {}
      });
      st.automationRunning = false;
      return;
    }

    const next = queue.combinations[queue.currentIndex];

    // Final stop check right before moving to next combination.
    const justBeforeNav = await loadAutomationQueue();
    if (!justBeforeNav || !justBeforeNav.running) {
      st.automationRunning = false;
      if (justBeforeNav) {
        justBeforeNav.running = false;
        await saveAutomationQueue(justBeforeNav);
      }
      await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });
      return;
    }

    const nextUrl = buildGoogleMapsSearchUrl(next.keyword, next.location);
    queue.currentSearchUrl = nextUrl;
    await saveAutomationQueue(queue);

    let records = 0;
    try { records = await PlacesDB.count(); } catch (_) {}
    await sendProgressUpdate(queue, records, `moving to ${next.location}`);

    // Navigate by URL after a short pause so the user can hit Stop and to reduce bot flags.
    st.automationTimer = setTimeout(async () => {
      if (!st.automationRunning) return;
      const fresh = await loadAutomationQueue();
      if (!fresh || !fresh.running) {
        st.automationRunning = false;
        await chrome.storage.local.set({ googlePlacesRunning: false });
        return;
      }
      window.location.href = nextUrl;
    }, 2000);
  }

  async function startAutomation(navigationOnly = false) {
    const st = state();
    let queue = await loadAutomationQueue();
    if (!queue || !queue.combinations || !queue.combinations.length) {
      return { error: 'No automation queue found. Start from the popup.' };
    }

    if (isGoogleChallengePage()) {
      await pauseForChallenge('Google bot challenge detected');
      return { running: false, message: 'Paused for challenge' };
    }

    queue.running = true;
    st.automationRunning = true;
    await saveAutomationQueue(queue);
    await chrome.storage.local.set({ googlePlacesRunning: true, googlePlacesUpdatedAt: Date.now() });

    if (queue.currentIndex >= queue.combinations.length) {
      queue.currentIndex = 0;
      await saveAutomationQueue(queue);
    }

    const item = queue.combinations[queue.currentIndex];

    if (!isGoogleMapsPage()) {
      // First start from a non-Maps tab: navigate by URL.
      const fresh = await loadAutomationQueue();
      if (!fresh || !fresh.running) {
        st.automationRunning = false;
        await chrome.storage.local.set({ googlePlacesRunning: false });
        return { running: false, message: 'Stopped before navigation' };
      }
      const targetUrl = buildGoogleMapsSearchUrl(item.keyword, item.location);
      queue.currentSearchUrl = targetUrl;
      await saveAutomationQueue(queue);
      st.automationTimer = setTimeout(async () => {
        if (!st.automationRunning) return;
        const fresh = await loadAutomationQueue();
        if (!fresh || !fresh.running) {
          st.automationRunning = false;
          await chrome.storage.local.set({ googlePlacesRunning: false });
          return;
        }
        window.location.href = targetUrl;
      }, 1500);
      return { running: true, current: queue.currentIndex + 1, total: queue.combinations.length, message: 'Navigating...' };
    }

    if (navigationOnly) {
      return { running: true, current: queue.currentIndex + 1, total: queue.combinations.length, message: 'On correct page' };
    }

    st.automationRunning = true;
    stopAutomationTimers();

    const query = normalizeText(`${item.keyword} ${item.location}`);
    const currentTerm = normalizeText(getCurrentSearchTerm());
    const targetUrl = buildGoogleMapsSearchUrl(item.keyword, item.location);
    const alreadyOnSearch = isOnExpectedSearchUrl(targetUrl) || currentTerm === query;
    const isDetailPage = location.pathname.includes('/maps/place/');

    if (isDetailPage) {
      // Google redirected the search to a single-place detail URL. We never capture details.
      // Skip this combination and continue with the next one.
      return finishCurrentAndAdvance(queue, 'redirected to place detail - skipping');
    }

    if (alreadyOnSearch) {
      // Already showing this combination; wait briefly for results to settle then capture.
      st.automationTimer = setTimeout(async () => {
        if (!st.automationRunning) return;
        await waitForSearchResults();
        if (!st.automationRunning) return;
        captureAndScrollCurrentSearch();
      }, 800);
      let records = 0;
      try { records = await PlacesDB.count(); } catch (_) {}
      return { running: true, current: queue.currentIndex + 1, total: queue.combinations.length, totalRecords: records };
    }

    // Navigate by URL (full page load). A short delay helps avoid bot-throttling.
    queue.currentSearchUrl = targetUrl;
    await saveAutomationQueue(queue);
    st.automationTimer = setTimeout(async () => {
      if (!st.automationRunning) return;
      const fresh = await loadAutomationQueue();
      if (!fresh || !fresh.running) {
        st.automationRunning = false;
        await chrome.storage.local.set({ googlePlacesRunning: false });
        return;
      }
      window.location.href = targetUrl;
    }, 2000);

    let records = 0;
    try { records = await PlacesDB.count(); } catch (_) {}
    return { running: true, current: queue.currentIndex + 1, total: queue.combinations.length, totalRecords: records };
  }

  async function stopAutomation() {
    const st = state();
    st.automationRunning = false;
    stopAutomationTimers();
    const queue = await loadAutomationQueue();
    if (queue) {
      queue.running = false;
      await saveAutomationQueue(queue);
    }
    await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });
    let records = 0;
    try { records = await PlacesDB.count(); } catch (_) {}
    return { running: false, total: records };
  }

  async function clearAutomation() {
    const st = state();
    st.automationRunning = false;
    stopAutomationTimers();
    st.seenIds.clear();
    st.captures = [];
    try { await PlacesDB.clear(); } catch(_) {}
    await chrome.storage.local.set({
      googlePlacesAutomationQueue: null,
      googlePlacesProgress: null,
      googlePlacesRunning: false,
      googlePlacesUpdatedAt: Date.now()
    });
    return { total: 0 };
  }

  async function resumeAutomationOnLoad() {
    const st = state();
    const queue = await loadAutomationQueue();
    if (!queue || !queue.running) return;
    st.automationRunning = true;
    if (isGoogleChallengePage()) {
      await pauseForChallenge('Google bot challenge detected on load');
      return;
    }
    if (location.pathname.includes('/maps/place/')) {
      // If Google auto-opened a single-place detail, skip it and move on.
      await finishCurrentAndAdvance(queue, 'redirected to place detail on load - skipping');
      return;
    }
    await startAutomation(false);
  }

  async function startCapture() {
    const st = state();
    if (st.running) {
      let records = 0;
      try { records = await PlacesDB.count(); } catch (_) {}
      return { running: true, total: records };
    }
    st.running = true;
    await chrome.storage.local.set({ googlePlacesRunning: true, googlePlacesUpdatedAt: Date.now() });

    await runCapturePass();
    attachAutoCaptureListeners(getListContainer());

    let records = 0;
    try { records = await PlacesDB.count(); } catch (_) {}
    return { running: true, total: records };
  }

  async function stopCapture() {
    const st = state();
    st.running = false;
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
      st.passTimerId = null;
    }
    detachAutoCaptureListeners();
    await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });
    let records = 0;
    try { records = await PlacesDB.count(); } catch (_) {}
    return { running: false, total: records };
  }

  async function refreshCapture() {
    const res = await runCapturePass();
    return { running: state().running, total: res.total, added: res.added, warning: res.warning || '' };
  }

  async function clearCapture() {
    const st = state();
    st.seenIds.clear();
    st.captures = [];
    try { await PlacesDB.clear(); } catch(_) {}
    await chrome.storage.local.set({ googlePlacesUpdatedAt: Date.now() });
    return { total: 0 };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'googlePlacesStart') {
      startCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesStop') {
      stopCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesRefresh') {
      refreshCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesClear') {
      clearCapture().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesAutomationStart') {
      startAutomation(false).then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesAutomationStop') {
      stopAutomation().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesAutomationClear') {
      clearAutomation().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
      return true;
    }
    if (request.action === 'googlePlacesStatus') {
      let sSnapshot = {};
      chrome.storage.local.get(['googlePlacesRunning', 'googlePlacesAutomationQueue']).then((s) => {
        sSnapshot = s;
        return PlacesDB.count();
      }).then((count) => {
        const queue = sSnapshot.googlePlacesAutomationQueue;
        sendResponse({
          running: Boolean(sSnapshot.googlePlacesRunning),
          total: count || 0,
          isMaps: isGoogleMapsPage(),
          automationRunning: Boolean(queue && queue.running),
          automationCurrent: queue ? queue.currentIndex + 1 : 0,
          automationTotal: queue && queue.combinations ? queue.combinations.length : 0
        });
      }).catch(() => {
        const queue = sSnapshot.googlePlacesAutomationQueue;
        sendResponse({
          running: Boolean(sSnapshot.googlePlacesRunning),
          total: 0,
          isMaps: isGoogleMapsPage(),
          automationRunning: Boolean(queue && queue.running),
          automationCurrent: queue ? queue.currentIndex + 1 : 0,
          automationTotal: queue && queue.combinations ? queue.combinations.length : 0
        });
      });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['googlePlacesRunning', 'googlePlacesAutomationQueue']).then((s) => {
    if (s.googlePlacesAutomationQueue && s.googlePlacesAutomationQueue.running) {
      resumeAutomationOnLoad().catch(() => {});
    } else if (s.googlePlacesRunning) {
      startCapture().catch(() => {});
    }
  }).catch(() => {});
})();
