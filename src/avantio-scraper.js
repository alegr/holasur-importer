const { parseAvantioResponse, extractAvsFromHtml, delay, log } = require('./utils');

const LARAVEL_API = 'http://localhost:8001/api/import';
const AVANTIO_BASE = 'https://app.avantio.pro';
const PAGE_SIZE = 30;
const NAV_DELAY = 2500; // ms between navigations

class AvantioScraper {
  /**
   * @param {import('playwright').Page} page - Playwright page instance
   */
  constructor(page) {
    this.page = page;
    this.avsTokens = new Map();
    this.status = 'initialized';
    this.importResults = {};
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
    log('Waiting for user to complete login...');
    this.status = 'waiting_for_login';

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const url = this.page.url();
        // After login Avantio typically redirects to module=Home
        if (url.includes('module=Home') || url.includes('module=Dashboard')) {
          log('Login detected via URL.');
          this.status = 'logged_in';
          return true;
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
          throw new Error(`Cannot navigate to ${key}: no avs token, no href link, no onclick handler found.`);
        }
      }
    }

    // Re-harvest tokens from the new page
    await this.harvestAvs();
    await delay(NAV_DELAY);
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
      await delay(NAV_DELAY);
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
  // Entity-specific import methods
  // ---------------------------------------------------------------------------

  async importOwners() {
    log('=== Importing Owners (Propietarios) ===');
    this.status = 'importing';
    await this.navigateToModule('Propietarios', 'ListView');
    // Owners may use card or table layout — try both
    await this._scrollToLoadAll();
    let records = await this._scrapeCardsFromPage();
    if (records.length === 0) {
      log('  No cards found for owners, trying table/list scrape...');
      records = await this.extractListData('Propietarios', 93);
    }
    await this._postToLaravel('owners', records);
    this.importResults.owners = records.length;
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
    await this._scrollToLoadAll();
    let records = await this._scrapeCardsFromPage();
    if (records.length === 0) {
      log('  No cards found for customers, trying table/AJAX scrape...');
      records = await this.extractListData('Compradores');
    }
    await this._postToLaravel('customers', records);
    this.importResults.customers = records.length;
    return records;
  }

  async importBookings() {
    log('=== Importing Bookings (Compromisos) ===');
    this.status = 'importing';
    await this.navigateToModule('Compromisos', 'ListView');
    // Bookings may use a different web component or table layout
    await this._scrollToLoadAll();
    let records = await this._scrapeCardsFromPage();
    if (records.length === 0) {
      log('  No cards found for bookings, trying table/AJAX scrape...');
      records = await this.extractListData('Compromisos');
    }
    await this._postToLaravel('bookings', records);
    this.importResults.bookings = records.length;
    return records;
  }

  async importTasks() {
    log('=== Importing Tasks (CompromisosExtras) ===');
    this.status = 'importing';
    await this.navigateToModule('CompromisosExtras', 'ListView');
    await this._scrollToLoadAll();
    let records = await this._scrapeCardsFromPage();
    if (records.length === 0) {
      log('  No cards found for tasks, trying table/AJAX scrape...');
      records = await this.extractListData('CompromisosExtras');
    }
    await this._postToLaravel('tasks', records);
    this.importResults.tasks = records.length;
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
      // Look for row elements inside the shadow DOM
      const rowSelectors = [
        '[class*="row-list"]',
        '[class*="row"][class*="item"]',
        '[role="row"]',
        'tr',
        '[class*="card"]',
        '[data-testid*="row"]',
        '[data-testid*="item"]',
      ];

      let rows = [];
      for (const sel of rowSelectors) {
        const found = shadow.querySelectorAll(sel);
        if (found.length > 0) {
          rows = found;
          break;
        }
      }

      rows.forEach(row => {
        const text = row.textContent.trim();
        if (!text || text.length < 10) return;
        // Skip header rows
        if (/^(Booking|Status|Reference|Guest|Date|Amount|Property)\b/i.test(text) && text.length < 100) return;

        const record = { _rawText: text.substring(0, 400) };

        // Extract from cells/columns
        const cells = row.querySelectorAll('td, [class*="cell"], [class*="col"]');
        cells.forEach((cell, i) => {
          const t = cell.textContent.trim();
          if (t) record[`col_${i}`] = t;
        });

        // Extract links for IDs
        const links = row.querySelectorAll('a[href]');
        links.forEach(a => {
          const href = a.getAttribute('href') || '';
          const recordMatch = href.match(/record=(\d+)/);
          if (recordMatch) record.avantio_id = recordMatch[1];
        });

        // Extract data attributes
        for (const attr of row.attributes || []) {
          if (attr.name.startsWith('data-')) {
            record[attr.name] = attr.value;
          }
        }

        // Try to parse common patterns from text
        const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          record.check_in = dateMatch[1];
          record.check_out = dateMatch[2];
        }

        const amountMatch = text.match(/[\d,.]+\s*[€$£]/);
        if (amountMatch) record.amount = amountMatch[0];

        const statusMatch = text.match(/\b(Confirmed|Pre-booking|Invoiced|Cancelled|Paid|Unpaid|Not Available|Owner Booking)\b/i);
        if (statusMatch) record.status = statusMatch[1];

        const refMatch = text.match(/\b([A-Z]+-\d+|LOC-\d+|\d{6,}-\d+)\b/);
        if (refMatch) record.reference = refMatch[0];

        records.push(record);
      });

      return records;
    });
  }

  /**
   * Scroll down repeatedly to trigger infinite scroll / lazy loading.
   * Keeps scrolling until no new cards appear.
   */
  async _scrollToLoadAll() {
    let previousCount = 0;
    let stableRounds = 0;
    const maxScrolls = 20;

    for (let i = 0; i < maxScrolls; i++) {
      // Count all possible item types
      let cardCount = 0;
      for (const sel of ['.alib-vertical-card', '.alib-row-list__item', '.alib-horizontal-card', '.alib-list-item', '[data-testid="row"]']) {
        const c = await this.page.locator(sel).count().catch(() => 0);
        if (c > cardCount) cardCount = c;
      }
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
