// Background Service Worker — stores picked element data

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Scraper] Background service worker installed.');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'picked') {
    // Store picked xpath so popup can read it when reopened
    chrome.storage.local.set({ 
      lastPickedXPath: request.xpath, 
      lastPickedAt: Date.now() 
    });
    sendResponse({ success: true });
  }
  return false;
});
