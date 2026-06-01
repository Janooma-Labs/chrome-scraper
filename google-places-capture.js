/* global chrome */
(function () {
  'use strict';

  if (globalThis.__placesCaptureLoaded) return;
  globalThis.__placesCaptureLoaded = true;

  const STATE_KEY = '__placesCaptureState';

  function isGoogleMapsPage() {
    return location.hostname.includes('google.') && location.pathname.includes('/maps');
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
    const scope = container || document;
    const links = Array.from(scope.querySelectorAll('a[href*="/maps/place/"]'));
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
    const existing = await chrome.storage.local.get(['googlePlacesData']);
    const prev = Array.isArray(existing.googlePlacesData) ? existing.googlePlacesData : [];

    const byKey = new Map();
    for (const row of prev) {
      const key = placeKey(row);
      if (key) byKey.set(key, row);
    }

    let added = 0;
    let updated = 0;
    for (const item of items) {
      const key = placeKey(item);
      if (!key) continue;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, item);
        added += 1;
      } else {
        const mergedItem = mergePreferNew(current, item);
        if (JSON.stringify(mergedItem) !== JSON.stringify(current)) {
          byKey.set(key, mergedItem);
          updated += 1;
        }
      }
    }

    const merged = Array.from(byKey.values());
    await chrome.storage.local.set({
      googlePlacesData: merged,
      googlePlacesUpdatedAt: Date.now()
    });
    return { total: merged.length, added, updated };
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
      const existing = await chrome.storage.local.get(['googlePlacesData']);
      total = Array.isArray(existing.googlePlacesData) ? existing.googlePlacesData.length : 0;
    }

    if (container) {
      container.scrollTop = container.scrollTop + Math.max(400, Math.floor(container.clientHeight * 0.7));
    }

    const searchTerm = getCurrentSearchTerm();
    if (searchTerm) {
      await chrome.storage.local.set({ googlePlacesSearchTerm: searchTerm });
    }

    return { added, updated, total, searchTerm };
  }

  async function startCapture() {
    const st = state();
    if (st.running) {
      const existing = await chrome.storage.local.get(['googlePlacesData']);
      return { running: true, total: Array.isArray(existing.googlePlacesData) ? existing.googlePlacesData.length : 0 };
    }
    st.running = true;
    await chrome.storage.local.set({ googlePlacesRunning: true, googlePlacesUpdatedAt: Date.now() });

    await runCapturePass();
    attachAutoCaptureListeners(getListContainer());
    st.timerId = setInterval(() => {
      runCapturePass().catch(() => {});
    }, 1500);

    const existing = await chrome.storage.local.get(['googlePlacesData']);
    return { running: true, total: Array.isArray(existing.googlePlacesData) ? existing.googlePlacesData.length : 0 };
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
    detachAutoCaptureListeners();
    await chrome.storage.local.set({ googlePlacesRunning: false, googlePlacesUpdatedAt: Date.now() });
    const existing = await chrome.storage.local.get(['googlePlacesData']);
    return { running: false, total: Array.isArray(existing.googlePlacesData) ? existing.googlePlacesData.length : 0 };
  }

  async function refreshCapture() {
    const res = await runCapturePass();
    return { running: state().running, total: res.total, added: res.added, warning: res.warning || '' };
  }

  async function clearCapture() {
    const st = state();
    st.seenIds.clear();
    st.captures = [];
    await chrome.storage.local.set({ googlePlacesData: [], googlePlacesUpdatedAt: Date.now() });
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
    if (request.action === 'googlePlacesStatus') {
      chrome.storage.local.get(['googlePlacesData', 'googlePlacesRunning']).then((s) => {
        sendResponse({
          running: Boolean(s.googlePlacesRunning),
          total: Array.isArray(s.googlePlacesData) ? s.googlePlacesData.length : 0,
          isMaps: isGoogleMapsPage()
        });
      });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['googlePlacesRunning']).then((s) => {
    if (s.googlePlacesRunning) {
      startCapture().catch(() => {});
    }
  }).catch(() => {});
})();
