const { parseAvantioResponse, extractAvsFromHtml, delay, log } = require('./utils');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LARAVEL_API = process.env.HOLASUR_API_URL || 'http://localhost:8001/api/import';
const LARAVEL_API_BASE = process.env.HOLASUR_API_URL?.replace('/import', '') || 'http://localhost:8001/api';
const AVANTIO_BASE = 'https://app.avantio.pro';
const PAGE_SIZE = 30;

// Rate limiting config
const RATE_LIMIT = {
  minDelay: 2000,       // minimum ms between requests
  maxDelay: 5000,       // maximum ms between requests
  scrollDelay: 2000,    // ms between scroll actions
  detailDelay: 3000,    // ms between detail page opens
  maxRequestsPerSession: 200, // hard cap per session
  backoffBase: 5000,    // base backoff on error (doubles each retry)
  maxRetries: 3,        // max retries per action
};

class AvantioScraper {
  /**
   * @param {import('playwright').Page} page - Playwright page instance
   */
  constructor(page) {
    this.page = page;
    this.avsTokens = new Map();
    this.status = 'initialized';
    this.importResults = {};
    this.requestCount = 0;
  }

  /**
   * Randomized delay between min and max to appear more human-like.
   */
  async _rateLimitedDelay(type = 'nav') {
    const delays = {
      nav: [RATE_LIMIT.minDelay, RATE_LIMIT.maxDelay],
      scroll: [RATE_LIMIT.scrollDelay, RATE_LIMIT.scrollDelay + 1000],
      detail: [RATE_LIMIT.detailDelay, RATE_LIMIT.detailDelay + 2000],
    };
    const [min, max] = delays[type] || delays.nav;
    const ms = min + Math.floor(Math.random() * (max - min));
    await delay(ms);
  }

  /**
   * Check if we've hit the request limit for this session.
   */
  _checkRequestLimit() {
    this.requestCount++;
    if (this.requestCount > RATE_LIMIT.maxRequestsPerSession) {
      throw new Error(`Session request limit reached (${RATE_LIMIT.maxRequestsPerSession}). Start a new session.`);
    }
    if (this.requestCount % 20 === 0) {
      log(`  [Rate] ${this.requestCount} requests this session.`);
    }
  }

