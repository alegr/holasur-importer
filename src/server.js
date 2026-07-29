require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const { AvantioScraper } = require('./avantio-scraper');
const { log } = require('./utils');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// CORS — allow the Vue frontend (localhost:5173) to call this service
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = 3100;
const AVANTIO_URL = 'https://app.avantio.pro';

// Active sessions: sessionId -> { browser, context, page, scraper, status }
const sessions = new Map();

// ---------------------------------------------------------------------------
// GET /import/active
// Return the current active session if one exists and is usable.
// ---------------------------------------------------------------------------
app.get('/import/active', (req, res) => {
  for (const [sessionId, session] of sessions) {
    const status = session.scraper.status !== 'initialized'
      ? session.scraper.status
      : session.status;
    if (status === 'logged_in' || status === 'done') {
      return res.json({ sessionId, status, active: true });
    }
  }
  res.json({ active: false });
});

// ---------------------------------------------------------------------------
// POST /import/start
// Launch a visible Chromium browser and navigate to Avantio login page.
// ---------------------------------------------------------------------------
app.post('/import/start', async (req, res) => {
  try {
    const sessionId = crypto.randomUUID();
    log(`[${sessionId}] Launching browser...`);

    // Close any existing sessions first — only one browser at a time
    for (const [oldId, oldSession] of sessions) {
      try {
        log(`[${oldId}] Closing previous session...`);
        await oldSession.browser.close();
      } catch { /* ignore */ }
      sessions.delete(oldId);
    }

    // Persistent user data in home directory (NOT /tmp — survives restarts)
    const os = require('os');
    const path = require('path');
    const userDataDir = path.join(os.homedir(), '.holasur-browser');

    // Ensure directory exists and clear stale lock files
    const fs = require('fs');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    const lockFile = `${userDataDir}/SingletonLock`;
    if (fs.existsSync(lockFile)) {
      log('Removing stale browser lock file...');
      fs.unlinkSync(lockFile);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: [
        '--window-size=900,700',
        '--window-position=100,100',
        // Use the profile directory for password storage (not mock keychain)
        '--password-store=basic',
        '--enable-features=PasswordManager,PasswordManagerOnboarding',
      ],
      viewport: { width: 880, height: 650 },
      acceptDownloads: true,
    });
    const browser = context;

    const page = context.pages()[0] || await context.newPage();
    const scraper = new AvantioScraper(page);

    sessions.set(sessionId, {
      browser,
      context,
      page,
      scraper,
      status: 'waiting_for_login',
      error: null,
    });

    // Respond immediately — navigation and login detection happen in the background
    res.json({ sessionId, status: 'waiting_for_login' });

    // Navigate to Avantio in the background
    log(`[${sessionId}] Navigating to ${AVANTIO_URL}...`);
    await page.goto(AVANTIO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      log(`[${sessionId}] Navigation error (continuing): ${e.message}`);
    });
    // Brief wait for JS redirects
    await new Promise(r => setTimeout(r, 2000));
    await page.waitForLoadState('load').catch(() => {});

    const finalUrl = page.url();
    log(`[${sessionId}] Settled on: ${finalUrl.substring(0, 80)}`);

    // Start watching for login
    // Dashboard token harvesting happens AFTER login is detected (not before)
    scraper.waitForLogin().then(async (loggedIn) => {
      const session = sessions.get(sessionId);
      if (!session) return;

      if (!loggedIn) {
        session.status = 'error';
        session.error = 'Login timed out.';
        return;
      }

      // Now that we're logged in, wait for dashboard to fully render
      log(`[${sessionId}] Logged in, loading dashboard...`);
      const { extractAvsFromHtml } = require('./utils');
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const html = await page.content().catch(() => '');
        const tokens = extractAvsFromHtml(html);
        if (tokens.size >= 10) {
          log(`[${sessionId}] Dashboard ready with ${tokens.size} avs tokens.`);
          break;
        }
      }
      // Minimize the Avantio browser so focus returns to the HolaSur app
      log(`[${sessionId}] Minimizing browser window...`);
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Browser.setWindowBounds', {
          windowId: (await cdp.send('Browser.getWindowForTarget')).windowId,
          bounds: { windowState: 'minimized' },
        });
      } catch {
        // Fallback: just navigate away focus
        log(`[${sessionId}] CDP minimize failed, trying JS blur...`);
        await page.evaluate(() => window.blur()).catch(() => {});
      }

      session.status = 'logged_in';
    });
  } catch (err) {
    log(`Error starting session: ${err.message}`);
    // Only send error if we haven't responded yet
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/status
// Return the current status of a session.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  // Prefer the scraper's status if it has been updated
  const status = session.scraper.status !== 'initialized'
    ? session.scraper.status
    : session.status;

  res.json({
    sessionId,
    status,
    importResults: session.scraper.importResults,
    error: session.error,
  });
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/run
// Trigger the full import sequence. Only works after login.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/run', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  const currentStatus = session.scraper.status !== 'initialized'
    ? session.scraper.status
    : session.status;

  if (currentStatus !== 'logged_in') {
    return res.status(400).json({
      error: `Cannot run import: current status is "${currentStatus}". User must be logged in first.`,
    });
  }

  // Respond immediately — the import runs in the background
  res.json({ sessionId, status: 'importing', message: 'Import started.' });

  // Run the import asynchronously
  try {
    session.status = 'importing';
    const results = await session.scraper.runFullImport();
    session.status = 'done';
    log(`[${sessionId}] Import finished: ${JSON.stringify(results)}. Closing browser.`);
    setTimeout(async () => {
      try { await session.browser.close(); } catch {}
      sessions.delete(sessionId);
    }, 2000);
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    log(`[${sessionId}] Import error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/import/:entity
// Import a single entity type. Allows importing from within each section.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/import/:entity', async (req, res) => {
  const { sessionId, entity } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  const currentStatus = session.scraper.status !== 'initialized'
    ? session.scraper.status
    : session.status;

  if (currentStatus !== 'logged_in' && currentStatus !== 'done') {
    return res.status(400).json({
      error: `Cannot import: status is "${currentStatus}". Login required.`,
    });
  }

  const methods = {
    properties: () => session.scraper.importPropertiesCSV(),
    bookings: () => session.scraper.importBookingsCSV(),
    owners: () => session.scraper.importOwners(),
    customers: () => session.scraper.importCustomers(),
    tasks: () => session.scraper.importTasks(),
    payments_received: () => session.scraper.importPaymentsReceived(),
    payments_made: () => session.scraper.importPaymentsMade(),
    payments_pending: () => session.scraper.importPaymentsToMake(),
    payments_outstanding: () => session.scraper.importPaymentsOutstanding(),
  };

  if (!methods[entity]) {
    return res.status(400).json({ error: `Unknown entity: ${entity}` });
  }

  res.json({ sessionId, entity, status: 'importing' });

  try {
    session.status = 'importing';
    session.scraper.status = 'importing';
    await methods[entity]();
    session.status = 'done';
    session.scraper.status = 'done';
    log(`[${sessionId}] ${entity} import finished.`);
    // Don't auto-close — session stays available for more imports
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    log(`[${sessionId}] ${entity} import error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/sync
// Quick sync — only re-imports properties and bookings.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/sync', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  const currentStatus = session.scraper.status !== 'initialized'
    ? session.scraper.status
    : session.status;

  if (currentStatus !== 'logged_in' && currentStatus !== 'done') {
    return res.status(400).json({
      error: `Cannot sync: current status is "${currentStatus}". User must be logged in first.`,
    });
  }

  res.json({ sessionId, status: 'importing', message: 'Quick sync started.' });

  try {
    session.status = 'importing';
    const results = await session.scraper.runQuickSync();
    session.status = 'done';
    log(`[${sessionId}] Quick sync finished: ${JSON.stringify(results)}`);
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    log(`[${sessionId}] Quick sync error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/scrape
// Scrape data from the current page using Playwright locators (pierce shadow DOM).
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/scrape', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const page = session.page;
    await new Promise(r => setTimeout(r, 3000));

    const result = {};

    // Use Playwright locators which automatically pierce shadow DOMs
    // Get the full text content and inner HTML of the web component
    const wcSelectors = [
      'avantio-accommodations-list',
      'avantio-bookings-list',
      'avantio-owners-list',
    ];

    for (const sel of wcSelectors) {
      const loc = page.locator(sel);
      if (await loc.count() > 0) {
        const text = await loc.textContent({ timeout: 5000 }).catch(() => '');
        const html = await loc.innerHTML({ timeout: 5000 }).catch(() => '');
        result[sel] = { textLength: text.length, htmlLength: html.length, textSample: text.substring(0, 500), htmlSample: html.substring(0, 3000) };
      }
    }

    // Also try generic: get all visible row-like elements inside the main content
    // Playwright's >> operator pierces shadow DOMs
    const rowTexts = [];
    try {
      // Try common row patterns inside shadow DOM
      for (const rowSel of ['avantio-accommodations-list >> .alib-vertical-card', 'avantio-accommodations-list >> [data-testid="vertical-card"]', 'avantio-accommodations-list >> div[class*="card"]:has(img)']) {
        const rowLoc = page.locator(rowSel);
        const count = await rowLoc.count();
        if (count > 0) {
          result[`rows_${rowSel.split('>>')[1].trim()}`] = { count };
          // Get first 5 rows for analysis
          for (let i = 0; i < Math.min(count, 5); i++) {
            const rowText = await rowLoc.nth(i).textContent({ timeout: 3000 }).catch(() => '');
            const rowHtml = await rowLoc.nth(i).innerHTML({ timeout: 3000 }).catch(() => '');
            rowTexts.push({ selector: rowSel, index: i, text: rowText.substring(0, 200), html: rowHtml.substring(0, 3000) });
          }
        }
      }
    } catch (e) {
      result._rowError = e.message;
    }
    result._rowSamples = rowTexts;

    // Also check pagination elements inside shadow DOM
    try {
      const paginationInfo = {};
      for (const pSel of [
        'avantio-accommodations-list >> button:has-text("Next")',
        'avantio-accommodations-list >> button:has-text("next")',
        'avantio-accommodations-list >> [class*="pagination"]',
        'avantio-accommodations-list >> [class*="paging"]',
        'avantio-accommodations-list >> [data-testid*="pagination"]',
        'avantio-accommodations-list >> [data-testid*="paging"]',
        'avantio-accommodations-list >> nav',
        'avantio-accommodations-list >> [class*="footer"]',
        'avantio-accommodations-list >> select',
      ]) {
        const loc = page.locator(pSel);
        const cnt = await loc.count().catch(() => 0);
        if (cnt > 0) {
          const txt = await loc.first().textContent({ timeout: 2000 }).catch(() => '');
          const html = await loc.first().innerHTML({ timeout: 2000 }).catch(() => '');
          paginationInfo[pSel.split('>> ')[1]] = { count: cnt, text: txt.substring(0, 200), html: html.substring(0, 500) };
        }
      }
      result._pagination = paginationInfo;
    } catch (e) {
      result._paginationError = e.message;
    }

    res.json({ sessionId, currentUrl: page.url(), result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/navigate
// Navigate to a specific module/action without importing.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/navigate', async (req, res) => {
  const { sessionId } = req.params;
  const { module: mod, action } = req.body || {};
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!mod || !action) return res.status(400).json({ error: 'Provide module and action in body.' });

  try {
    await session.scraper.navigateToModule(mod, action);
    res.json({ sessionId, navigatedTo: `${mod}:${action}`, currentUrl: session.page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/test/:entity
// Test import of a single entity type (owners, properties, customers, bookings, tasks)
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/test/:entity', async (req, res) => {
  const { sessionId, entity } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  const scraper = session.scraper;
  const methods = {
    owners: () => scraper.importOwners(),
    properties: () => scraper.importPropertiesCSV(),
    customers: () => scraper.importCustomers(),
    bookings: () => scraper.importBookingsCSV(),
    tasks: () => scraper.importTasks(),
    payments_received: () => scraper.importPaymentsReceived(),
    payments_made: () => scraper.importPaymentsMade(),
    payments_pending: () => scraper.importPaymentsToMake(),
    payments_outstanding: () => scraper.importPaymentsOutstanding(),
  };

  if (!methods[entity]) {
    return res.status(400).json({ error: `Unknown entity: ${entity}. Use: ${Object.keys(methods).join(', ')}` });
  }

  // Respond immediately
  res.json({ sessionId, entity, status: 'importing' });

  try {
    const records = await methods[entity]();
    // Log first 2 records as sample
    if (records.length > 0) {
      log(`[${sessionId}] Sample ${entity} record: ${JSON.stringify(records[0]).substring(0, 500)}`);
      if (records.length > 1) {
        log(`[${sessionId}] Sample ${entity} record 2: ${JSON.stringify(records[1]).substring(0, 500)}`);
      }
    }
    session.status = 'done';
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    log(`[${sessionId}] Test import error for ${entity}: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/debug
// Inspect the current page: URL, all links, avs tokens, menu structure.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/debug', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  try {
    const page = session.page;
    const currentUrl = page.url();

    // Extract all links and DOM structure info from the page
    const pageInfo = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (href && href.includes('module=')) {
          links.push({
            text: a.textContent.trim().substring(0, 80),
            href: href.substring(0, 300),
          });
        }
      });

      // Also look for menu items (onclick, data attributes, etc.)
      const menuItems = [];
      document.querySelectorAll('[data-module], [onclick*="module"], .menu-item, .nav-item, li.menu a, nav a, .sidebar a').forEach((el) => {
        menuItems.push({
          tag: el.tagName,
          text: el.textContent.trim().substring(0, 80),
          href: el.getAttribute('href') || '',
          onclick: (el.getAttribute('onclick') || '').substring(0, 200),
          dataModule: el.getAttribute('data-module') || '',
        });
      });

      // DOM structure analysis: find tables, grids, lists, web components
      const domAnalysis = {
        tables: Array.from(document.querySelectorAll('table')).map(t => ({
          id: t.id, classes: t.className, rows: t.querySelectorAll('tr').length,
          headers: Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.textContent.trim()).slice(0, 15),
        })),
        customElements: [...new Set(Array.from(document.querySelectorAll('*')).filter(e => e.tagName.includes('-')).map(e => e.tagName.toLowerCase()))],
        grids: Array.from(document.querySelectorAll('[class*="grid"], [class*="list"], [class*="card"], [role="grid"], [role="table"]')).map(g => ({
          tag: g.tagName, id: g.id, classes: g.className.substring(0, 100), children: g.children.length,
        })),
        bodyChildren: Array.from(document.body.children).slice(0, 10).map(c => ({
          tag: c.tagName, id: c.id, classes: (c.className || '').toString().substring(0, 80),
        })),
      };

      // Deep inspect web components - look inside shadow DOMs
      const webComponentDetails = {};
      document.querySelectorAll('avantio-accommodations-list, avantio-bookings-list, avantio-owners-list, avantio-customers-list').forEach(wc => {
        const tag = wc.tagName.toLowerCase();
        const info = { hasShadow: !!wc.shadowRoot, attributes: {} };
        for (const attr of wc.attributes) {
          info.attributes[attr.name] = attr.value.substring(0, 200);
        }
        // Check for data in properties
        if (wc._data) info.hasData = true;
        if (wc.data) info.hasDataProp = true;
        if (wc.items) info.hasItems = true;
        // Check shadow DOM content
        if (wc.shadowRoot) {
          info.shadowChildren = Array.from(wc.shadowRoot.children).map(c => ({
            tag: c.tagName, classes: (c.className || '').toString().substring(0, 80),
          }));
          info.shadowTables = wc.shadowRoot.querySelectorAll('table').length;
          info.shadowRows = wc.shadowRoot.querySelectorAll('tr, [class*="row"], [role="row"]').length;
          // Get text content sample
          info.shadowTextSample = wc.shadowRoot.textContent.substring(0, 500);
        }
        // Check light DOM
        info.innerHTML = wc.innerHTML.substring(0, 500);
        webComponentDetails[tag] = info;
      });
      domAnalysis.webComponentDetails = webComponentDetails;

      return { links, menuItems, title: document.title, domAnalysis };
    });

    // Harvest avs tokens
    const html = await page.content();
    const { extractAvsFromHtml } = require('./utils');
    const tokens = extractAvsFromHtml(html);
    const tokenEntries = {};
    for (const [k, v] of tokens) {
      tokenEntries[k] = typeof v === 'object' ? v.avs.substring(0, 30) + '...' : String(v).substring(0, 30) + '...';
    }

    res.json({
      currentUrl,
      pageTitle: pageInfo.title,
      linksWithModule: pageInfo.links.length,
      links: pageInfo.links.slice(0, 15),
      menuItems: pageInfo.menuItems.slice(0, 15),
      avsTokens: tokenEntries,
      domAnalysis: pageInfo.domAnalysis,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/detail/:entity
// Scrape detail page for a specific record. Body: { avantio_id: "123" }
// If no avantio_id provided, scrapes first item in the list.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/detail/:entity', async (req, res) => {
  const { sessionId, entity } = req.params;
  const avantioId = req.body?.avantio_id;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    let detail;
    if (avantioId) {
      detail = await session.scraper.scrapeRecordDetail(entity, avantioId);
    } else {
      detail = await session.scraper.importOneDetail(entity);
    }
    res.json({ entity, detail, status: detail ? 'done' : 'no_data' });
    // Auto-close browser after detail scrape
    if (detail) {
      setTimeout(async () => {
        try { await session.browser.close(); } catch {}
        sessions.delete(sessionId);
        log(`[${sessionId}] Browser closed after detail scrape.`);
      }, 2000);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/export-page
// Export data from a PHP page's Export/Excel link. Returns parsed rows.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/export-page', async (req, res) => {
  const { sessionId } = req.params;
  const linkText = req.body?.linkText || 'Excel';
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const page = session.page;

    // Open Export dropdown
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button'))
        if (btn.textContent.trim() === 'Export') { btn.click(); return; }
    });
    await new Promise(r => setTimeout(r, 1000));

    // Click the export link with download handler
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.evaluate((text) => {
        for (const a of document.querySelectorAll('a'))
          if (a.textContent.trim() === text) { a.click(); return true; }
        return false;
      }, linkText),
    ]);

    const fs = require('fs');
    const tmpFile = `/tmp/holasur-export-${Date.now()}.xls`;
    await download.saveAs(tmpFile);
    const content = fs.readFileSync(tmpFile, 'utf-8');
    const size = fs.statSync(tmpFile).size;

    // Parse the export — could be HTML table, CSV text, or XLS binary
    const rows = [];
    const headers = [];

    if (content.includes('<table') || content.includes('<tr')) {
      // HTML table format
      const trMatches = [...content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      if (trMatches.length > 0) {
        for (const m of trMatches[0][1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi))
          headers.push(m[1].replace(/<[^>]*>/g, '').trim());
        for (let i = 1; i < trMatches.length; i++) {
          const cells = [];
          for (const m of trMatches[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
            cells.push(m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim());
          if (cells.length >= 3) {
            const obj = {};
            headers.forEach((h, idx) => { if (h && cells[idx] !== undefined) obj[h] = cells[idx]; });
            rows.push(obj);
          }
        }
      }
    } else {
      // CSV/text format — use the scraper's CSV parser
      const parsed = session.scraper._parseCSV(content);
      if (parsed.length > 0) {
        Object.keys(parsed[0]).forEach(k => headers.push(k));
        rows.push(...parsed);
      }
    }

    // Keep debug copy
    const debugFile = `/tmp/holasur-export-debug-${Date.now()}.csv`;
    fs.copyFileSync(tmpFile, debugFile);
    log(`[${sessionId}] Debug copy: ${debugFile}`);
    fs.unlinkSync(tmpFile);
    log(`[${sessionId}] Exported ${rows.length} rows (${size} bytes, ${headers.length} columns)`);

    res.json({ rows: rows.length, headers, data: rows, size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/scrape-and-save/:entity
// Scrape the current page and POST to Laravel. No navigation.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/scrape-and-save/:entity', async (req, res) => {
  const { sessionId, entity } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const scraper = session.scraper;

    // Scrape from shadow DOM
    let records = await scraper._scrapeViaShadowRoot();
    log(`[${sessionId}] Scraped ${records.length} ${entity} records from current page.`);

    // Ensure avantio_id
    records = records.map((r, i) => {
      if (!r.avantio_id && r.reference) r.avantio_id = r.reference;
      if (!r.avantio_id) r.avantio_id = `${entity}-${Date.now()}-${i}`;
      return r;
    });

    // POST to Laravel
    await scraper._postToLaravel(entity, records);

    res.json({ entity, scraped: records.length, status: 'done' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /import/:sessionId/pages
// List all open pages/tabs in the browser context.
// ---------------------------------------------------------------------------
app.get('/import/:sessionId/pages', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const pages = session.context.pages();
  res.json({ count: pages.length, pages: pages.map((p, i) => ({ index: i, url: p.url().substring(0, 150), title: '' })) });
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/eval
// Run arbitrary JS in the page for debugging. Body: { code: "..." }
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/eval', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  try {
    const tabIndex = req.body.tab || 0;
    const pages = session.context.pages();
    const page = pages[tabIndex] || session.page;
    const result = await page.evaluate(new Function('return (' + req.body.code + ')()'));
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/stop
// Close the browser and clean up the session.
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/stop', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  try {
    log(`[${sessionId}] Closing browser...`);
    await session.browser.close();
  } catch (err) {
    log(`[${sessionId}] Error closing browser: ${err.message}`);
  }

  sessions.delete(sessionId);
  res.json({ sessionId, status: 'stopped' });
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  log(`HolaSur Importer service running on http://localhost:${PORT}`);
  log('Endpoints:');
  log('  POST /import/start           — launch browser');
  log('  POST /import/:id/status      — check status');
  log('  POST /import/:id/run         — start import (after login)');
  log('  POST /import/:id/stop        — close browser');
});

// ---------------------------------------------------------------------------
// POST /import/:sessionId/login
// Type Avantio credentials into the headless browser login form.
// Body: { email: "...", password: "..." } or { code: "..." } for 2FA
// ---------------------------------------------------------------------------
app.post('/import/:sessionId/login', async (req, res) => {
  const { sessionId } = req.params;
  const { email, password, code } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  try {
    const page = session.page;
    const url = page.url();

    if (code) {
      // 2FA code entry
      log(`[${sessionId}] Entering 2FA code...`);

      // Log the page state for debugging
      const pageUrl = page.url();
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '').catch(() => '');
      log(`[${sessionId}] 2FA page URL: ${pageUrl.substring(0, 120)}`);
      log(`[${sessionId}] 2FA page text: ${pageText.substring(0, 300)}`);

      // Dump all inputs on the page for debugging
      const inputInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
          visible: i.offsetParent !== null, autocomplete: i.autocomplete,
        }));
      }).catch(() => []);
      log(`[${sessionId}] Page inputs: ${JSON.stringify(inputInfo)}`);

      // Also check shadow DOM for inputs (Avantio uses web components)
      const shadowInputs = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) {
            el.shadowRoot.querySelectorAll('input').forEach(i => {
              results.push({
                host: el.tagName.toLowerCase(), type: i.type, name: i.name,
                id: i.id, placeholder: i.placeholder,
              });
            });
          }
        });
        return results;
      }).catch(() => []);
      if (shadowInputs.length) log(`[${sessionId}] Shadow DOM inputs: ${JSON.stringify(shadowInputs)}`);

      // Fill the OTP field via JS (Avantio's form can have visibility quirks)
      const filled = await page.evaluate((otpCode) => {
        // Try the known Avantio OTP field first
        let input = document.getElementById('otpToken');
        if (!input) input = document.querySelector('input[name*="otp"], input[name*="code"]');
        // Fallback: any visible text/number input
        if (!input) {
          const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"]');
          for (const inp of inputs) {
            if (inp.offsetParent !== null && inp.name !== 'user_name') { input = inp; break; }
          }
        }
        if (input) {
          input.value = otpCode;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return input.name || input.id || 'unknown';
        }
        return null;
      }, code).catch(() => null);

      if (filled) {
        log(`[${sessionId}] Filled 2FA code into field: ${filled}, clicking submit...`);
        // Avantio uses id="buttonSendOtpToken" with type="button" — use JS click
        // because Playwright's .click() fails visibility checks on this element
        const clicked = await page.evaluate(() => {
          const btn = document.getElementById('buttonSendOtpToken');
          if (btn) { btn.click(); return true; }
          const submit = document.querySelector('button[type="submit"], input[type="submit"]');
          if (submit) { submit.click(); return true; }
          return false;
        }).catch(() => false);
        if (clicked) {
          log(`[${sessionId}] Clicked 2FA submit via JS`);
        } else {
          log(`[${sessionId}] No submit button, submitting form via JS...`);
          await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.submit();
          }).catch(() => {});
        }
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));

        const newUrl = page.url();
        const loggedIn = await page.evaluate(() => {
          const url = new URL(window.location.href);
          const module = url.searchParams.get('module');
          return module === 'Home' || module === 'Dashboard' ||
            !!document.querySelector('avantio-menu') ||
            !!document.querySelector('#menu_lateral');
        }).catch(() => false);

        const errorMsg = await page.evaluate(() => {
          const el = document.querySelector('.error, .alert-danger, .text-danger, [class*="error"]');
          return el?.textContent?.trim() || null;
        }).catch(() => null);

        log(`[${sessionId}] After 2FA: ${newUrl.substring(0, 80)}, loggedIn=${loggedIn}, error=${errorMsg}`);
        if (loggedIn) {
          return res.json({ status: 'logged_in', url: newUrl.substring(0, 80) });
        }
        return res.json({ status: 'needs_2fa', url: newUrl.substring(0, 80), error: errorMsg || 'Código incorrecto' });
      }

      // Could not find any input — return screenshot for debugging
      log(`[${sessionId}] No 2FA input found on page`);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
      return res.json({
        status: 'needs_2fa',
        error: 'No se encontró el campo de verificación. Intentá de nuevo.',
        screenshot: screenshot ? `data:image/jpeg;base64,${screenshot.toString('base64')}` : null,
      });
    }

    if (email && password) {
      log(`[${sessionId}] Typing Avantio credentials...`);
      // Find and fill email field
      const emailInput = await page.waitForSelector('input[name="user_name"], input[type="email"], input[name="email"], input[type="text"]', { timeout: 10000 }).catch(() => null);
      if (!emailInput) return res.json({ status: 'error', error: 'Login form not found' });
      
      await emailInput.fill(email);
      
      // Find and fill password field
      const passInput = await page.$('input[type="password"], input[name="user_password"]');
      if (passInput) await passInput.fill(password);
      
      // Click submit
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], input[name="Login"], button:has-text("Log in"), button:has-text("Iniciar"), button:has-text("Acceder")');
      if (submitBtn) await submitBtn.click();
      
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      
      const newUrl = page.url();
      const loggedIn = await page.evaluate(() => {
        const url = new URL(window.location.href);
        const module = url.searchParams.get('module');
        return module === 'Home' || module === 'Dashboard' ||
          !!document.querySelector('avantio-menu') ||
          !!document.querySelector('#menu_lateral');
      }).catch(() => false);

      // Check if we're on the 2FA page
      const is2FA = !loggedIn && await page.evaluate(() => {
        const text = document.body?.textContent || '';
        return text.includes('Two-step authentication enabled') || text.includes('Enter verification code');
      }).catch(() => false);

      // Check for login error message (wrong credentials)
      const loginError = !loggedIn && !is2FA ? await page.evaluate(() => {
        const el = document.querySelector('.error, .alert-danger, .text-danger, [class*="error"], .login-error');
        return el?.textContent?.trim() || null;
      }).catch(() => null) : null;

      log(`[${sessionId}] After login: ${newUrl.substring(0, 80)}, loggedIn=${loggedIn}, is2FA=${is2FA}, error=${loginError}`);

      return res.json({
        status: loggedIn ? 'logged_in' : is2FA ? 'needs_2fa' : 'needs_login',
        url: newUrl.substring(0, 80),
        error: loginError || (!loggedIn && !is2FA ? 'Usuario o contraseña incorrectos' : undefined),
      });
    }

    // No credentials — just return current state + screenshot
    const isLoggedIn = await page.evaluate(() => {
      const url = new URL(window.location.href);
      const module = url.searchParams.get('module');
      return module === 'Home' || module === 'Dashboard' ||
        !!document.querySelector('avantio-menu') ||
        !!document.querySelector('#menu_lateral');
    }).catch(() => false);
    return res.json({
      status: isLoggedIn ? 'logged_in' : 'needs_login',
      url: url.substring(0, 80),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
