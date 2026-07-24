/* global XLSXWriter, chrome */

let currentScrapedData = null;

const elements = {
  scraperType: document.getElementById('scraper-type'),
  container: document.querySelector('.container'),
  googlePanel: document.getElementById('google-panel'),
  genericPanel: document.getElementById('generic-panel'),
  googleStartBtn: document.getElementById('google-start-btn'),
  googleStopBtn: document.getElementById('google-stop-btn'),
  googleRefreshBtn: document.getElementById('google-refresh-btn'),
  googleClearBtn: document.getElementById('google-clear-btn'),
  googleExportJsonBtn: document.getElementById('google-export-json'),
  googleExportCsvBtn: document.getElementById('google-export-csv'),
  googleExportXlsxBtn: document.getElementById('google-export-xlsx'),
  googleRecordsCount: document.getElementById('google-records-count'),
  googleInlineStatus: document.getElementById('google-inline-status'),
  googleKeywordInput: document.getElementById('google-keyword'),
  googleLocationsInput: document.getElementById('google-locations'),
  googleProgressWrap: document.getElementById('google-progress-wrap'),
  googleProgressFill: document.getElementById('google-progress-fill'),
  googleProgressText: document.getElementById('google-progress-text'),
  placesHelper: document.getElementById('places-helper'),
  googleColumnsBtn: document.getElementById('google-columns-btn'),
  googleColumnsResetBtn: document.getElementById('google-columns-reset'),
  googleColumnsPanel: document.getElementById('google-columns-panel'),
  googleColumnsList: document.getElementById('google-columns-list'),
  googleRunningBadge: document.getElementById('google-running-badge'),
  minimizeBtn: document.getElementById('minimize-btn'),
  maximizeBtn: document.getElementById('maximize-btn'),
  closeBtn: document.getElementById('close-btn'),
  modeRadios: document.querySelectorAll('input[name="mode"]'),
  xpathSection: document.getElementById('xpath-section'),
  xpathInput: document.getElementById('xpath-input'),
  scrapeBtn: document.getElementById('scrape-btn'),
  pickBtn: document.getElementById('pick-btn'),
  cancelPickBtn: document.getElementById('cancel-pick-btn'),
  statusSection: document.getElementById('status-section'),
  statusText: document.getElementById('status-text'),
  previewSection: document.getElementById('preview-section'),
  rawToggleBtn: document.getElementById('raw-toggle-btn'),
  previewTableWrap: document.getElementById('preview-table-wrap'),
  previewTable: document.getElementById('preview-table'),
  previewContent: document.getElementById('preview-content'),
  previewCount: document.getElementById('preview-count'),
  exportJson: document.getElementById('export-json'),
  exportCsv: document.getElementById('export-csv'),
  exportXlsx: document.getElementById('export-xlsx'),
  countBadge: document.getElementById('count-badge'),
  exportSection: document.getElementById('export-section')
};

let isMinimized = false;
let isMaximized = false;
let placesSelectedColumns = null;
let showRawPreview = false;

// IndexedDB is scoped to the page origin, so the popup (chrome-extension:// origin)
// cannot read the DB that a content script on google.com writes. Route all Google
// Places DB operations through the background service worker instead.
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

const DEFAULT_GOOGLE_COLUMNS = [
  'name',
  'rating',
  'reviewCount',
  'reviews',
  'category',
  'address',
  'phone',
  'website',
  'latitude',
  'longitude'
];

const DEFAULT_BING_COLUMNS = [
  'name',
  'category',
  'address',
  'phone',
  'website',
  'latitude',
  'longitude',
  'openStatus',
  'openHoursText',
  'reviews'
];

const DEFAULT_LINKEDIN_COLUMNS = [
  'name',
  'industry',
  'location',
  'followers',
  'companyUrl',
  'verified',
  'connectionInsight',
  'description'
];

const DEFAULT_APNA_COLUMNS = [
  'name',
  'experience',
  'location',
  'education',
  'preferredLocations',
  'phone',
  'email',
  'keywords',
  'lastActive'
];

const DEFAULT_SEARCH_LISTING_COLUMNS = [
  'name',
  'url',
  'source'
];

const DEFAULT_GENERIC_COLUMNS = [
  'type',
  'text',
  'href',
  'linkText',
  'tag',
  'pageTitle',
  'pageUrl'
];

function getDefaultPlacesColumns() {
  if (elements.scraperType.value === 'linkedin') return DEFAULT_LINKEDIN_COLUMNS;
  if (elements.scraperType.value === 'bing_places') return DEFAULT_BING_COLUMNS;
  if (elements.scraperType.value === 'apna') return DEFAULT_APNA_COLUMNS;
  if (elements.scraperType.value === 'search_listing') return DEFAULT_SEARCH_LISTING_COLUMNS;
  if (elements.scraperType.value === 'generic') return DEFAULT_GENERIC_COLUMNS;
  return DEFAULT_GOOGLE_COLUMNS;
}

function isCaptureMode() {
  return isPlacesMode() || elements.scraperType.value === 'generic' || elements.scraperType.value === 'linkedin' || elements.scraperType.value === 'apna' || elements.scraperType.value === 'search_listing';
}