  /**
   * Retry an async action with exponential backoff.
   */
  async _withRetry(actionName, fn) {
    for (let attempt = 1; attempt <= RATE_LIMIT.maxRetries; attempt++) {
      try {
        this._checkRequestLimit();
        return await fn();
      } catch (err) {
        if (attempt === RATE_LIMIT.maxRetries) throw err;
        const backoff = RATE_LIMIT.backoffBase * Math.pow(2, attempt - 1);
        log(`  [Retry] ${actionName} failed (attempt ${attempt}/${RATE_LIMIT.maxRetries}), waiting ${backoff}ms: ${err.message.substring(0, 80)}`);
        await delay(backoff);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Poll until the user has completed login (and any 2FA) in the visible
   * browser window. We detect login by looking for the dashboard URL
   * containing module=Home or a known post-login element.
   *
   * @param {number} timeoutMs - Maximum time to wait (default 5 minutes)
   * @returns {Promise<boolean>}
   */
  async waitForLogin(timeoutMs = 300_000) {
    log('Waiting for login...');
    this.status = 'waiting_for_login';

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        // Check if already logged in
        const isLoggedIn = await this.page.evaluate(() => {
          const url = new URL(window.location.href);
          const module = url.searchParams.get('module');
          return module === 'Home' || module === 'Dashboard' || !!document.querySelector('avantio-menu');
        }).catch(() => false);

        if (isLoggedIn) {
          log('Login detected.');
          this.status = 'logged_in';
          return true;
        }

        // Check for 2FA page FIRST (specific text only) — must check before
        // setting needs_login to avoid overwriting needs_2fa status
        const is2FA = await this.page.evaluate(() => {
          const text = document.body?.textContent || '';
          return text.includes('Two-step authentication enabled') || text.includes('Enter verification code');
        }).catch(() => false);

        if (is2FA) {
          if (this.status !== 'needs_2fa') {
            log('2FA required.');
            this.status = 'needs_2fa';
          }
        } else if (this.status !== 'needs_login' && this.status !== 'needs_2fa') {
          // Only set needs_login if we're not already on 2FA
          this.status = 'needs_login';
          log('Login required — waiting for credentials via /login endpoint...');
        }

        // Alternative: check for a known post-login DOM element
        const loggedIn = await this.page.evaluate(() => {
          return (
            !!document.querySelector('#menu_lateral') ||
            !!document.querySelector('.menu-lateral') ||
            !!document.querySelector('#main-menu') ||
            !!document.querySelector('.dashboard-container')
          );
        }).catch(() => false);

        if (loggedIn) {
          log('Login detected via DOM element.');
          this.status = 'logged_in';
          return true;
        }
      } catch {
        // Page might be navigating — ignore transient errors
      }
      await delay(2000);
    }

    log('Login wait timed out.');
    this.status = 'error';
    return false;
  }

  // ---------------------------------------------------------------------------
  // AVS token management
  // ---------------------------------------------------------------------------

  /**
   * Extract avs tokens from the current page HTML and merge them into
   * our token map.
   *
   * @param {string} [html] - Optional HTML string. If omitted, reads from page.
   * @returns {Map<string, string>} The full token map
   */
  async harvestAvs(html) {
    try {
      if (!html) {
        html = await this.page.content();
      }
      const tokens = extractAvsFromHtml(html);
      for (const [key, tokenData] of tokens) {
        this.avsTokens.set(key, tokenData);
      }
      log(`Harvested ${tokens.size} avs tokens (total: ${this.avsTokens.size}).`);
    } catch (err) {
      log(`harvestAvs failed (page may still be loading): ${err.message.substring(0, 80)}`);
    }
    return this.avsTokens;
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /**
   * Navigate to a module/action by finding its avs-signed link in the page.
   * Falls back to constructing the URL with a previously harvested token.
   *
   * @param {string} module
   * @param {string} action
   */
  async navigateToModule(module, action) {
    log(`Navigating to module=${module}, action=${action}...`);

    // Wait for the page menu/links to fully render before harvesting tokens.
    // Web components and onclick handlers load asynchronously after domcontentloaded.
    const maxWait = 20000;
    const pollInterval = 2000;
    const key = `${module}:${action}`;
    let tokenData = null;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await delay(pollInterval);
      await this.harvestAvs();
      tokenData = this.avsTokens.get(key);
      if (tokenData) break;
      log(`Token for ${key} not found yet, retrying... (${this.avsTokens.size} tokens so far)`);
    }

    if (tokenData && tokenData.fullUrl) {
      log(`Using full signed URL for ${key}`);
      await this.page.goto(tokenData.fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      // Try clicking a matching href link
      log(`No cached avs for ${key}, attempting DOM link click...`);
      const linkSelector = `a[href*="module=${module}"][href*="action=${action}"]`;
      let link = await this.page.$(linkSelector);
      if (link) {
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          link.click(),
        ]);
      } else {
        // Try onclick="redireccion('...')" elements (Avantio's menu pattern)
        log(`No href link, trying onclick redireccion...`);
        const clicked = await this.page.evaluate(({ mod, act }) => {
          const elements = document.querySelectorAll('[onclick*="redireccion"]');
          for (const el of elements) {
            const onclick = el.getAttribute('onclick') || '';
            if (onclick.includes(`module=${mod}`) && onclick.includes(`action=${act}`)) {
              el.click();
              return true;
            }
          }
          return false;
        }, { mod: module, act: action });

        if (clicked) {
          await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
        } else {
          // Last resort: try constructing URL with any available avs token
          // Some modules aren't linked from the dashboard but accept any valid avs
          log(`No onclick handler, trying URL construction with borrowed avs...`);
          const anyToken = this.avsTokens.values().next().value;
          if (anyToken && anyToken.avs) {
            const constructedUrl = `${AVANTIO_BASE}/index.php?module=${encodeURIComponent(module)}&action=${encodeURIComponent(action)}&avs=${encodeURIComponent(anyToken.avs)}`;
            await this.page.goto(constructedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Check if we got error 6019
            const resultUrl = this.page.url();
            if (resultUrl.includes('error=6019')) {
              log(`Borrowed avs failed (6019). Module ${module} may not be accessible from current context.`);
            }
          } else {
            throw new Error(`Cannot navigate to ${key}: no avs token, no href link, no onclick handler found.`);
          }
        }
      }
    }

    // Check for 6019 error and retry from dashboard if needed
    const arrivedUrl = this.page.url();
    if (arrivedUrl.includes('error=6019')) {
      log(`Got error 6019, retrying via dashboard...`);
      await this.page.goto(`${AVANTIO_BASE}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(5000);
      this.avsTokens.clear();
      await this.harvestAvs();
      // Try once more with fresh tokens
      const retryToken = this.avsTokens.get(key);
      if (retryToken && retryToken.fullUrl) {
        await this.page.goto(retryToken.fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
    }

    // Re-harvest tokens from the new page
    await this.harvestAvs();
    await this._rateLimitedDelay('nav');
    log(`Arrived at ${this.page.url()}`);
  }

  // ---------------------------------------------------------------------------
  // Data extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract list data from a module that loads its rows via an AJAX POST.
   * We intercept XHR responses on the page to capture the JSON payload.
   *
   * @param {string} module - Avantio module name
   * @param {number} [expectedTotal] - If known, how many items to expect
   * @returns {Promise<object[]>} All collected records
   */
  async extractListData(module, expectedTotal) {
    const allRecords = [];
    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      log(`Extracting ${module} list data — page ${currentPage}...`);

      // Set up a response interceptor BEFORE triggering any page load
      const jsonPromise = this._interceptNextJsonResponse();

      // On the first page the navigation already happened; for subsequent
      // pages we click the next-page link.
      if (currentPage > 1) {
        const nextClicked = await this._clickNextPage();
        if (!nextClicked) {
          log(`No next page link found for ${module} at page ${currentPage}.`);
          hasNextPage = false;
          break;
        }
      }

      // Wait for the AJAX response (with a generous timeout)
      const data = await Promise.race([
        jsonPromise,
        delay(15_000).then(() => null),
      ]);

      if (data) {
        const records = this._extractRecordsFromResponse(data);
        log(`  Page ${currentPage}: got ${records.length} records from AJAX.`);
        allRecords.push(...records);
      } else {
        // Fallback 1: try web component cards (Playwright locators pierce shadow DOM)
        log(`  No AJAX data intercepted on page ${currentPage}, trying card scrape...`);
        const cardRecords = await this._scrapeCardsFromPage();
        if (cardRecords.length > 0) {
          log(`  Page ${currentPage}: scraped ${cardRecords.length} records from cards.`);
          allRecords.push(...cardRecords);
        } else {
          // Fallback 2: try standard HTML table
          log(`  No cards found, trying table scrape...`);
          const domRecords = await this._scrapeTableFromDom();
          log(`  Page ${currentPage}: scraped ${domRecords.length} records from table.`);
          allRecords.push(...domRecords);
        }
      }

      // Check if there is a next page
      if (expectedTotal && allRecords.length >= expectedTotal) {
        hasNextPage = false;
      } else {
        const nextExists = await this.page.$('a.next-page, a.pag_siguiente, a[rel="next"], .pagination .next a, a[href*="pag="]:last-child');
        if (!nextExists) {
          hasNextPage = false;
        }
      }

      currentPage++;
      await this._rateLimitedDelay('nav');
    }

    log(`Finished extracting ${module}: ${allRecords.length} total records.`);
    return allRecords;
  }

  /**
   * Click on a list row to open the detail drawer/panel and capture the
   * AJAX response with full entity data.
   *
   * @param {string|number} entityId
   * @returns {Promise<object|null>}
   */
  async extractDetailData(entityId) {
    log(`Extracting detail data for entity ${entityId}...`);

    const jsonPromise = this._interceptNextJsonResponse();

    // Try clicking a row that contains the entity ID
    const row = await this.page.$(`tr[data-id="${entityId}"], tr[id*="${entityId}"], tr:has(td:text("${entityId}"))`);
    if (row) {
      await row.click();
    } else {
      log(`  Could not find row for entity ${entityId}.`);
      return null;
    }

    const data = await Promise.race([
      jsonPromise,
      delay(10_000).then(() => null),
    ]);

    await delay(1000);
    return data;
  }

  // ---------------------------------------------------------------------------
  // CSV-based import (primary method)
  // ---------------------------------------------------------------------------

  async _downloadAndParseCSV(wcSelector) {
    log('  Clicking More actions → CSV download...');
    await this.page.evaluate((wcSel) => {
      const wc = document.querySelector(wcSel);
      if (!wc || !wc.shadowRoot) return;
      for (const btn of wc.shadowRoot.querySelectorAll('button')) {
        const t = btn.textContent.trim();
        const aria = btn.getAttribute('aria-label') || '';
        if (t === 'More actions' || aria === 'More actions') { btn.click(); return; }
      }
    }, wcSelector);
    await delay(2000);

    const downloadPromise = this.page.waitForEvent('download', { timeout: 30000 });

    await this.page.evaluate((wcSel) => {
      const wc = document.querySelector(wcSel);
      if (!wc || !wc.shadowRoot) return;
      for (const btn of wc.shadowRoot.querySelectorAll('button')) {
        const t = btn.textContent.trim();
        if (t === 'Download CSV' || t === 'Export CSV' || t === 'Download csv') { btn.click(); return; }
      }
    }, wcSelector);

    let download;
    try { download = await downloadPromise; } catch { log('  CSV download timed out.'); return []; }

    const tmpFile = `/tmp/holasur-csv-${Date.now()}.csv`;
    await download.saveAs(tmpFile);
    const size = fs.statSync(tmpFile).size;
    log(`  CSV saved (${size} bytes)`);

    const content = fs.readFileSync(tmpFile, 'utf-8');
    // Save a debug copy
    const debugFile = `/tmp/holasur-last-csv-${Date.now()}.csv`;
    fs.copyFileSync(tmpFile, debugFile);
    log(`  Debug copy: ${debugFile}`);
    const rows = this._parseCSV(content);
    fs.unlinkSync(tmpFile);
    log(`  Parsed ${rows.length} rows from CSV.`);
    return rows;
  }

  _parseCSV(content) {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 2) return [];

    // Auto-detect delimiter: semicolons or commas
    const firstLines = lines.slice(0, 3).join('\n');
    const semicolons = (firstLines.match(/;/g) || []).length;
    const commas = (firstLines.match(/,/g) || []).length;
    const delimiter = semicolons > commas ? ';' : ',';
    log(`  CSV delimiter: "${delimiter}" (${semicolons} semicolons, ${commas} commas)`);

    const parseRow = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (ch === delimiter && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += ch;
      }
      result.push(current.trim());
      return result;
    };

    // Detect header row: first row with many non-empty unique values is the header
    // Avantio bookings CSV has: title row (line 0), header row (line 1), data (line 2+)
    // Avantio properties CSV might have: header row (line 0), data (line 1+)
    let headerIdx = 0;
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const cols = parseRow(lines[i]);
      const nonEmpty = cols.filter(c => c).length;
      // A header row has many unique non-numeric values
      const hasLetters = cols.filter(c => c && /[a-zA-Z]/.test(c) && !/^\d+\/\d+\/\d+$/.test(c)).length;
      if (hasLetters >= 3 && nonEmpty >= 5) {
        headerIdx = i;
        break;
      }
    }

    // Check if the row BEFORE the header is a title row (single merged cell with few values)
    if (headerIdx > 0) {
      const prevRow = parseRow(lines[headerIdx - 1]);
      const prevNonEmpty = prevRow.filter(c => c).length;
      if (prevNonEmpty <= 2) {
        // Title row confirmed, header is at headerIdx
      }
    }

    const headers = parseRow(lines[headerIdx]);
    log(`  CSV header at line ${headerIdx}: ${headers.slice(0, 5).join(', ')}... (${headers.filter(h=>h).length} columns)`);

    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const values = parseRow(lines[i]);
      if (values.length < 3) continue;
      // Skip rows that look like the header repeated
      if (values[0] === headers[0] && values[1] === headers[1]) continue;
      const obj = {};
      headers.forEach((h, idx) => { if (h && values[idx] !== undefined) obj[h] = values[idx]; });
      rows.push(obj);
    }
    return rows;
  }

  _parseCSVDate(dateStr) {
    if (!dateStr) return null;
    const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1]}-${m[2]}`;
    return dateStr;
  }

  async importBookingsCSV() {
    log('=== Importing Bookings via CSV ===');
    this.status = 'importing';

    const bookingsUrl = await this.page.evaluate(() => {
      const menu = document.querySelector('avantio-menu');
      if (!menu || !menu.shadowRoot) return null;
      for (const a of menu.shadowRoot.querySelectorAll('a'))
        if (a.textContent.trim() === 'Bookings' && a.href.includes('action=index')) return a.href;
      return null;
    });
    if (bookingsUrl) await this.page.goto(bookingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(5000);

    const rows = await this._downloadAndParseCSV('avantio-bookings-list');
    if (rows.length === 0) { log('  No CSV data. Falling back to scraping...'); return this.importBookings(); }

    const records = rows.map(r => ({
      avantio_id: r['Booking number'] || `csv-${Date.now()}`,
      avantio_reference: r['Booking number'],
      check_in: this._parseCSVDate(r['Check-in date']),
      check_out: this._parseCSVDate(r['Check-out date']),
      nights: parseInt(r['nights']) || null,
      total_amount: parseFloat(r['Booking total with tax']) || 0,
      adults: parseInt(r['Adults']) || null,
      children: parseInt(r['Children']) || null,
      status: (r['Status'] || '').toLowerCase().replace(/ /g, '_'),
      channel: r['Portal / Agent'] || null,
      currency: 'USD',
      is_revenue: !['not_available', 'owner_booking'].includes((r['Status'] || '').toLowerCase().replace(/ /g, '_')),
      property_avantio_id: r['Property ID'] || null,
      _csv: r,
    }));

    await this._postToLaravel('bookings', records);
    this.importResults.bookings = records.length;
    log(`  Imported ${records.length} bookings from CSV.`);
    return records;
  }

  async importPropertiesCSV() {
    log('=== Importing Properties via CSV ===');
    this.status = 'importing';

    await this.navigateToModule('Propiedades', 'ListViewPropiedades');
    await delay(5000);

    const rows = await this._downloadAndParseCSV('avantio-accommodations-list');
    if (rows.length === 0) { log('  No CSV data. Falling back to scraping...'); return this.importProperties(); }

    // Log column names for mapping
    if (rows.length > 0) log(`  CSV columns: ${Object.keys(rows[0]).join(', ')}`);

    const records = rows.map(r => {
      const record = { _csv: r };
      // Properties CSV columns: Owner ID, Code, Status, Property, Type, Max. guest capacity,
      // Rate, Building, Photo gallery, Town, Area, ZIP, Street type, Address,
      // Building/house number, Staircase, Floor, Apartment, Owner, Registration Number
      record.avantio_id = r['Code'] || r['Property ID'] || r['ID'] || Object.values(r)[1];
      record.name = r['Property'] || r['Property name'] || r['Name'] || '';
      record.type = r['Type'] || r['Property type'] || null;
      record.location = r['Town'] || r['City'] || r['Location'] || null;
      record.status = (r['Status'] || 'Active').includes('Deactivated') ? 'Deactivated' : 'Active';
      record.max_guests = parseInt(r['Max. guest capacity'] || r['Max guests']) || null;
      // Build full address
      const addrParts = [r['Address'], r['Building/house number'], r['Floor'] ? `Piso ${r['Floor']}` : null, r['Apartment / Unit / Suite number']].filter(Boolean);
      if (addrParts.length) record.address = addrParts.join(' ');
      return record;
    });

    await this._postToLaravel('properties', records);
    this.importResults.properties = records.length;
    log(`  Imported ${records.length} properties from CSV.`);
    return records;
  }

  // ---------------------------------------------------------------------------
  // Entity-specific import methods (scraping fallback)
  // ---------------------------------------------------------------------------

  async importOwners() {
    log('=== Importing Owners from Properties CSV ===');
    this.status = 'importing';

    // Wait for page to settle after login
    await delay(3000);
    await this.page.waitForLoadState('load').catch(() => {});
    await delay(2000);

    // Navigate to properties list and download CSV — it has Owner ID and Owner columns
    await this.navigateToModule('Propiedades', 'ListViewPropiedades');
    await delay(5000);

    const rows = await this._downloadAndParseCSV('avantio-accommodations-list');
    if (rows.length === 0) {
      log('  No properties CSV data — cannot extract owners.');
      this.importResults.owners = 0;
      return [];
    }

    // Extract unique owners from the properties CSV
    const ownerMap = new Map();
    for (const row of rows) {
      const oid = (row['Owner ID'] || '').trim();
      const name = (row['Owner'] || '').trim();
      if (oid && name && !ownerMap.has(oid)) {
        ownerMap.set(oid, { avantio_id: oid, name });
      }
    }

    const records = Array.from(ownerMap.values());
    log(`  Found ${records.length} unique owners from ${rows.length} properties.`);

    await this._postToLaravel('owners', records);
    this.importResults.owners = records.length;
    log(`  Imported ${records.length} owners.`);
    return records;
  }

  async importProperties() {
    log('=== Importing Properties (Propiedades) ===');
    this.status = 'importing';
    // Navigate to properties list — note: the dashboard link filters by estadoCD=DISPONIBLE
    // After navigation, we'll try to remove the filter to get ALL properties
    await this.navigateToModule('Propiedades', 'ListViewPropiedades');

    // The web component may use infinite scroll — scroll down to load all cards
    await this._scrollToLoadAll();

    const records = await this._scrapeCardsFromPage();
    log(`Scraped ${records.length} properties total.`);
    await this._postToLaravel('properties', records);
    this.importResults.properties = records.length;
    return records;
  }

  async importCustomers() {
    log('=== Importing Customers (Compradores) ===');
    this.status = 'importing';
    await this.navigateToModule('Compradores', 'index');
    await delay(3000);

    await this._scrollToLoadAll();
    let records = await this._scrapeCardsFromPage();
    if (records.length === 0) {
      log('  No cards, trying shadowRoot...');
      records = await this._scrapeViaShadowRoot();
    }
    if (records.length === 0) {
      log('  No shadow data, trying table/AJAX...');
      records = await this.extractListData('Compradores');
    }

    // Ensure avantio_id — use email or name as fallback
    records = records.map((r, i) => {
      if (!r.avantio_id) {
        r.avantio_id = r.email || r.name || `customer-${Date.now()}-${i}`;
      }
      return r;
    });

    await this._postToLaravel('customers', records);
    this.importResults.customers = records.length;
    return records;
  }

  async importBookings() {
    log('=== Importing Bookings (Compromisos) ===');
    this.status = 'importing';

    // Navigate via the sidebar menu "Bookings" link which goes to the unfiltered view
    // (action=index), NOT the dashboard link which has date/status filters baked in
    log('  Navigating via sidebar menu to unfiltered bookings...');
    const navigated = await this.page.evaluate(() => {
      const menu = document.querySelector('avantio-menu');
      if (!menu || !menu.shadowRoot) return false;
      const links = menu.shadowRoot.querySelectorAll('a');
      for (const a of links) {
        if (a.textContent.trim() === 'Bookings' && a.href.includes('action=index')) {
          window.location.href = a.href;
          return true;
        }
      }
      return false;
    });

    if (navigated) {
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await delay(5000);
      log(`  Arrived at ${this.page.url().substring(0, 80)}`);
    } else {
      log('  Menu link not found, falling back to dashboard link...');
      await this.navigateToModule('Compromisos', 'ListView');
      await delay(5000);
      await this._clearBookingFilters();
      await delay(5000);
    }

    // Bookings use avantio-bookings-list with shadow DOM + infinite scroll.
    // Scroll the page body to trigger lazy loading, count shadow DOM rows.
    log('  Scrolling to load all booking rows...');
    let prevRowCount = 0;
    let stableCount = 0;
    for (let i = 0; i < 30; i++) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(2000);

      const rowCount = await this.page.evaluate(() => {
        const wc = document.querySelector('avantio-bookings-list');
        if (!wc || !wc.shadowRoot) return 0;
        return wc.shadowRoot.querySelectorAll('[data-testid="row-list"]').length;
      }).catch(() => 0);

      if (i % 5 === 0 || rowCount !== prevRowCount) {
        log(`  Scroll ${i + 1}: ${rowCount} booking rows`);
      }

      if (rowCount === prevRowCount) {
        stableCount++;
        if (stableCount >= 4) {
          log(`  All rows loaded: ${rowCount}`);
          break;
        }
      } else {
        stableCount = 0;
      }
      prevRowCount = rowCount;
    }

    // Scrape from the fully-loaded shadow DOM
    let records = await this._scrapeViaShadowRoot();
    log(`  Scraped ${records.length} booking records.`);

    // Ensure each record has an avantio_id — use reference if no ID found
    records = records.map((r, i) => {
      if (!r.avantio_id && r.reference) {
        r.avantio_id = r.reference;
      }
      if (!r.avantio_id && r.col_5) {
        // col_5 often contains the reference like LOC-999999
        const refMatch = (r.col_5 || '').match(/^([A-Z]+-\d+|\d{6,})/);
        if (refMatch) r.avantio_id = refMatch[1];
      }
      if (!r.avantio_id) {
        // Last resort: generate from index + raw text hash
        r.avantio_id = `import-${Date.now()}-${i}`;
      }
      return r;
    });

    await this._postToLaravel('bookings', records);
    this.importResults.bookings = records.length;
    return records;
  }

  async importTasks() {
    log('=== Importing Tasks (CompromisosExtras) ===');
    this.status = 'importing';
    await this.navigateToModule('CompromisosExtras', 'ListView');
    await delay(3000);

    await this._scrollToLoadAll();
    let records = await this._scrapeCardsFromPage();
    if (records.length === 0) {
      log('  No cards, trying shadowRoot...');
      records = await this._scrapeViaShadowRoot();
    }
    if (records.length === 0) {
      log('  No shadow data, trying table/AJAX...');
      records = await this.extractListData('CompromisosExtras');
    }

    // Ensure avantio_id
    records = records.map((r, i) => {
      if (!r.avantio_id) {
        r.avantio_id = `task-${Date.now()}-${i}`;
      }
      return r;
    });

    await this._postToLaravel('tasks', records);
    this.importResults.tasks = records.length;
    return records;
  }

  // ---------------------------------------------------------------------------
  // Payments CSV import (old PHP pages with Export → Csv)
  // ---------------------------------------------------------------------------

  /**
   * Generic payment CSV import.
   * Navigates to the payment list page via avantio-menu, clicks Export → Csv,
   * parses the downloaded CSV, maps to avantio_payments schema, and POSTs to Laravel.
   *
   * @param {string} paymentType - 'received', 'made', or 'pending'
   * @param {string} menuLinkText - Text of the menu link to click (e.g. "List of payments received")
   */
  async importPaymentsCSV(paymentType, menuLinkText) {
    log(`=== Importing Payments (${paymentType}) via CSV ===`);
    this.status = 'importing';

    // Navigate to the payments page via the avantio-menu sidebar
    log(`  Looking for menu link: "${menuLinkText}"...`);
    const navigated = await this.page.evaluate((linkText) => {
      const menu = document.querySelector('avantio-menu');
      if (!menu || !menu.shadowRoot) return false;
      for (const a of menu.shadowRoot.querySelectorAll('a')) {
        if (a.textContent.trim() === linkText) {
          window.location.href = a.href;
          return true;
        }
      }
      return false;
    }, menuLinkText);

    if (navigated) {
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await delay(5000);
      log(`  Arrived at ${this.page.url().substring(0, 100)}`);
    } else {
      log(`  Menu link "${menuLinkText}" not found, trying onclick handlers...`);
      const clickedOnclick = await this.page.evaluate((linkText) => {
        for (const el of document.querySelectorAll('[onclick*="redireccion"]')) {
          if (el.textContent.trim().includes(linkText)) {
            el.click();
            return true;
          }
        }
        // Also try regular links outside shadow DOM
        for (const a of document.querySelectorAll('a')) {
          if (a.textContent.trim() === linkText) {
            a.click();
            return true;
          }
        }
        return false;
      }, menuLinkText);

      if (clickedOnclick) {
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await delay(5000);
      } else {
        throw new Error(`Could not find menu link "${menuLinkText}" for payments (${paymentType}).`);
      }
    }

    // Wait for the page table to fully render
    await delay(3000);

    // Download the CSV using the old PHP page Export button pattern
    const rows = await this._downloadPaymentsCSV();
    if (rows.length === 0) {
      log(`  No CSV data for payments (${paymentType}).`);
      this.importResults[`payments_${paymentType}`] = 0;
      return [];
    }

    if (rows.length > 0) log(`  CSV columns: ${Object.keys(rows[0]).join(', ')}`);

    // Map CSV columns to avantio_payments schema
    const records = rows.map((r, i) => {
      const record = { _csv: r };

      // Parse date (DD/MM/YYYY format from Avantio)
      const rawDate = r['Date'] || r['Fecha'] || '';
      record.date = this._parseCSVDate(rawDate);

      record.payment_type = paymentType;

      // Booking reference (only for "received" payments)
      record.booking_reference = r['Booking number'] || r['Booking unique Id'] || null;

      // Property code (for "made" and "pending" payments)
      record.property_code = r['Property code'] || r['Property Code'] || null;

      // Description / Details
      record.description = r['Details'] || r["Property's name"] || r['Property name'] || '';

      // Counterpart: Guest for received, Recipient for made/pending
      record.counterpart = r['Guest'] || r['Recipient'] || null;

      // Payment method
      record.payment_method = r['Payment method'] || r['Payment Method'] || null;

      // Amount — clean numeric
      const rawAmount = r['Amount'] || r['Cantidad'] || '0';
      record.amount = parseFloat(
        rawAmount.replace(/[^\d.,\-]/g, '').replace(',', '.')
      ) || 0;

      record.currency = 'USD';

      // State
      record.state = r['State'] || r['Estado'] || (paymentType === 'pending' ? 'Pending' : 'Paid');

      // Portal (for made/pending)
      record.portal = r['Portal'] || null;

      // Observations (for received)
      record.observations = r['Observations'] || r['Observaciones'] || null;

      // Generate a unique avantio_id from composite key
      const idParts = [
        paymentType,
        record.date || '',
        record.booking_reference || record.property_code || '',
        record.counterpart || '',
        String(record.amount),
      ];
      record.avantio_id = `pay-${paymentType}-${crypto.createHash('md5').update(idParts.join('|')).digest('hex').substring(0, 16)}`;

      return record;
    });

    await this._postToLaravel('avantio_payments', records);
    this.importResults[`payments_${paymentType}`] = records.length;
    log(`  Imported ${records.length} payments (${paymentType}) from CSV.`);
    return records;
  }

  /**
   * Download CSV from old PHP page Export button.
   * These pages use a button with class "button_listaExport" that opens a dropdown,
   * then a "Csv" link inside the dropdown triggers the download.
   */
  async _downloadPaymentsCSV() {
    log('  Clicking Export → Csv on PHP page...');

    // Click the Export button to open the dropdown
    await this.page.evaluate(() => {
      // Try class-based selector first
      const exportBtn = document.querySelector('.button_listaExport')
        || document.querySelector('button.button_listaExport');
      if (exportBtn) { exportBtn.click(); return; }
      // Fallback: find button by text
      for (const btn of document.querySelectorAll('button')) {
        if (btn.textContent.trim() === 'Export') { btn.click(); return; }
      }
    });
    await delay(2000);

    // Set up download handler before clicking the Csv link
    const downloadPromise = this.page.waitForEvent('download', { timeout: 30000 });

    // Click the Csv link in the dropdown
    await this.page.evaluate(() => {
      for (const a of document.querySelectorAll('a')) {
        const text = a.textContent.trim();
        if (text === 'Csv' || text === 'CSV') { a.click(); return true; }
      }
      return false;
    });

    let download;
    try {
      download = await downloadPromise;
    } catch {
      log('  CSV download timed out.');
      return [];
    }

    const tmpFile = `/tmp/holasur-payments-csv-${Date.now()}.csv`;
    await download.saveAs(tmpFile);
    const size = fs.statSync(tmpFile).size;
    log(`  Payments CSV saved (${size} bytes)`);

    const content = fs.readFileSync(tmpFile, 'utf-8');
    // Save a debug copy
    const debugFile = `/tmp/holasur-payments-debug-${Date.now()}.csv`;
    fs.copyFileSync(tmpFile, debugFile);
    log(`  Debug copy: ${debugFile}`);

    const rows = this._parseCSV(content);
    fs.unlinkSync(tmpFile);
    log(`  Parsed ${rows.length} rows from payments CSV.`);
    return rows;
  }

  /**
   * Import payments received (208 records).
   * Columns: Date, Booking number, Details, Guest, Payment method, Amount, Observations, Booking unique Id
   */
  async importPaymentsReceived() {
    return this.importPaymentsCSV('received', 'List of payments received');
  }

  /**
   * Import payments made (320 records).
   * Columns: Date, Details, Recipient, Payment method, Amount, State, Property code, Property's name, Portal
   */
  async importPaymentsMade() {
    return this.importPaymentsCSV('made', 'List of payments made');
  }

  /**
   * Import payments to be made (124 records).
   * Same structure as payments made but with State=Pending.
   */
  async importPaymentsToMake() {
    return this.importPaymentsCSV('pending', 'List of payments to be made');
  }

  async importInvoices() {
    log('=== Importing Invoices via CSV ===');
    this.status = 'importing';

    // Navigate by clicking the sidebar link directly
    const menuTexts = ['Issue invoices from bookings', 'Accounting documents'];
    let navigated = false;

    // Wait for page to settle after login
    await delay(3000);
    await this.page.waitForLoadState('load').catch(() => {});
    await delay(2000);

    for (const linkText of menuTexts) {
      const url = await this.page.evaluate((text) => {
        const menu = document.querySelector('avantio-menu');
        if (!menu || !menu.shadowRoot) return null;
        for (const a of menu.shadowRoot.querySelectorAll('a')) {
          if (a.textContent.trim() === text && (a.href.includes('AccountingDocument') || a.href.includes('Facturacion'))) {
            return a.href;
          }
        }
        return null;
      }, linkText);

      if (url) {
        log(`  Found invoices URL: "${linkText}" → ${url.substring(0, 100)}`);
        await this.page.evaluate((targetUrl) => { window.location.href = targetUrl; }, url);
        await this.page.waitForURL(/Facturacion|AccountingDocument/, { timeout: 15000 }).catch(() => {});
        await delay(5000);
        if (this.page.url().includes('AccountingDocument') || this.page.url().includes('Facturacion')) {
          navigated = true;
        }
        break;
      }
    }

    if (!navigated) {
      log('  Could not navigate to invoices page.');
      this.importResults.invoices = 0;
      return [];
    }

    log(`  Arrived at ${this.page.url().substring(0, 100)}`);

    // Debug: dump page structure to understand the invoices page
    const pageInfo = await this.page.evaluate(() => {
      const wcs = Array.from(document.querySelectorAll('*')).filter(e => e.tagName.includes('-')).map(e => e.tagName.toLowerCase());
      const uniqueWcs = [...new Set(wcs)];
      const tables = document.querySelectorAll('table').length;
      const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, .btn'))
        .map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 50);
      const iframes = document.querySelectorAll('iframe').length;
      const exportLinks = Array.from(document.querySelectorAll('a[href*="export"], a[href*="csv"], a[href*="download"], a[href*="Export"]'))
        .map(a => ({ text: a.textContent.trim(), href: a.href.substring(0, 100) }));
      return { webComponents: uniqueWcs, tables, buttons: [...new Set(buttons)], iframes, exportLinks };
    }).catch(() => ({}));
    log(`  Page structure: ${JSON.stringify(pageInfo)}`);

    // Try CSV download from the web component on the page
    const wcSelectors = ['avantio-invoices-list', 'avantio-invoice-list', 'avantio-billing-list', 'avantio-facturacion-list', 'avantio-proforma-list', 'avantio-accounting-document-list'];
    let rows = [];

    for (const wc of wcSelectors) {
      const exists = await this.page.$(wc);
      if (exists) {
        log(`  Found web component: ${wc}`);
        rows = await this._downloadAndParseCSV(wc);
        break;
      }
    }

    // Fallback: scrape HTML tables on the page
    if (rows.length === 0) {
      log('  No web component CSV, scraping Avantio invoices table...');
      rows = await this.page.evaluate(() => {
        // Avantio's invoices table puts ALL data in a single <tr> as flat <td> cells
        // Each invoice is a repeating group: [checkbox][checkbox][Number][Date][Accommodation][Client][Owner][Entry][Exit][Status][Total]
        const tables = document.querySelectorAll('table');
        let best = null, bestCount = 0;
        for (const t of tables) {
          const r = t.querySelectorAll('tbody tr');
          if (r.length > bestCount) { best = t; bestCount = r.length; }
        }
        if (!best) return [];

        const firstRow = best.querySelector('tbody tr');
        if (!firstRow) return [];
        const tds = firstRow.querySelectorAll('td');
        const cells = Array.from(tds).map(td => {
          const clone = td.cloneNode(true);
          clone.querySelectorAll('script, style, noscript').forEach(s => s.remove());
          return clone.textContent.replace(/\s+/g, ' ').trim();
        });

        // Deduplicate "text text" → "text"
        function dedup(s) {
          const parts = s.split(' ');
          if (parts.length >= 2 && parts.length % 2 === 0) {
            const half = parts.length / 2;
            if (parts.slice(0, half).join(' ') === parts.slice(half).join(' '))
              return parts.slice(0, half).join(' ');
          }
          return s;
        }

        // Skip junk cells until first booking number (7+ digits)
        let i = 0;
        while (i < cells.length && !/^\d{7,}/.test(cells[i])) i++;

        const results = [];
        while (i < cells.length) {
          if (/^\d{7,}/.test(cells[i])) {
            results.push({
              'Number': dedup(cells[i] || ''),
              'Invoice adding': cells[i+1] || '',
              'Accommodation': dedup(cells[i+2] || '').replace(/\{[^}]+\}/g, '').trim(),
              'Client/Guest': (cells[i+3] || '').replace(/\{[^}]+\}/g, '').trim(),
              'Owner': dedup(cells[i+4] || ''),
              'Invoice entry': cells[i+5] || '',
              'Invoice exit': cells[i+6] || '',
              'Status': cells[i+7] || '',
              'Total': cells[i+8] || '',
            });
            i += 9;
            while (i < cells.length && (cells[i] === 'No' || cells[i] === '')) i++;
          } else {
            i++;
          }
        }
        return results;
      }).catch(() => []);
      if (rows.length > 0) log(`  Scraped ${rows.length} rows from HTML table`);
    }

    if (rows.length === 0) {
      log('  No invoice data found.');
      this.importResults.invoices = 0;
      return [];
    }

    if (rows.length > 0) log(`  CSV columns: ${Object.keys(rows[0]).join(', ')}`);

    // Map columns to invoices schema
    // Known Avantio columns: Number, Invoice adding, Accommodation, Client/Guest,
    // Owner, Invoice entry, Invoice exit, Status, Total
    const columnMap = {
      'number': 'invoice_number',
      'invoice adding': 'type',
      'accommodation': 'property_code',
      'client/guest': 'customer_name',
      'owner': 'description',
      'invoice entry': 'date',
      'invoice exit': 'due_date',
      'status': 'status',
      'total': 'total',
    };

    const records = rows.map(r => {
      const record = { raw_data: r };

      for (const [k, v] of Object.entries(r)) {
        const kl = k.toLowerCase().trim();
        // Skip junk columns (checkbox controls etc.)
        if (kl.includes('select') || kl.includes('deselect') || kl.length > 40) continue;

        // Try exact Avantio column match first
        if (columnMap[kl]) {
          const field = columnMap[kl];
          if (field === 'total') {
            record[field] = parseFloat((v || '').replace(/[^0-9.-]/g, '')) || 0;
          } else if (field === 'date' || field === 'due_date') {
            record[field] = this._parseCSVDate(v) || v;
          } else {
            record[field] = v;
          }
          continue;
        }

        // Generic keyword fallback
        if (kl.includes('booking') || kl.includes('reservation')) record.booking_reference = v;
        if (kl.includes('subtotal')) record.subtotal = parseFloat((v || '').replace(/[^0-9.-]/g, '')) || 0;
        if (kl.includes('tax') || kl.includes('iva')) record.tax_amount = parseFloat((v || '').replace(/[^0-9.-]/g, '')) || 0;
      }

      // Generate a unique ID
      record.avantio_id = record.invoice_number ||
        require('crypto').createHash('md5')
          .update(`invoice-${record.date}-${record.total}-${record.customer_name || ''}`)
          .digest('hex').substring(0, 16);

      return record;
    });

    await this._postToLaravel('invoices', records);
    this.importResults.invoices = records.length;
    log(`  Imported ${records.length} invoices.`);
    return records;
  }

