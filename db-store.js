/* global indexedDB */
(function (global) {
  'use strict';

  const DB_NAME = 'JanoomaScraperDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'googlePlacesRecords';

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('placeKey', 'placeKey', { unique: false });
        }
      };
    });
  }

  function placeKeyOf(row) {
    return row.placeKey || row.placeId || row.placeUrl || `${row.name || ''}|${row.address || ''}`;
  }

  async function withStore(mode) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(new Error('IndexedDB transaction aborted'));
      resolve({ tx, store: tx.objectStore(STORE_NAME) });
    });
  }

  async function getAllRecords() {
    const { store, tx } = await withStore('readonly');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  async function getRecordCount() {
    const { store, tx } = await withStore('readonly');
    return new Promise((resolve, reject) => {
      const request = store.count();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || 0);
    });
  }

  async function clearRecords() {
    const { store, tx } = await withStore('readwrite');
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  }

  async function saveRecords(rows, mergeFn) {
    if (!Array.isArray(rows) || !rows.length) {
      const total = await getRecordCount();
      return { total, added: 0, updated: 0 };
    }

    const { store, tx } = await withStore('readwrite');

    // Build incoming map by placeKey
    const incoming = new Map();
    for (const row of rows) {
      const key = placeKeyOf(row);
      if (!key) continue;
      row.placeKey = key;
      if (!incoming.has(key)) incoming.set(key, row);
    }

    let added = 0;
    let updated = 0;

    for (const [key, newRow] of incoming) {
      const existingList = await new Promise((resolve, reject) => {
        const req = store.index('placeKey').getAll(key);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result || []);
      });

      if (!existingList.length) {
        await new Promise((resolve, reject) => {
          const req = store.add(newRow);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve();
        });
        added += 1;
      } else {
        // Merge into the first existing record (there should only be one).
        const existing = existingList[0];
        let merged;
        if (typeof mergeFn === 'function') {
          merged = mergeFn(existing, newRow);
        } else {
          merged = { ...existing };
          for (const [k, v] of Object.entries(newRow)) {
            if (v == null || v === '') continue;
            if (k === 'id') continue;
            if (merged[k] == null || merged[k] === '') {
              merged[k] = v;
            }
          }
        }
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          await new Promise((resolve, reject) => {
            const req = store.put(merged);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
          });
          updated += 1;
        }
      }
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('saveRecords transaction aborted'));
    });

    const total = await getRecordCount();
    return { total, added, updated };
  }

  global.PlacesDB = {
    getAll: getAllRecords,
    count: getRecordCount,
    save: saveRecords,
    clear: clearRecords
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