function parseLines(value) {
  if (!value || typeof value !== 'string') return [];
  const lines = value.split(/\n|,/);
  const clean = lines.map(s => s.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  return Array.from(new Set(clean));
}

function getGoogleAutomationQueue() {
  const keywords = parseLines(elements.googleKeywordInput.value);
  const locations = parseLines(elements.googleLocationsInput.value);
  return { keywords, locations };
}

function buildGoogleAutomationQueue(existingIndex = 0) {
  const { keywords, locations } = getGoogleAutomationQueue();
  const combinations = [];
  for (const kw of keywords) {
    for (const loc of locations) {
      combinations.push({ keyword: kw, location: loc });
    }
  }
  return {
    running: false,
    currentIndex: Math.max(0, Math.min(existingIndex, combinations.length)),
    combinations,
    recordsCaptured: 0,
    currentSearchUrl: null
  };
}

function isPlacesMode() {
  return elements.scraperType.value === 'google_places' || elements.scraperType.value === 'bing_places';
}

function getPlacesConfig() {
  if (elements.scraperType.value === 'linkedin') {
    return {
      label: 'LinkedIn Scrapper',
      dataKey: 'linkedinCapturedData',
      runningKey: 'linkedinCaptureRunning',
      searchTermKey: 'linkedinSearchTerm',
      scriptFile: 'linkedin-capture.js',
      actions: {
        start: 'linkedinCaptureStart',
        stop: 'linkedinCaptureStop',
        refresh: 'linkedinCaptureRefresh',
        clear: 'linkedinCaptureClear'
      },
      helperText: 'Open LinkedIn company search results, start capture, and scroll or paginate. Capture continues automatically.'
    };
  }

  if (elements.scraperType.value === 'apna') {
    return {
      label: 'Apna Profiles',
      dataKey: 'apnaCapturedData',
      runningKey: 'apnaCaptureRunning',
      searchTermKey: 'apnaSearchTerm',
      scriptFile: 'apna-capture.js',
      actions: {
        start: 'apnaCaptureStart',
        stop: 'apnaCaptureStop',
        refresh: 'apnaCaptureRefresh',
        clear: 'apnaCaptureClear'
      },
      helperText: 'Open Apna employer search results, start capture, and scroll to collect candidate profiles with phone numbers.'
    };
  }

  if (elements.scraperType.value === 'search_listing') {
    return {
      label: 'Search Listing',
      dataKey: 'searchListingData',
      runningKey: 'searchListingRunning',
      searchTermKey: 'searchListingSearchTerm',
      scriptFile: 'search-listing-capture.js',
      actions: {
        start: 'searchListingStart',
        stop: 'searchListingStop',
        refresh: 'searchListingRefresh',
        clear: 'searchListingClear'
      },
      helperText: 'Open Google, Bing, Yahoo or DuckDuckGo search results, start capture, and scroll or paginate. New listings are captured automatically with URL deduplication.'
    };
  }

  if (elements.scraperType.value === 'generic') {
    return {
      label: 'Generic Scraper',
      dataKey: 'genericCapturedData',
      runningKey: 'genericCaptureRunning',
      searchTermKey: 'genericPageLabel',
      scriptFile: 'generic-capture.js',
      actions: {
        start: 'genericCaptureStart',
        stop: 'genericCaptureStop',
        refresh: 'genericCaptureRefresh',
        clear: 'genericCaptureClear'
      },
      helperText: 'Open any page, start capture, and scroll. New text/links are captured automatically.'
    };
  }

  if (elements.scraperType.value === 'bing_places') {
    return {
      label: 'Bing Places',
      dataKey: 'bingPlacesData',
      runningKey: 'bingPlacesRunning',
      searchTermKey: 'bingPlacesSearchTerm',
      scriptFile: 'bing-places-capture.js',
      actions: {
        start: 'bingPlacesStart',
        stop: 'bingPlacesStop',
        refresh: 'bingPlacesRefresh',
        clear: 'bingPlacesClear'
      },
      helperText: 'Open Bing Maps search results, then start capture and scroll to collect more places.'
    };
  }

  return {
    label: 'Google Places',
    dataKey: 'googlePlacesData',
    runningKey: 'googlePlacesRunning',
    searchTermKey: 'googlePlacesSearchTerm',
    scriptFile: 'google-places-capture.js',
    actions: {
      start: 'googlePlacesStart',
      stop: 'googlePlacesStop',
      refresh: 'googlePlacesRefresh',
      clear: 'googlePlacesClear'
    },
    helperText: 'Open Google Maps search results, then start capture and scroll to collect more places.'
  };
}

function setupWindowControls() {
  isMaximized = true;
  document.body.style.width = '760px';
  document.body.style.minHeight = '620px';
  elements.maximizeBtn.textContent = '<>';
  elements.maximizeBtn.title = 'Restore size';

  elements.minimizeBtn.addEventListener('click', () => {
    isMinimized = !isMinimized;
    elements.container.classList.toggle('minimized', isMinimized);
    elements.minimizeBtn.textContent = isMinimized ? '+' : '-';
    elements.minimizeBtn.title = isMinimized ? 'Restore' : 'Minimize';
  });

  elements.maximizeBtn.addEventListener('click', () => {
    isMaximized = !isMaximized;
    if (isMaximized) {
      document.body.style.width = '760px';
      document.body.style.minHeight = '620px';
      elements.maximizeBtn.textContent = '<>';
      elements.maximizeBtn.title = 'Restore size';
    } else {
      document.body.style.width = '360px';
      document.body.style.minHeight = '400px';
      elements.maximizeBtn.textContent = '[]';
      elements.maximizeBtn.title = 'Maximize';
    }
  });

  elements.closeBtn.addEventListener('click', () => {
    window.close();
  });
}

function normalizeGoogleColumnSelection(allKeys) {
  if (!Array.isArray(allKeys) || !allKeys.length) return;
  const defaults = getDefaultPlacesColumns();
  if (!Array.isArray(placesSelectedColumns) || !placesSelectedColumns.length) {
    placesSelectedColumns = defaults.filter(k => allKeys.includes(k));
    if (!placesSelectedColumns.length) placesSelectedColumns = allKeys.slice(0, 10);
    return;
  }
  placesSelectedColumns = placesSelectedColumns.filter(k => allKeys.includes(k));
  if (!placesSelectedColumns.length) {
    placesSelectedColumns = defaults.filter(k => allKeys.includes(k));
    if (!placesSelectedColumns.length) placesSelectedColumns = allKeys.slice(0, 10);
  }
}

function renderGoogleColumnsPanel(allKeys) {
  if (!elements.googleColumnsList) return;
  if (!Array.isArray(allKeys) || !allKeys.length) {
    elements.googleColumnsList.innerHTML = '';
    return;
  }

  normalizeGoogleColumnSelection(allKeys);
  elements.googleColumnsList.innerHTML = allKeys.map((key) => {
    const checked = placesSelectedColumns.includes(key) ? 'checked' : '';
    return `<label class="columns-item"><input type="checkbox" value="${key}" ${checked}> <span>${key}</span></label>`;
  }).join('');

  elements.googleColumnsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const checked = Array.from(elements.googleColumnsList.querySelectorAll('input[type="checkbox"]:checked')).map(i => i.value);
      placesSelectedColumns = checked.length ? checked : [...getDefaultPlacesColumns()];
      renderPreviewTable(currentScrapedData);
    });
  });
}