  async importPaymentsOutstanding() {
    log('=== Importing Outstanding Payments via CSV ===');
    this.status = 'importing';

    // Navigate via menu
    const url = await this.page.evaluate(() => {
      const menu = document.querySelector('avantio-menu');
      if (!menu || !menu.shadowRoot) return null;
      for (const a of menu.shadowRoot.querySelectorAll('a'))
        if (a.textContent.trim() === 'List of outstanding payments receivable') return a.href;
      return null;
    });
    if (url) await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(5000);

    // This page uses avantio-pending-payments-list web component (like bookings)
    const rows = await this._downloadAndParseCSV('avantio-pending-payments-list');
    if (rows.length === 0) {
      log('  No CSV data for outstanding payments.');
      return [];
    }

    // Map CSV columns to our payments schema
    const records = rows.map(r => {
      const record = {
        payment_type: 'outstanding',
        raw_data: r,
      };
      // Map known columns (discover from first row)
      for (const [k, v] of Object.entries(r)) {
        const kl = k.toLowerCase();
        if (kl.includes('date') && !record.date) record.date = this._parseCSVDate(v) || v;
        if (kl.includes('amount') || kl.includes('import')) record.amount = parseFloat((v || '').replace(/[^0-9.-]/g, '')) || 0;
        if (kl.includes('reservation') || kl.includes('booking')) record.booking_reference = v;
        if (kl.includes('payer') || kl.includes('guest')) record.counterpart = v;
        if (kl.includes('state') || kl.includes('status')) record.state = v;
        if (kl.includes('portal') || kl.includes('commission')) record.portal = v;
        if (kl.includes('property') || kl.includes('code')) record.property_code = v;
        if (kl.includes('method')) record.payment_method = v;
      }
      record.avantio_id = require('crypto').createHash('md5')
        .update(`outstanding-${record.date}-${record.booking_reference}-${record.amount}`)
        .digest('hex').substring(0, 16);
      return record;
    });

    await this._postToLaravel('avantio_payments', records);
    this.importResults.payments_outstanding = records.length;
    log(`  Imported ${records.length} outstanding payments.`);
    return records;
  }

