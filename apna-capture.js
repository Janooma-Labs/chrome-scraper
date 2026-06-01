/* global chrome */
(function () {
  'use strict';

  console.log('[Apna Scraper] Script loaded!', location.href);

  if (globalThis.__apnaCaptureLoaded) {
    console.log('[Apna Scraper] Already loaded, skipping');
    return;
  }
  globalThis.__apnaCaptureLoaded = true;
  console.log('[Apna Scraper] Initializing...');

  const STATE_KEY = '__apnaCaptureState';

  function isApnaPage() {
    // Allow any employer.apna.co page
    return location.hostname.includes('apna.co');
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

  function getListContainer() {
    // Find the main container that holds all profile cards
    // Look for div.css-qmeovh which contains all the cards
    const mainContainer = document.querySelector('div.css-qmeovh');
    if (mainContainer) return mainContainer;
    
    // Fallback: Look for any container with MuiCard-root cards
    const candidates = [
      'div[class*="css-"]',
      'div[role="main"]',
      'main'
    ];
    
    for (const selector of candidates) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (el.querySelector('div.MuiCard-root.css-1tv8qms') || 
            el.querySelector('div.MuiCard-root.css-1k5fup7') ||
            el.querySelector('div.MuiCard-root')) {
          return el;
        }
      }
    }
    return document.body;
  }

  function getProfileCards(container) {
    const scope = container || document;
    
    // Try multiple selectors in order of specificity
    const selectors = [
      'div.MuiCard-root.css-1tv8qms',  // Primary selector
      'div.MuiCard-root.css-1k5fup7',  // Fallback 1
      'div.css-qmeovh div.MuiCard-root',  // Fallback 2: any card in main container
      'div.MuiCard-root',  // Fallback 3: any card at all
      'div.MuiPaper-root.MuiCard-root'  // Fallback 4: full MUI class
    ];
    
    for (const selector of selectors) {
      const cards = Array.from(scope.querySelectorAll(selector));
      if (cards.length > 0) {
        console.log(`[Apna Scraper] Found ${cards.length} cards using selector: ${selector}`);
        return cards;
      }
    }
    
    console.log('[Apna Scraper] No cards found with any selector');
    return [];
  }

  function extractTextFromElement(el, selector) {
    if (!el) return '';
    const target = selector ? el.querySelector(selector) : el;
    return normalizeText(target ? target.textContent : '');
  }

  function extractPhoneFromButton(card) {
    // Phone number might be behind "View Phone Number" button
    // Check if button has been clicked and number is visible
    const phoneBtn = card.querySelector('button[id*=":r"] span.MuiButton-startIcon');
    if (!phoneBtn) return '';
    
    // Look for phone number in nearby elements or button text
    const buttonText = extractTextFromElement(card, 'button[id*=":r"]');
    if (buttonText && buttonText !== 'View Phone Number') {
      const phoneMatch = buttonText.match(/[\d\s\-\(\)\+]+/);
      if (phoneMatch) return normalizeText(phoneMatch[0]);
    }
    
    return 'Locked - Click to view';
  }

  function extractPhoneFromScript() {
    // Try to find phone numbers in embedded JavaScript
    const scripts = Array.from(document.querySelectorAll('script'));
    const phoneNumbers = [];
    
    for (const script of scripts) {
      const content = script.textContent || script.innerText;
      if (!content) continue;
      
      // Look for phone patterns in JSON or JavaScript
      const phoneMatches = content.match(/"phone[^"]*":\s*"([^"]+)"/gi);
      if (phoneMatches) {
        phoneMatches.forEach(match => {
          const num = match.match(/"([^"]+)"$/);
          if (num && num[1]) phoneNumbers.push(normalizeText(num[1]));
        });
      }
      
      // Look for direct phone number patterns
      const directMatches = content.match(/[\+\d][\d\s\-\(\)]{8,}/g);
      if (directMatches) {
        directMatches.forEach(num => {
          const cleaned = normalizeText(num);
          if (cleaned.length >= 10) phoneNumbers.push(cleaned);
        });
      }
    }
    
    return phoneNumbers;
  }

  function extractProfile(card, index) {
    // Extract name - in h1.css-8wki2x
    let name = '';
    const nameEl = card.querySelector('h1.css-8wki2x');
    if (nameEl) {
      name = normalizeText(nameEl.textContent);
    }

    if (index === 0) {
      console.log('[Apna Scraper] Sample extraction (first card):');
      console.log('  Name element:', nameEl);
      console.log('  Name:', name);
    }

    // Extract experience/title - looks for "Fresher" or experience in h5
    let title = '';
    let experience = '';
    const h5Elements = card.querySelectorAll('h5.css-8wri2g, h5.css-1iiw76u, h5');
    for (const h5 of h5Elements) {
      const text = normalizeText(h5.textContent);
      if (text && !text.includes('Education') && !text.includes('Location')) {
        if (text.toLowerCase().includes('fresher') || text.match(/\d+\s*year/i)) {
          experience = text;
        } else if (!title) {
          title = text;
        }
      }
    }

    // Extract location - h5 with location icon nearby
    let location = '';
    const locationSvgs = card.querySelectorAll('svg path[d*="M5.99935"]');
    for (const svg of locationSvgs) {
      const parent = svg.closest('div.css-15mtapa, div.css-3u2ksa');
      if (parent) {
        const h5 = parent.querySelector('h5.css-8wri2g, h5.css-1iiw76u, h5');
        if (h5) {
          location = normalizeText(h5.textContent);
          break;
        }
      }
    }

    // Extract education
    let education = '';
    const educationDiv = card.querySelector('div.css-lblz1');
    if (educationDiv) {
      education = normalizeText(educationDiv.textContent);
    }

    // Extract preferred locations (chips)
    const prefLocations = [];
    const chips = card.querySelectorAll('div.MuiChip-root span.MuiChip-label div');
    for (const chip of chips) {
      const text = normalizeText(chip.textContent);
      if (text) prefLocations.push(text);
    }

    // Extract phone button ID (for tracking)
    let phoneButtonId = '';
    const phoneBtn = card.querySelector('button[id*=":r"]');
    if (phoneBtn) {
      phoneButtonId = phoneBtn.id;
    }

    // Extract phone
    const phone = extractPhoneFromButton(card);

    // Extract last active date
    let lastActive = '';
    const activeEl = card.querySelector('div.css-3u2ksa');
    if (activeEl && activeEl.textContent.includes('Active on')) {
      lastActive = normalizeText(activeEl.textContent);
    }

    // Extract skills/keywords (highlighted text)
    const highlights = Array.from(card.querySelectorAll('span[style*="background-color:#FFEA92"]'));
    const keywords = highlights.map(h => normalizeText(h.textContent)).filter(Boolean);

    // Extract full text for additional parsing
    const fullText = extractTextFromElement(card);
    
    // Extract email if present
    const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';

    // Create unique ID
    const profileId = phoneButtonId || `apna_${index}_${Date.now()}`;

    return {
      profileId,
      name: name || 'N/A',
      title: title || 'N/A',
      experience: experience || 'N/A',
      location: location || 'N/A',
      education: education || 'N/A',
      preferredLocations: prefLocations.join(', ') || 'N/A',
      phone: phone || 'N/A',
      email: email || 'N/A',
      keywords: keywords.join(', ') || 'N/A',
      lastActive: lastActive || 'N/A',
      fullText: fullText.substring(0, 500), // First 500 chars of full text
      capturedAt: new Date().toISOString(),
      searchPage: location.href
    };
  }

  function profileKey(profile) {
    return profile.profileId || `${profile.name}|${profile.location}`;
  }

  function mergeProfiles(oldProfile, newProfile) {
    const merged = { ...oldProfile };
    for (const [key, value] of Object.entries(newProfile)) {
      if (value == null || value === '' || value === 'N/A') continue;
      if (merged[key] == null || merged[key] === '' || merged[key] === 'N/A') {
        merged[key] = value;
      } else if (key === 'capturedAt') {
        merged[key] = value;
      }
    }
    return merged;
  }

  async function runCapturePass() {
    const st = state();
    if (!st.running) return;

    console.log('[Apna Scraper] Running capture pass...');
    
    const container = getListContainer();
    if (!container) {
      console.log('[Apna Scraper] No container found');
      return;
    }

    const cards = getProfileCards(container);
    console.log('[Apna Scraper] Processing', cards.length, 'cards');
    let newCount = 0;

    // Extract phone numbers from scripts (if any)
    const scriptPhones = extractPhoneFromScript();
    console.log('[Apna Scraper] Found', scriptPhones.length, 'phone numbers in scripts');

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const profile = extractProfile(card, i);
      const key = profileKey(profile);

      if (st.seenIds.has(key)) {
        const existingIndex = st.captures.findIndex(p => profileKey(p) === key);
        if (existingIndex !== -1) {
          st.captures[existingIndex] = mergeProfiles(st.captures[existingIndex], profile);
        }
        continue;
      }

      st.seenIds.add(key);
      st.captures.push(profile);
      newCount++;
    }

    console.log('[Apna Scraper] Captured', newCount, 'new profiles. Total:', st.captures.length);
    await sendUpdate();
  }

  async function sendUpdate() {
    const st = state();
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        await chrome.runtime.sendMessage({
          action: 'apnaCaptureUpdate',
          data: st.captures,
          running: st.running
        });
      } catch (_) {}
    }
  }

  async function startCapture() {
    const st = state();
    if (st.running) return;

    console.log('[Apna Scraper] Starting capture...');
    console.log('[Apna Scraper] Current URL:', location.href);
    
    // Remove strict page check - just try to find cards
    const container = getListContainer();
    console.log('[Apna Scraper] Container found:', container ? 'Yes' : 'No');
    
    const testCards = getProfileCards(container);
    console.log('[Apna Scraper] Cards found:', testCards.length);
    
    if (!testCards || testCards.length === 0) {
      // Try waiting a bit for page to load
      console.log('[Apna Scraper] No cards found immediately, waiting 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const retryCards = getProfileCards(container);
      console.log('[Apna Scraper] Cards after wait:', retryCards.length);
      
      if (!retryCards || retryCards.length === 0) {
        alert('No Apna profile cards found on this page. Please make sure you are on the employer.apna.co search results page with candidate profiles visible.');
        return;
      }
    }

    st.running = true;
    await sendUpdate();

    if (container) {
      attachAutoCaptureListeners(container);
    }

    await runCapturePass();
  }

  async function stopCapture() {
    const st = state();
    st.running = false;
    detachAutoCaptureListeners();
    if (st.timerId) {
      clearTimeout(st.timerId);
      st.timerId = null;
    }
    if (st.passTimerId) {
      clearTimeout(st.passTimerId);
      st.passTimerId = null;
    }
    await sendUpdate();
  }

  async function refreshCapture() {
    await runCapturePass();
  }

  async function clearCapture() {
    const st = state();
    st.seenIds.clear();
    st.captures = [];
    await sendUpdate();
  }

  function getData() {
    return state().captures;
  }

  function isRunning() {
    return state().running;
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    console.log('[Apna Scraper] Setting up message listener');
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      console.log('[Apna Scraper] Message received:', request.action);
      (async () => {
        try {
          if (request.action === 'apnaCaptureStart') {
            console.log('[Apna Scraper] Start action triggered');
            await startCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureStop') {
            console.log('[Apna Scraper] Stop action triggered');
            await stopCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureRefresh') {
            console.log('[Apna Scraper] Refresh action triggered');
            await refreshCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureClear') {
            console.log('[Apna Scraper] Clear action triggered');
            await clearCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureGetData') {
            sendResponse({ success: true, data: getData() });
          } else if (request.action === 'apnaCaptureIsRunning') {
            sendResponse({ success: true, running: isRunning() });
          }
        } catch (error) {
          console.error('[Apna Scraper] Error:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    });
  } else {
    console.warn('[Apna Scraper] Chrome runtime not available');
  }

  globalThis.apnaCapture = {
    start: startCapture,
    stop: stopCapture,
    refresh: refreshCapture,
    clear: clearCapture,
    getData: getData,
    isRunning: isRunning
  };
})();
