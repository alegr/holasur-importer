/**
 * Utility functions for the Avantio importer.
 */

/**
 * Parse an Avantio response body. Avantio serves JSON with content-type
 * text/html, so we need to handle that gracefully.
 *
 * @param {string} body - Raw response body text
 * @returns {object|null} Parsed JSON or null on failure
 */
function parseAvantioResponse(body) {
  if (!body || typeof body !== 'string') return null;

  // Trim any leading/trailing whitespace or BOM characters
  let cleaned = body.trim().replace(/^\uFEFF/, '');

  // Sometimes responses are wrapped in HTML tags — strip them
  cleaned = cleaned.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON within the string (e.g. embedded in HTML)
    const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Extract all avs tokens from URLs found in HTML (href attributes and
 * onclick="redireccion('url')" handlers).
 *
 * Avantio URLs contain both `module=X` and `return_module=Y`. We need the
 * actual module/action, not the return_* variants. We parse each URL's query
 * params properly instead of relying on regex capture order.
 *
 * @param {string} html - Raw HTML string
 * @returns {Map<string, string>} Map of "module:action" -> avs token
 */
function extractAvsFromHtml(html) {
  const tokens = new Map();

  // Collect all URLs from href="..." and onclick="redireccion('...')"
  const urls = [];
  const hrefPattern = /href=["']([^"']*index\.php\?[^"']*avs=[^"']*)/gi;
  const onclickPattern = /redireccion\(['"]([^"']*index\.php\?[^"']*avs=[^"']*)/gi;

  let match;
  while ((match = hrefPattern.exec(html)) !== null) urls.push(match[1]);
  while ((match = onclickPattern.exec(html)) !== null) urls.push(match[1]);

  for (const rawUrl of urls) {
    try {
      // Decode HTML entities only (keep percent-encoding intact for the URL)
      const decoded = rawUrl.replace(/&amp;/g, '&');
      const url = new URL(decoded, 'https://app.avantio.pro');
      const params = url.searchParams;

      const mod = params.get('module');
      const action = params.get('action');
      const avs = params.get('avs');

      if (mod && action && avs) {
        // Store the FULL original URL — the avs token is signed against
        // the complete URL including return_module, filters, etc.
        const fullUrl = new URL(decoded, 'https://app.avantio.pro').href;
        tokens.set(`${mod}:${action}`, { avs, fullUrl });
      }
    } catch {
      // Malformed URL — skip
    }
  }

  return tokens;
}

/**
 * Simple delay helper for rate-limiting between requests.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log a message with a timestamp prefix.
 *
 * @param {string} message
 */
function log(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

module.exports = {
  parseAvantioResponse,
  extractAvsFromHtml,
  delay,
  log,
};