  // ---------------------------------------------------------------------------
  // Full import orchestration
  // ---------------------------------------------------------------------------

  /**
   * Run all imports in dependency order.
   * Owners first (properties reference them), then properties, customers,
   * bookings, and finally tasks.
   */
  async runFullImport() {
    log('========================================');
    log('Starting full Avantio import');
    log('========================================');
    this.status = 'importing';
    this.importResults = {};

    try {
      await this.importOwners();
      await this.importProperties();
      await this.importCustomers();
      await this.importBookings();
      await this.importTasks();

      this.status = 'done';
      log('========================================');
      log('Full import completed successfully.');
      log(`Results: ${JSON.stringify(this.importResults)}`);
      log('========================================');
    } catch (err) {
      this.status = 'error';
      log(`Import failed: ${err.message}`);
      throw err;
    }

    return this.importResults;
  }

  /**
   * Quick sync — only re-imports properties and bookings (most dynamic data).
   * Uses updateOrCreate on the Laravel side, so existing records are updated.
   */
  async runQuickSync() {
    log('========================================');
    log('Starting quick sync (properties + bookings)');
    log('========================================');
    this.status = 'importing';
    this.importResults = {};

    try {
      await this.importProperties();
      await this.importBookings();

      this.status = 'done';
      log('========================================');
      log('Quick sync completed.');
      log(`Results: ${JSON.stringify(this.importResults)}`);
      log('========================================');
    } catch (err) {
      this.status = 'error';
      log(`Import failed: ${err.message}`);
      throw err;
    }

    return this.importResults;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Set up a one-shot response interceptor that resolves with the first
   * JSON response body from an index.php POST.
   */
  _interceptNextJsonResponse() {
    return new Promise((resolve) => {
      const handler = async (response) => {
        try {
          const url = response.url();
          const req = response.request();
          if (
            url.includes('index.php') &&
            (req.method() === 'POST' || url.includes('module='))
          ) {
            const body = await response.text();
            const parsed = parseAvantioResponse(body);
            if (parsed && typeof parsed === 'object') {
              this.page.removeListener('response', handler);
              resolve(parsed);
            }
          }
        } catch {
          // Response might have been disposed — ignore
        }
      };
      this.page.on('response', handler);
    });
  }

  /**
   * Attempt to click a "next page" link on the current list view.
   * Harvests the avs token from the link before clicking.
   */
  async _clickNextPage() {
    const selectors = [
      'a.next-page',
      'a.pag_siguiente',
      'a[rel="next"]',
      '.pagination .next a',
      '.paginacion a.siguiente',
    ];

    for (const sel of selectors) {
      const link = await this.page.$(sel);
      if (link) {
        // Harvest avs from this link
        const href = await link.getAttribute('href');
        if (href && href.includes('avs=')) {
          const html = `<a href="${href}">link</a>`;
          const tokens = extractAvsFromHtml(html);
          for (const [k, v] of tokens) {
            this.avsTokens.set(k, v);
          }
        }

        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
          link.click(),
        ]);
        await this.harvestAvs();
        return true;
      }
    }

