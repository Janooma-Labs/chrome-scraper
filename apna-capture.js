/* global chrome */
(function () {
  'use strict';

  if (globalThis.__apnaCaptureLoaded) return;
  globalThis.__apnaCaptureLoaded = true;

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
    // Find the main scroll container for profile cards
    const candidates = [
      'div[class*="css-"]',
      'div[role="main"]',
      'main'
    ];
    
    // Look for scrollable container with profile cards
    for (const selector of candidates) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (el.querySelector('button[id*=":r"]') && el.querySelector('div.css-d53uuf')) {
          return el;
        }
      }
    }
    return document.body;
  }

  function getProfileCards(container) {
    const scope = container || document;
    // Profile cards are in divs with class css-d53uuf
    const cards = Array.from(scope.querySelectorAll('div.css-d53uuf'));
    return cards;
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
    // Extract name - usually in a heading or prominent text
    let name = '';
    const nameSelectors = [
      'div.css-1xxiv2b p',
      'div[class*="css-"] p:first-child',
      'h1', 'h2', 'h3'
    ];
    
    for (const sel of nameSelectors) {
      name = extractTextFromElement(card, sel);
      if (name && name.length > 0 && name.length < 100) break;
    }

    // Extract experience/title
    let title = '';
    const titleSelectors = [
      'div.css-1xxiv2b p:nth-child(2)',
      'div[class*="experience"]',
      'div[class*="title"]'
    ];
    
    for (const sel of titleSelectors) {
      const text = extractTextFromElement(card, sel);
      if (text && text !== name) {
        title = text;
        break;
      }
    }

    // Extract location
    let location = '';
    const locationIcons = card.querySelectorAll('svg path[d*="M12"]');
    for (const icon of locationIcons) {
      const parent = icon.closest('div');
      if (parent) {
        const text = extractTextFromElement(parent);
        if (text && text.includes(',')) {
          location = text;
          break;
        }
      }
    }

    // Extract skills/keywords (highlighted text)
    const highlights = Array.from(card.querySelectorAll('span[style*="background-color:#FFEA92"]'));
    const keywords = highlights.map(h => normalizeText(h.textContent)).filter(Boolean);

    // Extract description/summary
    const descDiv = card.querySelector('div.css-f9spqm');
    const description = descDiv ? extractTextFromElement(descDiv) : '';

    // Extract phone
    const phone = extractPhoneFromButton(card);

    // Extract recruiter unlock count
    let unlockCount = 0;
    const unlockLabel = card.querySelector('div[aria-label*="recruiters have unlocked"]');
    if (unlockLabel) {
      const labelText = unlockLabel.getAttribute('aria-label');
      const match = labelText ? labelText.match(/(\d+)\s+recruiter/) : null;
      if (match) unlockCount = parseInt(match[1], 10);
    }

    // Extract profile URL if available
    let profileUrl = '';
    const profileLink = card.querySelector('a[href*="/profile/"]');
    if (profileLink) {
      profileUrl = profileLink.href;
    }

    // Try to extract additional info from the full profile text
    const fullText = extractTextFromElement(card);
    
    // Extract email if present
    const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';

    // Extract years of experience
    const expMatch = fullText.match(/(\d+)\s*(?:\+\s*)?years?/i);
    const experience = expMatch ? expMatch[1] + ' years' : '';

    // Create unique ID
    const profileId = profileUrl || `apna_${index}_${Date.now()}`;

    return {
      profileId,
      name: name || 'N/A',
      title: title || 'N/A',
      location: location || 'N/A',
      experience: experience || 'N/A',
      phone: phone || 'N/A',
      email: email || 'N/A',
      keywords: keywords.join(', ') || 'N/A',
      description: description || 'N/A',
      unlockCount,
      profileUrl: profileUrl || 'N/A',
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

    const container = getListContainer();
    if (!container) return;

    const cards = getProfileCards(container);
    let newCount = 0;

    // Extract phone numbers from scripts (if any)
    const scriptPhones = extractPhoneFromScript();

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

    if (!isApnaPage()) {
      alert('Please navigate to Apna search results page first.');
      return;
    }

    st.running = true;
    await sendUpdate();

    const container = getListContainer();
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
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      (async () => {
        try {
          if (request.action === 'apnaCaptureStart') {
            await startCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureStop') {
            await stopCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureRefresh') {
            await refreshCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureClear') {
            await clearCapture();
            sendResponse({ success: true });
          } else if (request.action === 'apnaCaptureGetData') {
            sendResponse({ success: true, data: getData() });
          } else if (request.action === 'apnaCaptureIsRunning') {
            sendResponse({ success: true, running: isRunning() });
          }
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    });
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
