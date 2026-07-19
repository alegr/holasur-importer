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
// POST /import/start
// Launch a visible Chromium browser and navigate to Avantio login page.
// ---------------------------------------------------------------------------
app.post('/import/start', async (req, res) => {
  try {
    const sessionId = crypto.randomUUID();
    log(`[${sessionId}] Launching browser...`);

    // Use persistent context to preserve cookies/session across restarts
    const userDataDir = '/tmp/holasur-browser-data';
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--start-maximized'],
      viewport: null,
      acceptDownloads: false,
    });
    const browser = context; // persistent context acts as both browser and context

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

    // Navigate to the root — it should redirect to dashboard if logged in
    log(`[${sessionId}] Navigating to ${AVANTIO_URL}...`);
    await page.goto(AVANTIO_URL, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 3000));

    // If we ended up on a non-dashboard page (persistent context), force go to dashboard
    const currentUrl = page.url();
    if (!currentUrl.includes('module=Home') && !currentUrl.includes('action=Login')) {
      log(`[${sessionId}] Not on dashboard (${currentUrl.substring(0, 60)}...), navigating to Home...`);
      // Click the home/logo link if available, or use a known avs token
      const homeLink = await page.$('a[href*="module=Home"][href*="action=index"]');
      if (homeLink) {
        await homeLink.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
    // Give the dashboard time to fully render (web components, menus, widgets)
    await new Promise(r => setTimeout(r, 8000));

    // Start watching for login in the background
    scraper.waitForLogin().then((loggedIn) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.status = loggedIn ? 'logged_in' : 'error';
        if (!loggedIn) session.error = 'Login timed out.';
      }
    });

    res.json({ sessionId, status: 'waiting_for_login' });
  } catch (err) {
    log(`Error starting session: ${err.message}`);
    res.status(500).json({ error: err.message });
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
    log(`[${sessionId}] Import finished: ${JSON.stringify(results)}`);
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    log(`[${sessionId}] Import error: ${err.message}`);
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
    properties: () => scraper.importProperties(),
    customers: () => scraper.importCustomers(),
    bookings: () => scraper.importBookings(),
    tasks: () => scraper.importTasks(),
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