function setStatus(msg, type = 'info') {
  elements.statusSection.classList.remove('hidden');
  elements.statusText.textContent = msg;
  if (type === 'error') elements.statusText.style.color = '#dc2626';
  else if (type === 'success') elements.statusText.style.color = '#10b981';
  else elements.statusText.style.color = '#64748b';

  if (isPlacesMode()) {
    elements.googleInlineStatus.textContent = msg;
  }
}

function slugifyFilePart(value) {
  const raw = (value || '').toLowerCase().trim();
  if (!raw) return '';
  const clean = raw
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return clean.slice(0, 80);
}

function timestampSuffix() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}`;
}

async function getExportBaseName() {
  const placesCfg = getPlacesConfig();
  const state = await chrome.storage.local.get([placesCfg.searchTermKey]);
  const type = elements.scraperType.value;

  if (isCaptureMode()) {
    let fallback = 'google-places';
    if (type === 'bing_places') fallback = 'bing-places';
    else if (type === 'linkedin') fallback = 'linkedin-results';
    else if (type === 'search_listing') fallback = 'search-listing-results';
    const fallbackName = type === 'generic' ? 'generic-capture' : fallback;
    const term = slugifyFilePart(state[placesCfg.searchTermKey] || fallbackName);
    return `${term || fallbackName}-${timestampSuffix()}`;
  }

  return `scraped-data-${timestampSuffix()}`;
}

function clearStatus() {
  elements.statusSection.classList.add('hidden');
  elements.statusText.textContent = '';
  elements.googleInlineStatus.textContent = '';
}

function updatePreview(data) {
  currentScrapedData = Array.isArray(data) ? data : [];
  if (!currentScrapedData.length) {
    elements.previewSection.classList.add('hidden');
    elements.previewTableWrap.classList.add('hidden');
    elements.previewTable.innerHTML = '';
    elements.previewCount.textContent = '0';
    elements.countBadge.textContent = '0';
    elements.exportJson.disabled = true;
    elements.exportCsv.disabled = true;
    elements.exportXlsx.disabled = true;
    elements.googleExportJsonBtn.disabled = true;
    elements.googleExportCsvBtn.disabled = true;
    elements.googleExportXlsxBtn.disabled = true;
    elements.googleRecordsCount.textContent = '0 records';
    showRawPreview = false;
    elements.previewContent.classList.add('hidden');
    elements.rawToggleBtn.textContent = '</> Raw';
    return;
  }

  elements.previewSection.classList.remove('hidden');
  renderPreviewTable(currentScrapedData);
  elements.previewCount.textContent = String(currentScrapedData.length);
  elements.countBadge.textContent = String(currentScrapedData.length);
  elements.googleRecordsCount.textContent = `${currentScrapedData.length} records`;
  elements.previewContent.textContent = JSON.stringify(currentScrapedData.slice(0, 5), null, 2) + (currentScrapedData.length > 5 ? '\n...' : '');
  elements.previewContent.classList.toggle('hidden', !showRawPreview);
  elements.rawToggleBtn.textContent = showRawPreview ? '</> Hide' : '</> Raw';
  elements.exportJson.disabled = false;
  elements.exportCsv.disabled = false;
  elements.exportXlsx.disabled = false;
  elements.googleExportJsonBtn.disabled = false;
  elements.googleExportCsvBtn.disabled = false;
  elements.googleExportXlsxBtn.disabled = false;
}

function renderPreviewTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    elements.previewTableWrap.classList.add('hidden');
    elements.previewTable.innerHTML = '';
    return;
  }

  const preferredGoogleColumns = getDefaultPlacesColumns();

  const allKeys = Array.from(new Set(rows.flatMap(Object.keys)));
  let columns = preferredGoogleColumns.filter(k => allKeys.includes(k));

  if (columns.length === 0) {
    columns = allKeys;
  } else {
    if (!isCaptureMode()) {
      const extras = allKeys.filter(k => !columns.includes(k));
      columns = columns.concat(extras);
    } else {
      normalizeGoogleColumnSelection(allKeys);
      columns = placesSelectedColumns.filter(k => allKeys.includes(k));
    }
  }

  if (isCaptureMode()) {
    renderGoogleColumnsPanel(allKeys);
  }

  const sample = rows.slice(0, 100);
  const thead = `<thead><tr>${columns.map(c => `<th title="${c}">${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${sample.map(row => {
    const tds = columns.map(col => {
      const v = row[col];
      const value = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      const safe = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<td title="${safe}">${safe}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('')}</tbody>`;

  elements.previewTable.innerHTML = thead + tbody;
  elements.previewTableWrap.classList.remove('hidden');
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function updateMode() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'xpath') {
    elements.xpathSection.classList.remove('hidden');
    elements.pickBtn.classList.add('hidden');
    elements.scrapeBtn.classList.remove('hidden');
  } else if (mode === 'click') {
    elements.xpathSection.classList.add('hidden');
    elements.pickBtn.classList.remove('hidden');
    elements.scrapeBtn.classList.add('hidden');
  } else {
    elements.xpathSection.classList.add('hidden');
    elements.pickBtn.classList.add('hidden');
    elements.scrapeBtn.classList.remove('hidden');
  }
}

