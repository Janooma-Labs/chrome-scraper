// Background Service Worker — stores picked element data and Google Places records.
// db-store.js is loaded here so IndexedDB is always accessed from the extension origin.
importScripts('db-store.js');

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
    return false;
  }

  if (request.action === 'placesDB_getAll') {
    PlacesDB.getAll()
      .then(rows => sendResponse({ rows: rows || [] }))
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  if (request.action === 'placesDB_count') {
    PlacesDB.count()
      .then(count => sendResponse({ count: count || 0 }))
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  if (request.action === 'placesDB_save') {
    PlacesDB.save(request.rows || [])
      .then(result => sendResponse(result || { total: 0, added: 0, updated: 0 }))
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  if (request.action === 'placesDB_clear') {
    PlacesDB.clear()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  return false;
});
