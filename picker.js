/* global chrome */
(function () {
  'use strict';

  if (globalThis.__pageDataScraperPickerLoaded) {
    return;
  }
  globalThis.__pageDataScraperPickerLoaded = true;

  let picking = false;
  let tooltip = null;
  let hoveredEl = null;

  function createTooltip() {
    if (tooltip) return;
    tooltip = document.createElement('div');
    tooltip.className = 'scraper-tooltip';
    document.body.appendChild(tooltip);
  }

  function removeTooltip() {
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  }

  function getXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `//*[@id="${CSS.escape(el.id)}"]`;
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

  function onMouseOver(e) {
    if (!picking) return;
    const target = e.target;
    if (target === tooltip) return;
    if (hoveredEl && hoveredEl !== target) {
      hoveredEl.classList.remove('scraper-highlight');
    }
    hoveredEl = target;
    target.classList.add('scraper-highlight');
    createTooltip();
    tooltip.textContent = `${target.tagName.toLowerCase()} — Click to select`;
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY + 14) + 'px';
  }

  function onMouseOut(e) {
    if (!picking) return;
    e.target.classList.remove('scraper-highlight');
  }

  function onMouseMove(e) {
    if (!picking || !tooltip) return;
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY + 14) + 'px';
  }

  function onClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();

    const target = hoveredEl || e.target;
    if (!target) return;

    // Clean up UI
    picking = false;
    hoveredEl = null;
    removeTooltip();
    document.querySelectorAll('.scraper-highlight, .scraper-picked').forEach(el => {
      el.classList.remove('scraper-highlight', 'scraper-picked');
    });
    target.classList.add('scraper-picked');

    // Remove listeners
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);

    // Store picked XPath via background/storage
    const xpath = getXPath(target);
    try {
      chrome.runtime.sendMessage({ 
        action: 'picked', 
        xpath: xpath,
        tag: target.tagName.toLowerCase()
      });
    } catch (err) {
      console.error('[Picker] Failed to send picked message:', err);
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startPicking') {
      if (picking) {
        sendResponse({ success: true });
        return false;
      }
      picking = true;
      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mouseout', onMouseOut, true);
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('click', onClick, true);
      sendResponse({ success: true });
    } else if (request.action === 'stopPicking') {
      picking = false;
      hoveredEl = null;
      removeTooltip();
      document.querySelectorAll('.scraper-highlight, .scraper-picked').forEach(el => {
        el.classList.remove('scraper-highlight', 'scraper-picked');
      });
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('mouseout', onMouseOut, true);
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      sendResponse({ success: true });
    }
    return false;
  });
})();