function updateScraperPanel() {
  if (isCaptureMode()) {
    const cfg = getPlacesConfig();
    elements.googlePanel.classList.remove('hidden');
    elements.genericPanel.classList.add('hidden');
    elements.exportSection.classList.add('hidden');
    if (elements.placesHelper) {
      elements.placesHelper.textContent = cfg.helperText;
    }

    // Hide legacy generic picker controls for capture-mode scrapers
    elements.xpathSection.classList.add('hidden');
    elements.pickBtn.classList.add('hidden');
    elements.scrapeBtn.classList.remove('hidden');
  } else {
    elements.googlePanel.classList.add('hidden');
    elements.genericPanel.classList.remove('hidden');
    elements.exportSection.classList.remove('hidden');
    elements.googleColumnsPanel.classList.add('hidden');
  }
}

async function setGoogleRunning(running) {
  elements.googleRunningBadge.textContent = running ? 'Running' : 'Stopped';
  elements.googleRunningBadge.classList.toggle('running', running);
  elements.googleRunningBadge.classList.toggle('stopped', !running);
  elements.googleStartBtn.disabled = running;
  elements.googleStopBtn.disabled = !running;

  if (elements.scraperType.value !== 'google_places') {
    elements.googleStartBtn.textContent = '▶ Start';
    return;
  }

  const saved = await chrome.storage.local.get(['googlePlacesAutomationQueue']);
  const queue = saved.googlePlacesAutomationQueue;
  const canResume = queue && queue.combinations && queue.combinations.length && !running && queue.currentIndex < queue.combinations.length;
  elements.googleStartBtn.textContent = canResume ? '▶ Resume' : '▶ Start';
}

async function ensurePickerInjected(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['picker.css'] });
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
}

async function ensureGooglePlacesInjected(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['google-places-capture.js'] });
}

async function ensureBingPlacesInjected(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['bing-places-capture.js'] });
}