    // Fallback: look for numbered page links and click the next number
    const pageLinks = await this.page.$$('.pagination a, .paginacion a');
    if (pageLinks.length > 0) {
      const last = pageLinks[pageLinks.length - 1];
      const text = await last.textContent();
      if (text && /\d+|[>»]|next|sig/i.test(text.trim())) {
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
          last.click(),
        ]);
        await this.harvestAvs();
        return true;
      }
    }

    return false;
  }

  /**
   * Try to pull row objects from the AJAX JSON response.
   * Avantio list responses vary in structure, so we try several paths.
   */
  _extractRecordsFromResponse(data) {
    if (Array.isArray(data)) return data;
    if (data.data && Array.isArray(data.data)) return data.data;
    if (data.rows && Array.isArray(data.rows)) return data.rows;
    if (data.items && Array.isArray(data.items)) return data.items;
    if (data.result && Array.isArray(data.result)) return data.result;
    if (data.aaData && Array.isArray(data.aaData)) return data.aaData;

    // Search one level deeper
    for (const val of Object.values(data)) {
      if (Array.isArray(val) && val.length > 0) return val;
    }

    // Wrap the whole object if nothing else matched
    return [data];
  }

  /**
   * Scrape data from the page using Playwright locators which pierce shadow DOMs.
   * Avantio uses web components with shadow roots. Different entities use different layouts:
   * - Properties: .alib-vertical-card (grid of cards)
   * - Bookings/Owners/Customers: .alib-row-list or .alib-horizontal-card (list rows)
   */
  async _scrapeCardsFromPage() {
    // Try multiple selectors — different entities use different layouts
    const selectors = [
      '.alib-vertical-card',       // Properties grid cards
      '.alib-row-list__item',      // List row items
      '.alib-horizontal-card',     // Horizontal card layout
      '.alib-list-item',           // Generic list items
      '[data-testid="row"]',       // Test-id based rows
      'tr[data-id]',               // Table rows with data-id
    ];

    let cardLocator = null;
    let count = 0;
    for (const sel of selectors) {
      const loc = this.page.locator(sel);
      const c = await loc.count().catch(() => 0);
      if (c > 0) {
        log(`  Found ${c} items with selector "${sel}"`);
        cardLocator = loc;
        count = c;
        break;
      }
    }

    if (!cardLocator || count === 0) {
      // Fallback: try evaluate() with direct shadowRoot access for web components
      log(`  No items via Playwright locators, trying shadowRoot evaluate...`);
      const shadowRecords = await this._scrapeViaShadowRoot();
      if (shadowRecords.length > 0) return shadowRecords;
      log(`  No items found with any known method.`);
      return [];
    }

    const records = [];
    for (let i = 0; i < count; i++) {
      try {
        const card = cardLocator.nth(i);
        const text = await card.textContent({ timeout: 2000 }).catch(() => '');
        if (!text || text.length < 3) continue;

        // Extract structured data from the card
        const data = await card.evaluate((el) => {
          const record = {};
          // Name from h3
          const h3 = el.querySelector('h3');
          if (h3) record.name = h3.textContent.trim();
          // Image alt as fallback name
          const img = el.querySelector('img[data-testid="image"]');
          if (img) record.name = record.name || img.alt.trim();

          // Collect all text spans that contain data fields
          const bodySpans = el.querySelectorAll('.alib-vertical-card__body span.truncate, .alib-vertical-card__body span[class*="text-xs"]');
          const spanTexts = [];
          bodySpans.forEach(s => {
            const t = s.textContent.trim();
            if (t && t !== record.name && !spanTexts.includes(t)) spanTexts.push(t);
          });

          // Also check for status badges/tags
          const badge = el.querySelector('[class*="badge"], [class*="tag"], [class*="status"], [class*="chip"]');
          if (badge) record.status = badge.textContent.trim();

          // Map spans by content pattern
          for (const t of spanTexts) {
            if (/^\d{4,}$/.test(t)) {
              record.avantio_id = t;
            } else if (/active|inactive|deactivated|disponible/i.test(t)) {
              record.status = record.status || t;
            } else if (t.includes(' - ') || /house|apartment|villa|studio|chalet|flat|room/i.test(t)) {
              record.type_location = t;
            } else if (!record.avantio_id) {
              record.avantio_id = t;
            }
          }

          record._rawText = (record.name || '') + ' | ' + spanTexts.join(' | ');
          return record;
        });

        records.push(data);
      } catch {
        // Skip cards that fail to extract
      }
    }

    return records;
  }

  /**
   * Scrape data directly from shadow DOM using page.evaluate().
   * Works when Playwright locators can't pierce the shadow DOM.
   * Finds any avantio-*-list web component and extracts rows from its shadow root.
   */
  async _scrapeViaShadowRoot() {
    return this.page.evaluate(() => {
      // Find any avantio list web component
      const wcSelectors = [
        'avantio-bookings-list',
        'avantio-accommodations-list',
        'avantio-owners-list',
        'avantio-customers-list',
      ];

      let shadow = null;
      for (const sel of wcSelectors) {
        const wc = document.querySelector(sel);
        if (wc && wc.shadowRoot) {
          shadow = wc.shadowRoot;
          break;
        }
      }
      if (!shadow) return [];

      const records = [];
      // Use data-testid="row-list" which reliably identifies booking rows
      let rows = shadow.querySelectorAll('[data-testid="row-list"]');
      if (rows.length === 0) {
        // Fallback for other entity types
        for (const sel of ['[role="row"]', 'tr', '[class*="row-list"]']) {
          const found = shadow.querySelectorAll(sel);
          if (found.length > 0) { rows = found; break; }
        }
      }

      const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

      rows.forEach(row => {
        const text = row.textContent.trim();
        if (!text || text.length < 10) return;

        const record = { _rawText: text.substring(0, 400) };

        // Extract avantio_id from links (most reliable)
        const links = row.querySelectorAll('a[href], button[data-testid="link"]');
        links.forEach(a => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/record=(\d+)/);
          if (m) record.avantio_id = m[1];
          // First link text is usually the property name
          const t = a.textContent.trim();
          if (t && !record.property_name) record.property_name = t;
        });

        // Extract cells by index — Avantio booking rows have a consistent structure:
        // c2/c3: dates + property | c4: status | c5/c6: reference | c7/c8: guest | c9: alerts | c10: amount
        const cells = row.querySelectorAll('[class*="cell"], [class*="col"], td');
        const cellTexts = [];
        cells.forEach(c => cellTexts.push(c.textContent.trim()));

        // Parse dates from text (format: "Aug 10 2026 - Aug 16 2026")
        const mmmMatch = text.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s*-\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})/);
        if (mmmMatch) {
          const m1 = months[mmmMatch[1]] || '01';
          const m2 = months[mmmMatch[4]] || '01';
          record.check_in = `${mmmMatch[3]}-${m1}-${mmmMatch[2].padStart(2,'0')}`;
          record.check_out = `${mmmMatch[6]}-${m2}-${mmmMatch[5].padStart(2,'0')}`;
        }
        // Fallback: ISO format
        const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
        if (!record.check_in && isoMatch) {
          record.check_in = isoMatch[1];
          record.check_out = isoMatch[2];
        }

        // Status — look for known booking statuses
        const statusMatch = text.match(/\b(Confirmed|Information Request|Pre-booking|Invoiced|Cancelled|Paid|Unpaid|Not Available|Owner Booking|Owner Block)\b/i);
        if (statusMatch) record.status = statusMatch[1];

        // Reference — alphanumeric patterns like "A203-HMXM2WCJYN" or "33374878-1744214528"
        const refMatch = text.match(/\b([A-Z]\d+-[A-Z0-9]+|\d{7,}-\d+)\b/);
        if (refMatch) record.reference = refMatch[0];
        if (!record.avantio_id && record.reference) record.avantio_id = record.reference;

        // Amount — "US$ 550.16" or "550,16€"
        const amountMatch = text.match(/(?:US?\$|€|£)\s*([\d,.]+)|([\d,.]+)\s*[€$£]/);
        if (amountMatch) {
          record.amount = (amountMatch[1] || amountMatch[2]).replace(/,/g, '');
        }

        // Guest info
        const adultMatch = text.match(/(\d+)\s*Adult/i);
        if (adultMatch) record.adults = parseInt(adultMatch[1]);
        const childMatch = text.match(/(\d+)\s*Child/i);
        if (childMatch) record.children = parseInt(childMatch[1]);

        // Guest name — pattern: "Name - CC" where CC is country code
        const guestMatch = text.match(/([A-ZÀ-Ú][a-zà-ú]+(?: [A-ZÀ-Ú][a-zà-ú]+)*)\s*-\s*[A-Z]{2}\d/);
        if (guestMatch) record.guest_name = guestMatch[1];

        records.push(record);
      });

      return records;
    });
  }

  /**
   * Scrape detail page for a property or booking.
   * Opens "See" in a new tab, extracts all input fields + table data, closes tab.
   */
  async scrapeDetailPage(entityType, rowIndex) {
    const wcSelector = entityType === 'property' ? 'avantio-accommodations-list' : 'avantio-bookings-list';

    const clicked = await this.page.evaluate(({ wcSel, idx }) => {
      const wc = document.querySelector(wcSel);
      if (!wc || !wc.shadowRoot) return false;
      const items = wcSel.includes('accommodations')
        ? wc.shadowRoot.querySelectorAll('.alib-vertical-card')
        : wc.shadowRoot.querySelectorAll('[data-testid="row-list"]');
      if (idx >= items.length) return false;
      const btn = items[idx].querySelector('button[aria-label="See"]');
      if (btn) { btn.click(); return true; }
      return false;
    }, { wcSel: wcSelector, idx: rowIndex });

    if (!clicked) { log(`  No See button on ${entityType} row ${rowIndex}`); return null; }

    // Wait for new tab with a DetailView URL
    let detailPage = null;
    for (let i = 0; i < 15; i++) {
      await delay(1000);
      const pages = this.page.context().pages();
      // Find the page with DetailView in the URL (not the list page)
      for (const p of pages) {
        const url = p.url();
        if (url.includes('action=DetailView') && url.includes('record=')) {
          detailPage = p;
          break;
        }
      }
      if (detailPage) break;
    }
    if (!detailPage) { log(`  No detail tab for ${entityType} row ${rowIndex}`); return null; }

    await detailPage.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    log(`  Detail tab opened: ${detailPage.url().substring(0, 100)}`);
    // Wait for AJAX content to load (booking details load async)
    await delay(8000);

    try {
      const data = await detailPage.evaluate(() => {
        const result = {};
        document.querySelectorAll('input[id], select[id]').forEach(el => {
          if (el.value && el.id && !el.id.startsWith('checkbox')) result[el.id] = el.value;
        });
        document.querySelectorAll('table tr').forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 2) {
            const label = cells[0].textContent.trim().replace(/\s+/g, ' ').replace(/:+$/, '');
            const value = cells[1].textContent.trim().replace(/\s+/g, ' ');
            if (label && value && label.length < 50 && value.length < 300 && value !== label)
              result['_t_' + label] = value;
          }
        });
        return result;
      });

      const url = detailPage.url();
      const m = url.match(/record=(\d+)/);
      if (m) data._recordId = m[1];
      log(`  Detail ${entityType} #${rowIndex}: ${Object.keys(data).length} fields (record=${data._recordId || '?'})`);
      return data;
    } finally {
      await detailPage.close().catch(() => {});
    }
  }

  /**
   * Import detail for ONE item to validate before full import.
   */
  /**
   * Scrape a SPECIFIC record's detail by navigating to its detail page directly.
   * Opens a new tab with the detail URL, scrapes all fields, saves to Laravel.
   */
  async scrapeRecordDetail(entityType, avantioId) {
    log(`=== Scraping detail for ${entityType} record ${avantioId} ===`);

    // For properties: avantio_id appears as text in the card (e.g. "671862")
    // For bookings: avantio_id is only in the See button URL, not in row text/links.
    //   We must find the row by matching dates+property from our DB.

    // Get identifying info from our DB to help find the row
    let searchText = avantioId;
    try {
      const entity = entityType === 'properties' ? 'properties' : 'bookings';
      const res = await fetch(`${LARAVEL_API.replace('/import', '')}/${entity}?search=${avantioId}`);
      if (res.ok) {
        const body = await res.json();
        const records = body.data || [];
        const rec = records.find(r => String(r.avantio_id) === String(avantioId));
        if (rec) {
          // For bookings, combine property name + check-in date for unique match
          if (entityType === 'bookings') {
            const parts = [];
            if (rec.raw_data?.property_name) parts.push(rec.raw_data.property_name);
            // Format check_in as "Feb 14 2027" to match Avantio's display
            if (rec.check_in) {
              // Parse date string directly (avoid timezone shift from Date constructor)
              const dateStr = String(rec.check_in).substring(0, 10); // "2027-02-14"
              const [y, m, day] = dateStr.split('-');
              const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              parts.push(`${months[parseInt(m)]} ${parseInt(day)} ${y}`);
            }
            if (parts.length > 0) searchText = parts.join('|');
          }
        }
      }
    } catch { /* use avantioId as fallback */ }

    // Navigate to list
    if (entityType === 'properties') {
      await this.navigateToModule('Propiedades', 'ListViewPropiedades');
    } else {
      const bookingsUrl = await this.page.evaluate(() => {
        const menu = document.querySelector('avantio-menu');
        if (!menu || !menu.shadowRoot) return null;
        for (const a of menu.shadowRoot.querySelectorAll('a'))
          if (a.textContent.trim() === 'Bookings' && a.href.includes('action=index')) return a.href;
        return null;
      });
      if (bookingsUrl) await this.page.goto(bookingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await delay(3000);

    const wcSelector = entityType === 'properties' ? 'avantio-accommodations-list' : 'avantio-bookings-list';
    const rowSelector = entityType === 'properties' ? '.alib-vertical-card' : '[data-testid="row-list"]';

    // Try the search box first (faster than scrolling)
    const searchTerms = [avantioId];
    // Also add booking reference from our DB if available
    try {
      const res = await fetch(`${LARAVEL_API.replace('/import', '')}/bookings?search=${avantioId}`);
      if (res.ok) {
        const body = await res.json();
        const rec = (body.data || []).find(r => String(r.avantio_id) === String(avantioId));
        if (rec?.raw_data?._rawText) {
          const refMatch = rec.raw_data._rawText.match(/(\d{7,}-\d+)/);
          if (refMatch) searchTerms.push(refMatch[1]);
        }
      }
    } catch {}

    for (const term of searchTerms) {
      log(`  Trying search box for "${term}"...`);
      try {
        const searchInput = this.page.locator(`${wcSelector} >> input[placeholder*="Search"]`);
        if (await searchInput.count() > 0) {
          await searchInput.fill('');
          await searchInput.type(term, { delay: 50 });
          await this.page.keyboard.press('Enter');
          await delay(4000);
          // Check if results filtered
          const count = await this.page.evaluate(({ wc, rs }) => {
            const el = document.querySelector(wc);
            return el && el.shadowRoot ? el.shadowRoot.querySelectorAll(rs).length : 0;
          }, { wc: wcSelector, rs: rowSelector }).catch(() => 0);
          if (count > 0 && count < 10) {
            log(`  Search returned ${count} results.`);
            break;
          }
          // Clear search if it didn't filter
          await searchInput.fill('');
          await this.page.keyboard.press('Enter');
          await delay(2000);
        }
      } catch { /* fall through to scrolling */ }
    }

    // Scroll until we find the row or exhaust the list
    log(`  Scrolling to find "${searchText.substring(0, 40)}"...`);
    let foundIndex = -1;
    let prevCount = 0;
    let stableRounds = 0;

    for (let scroll = 0; scroll < 30; scroll++) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(2000);

      const result = await this.page.evaluate(({ wcSel, rSel, search, aId }) => {
        const wc = document.querySelector(wcSel);
        if (!wc || !wc.shadowRoot) return { count: 0, found: -1 };
        const rows = wc.shadowRoot.querySelectorAll(rSel);
        let found = -1;
        for (let i = 0; i < rows.length; i++) {
          const text = rows[i].textContent;
          // Match by avantio_id in text, or by ALL search parts (prop name + date)
          const searchParts = search.split('|');
          const allPartsMatch = searchParts.length > 0 && searchParts.every(p => text.includes(p));
          if (text.includes(aId) || allPartsMatch) {
            found = i;
            break;
          }
          // For properties, also check links for record=<id>
          const links = rows[i].querySelectorAll('a[href]');
          for (const a of links) {
            if (a.href.includes(`record=${aId}`)) { found = i; break; }
          }
          if (found >= 0) break;
        }
        return { count: rows.length, found };
      }, { wcSel: wcSelector, rSel: rowSelector, search: searchText, aId: avantioId });

      if (result.found >= 0) {
        foundIndex = result.found;
        log(`  Found at row ${foundIndex} after ${scroll + 1} scrolls (${result.count} rows).`);
        break;
      }

      if (result.count === prevCount) {
        stableRounds++;
        if (stableRounds >= 4) {
          log(`  All ${result.count} rows loaded, record not found.`);
          break;
        }
      } else { stableRounds = 0; }
      prevCount = result.count;
    }

    if (foundIndex < 0) {
      log(`  Could not find record ${avantioId} in list.`);
      return null;
    }

    // Click "See" on the found row
    const clicked = await this.page.evaluate(({ wcSel, rSel, idx }) => {
      const wc = document.querySelector(wcSel);
      if (!wc || !wc.shadowRoot) return false;
      const rows = wc.shadowRoot.querySelectorAll(rSel);
      if (idx >= rows.length) return false;
      const btn = rows[idx].querySelector('button[aria-label="See"]');
      if (btn) { btn.click(); return true; }
      return false;
    }, { wcSel: wcSelector, rSel: rowSelector, idx: foundIndex });

    if (!clicked) {
      log(`  Could not click See on row ${foundIndex}.`);
      return null;
    }

    // Wait for detail tab
    let detailPage = null;
    for (let i = 0; i < 15; i++) {
      await delay(1000);
      for (const p of this.page.context().pages()) {
        if (p.url().includes('action=DetailView') && p.url().includes('record=')) {
          detailPage = p;
          break;
        }
      }
      if (detailPage) break;
    }

    if (!detailPage) {
      log(`  No detail tab opened.`);
      return null;
    }

    await detailPage.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    log(`  Detail tab: ${detailPage.url().substring(0, 80)}`);
    await delay(5000);

    const data = await this._extractDetailFromPage(detailPage);
    await detailPage.close().catch(() => {});

    if (Object.keys(data).length > 5) {
      log(`  Extracted ${Object.keys(data).length} fields.`);
      const record = this._mapDetailToRecord(entityType, data);
      await this._postToLaravel(entityType, [record]);
      return data;
    }

    log(`  Too few fields (${Object.keys(data).length}).`);
    return null;
  }

  /**
   * Extract all input fields and table data from a detail page.
   */
  async _extractDetailFromPage(page) {
    return page.evaluate(() => {
      const result = {};
      document.querySelectorAll('input[id], select[id]').forEach(el => {
        if (el.value && el.id && !el.id.startsWith('checkbox')) result[el.id] = el.value;
      });
      document.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length >= 2) {
          const label = cells[0].textContent.trim().replace(/\s+/g, ' ').replace(/:+$/, '');
          const value = cells[1].textContent.trim().replace(/\s+/g, ' ');
          if (label && value && label.length < 50 && value.length < 300 && value !== label)
            result['_t_' + label] = value;
        }
      });
      const url = window.location.href;
      const m = url.match(/record=(\d+)/);
      if (m) result._recordId = m[1];
      return result;
    });
  }

  /**
   * Import detail for ONE item to validate before full import.
   */
  async importOneDetail(entityType) {
    log(`=== Scraping detail for first ${entityType} ===`);

    if (entityType === 'properties') {
      await this.navigateToModule('Propiedades', 'ListViewPropiedades');
    } else {
      // Get the bookings menu URL and navigate via page.goto (more reliable)
      const bookingsUrl = await this.page.evaluate(() => {
        const menu = document.querySelector('avantio-menu');
        if (!menu || !menu.shadowRoot) return null;
        for (const a of menu.shadowRoot.querySelectorAll('a')) {
          if (a.textContent.trim() === 'Bookings' && a.href.includes('action=index')) {
            return a.href;
          }
        }
        return null;
      });
      if (bookingsUrl) {
        await this.page.goto(bookingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
    }

    // Wait for the web component to render rows
    log(`  Waiting for ${entityType} list to load...`);
    const wcSel = entityType === 'properties' ? 'avantio-accommodations-list' : 'avantio-bookings-list';
    const rowSel = entityType === 'properties' ? '.alib-vertical-card' : '[data-testid="row-list"]';
    for (let i = 0; i < 15; i++) {
      await delay(2000);
      const count = await this.page.evaluate(({ wc, rs }) => {
        const el = document.querySelector(wc);
        return el && el.shadowRoot ? el.shadowRoot.querySelectorAll(rs).length : 0;
      }, { wc: wcSel, rs: rowSel }).catch(() => 0);
      if (count > 0) { log(`  ${count} items loaded.`); break; }
    }

    const detail = await this.scrapeDetailPage(entityType === 'properties' ? 'property' : 'booking', 0);
    if (detail) {
      const record = this._mapDetailToRecord(entityType, detail);
      await this._postToLaravel(entityType, [record]);
      this.importResults[`${entityType}_detail`] = 1;
    }
    return detail;
  }

  /**
   * Map scraped detail fields to a record suitable for the Laravel import API.
   * Known fields go to named columns, everything else to raw_data (detail section).
   */
  _mapDetailToRecord(entityType, detail) {
    const record = {
      avantio_id: detail._recordId || detail.record || `detail-${Date.now()}`,
    };

    if (entityType === 'properties') {
      // Map property detail fields to DB columns
      if (detail['_t_Address']) record.address = detail['_t_Address'];
      if (detail['_t_Building/house number']) {
        record.address = (record.address || '') + ' ' + detail['_t_Building/house number'];
      }
      if (detail['_t_Floor']) record.address = (record.address || '') + ', Piso ' + detail['_t_Floor'];
      if (detail['_t_Apartment / Unit / Suite number']) {
        record.address = (record.address || '') + ', ' + detail['_t_Apartment / Unit / Suite number'];
      }

      if (detail['_t_Number of bedrooms']) {
        record.bedrooms = parseInt(detail['_t_Number of bedrooms']) || null;
      }
      if (detail['_t_Square Footage']) {
        // Convert ft² to m² (1 ft² = 0.0929 m²)
        const sqft = parseFloat(detail['_t_Square Footage'].replace(/[^0-9.]/g, ''));
        if (sqft) record.size_m2 = Math.round(sqft * 0.0929 * 100) / 100;
      }
      if (detail['_t_Occupation without supplement']) {
        const match = detail['_t_Occupation without supplement'].match(/(\d+)/);
        if (match) record.max_guests = parseInt(match[1]);
      }

      // Count bathrooms from bedroom details (look for "bathroom" mentions)
      let bathrooms = 0;
      for (const [k, v] of Object.entries(detail)) {
        if (k.includes('bathroom') || (typeof v === 'string' && v.toLowerCase().includes('bathroom'))) {
          bathrooms++;
        }
      }
      if (bathrooms > 0) record.bathrooms = bathrooms;

      // Count beds
      let beds = 0;
      for (const [k, v] of Object.entries(detail)) {
        if (k.startsWith('_t_Bedroom')) {
          const bedMatch = (v || '').match(/(\d+)x/);
          if (bedMatch) beds += parseInt(bedMatch[1]);
          else beds += 1; // "Double bed" = 1 bed
        }
      }
      if (beds > 0) record.beds = beds;

      if (detail['ESTADO_CD']) {
        const statusMap = { 'DISPONIBLE': 'Active', 'BAJA': 'Deactivated', 'NODISPONIBLE': 'Inactive' };
        record.status = statusMap[detail['ESTADO_CD']] || detail['ESTADO_CD'];
      }
    }

    if (entityType === 'bookings') {
      if (detail.fechaEntrada) record.check_in = detail.fechaEntrada.split(' ')[0];
      if (detail.fechaSalida) record.check_out = detail.fechaSalida.split(' ')[0];
      if (detail.idPropiedad || detail.idAlojamiento) {
        record.property_avantio_id = detail.idPropiedad || detail.idAlojamiento;
      }
      if (detail.amountHiddenCompPop1) record.amount = detail.amountHiddenCompPop1;
      if (detail['_t_Adults']) record.adults = parseInt(detail['_t_Adults']) || null;
      if (detail['_t_Children']) record.children = parseInt(detail['_t_Children']) || null;

      // Currency: 840 = USD, 978 = EUR, 032 = ARS
      const currMap = { '840': 'USD', '978': 'EUR', '032': 'ARS' };
      if (detail.currencyPago1) record.currency = currMap[detail.currencyPago1] || 'USD';
    }

    // Store ALL detail fields in raw_data for the frontend to display
    record._detail = detail;

    return record;
  }

  /**
   * Compute a short hash of text for change detection.
   */
  _hash(text) {
    return crypto.createHash('md5').update(text || '').digest('hex').substring(0, 12);
  }

  /**
   * Fetch existing records from our DB to diff against scraped data.
   * Returns a Map of avantio_id → { hash } for quick lookup.
   */
  async _fetchExistingRecords(entity) {
    try {
      const res = await fetch(`${LARAVEL_API_BASE}/${entity}`);
      if (!res.ok) return new Map();
      const body = await res.json();
      const records = body.data || body || [];
      const map = new Map();
      for (const r of records) {
        const hash = r.raw_data?._listHash || '';
        map.set(String(r.avantio_id), { hash, id: r.id });
      }
      log(`  [Diff] Fetched ${map.size} existing ${entity} from DB.`);
      return map;
    } catch (err) {
      log(`  [Diff] Could not fetch existing ${entity}: ${err.message}`);
      return new Map();
    }
  }

  /**
   * Diff scraped records against DB to find new/changed items.
   * Adds _listHash to each record for future comparison.
   * Returns { newRecords, changedRecords, unchangedCount }.
   */
  _diffRecords(scraped, existing) {
    const newRecords = [];
    const changedRecords = [];
    let unchangedCount = 0;

    for (const record of scraped) {
      const id = String(record.avantio_id || '');
      const hash = this._hash(record._rawText);
      record._listHash = hash;

      if (!id || !existing.has(id)) {
        newRecords.push(record);
      } else if (existing.get(id).hash !== hash) {
        changedRecords.push(record);
      } else {
        unchangedCount++;
      }
    }

    log(`  [Diff] New: ${newRecords.length}, Changed: ${changedRecords.length}, Unchanged: ${unchangedCount}`);
    return { newRecords, changedRecords, unchangedCount };
  }

  /**
   * Clear filters on the bookings page to show all bookings.
   * The dashboard link navigates with date/status filters. We need to remove them.
   */
  async _clearBookingFilters() {
    try {
      // Strategy 1: Look for a "clear filters" or "reset" button in the shadow DOM
      const cleared = await this.page.evaluate(() => {
        const wc = document.querySelector('avantio-bookings-list');
        if (!wc || !wc.shadowRoot) return false;
        const shadow = wc.shadowRoot;

        // Look for clear/reset buttons
        const buttons = shadow.querySelectorAll('button, a, [role="button"]');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes('clear') || text.includes('reset') || text.includes('limpiar') ||
              text.includes('borrar filtro') || text.includes('all') || text.includes('todos')) {
            btn.click();
            return true;
          }
        }

        // Look for a "select all" date range option
        const selects = shadow.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            if (opt.value === '' || opt.text.toLowerCase().includes('todo') || opt.text.toLowerCase().includes('all')) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }

        return false;
      });

      if (cleared) {
        log('  Filters cleared via shadow DOM controls.');
        return;
      }

      // Strategy 2: Navigate to bookings index without filters using URL manipulation
      // Try module=Compromisos&action=index (the main bookings page without filters)
      log('  No filter controls found. Trying direct navigation to unfiltered listing...');

      // Look for a menu link to the main bookings page (not the filtered dashboard link)
      const clicked = await this.page.evaluate(() => {
        // Check onclick handlers for an unfiltered bookings link
        const elements = document.querySelectorAll('[onclick*="redireccion"]');
        for (const el of elements) {
          const onclick = el.getAttribute('onclick') || '';
          if (onclick.includes('module=Compromisos') &&
              (onclick.includes('action=index') || onclick.includes('action=ListView')) &&
              !onclick.includes('fechaInicio')) {
            el.click();
            return true;
          }
        }
        // Check href links
        const links = document.querySelectorAll('a[href*="module=Compromisos"]');
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          if (href.includes('action=index') && !href.includes('fechaInicio')) {
            a.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
        log('  Navigated to unfiltered bookings page.');
      } else {
        log('  WARNING: Could not clear filters. Import may be incomplete.');
      }
    } catch (err) {
      log(`  Error clearing filters: ${err.message}`);
    }
  }

  /**
   * Scroll down repeatedly to trigger infinite scroll / lazy loading.
   * Keeps scrolling until no new cards appear.
   */
  async _scrollToLoadAll() {
    let previousCount = 0;
    let stableRounds = 0;
    const maxScrolls = 30;

    for (let i = 0; i < maxScrolls; i++) {
      // Count items: Playwright locators + shadow DOM rows
      let cardCount = 0;
      for (const sel of ['.alib-vertical-card', '.alib-row-list__item', '.alib-horizontal-card', '.alib-list-item', '[data-testid="row"]', '[data-testid="row-list"]']) {
        const c = await this.page.locator(sel).count().catch(() => 0);
        if (c > cardCount) cardCount = c;
      }
      // Also check shadow DOM row count
      const shadowCount = await this.page.evaluate(() => {
        for (const sel of ['avantio-bookings-list', 'avantio-accommodations-list']) {
          const wc = document.querySelector(sel);
          if (wc && wc.shadowRoot) {
            return wc.shadowRoot.querySelectorAll('[data-testid="row-list"], [role="row"], tr').length;
          }
        }
        return 0;
      }).catch(() => 0);
      if (shadowCount > cardCount) cardCount = shadowCount;
      log(`  Scroll ${i + 1}: ${cardCount} cards visible`);

      if (cardCount === previousCount) {
        stableRounds++;
        if (stableRounds >= 3) {
          log(`  Card count stable at ${cardCount}, stopping scroll.`);
          break;
        }
      } else {
        stableRounds = 0;
      }
      previousCount = cardCount;

      // Scroll to bottom
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // Also try scrolling inside the web component's shadow root container
      await this.page.evaluate(() => {
        const wc = document.querySelector('avantio-accommodations-list');
        if (wc && wc.shadowRoot) {
          const scrollable = wc.shadowRoot.querySelector('[class*="scroll"], [class*="content"], [style*="overflow"]');
          if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
        }
      });
      await delay(2000);
    }
  }

  /**
   * Legacy fallback: scrape standard HTML tables.
   */
  async _scrapeTableFromDom() {
    return this.page.evaluate(() => {
      const table = document.querySelector('table.listado, table.list, table#listado, table.dataTable, table.wListView');
      if (!table) return [];

      const headers = Array.from(table.querySelectorAll('thead th, thead td')).map(
        (th) => th.textContent.trim()
      );

      const rows = [];
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
        if (cells.length === 0) return;

        const row = {};
        cells.forEach((cell, i) => {
          const key = headers[i] || `col_${i}`;
          row[key] = cell;
        });

        const id = tr.getAttribute('data-id') || tr.getAttribute('id');
        if (id) row._rowId = id;

        rows.push(row);
      });
      return rows;
    });
  }

  /**
   * POST extracted records to the Laravel import API.
   */
  async _postToLaravel(entity, records) {
    if (!records || records.length === 0) {
      log(`No records to send for ${entity}.`);
      return;
    }

    log(`Sending ${records.length} ${entity} records to Laravel API...`);

    try {
      const response = await fetch(`${LARAVEL_API}/${entity}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ data: records }),
      });

      if (!response.ok) {
        log(`Laravel API responded with ${response.status} for ${entity}.`);
      } else {
        const result = await response.json();
        log(`Laravel API accepted ${entity}: ${JSON.stringify(result)}`);
      }
    } catch (err) {
      log(`Failed to POST ${entity} to Laravel: ${err.message}`);
      // Don't throw — we still want to continue the import
    }
  }
}

module.exports = { AvantioScraper };
