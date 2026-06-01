# Page Data Scraper — Chrome/Brave Extension

A multi-mode Chromium extension with two scrapers:

- **Google Places** (continuous capture from Google Maps results)
- **Generic Scraper** (full page, XPath, click-to-select)

Both export to **JSON**, **CSV**, and **XLSX**.

## Features

- **Scraper Dropdown**
  - `Google Places`
  - `Generic Scraper`

- **Google Places mode**
  - Start/Stop continuous capture on Google Maps search result pages
  - Refresh pass to capture newly loaded cards
  - Clear captured dataset
  - Fields include: name, rating, review count, category, address, phone, website, place URL, image URL

- **Generic mode**
  - Full Page scrape
  - XPath-targeted scrape
  - Click-to-select scrape
  - Structured element extraction (text, links, images, tables, metadata)

- **Export Formats**
  - `JSON` — Pretty-printed structured data
  - `CSV` — Comma-separated values with UTF-8 BOM
  - `XLSX` — Real Excel file (no external libraries)

## Installation

1. Open Chrome/Brave and go to `chrome://extensions/` (or `brave://extensions/`).
2. Enable **Developer mode** (toggle in top-right).
3. Click **Load unpacked**.
4. Select the `chrome-scraper` folder.
5. Pin the extension: click the 🧩 puzzle piece icon next to the address bar, find "Page Data Scraper", and click the 📌 pin.

## How to Use

**IMPORTANT:** You must be on a **normal website** (e.g. https://google.com, https://example.com). You cannot scrape:
- `chrome://` or `brave://` pages
- The Extensions page itself
- Browser internal pages

### Google Places mode
1. Open `https://www.google.com/maps` and run a place search.
2. Open extension popup.
3. Select `Google Places` in scraper dropdown.
4. Click **Start Capture**.
5. Scroll the results panel in Maps to load more places.
6. Use **Refresh Data** if needed; click **Stop** when done.
7. Export JSON/CSV/XLSX.

### Generic mode
1. Open extension popup.
2. Select `Generic Scraper` in scraper dropdown.

### Generic Full Page
1. Open any website.
2. Click the **blue "S"** extension icon.
3. Click **Scrape & Preview**.
4. See preview and export.

### Generic Click on Element
1. Click the extension icon.
2. Select `Generic Scraper` and then **"Click on page element"**.
3. Click **Pick Element** — the popup will close.
4. Hover over the page — elements will highlight in blue.
5. **Click** the element you want to scrape — it turns green.
6. Click the extension icon again — popup will show the scraped data.

### Generic XPath
1. Click the extension icon.
2. Select `Generic Scraper` and then **"Enter XPath"**.
3. Type an XPath (e.g. `//div[@class='main-content']`).
4. Click **Scrape & Preview**.

## File Structure

```
chrome-scraper/
├── manifest.json       # Manifest V3
├── popup.html          # Popup UI
├── popup.css           # Popup styles
├── popup.js            # Popup logic (google + generic modes)
├── google-places-capture.js # Google Maps continuous capture logic
├── picker.js           # Content script for click-to-pick highlighting
├── picker.css          # Highlight overlay styles
├── xlsx-writer.js      # Pure-JS XLSX generator
├── background.js       # Service worker (stores picked xpath)
└── icon*.png           # Extension icons
```

## Architecture

- **Generic scrape** uses `chrome.scripting.executeScript` for robust one-shot extraction.
- **Google Places** uses a content script (`google-places-capture.js`) that supports start/stop loop capture and stores data in `chrome.storage.local`.
- **Click-to-pick** uses `picker.js` for hover/click interaction and picked XPath handoff.

## Permissions

- `activeTab` — Read the current page
- `scripting` — Inject scrape code into pages
- `downloads` — Save files to disk
- `storage` — Remember picked element across popup sessions

## Troubleshooting

| Issue | Solution |
|---|---|
| "No data found" on every page | Make sure you're on a regular website, not a browser internal page. Try refreshing the page after loading the extension. |
| Pick Element doesn't highlight | Refresh the page and try again. Content scripts load on page refresh. |
| Google Places capture not increasing | Stay on Google Maps search results and scroll the results panel to load more cards. |
| Export buttons are greyed out | Scrape some data first — buttons enable automatically when data is found. |

## Notes

- Data URIs for images are masked as `(data-uri)` in exports to keep files small.
- The XLSX writer is built-in and produces valid Office Open XML files without external dependencies.