function scrapePage(xpathExpression) {
  const MAX_NODES = 2500;
  const MAX_TEXT_LEN = 800;

  function cleanText(value) {
    if (!value) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
  }

  function toAbsoluteUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, window.location.href).href;
    } catch (_) {
      return url;
    }
  }

  function getXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    while (el && el.nodeType === 1) {
      let idx = 1;
      let sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === el.tagName) idx++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${el.tagName.toLowerCase()}[${idx}]`);
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }

  function extractFromElement(el, depth) {
    const tag = el.tagName.toLowerCase();
    const record = { tag, xpath: getXPath(el), depth };

    const text = cleanText(el.innerText || el.textContent);
    if (text) record.text = text;
    if (el.id) record.id = el.id;
    if (typeof el.className === 'string' && el.className.trim()) record.className = cleanText(el.className);

    const attrs = {};
    for (const attr of el.attributes || []) {
      if (attr.name === 'title' || attr.name === 'alt' || attr.name === 'aria-label' || attr.name === 'name' || attr.name.startsWith('data-')) {
        attrs[attr.name] = cleanText(attr.value);
      }
    }
    if (Object.keys(attrs).length) record.attributes = attrs;

    if (tag === 'a') {
      const href = toAbsoluteUrl(el.getAttribute('href') || el.href);
      if (href) record.url = href;
    }
    if (tag === 'img') {
      const src = toAbsoluteUrl(el.currentSrc || el.src || el.getAttribute('data-src') || '');
      if (src) record.imageUrl = src.startsWith('data:') ? '(data-uri)' : src;
      if (el.alt) record.alt = cleanText(el.alt);
      if (el.naturalWidth) record.width = el.naturalWidth;
      if (el.naturalHeight) record.height = el.naturalHeight;
    }
    if (tag === 'video' || tag === 'source') {
      const src = toAbsoluteUrl(el.src || el.getAttribute('src') || '');
      if (src) record.videoUrl = src;
    }
    if (tag === 'iframe') {
      const src = toAbsoluteUrl(el.src || '');
      if (src) record.frameUrl = src;
    }
    if (tag === 'table') {
      const rows = [];
      const trs = el.querySelectorAll('tr');
      for (let r = 0; r < trs.length && r < 100; r++) {
        const row = trs[r];
        rows.push(Array.from(row.querySelectorAll('th, td')).slice(0, 30).map(c => cleanText(c.textContent)));
      }
      record.table = rows;
    }
    return record;
  }

  let scanned = 0;
  function walk(el, results, depth = 0) {
    if (!el || el.nodeType !== 1 || scanned >= MAX_NODES) return;
    scanned++;
    results.push(extractFromElement(el, depth));
    for (const child of el.children) {
      if (scanned >= MAX_NODES) break;
      walk(child, results, depth + 1);
    }
  }

  let roots = [];
  if (xpathExpression) {
    try {
      const res = document.evaluate(xpathExpression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < res.snapshotLength; i++) roots.push(res.snapshotItem(i));
    } catch (e) {
      return { error: 'Invalid XPath: ' + e.message };
    }
  }
  if (!roots.length) roots = [document.body];

  const results = [];
  for (const root of roots) if (root && root.nodeType === 1) walk(root, results);
  return {
    data: results,
    meta: {
      pageUrl: window.location.href,
      title: document.title,
      selectedXPath: xpathExpression || '/html/body',
      scannedNodes: scanned,
      truncated: scanned >= MAX_NODES
    }
  };
}

async function runGenericScrape(xpath = null) {
  clearStatus();
  setStatus('Scraping...', 'info');
  const tab = await getCurrentTab();
  if (!tab || !tab.id) {
    setStatus('No active tab found.', 'error');
    return;
  }
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://'))) {
    setStatus('Cannot scrape browser pages. Open a website.', 'error');
    return;
  }

  try {
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage, args: [xpath] });
    const payload = result[0] && result[0].result;
    if (payload && payload.error) {
      setStatus(payload.error, 'error');
      updatePreview([]);
      return;
    }
    updatePreview((payload && payload.data) || []);
    setStatus(`Scraped ${((payload && payload.data) || []).length} nodes.`, 'success');
  } catch (err) {
    setStatus('Scrape failed: ' + (err && err.message ? err.message : String(err)), 'error');
    updatePreview([]);
  }
}

function renderProgress(progress) {
  if (!progress || !progress.total) {
    elements.googleProgressWrap.classList.add('hidden');
    return;
  }
  elements.googleProgressWrap.classList.remove('hidden');
  elements.googleProgressFill.style.width = `${progress.percent}%`;
  elements.googleProgressText.textContent = `${progress.current}/${progress.total} - ${progress.percent}% complete`;
}

async function loadGoogleAutomationInputs() {
  if (elements.scraperType.value !== 'google_places') return;
  const saved = await chrome.storage.local.get([
    'googlePlacesKeyword',
    'googlePlacesLocations',
    'googlePlacesProgress',
    'googlePlacesAutomationQueue'
  ]);
  if (saved.googlePlacesKeyword) {
    elements.googleKeywordInput.value = saved.googlePlacesKeyword;
  }
  if (saved.googlePlacesLocations) {
    elements.googleLocationsInput.value = saved.googlePlacesLocations;
  }
  renderProgress(saved.googlePlacesProgress);

  const queue = saved.googlePlacesAutomationQueue;
  if (queue && queue.combinations && queue.combinations.length && queue.currentIndex < queue.combinations.length) {
    elements.googleStartBtn.textContent = queue.running ? '▶ Start' : '▶ Resume';
  } else {
    elements.googleStartBtn.textContent = '▶ Start';
  }
}

async function loadPlacesData() {
  const cfg = getPlacesConfig();
  const state = await chrome.storage.local.get([
    cfg.dataKey,
    cfg.runningKey,
    'googlePlacesProgress',
    'googlePlacesAutomationQueue'
  ]);

  let rows = [];
  if (elements.scraperType.value === 'google_places') {
    try {
      rows = await PlacesDB.getAll();
      // One-time migration from chrome.storage.local (older versions stored here).
      try {
        const legacy = await chrome.storage.local.get(['googlePlacesData']);
        if (Array.isArray(legacy.googlePlacesData) && legacy.googlePlacesData.length) {
          await PlacesDB.save(legacy.googlePlacesData);
          await chrome.storage.local.remove(['googlePlacesData']);
          rows = await PlacesDB.getAll();
        }
      } catch (legacyErr) {
        console.warn('[Popup] Legacy storage migration skipped', legacyErr);
      }
    } catch (err) {
      console.warn('[Popup] Failed to load Google Places DB records', err);
      rows = [];
    }
  } else {
    rows = Array.isArray(state[cfg.dataKey]) ? state[cfg.dataKey] : [];
  }

  setGoogleRunning(Boolean(state[cfg.runningKey]));
  updatePreview(rows);
  renderProgress(state.googlePlacesProgress);
  await loadGoogleAutomationInputs();
  if (!rows.length) {
    setStatus(`No ${cfg.label} data captured yet.`, 'info');
  } else {
    setStatus(`Loaded ${rows.length} ${cfg.label} records.`, 'success');
  }
}

async function sendPlacesAction(action) {
  const tab = await getCurrentTab();
  if (!tab || !tab.id) {
    setStatus('No active tab found.', 'error');
    return null;
  }

  const cfg = getPlacesConfig();

  if (elements.scraperType.value === 'generic') {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['generic-capture.js'] });
      const resGeneric = await chrome.tabs.sendMessage(tab.id, { action });
      if (resGeneric && resGeneric.error) {
        setStatus(`${cfg.label} error: ` + resGeneric.error, 'error');
        return null;
      }
      return resGeneric;
    } catch (err) {
      setStatus('Unable to reach page for Generic capture. Refresh and retry.', 'error');
      return null;
    }
  }

  if (elements.scraperType.value === 'linkedin') {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['linkedin-capture.js'] });
      const resLinkedin = await chrome.tabs.sendMessage(tab.id, { action });
      if (resLinkedin && resLinkedin.error) {
        setStatus(`${cfg.label} error: ` + resLinkedin.error, 'error');
        return null;
      }
      return resLinkedin;
    } catch (err) {
      setStatus('Unable to reach page for LinkedIn capture. Refresh and retry.', 'error');
      return null;
    }
  }

  if (elements.scraperType.value === 'apna') {
    try {
      console.log('[Popup] Injecting apna-capture.js into tab', tab.id);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['apna-capture.js'] });
      console.log('[Popup] Script injected, waiting 500ms...');
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('[Popup] Sending message:', action);
      const resApna = await chrome.tabs.sendMessage(tab.id, { action });
      console.log('[Popup] Response received:', resApna);
      if (resApna && resApna.error) {
        setStatus(`${cfg.label} error: ` + resApna.error, 'error');
        return null;
      }
      return resApna;
    } catch (err) {
      console.error('[Popup] Error with Apna capture:', err);
      setStatus('Unable to reach page for Apna capture. Refresh and retry.', 'error');
      return null;
    }
  }

  if (elements.scraperType.value === 'search_listing') {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['search-listing-capture.js'] });
      const resListing = await chrome.tabs.sendMessage(tab.id, { action });
      if (resListing && resListing.error) {
        setStatus(`${cfg.label} error: ` + resListing.error, 'error');
        return null;
      }
      return resListing;
    } catch (err) {
      setStatus('Unable to reach page for Search Listing capture. Refresh and retry.', 'error');
      return null;
    }
  }

  const isAutomationAction = elements.scraperType.value === 'google_places' && action && action.startsWith('googlePlacesAutomation');

  if (!isAutomationAction && (!tab.url || !tab.url.includes('/maps'))) {
    setStatus(`Open ${cfg.label} search results tab first.`, 'error');
    return null;
  }

  if (!isAutomationAction && elements.scraperType.value === 'google_places' && !tab.url.includes('google.')) {
    setStatus('Open Google Maps tab first.', 'error');
    return null;
  }

  if (elements.scraperType.value === 'bing_places' && !tab.url.includes('bing.com')) {
    setStatus('Open Bing Maps tab first.', 'error');
    return null;
  }

  try {
    if (elements.scraperType.value === 'bing_places') {
      await ensureBingPlacesInjected(tab.id);
    } else {
      await ensureGooglePlacesInjected(tab.id);
    }
    const res = await chrome.tabs.sendMessage(tab.id, { action });
    if (res && res.error) {
      setStatus(`${cfg.label} error: ` + res.error, 'error');
      return null;
    }
    return res;
  } catch (err) {
    setStatus(`Unable to reach ${cfg.label} tab. Refresh Maps page and retry.`, 'error');
    return null;
  }
}

elements.scraperType.addEventListener('change', async () => {
  placesSelectedColumns = null;
  await chrome.storage.local.set({ lastScraperType: elements.scraperType.value });
  updateScraperPanel();
  if (isCaptureMode()) {
    await loadPlacesData();
  } else {
    clearStatus();
    updatePreview([]);
  }
});

elements.modeRadios.forEach(r => r.addEventListener('change', updateMode));

elements.scrapeBtn.addEventListener('click', async () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let xpath = null;
  if (mode === 'xpath') {
    xpath = elements.xpathInput.value.trim();
    if (!xpath) {
      setStatus('Please enter an XPath expression.', 'error');
      return;
    }
  }
  await runGenericScrape(xpath);
});

elements.pickBtn.addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (!tab) return;
  try {
    await ensurePickerInjected(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action: 'startPicking' });
    window.close();
  } catch (_) {
    setStatus('Could not start picker. Refresh page and try again.', 'error');
  }
});

elements.cancelPickBtn.addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { action: 'stopPicking' }); } catch (_) {}
  clearStatus();
});

elements.googleStartBtn.addEventListener('click', async () => {
  const cfg = getPlacesConfig();

  if (elements.scraperType.value === 'google_places') {
    const { keywords, locations } = getGoogleAutomationQueue();
    if (!keywords.length) {
      setStatus('Please enter at least one keyword.', 'error');
      return;
    }
    if (!locations.length) {
      setStatus('Please enter at least one city or state.', 'error');
      return;
    }

    setStatus(`Starting ${cfg.label} automation...`, 'info');

    await chrome.storage.local.set({
      googlePlacesKeyword: elements.googleKeywordInput.value,
      googlePlacesLocations: elements.googleLocationsInput.value
    });

    const saved = await chrome.storage.local.get(['googlePlacesAutomationQueue']);
    const existing = saved.googlePlacesAutomationQueue;
    let queue;
    if (existing && existing.combinations && existing.combinations.length && existing.currentIndex < existing.combinations.length) {
      // Continue the existing queue. Only Reset/Clear wipes it out and starts new.
      queue = existing;
      queue.running = true;
    } else {
      queue = buildGoogleAutomationQueue(0);
      queue.running = true;
    }
    await chrome.storage.local.set({ googlePlacesAutomationQueue: queue });

    const res = await sendPlacesAction('googlePlacesAutomationStart');
    if (!res) return;
    setGoogleRunning(true);
    await loadPlacesData();
    setStatus(`Automation running. Search ${queue.currentIndex + 1}/${queue.combinations.length}`, 'success');
    return;
  }

  setStatus(`Starting ${cfg.label} capture...`, 'info');
  const res = await sendPlacesAction(cfg.actions.start);
  if (!res) return;
  setGoogleRunning(true);
  await loadPlacesData();
  setStatus(`Capture running. Total records: ${res.total || 0}`, 'success');
});

elements.googleStopBtn.addEventListener('click', async () => {
  const cfg = getPlacesConfig();
  const action = elements.scraperType.value === 'google_places'
    ? 'googlePlacesAutomationStop'
    : cfg.actions.stop;
  const res = await sendPlacesAction(action);
  if (!res) return;
  setGoogleRunning(false);
  await loadPlacesData();
  setStatus(`Capture stopped. Total records: ${res.total || 0}`, 'success');
});

elements.googleRefreshBtn.addEventListener('click', async () => {
  const cfg = getPlacesConfig();
  const res = await sendPlacesAction(cfg.actions.refresh);
  if (!res) return;

  if (elements.scraperType.value === 'linkedin') {
    await sendPlacesAction('linkedinCaptureDedupe');
  }

  await loadPlacesData();
  const added = typeof res.added === 'number' ? res.added : 0;
  const updated = typeof res.updated === 'number' ? res.updated : 0;
  setStatus(`Refreshed ${cfg.label} data. Added ${added}, updated ${updated}.`, 'success');
});

elements.googleClearBtn.addEventListener('click', async () => {
  const cfg = getPlacesConfig();
  await chrome.storage.local.set({
    [cfg.dataKey]: [],
    [cfg.runningKey]: false,
    genericCapturedUpdatedAt: Date.now(),
    bingPlacesUpdatedAt: Date.now(),
    googlePlacesUpdatedAt: Date.now(),
    googlePlacesAutomationQueue: null,
    googlePlacesProgress: null
  });
  if (elements.scraperType.value === 'google_places') {
    try { await PlacesDB.clear(); } catch (_) {}
  }
  const action = elements.scraperType.value === 'google_places'
    ? 'googlePlacesAutomationClear'
    : cfg.actions.clear;
  await sendPlacesAction(action);
  setGoogleRunning(false);
  updatePreview([]);
  setStatus(`${cfg.label} data cleared.`, 'success');
  renderGoogleColumnsPanel([]);
  renderProgress(null);
});

elements.googleColumnsBtn.addEventListener('click', () => {
  elements.googleColumnsPanel.classList.toggle('hidden');
});

elements.googleColumnsResetBtn.addEventListener('click', () => {
  placesSelectedColumns = null;
  renderPreviewTable(currentScrapedData);
});

elements.rawToggleBtn.addEventListener('click', () => {
  showRawPreview = !showRawPreview;
  elements.previewContent.classList.toggle('hidden', !showRawPreview);
  elements.rawToggleBtn.textContent = showRawPreview ? '</> Hide' : '</> Raw';
});

function exportJsonNow() {
  if (!currentScrapedData || !currentScrapedData.length) return;
  const prepared = getExportPayload(currentScrapedData);
  getExportBaseName().then((base) => {
    const blob = new Blob([JSON.stringify(prepared.rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `${base}.json`, saveAs: true });
  });
}

function exportCsvNow() {
  if (!currentScrapedData || !currentScrapedData.length) return;
  const prepared = getExportPayload(currentScrapedData);
  const headers = prepared.headers;
  const escape = (val) => {
    if (val == null) return '';
    const normalized = typeof val === 'object' ? JSON.stringify(val) : String(val);
    const str = normalized.replace(/"/g, '""');
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) return `"${str}"`;
    return str;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of prepared.rows) lines.push(headers.map(h => escape(row[h])).join(','));
  getExportBaseName().then((base) => {
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `${base}.csv`, saveAs: true });
  });
}

function exportXlsxNow() {
  if (!currentScrapedData || !currentScrapedData.length) return;
  const prepared = getExportPayload(currentScrapedData);
  const headers = prepared.headers;
  const rows = prepared.rows.map(row => headers.map(h => {
    const v = row[h];
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }));
  getExportBaseName().then((base) => {
    const xlsx = new XLSXWriter('Sheet1');
    xlsx.addRow(headers);
    rows.forEach(r => xlsx.addRow(r));
    const buf = xlsx.generate();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `${base}.xlsx`, saveAs: true });
  });
}

function getExportPayload(rows) {
  const inputRows = Array.isArray(rows) ? rows : [];
  if (!inputRows.length) {
    return { headers: [], rows: [] };
  }

  if (elements.scraperType.value === 'generic') {
    const preferredGeneric = [
      { out: 'type', ins: ['type'] },
      { out: 'text', ins: ['text'] },
      { out: 'href', ins: ['href'] },
      { out: 'linkText', ins: ['linkText'] },
      { out: 'tag', ins: ['tag'] },
      { out: 'context', ins: ['context'] },
      { out: 'pageTitle', ins: ['pageTitle'] },
      { out: 'pageUrl', ins: ['pageUrl'] }
    ];

    const consumedGeneric = new Set(preferredGeneric.flatMap(d => d.ins));
    const extrasGeneric = [];
    const extrasSet = new Set();

    const mapped = inputRows.map((row) => {
      const out = {};
      for (const def of preferredGeneric) {
        let value = '';
        for (const candidate of def.ins) {
          if (row[candidate] != null && row[candidate] !== '') {
            value = row[candidate];
            break;
          }
        }
        out[def.out] = value;
      }

      for (const key of Object.keys(row)) {
        if (consumedGeneric.has(key)) continue;
        if (!extrasSet.has(key)) {
          extrasSet.add(key);
          extrasGeneric.push(key);
        }
        out[key] = row[key];
      }
      return out;
    });

    const headers = preferredGeneric.map(d => d.out).concat(extrasGeneric);
    return { headers, rows: mapped };
  }

  if (elements.scraperType.value === 'linkedin') {
    const preferredLinkedin = [
      { out: 'name', ins: ['name'] },
      { out: 'industry', ins: ['industry'] },
      { out: 'location', ins: ['location'] },
      { out: 'followers', ins: ['followers'] },
      { out: 'companyUrl', ins: ['companyUrl'] },
      { out: 'verified', ins: ['verified'] },
      { out: 'connectionInsight', ins: ['connectionInsight'] },
      { out: 'description', ins: ['description'] }
    ];

    const consumedLinkedin = new Set(preferredLinkedin.flatMap(d => d.ins));
    const extrasLinkedin = [];
    const extrasSetLinkedin = new Set();

    const mapped = inputRows.map((row) => {
      const out = {};
      for (const def of preferredLinkedin) {
        let value = '';
        for (const candidate of def.ins) {
          if (row[candidate] != null && row[candidate] !== '') {
            value = row[candidate];
            break;
          }
        }
        out[def.out] = value;
      }

      for (const key of Object.keys(row)) {
        if (consumedLinkedin.has(key)) continue;
        if (!extrasSetLinkedin.has(key)) {
          extrasSetLinkedin.add(key);
          extrasLinkedin.push(key);
        }
        out[key] = row[key];
      }
      return out;
    });

    const headers = preferredLinkedin.map(d => d.out).concat(extrasLinkedin);
    return { headers, rows: mapped };
  }

  if (elements.scraperType.value === 'search_listing') {
    const preferredListing = [
      { out: 'name', ins: ['name'] },
      { out: 'url', ins: ['url'] },
      { out: 'source', ins: ['source'] }
    ];

    const consumedListing = new Set(preferredListing.flatMap(d => d.ins));
    const extrasListing = [];
    const extrasSetListing = new Set();

    const mapped = inputRows.map((row) => {
      const out = {};
      for (const def of preferredListing) {
        let value = '';
        for (const candidate of def.ins) {
          if (row[candidate] != null && row[candidate] !== '') {
            value = row[candidate];
            break;
          }
        }
        out[def.out] = value;
      }

      for (const key of Object.keys(row)) {
        if (consumedListing.has(key)) continue;
        if (!extrasSetListing.has(key)) {
          extrasSetListing.add(key);
          extrasListing.push(key);
        }
        out[key] = row[key];
      }
      return out;
    });

    const headers = preferredListing.map(d => d.out).concat(extrasListing);
    return { headers, rows: mapped };
  }

  if (!isCaptureMode()) {
    const headers = Array.from(new Set(inputRows.flatMap(Object.keys)));
    return { headers, rows: inputRows };
  }

  const preferredDefs = [
    { out: 'category', ins: ['category'] },
    { out: 'name', ins: ['name'] },
    { out: 'address', ins: ['address'] },
    { out: 'phone', ins: ['phone'] },
    { out: 'website', ins: ['website'] },
    { out: 'lat', ins: ['lat', 'latitude'] },
    { out: 'lng', ins: ['lng', 'longitude'] },
    { out: 'rating', ins: ['rating'] },
    { out: 'reviews', ins: ['reviews', 'reviewCount'] }
  ];

  const consumed = new Set(preferredDefs.flatMap(d => d.ins));
  const extras = [];
  const extraSet = new Set();

  const mappedRows = inputRows.map((row) => {
    const out = {};

    for (const def of preferredDefs) {
      let value = '';
      for (const candidate of def.ins) {
        if (row[candidate] != null && row[candidate] !== '') {
          value = row[candidate];
          break;
        }
      }
      out[def.out] = value;
    }

    for (const key of Object.keys(row)) {
      if (consumed.has(key)) continue;
      if (!extraSet.has(key)) {
        extraSet.add(key);
        extras.push(key);
      }
      out[key] = row[key];
    }

    return out;
  });

  const headers = preferredDefs.map(d => d.out).concat(extras);
  return { headers, rows: mappedRows };
}

elements.exportJson.addEventListener('click', exportJsonNow);

elements.exportCsv.addEventListener('click', exportCsvNow);

elements.exportXlsx.addEventListener('click', exportXlsxNow);
elements.googleExportJsonBtn.addEventListener('click', exportJsonNow);
elements.googleExportCsvBtn.addEventListener('click', exportCsvNow);
elements.googleExportXlsxBtn.addEventListener('click', exportXlsxNow);

async function checkPickedData() {
  try {
    const result = await chrome.storage.local.get(['lastPickedXPath', 'lastPickedAt']);
    if (result.lastPickedXPath && elements.scraperType.value === 'generic') {
      await chrome.storage.local.remove(['lastPickedXPath', 'lastPickedAt']);
      await runGenericScrape(result.lastPickedXPath);
    }
  } catch (_) {}
}

function scraperTypeMatchesSource(source) {
  if (elements.scraperType.value === 'google_places' && source === 'google_places') return true;
  if (elements.scraperType.value === 'bing_places' && source === 'bing_places') return true;
  if (elements.scraperType.value === 'linkedin' && source === 'linkedin_companies') return true;
  if (elements.scraperType.value === 'search_listing' && source === 'search_listing') return true;
  if (elements.scraperType.value === 'apna' && source === 'apna') return true;
  if (elements.scraperType.value === 'generic' && source === 'generic_capture') return true;
  return false;
}

async function saveGoogleAutomationInputs() {
  const keyword = elements.googleKeywordInput.value;
  const locations = elements.googleLocationsInput.value;
  const saved = await chrome.storage.local.get(['googlePlacesAutomationQueue', 'googlePlacesRunning']);
  const queue = saved.googlePlacesAutomationQueue;

  // If user changes inputs while not running, wipe the old queue/progress so the next Start uses the new values.
  if (queue && !queue.running && !saved.googlePlacesRunning) {
    await chrome.storage.local.remove(['googlePlacesAutomationQueue', 'googlePlacesProgress']);
    elements.googleStartBtn.textContent = '▶ Start';
    elements.googleProgressWrap.classList.add('hidden');
  }

  await chrome.storage.local.set({
    googlePlacesKeyword: keyword,
    googlePlacesLocations: locations
  });
}

if (elements.googleKeywordInput) {
  elements.googleKeywordInput.addEventListener('input', debounce(saveGoogleAutomationInputs, 400));
}
if (elements.googleLocationsInput) {
  elements.googleLocationsInput.addEventListener('input', debounce(saveGoogleAutomationInputs, 400));
}

function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'capturedDataUpdated') {
    if (!isCaptureMode()) return;
    if (!scraperTypeMatchesSource(request.source)) return;
    loadPlacesData();
  }
  if (request.action === 'googlePlacesProgressUpdated') {
    renderProgress(request.progress);
  }
  if (request.action === 'automationComplete') {
    setStatus('Automation completed all searches.', 'success');
    setGoogleRunning(false);
  }
  if (request.action === 'googlePlacesChallengeDetected') {
    setStatus(`Google challenge page detected: ${request.reason || ''}. Complete it, then click Resume.`, 'error');
    setGoogleRunning(false);
    loadGoogleAutomationInputs();
  }
});

async function boot() {
  setupWindowControls();

  // Restore last selected scraper type
  try {
    const saved = await chrome.storage.local.get(['lastScraperType']);
    if (saved.lastScraperType) {
      elements.scraperType.value = saved.lastScraperType;
    }
  } catch (_) {}

  updateMode();
  updateScraperPanel();
  if (isCaptureMode()) {
    await loadPlacesData();
  }
  checkPickedData();
}

boot();
