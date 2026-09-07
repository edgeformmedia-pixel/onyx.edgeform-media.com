/****************************************************************
 * Onyx LeadHunter — Google Sheets backend
 *
 * SETUP (about two minutes)
 *  1. Make a new Google Sheet.
 *  2. Extensions ▸ Apps Script. Delete whatever is in Code.gs and
 *     paste this whole file in.
 *  3. Edit SHARED_SECRET below to any random string, then paste
 *     that same string into the extension.
 *  4. Deploy ▸ New deployment ▸ type "Web app".
 *       Execute as:      Me
 *       Who has access:  Anyone            ← must be "Anyone"
 *  5. Copy the /exec URL it gives you into the extension.
 *
 * Access "Anyone" means anyone with the URL can POST to it, which
 * is why SHARED_SECRET exists — requests without it are rejected.
 * Treat the URL and the secret like a password.
 ****************************************************************/

var SHARED_SECRET = 'change-me-to-something-random';

var SHEET_NAME = 'Leads';

var HEADERS = [
  'name', 'category', 'phone', 'website', 'street', 'city', 'state', 'zip',
  'rating', 'reviewCount', 'yearsInBusiness', 'openStatus',
  'mapsUrl', 'directionsUrl', 'googleSearchUrl',
  'isNationalChain', 'chainBrand', 'chainType', 'buyerType',
  'searchTerm', 'searchCity', 'page', 'stage', 'notes', 'scrapedAt',
  'email', 'emailSource', 'emailConfidence', 'emailCheckedAt'
];

/* ═══════════════════════════════════════════════════════════════
   WEB APP ENDPOINT
   ═══════════════════════════════════════════════════════════════ */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (body.secret !== SHARED_SECRET) {
      return json({ ok: false, error: 'Bad secret.' });
    }

    if (body.action === 'ping') {
      var s = sheet();
      return json({ ok: true, action: 'ping', sheet: s.getName(), rows: Math.max(0, s.getLastRow() - 1) });
    }

    if (body.action === 'append' || body.action === 'appendLeads') {
      return json(append(body.rows || []));
    }

    return json({ ok: false, error: 'Unknown action: ' + body.action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

// A GET in the browser is handy for confirming the deployment is live.
function doGet() {
  return json({ ok: true, service: 'Onyx LeadHunter', hint: 'POST with a secret to use this.' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════════════════════════════════════════════════════════
   APPEND
   ═══════════════════════════════════════════════════════════════ */

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(SHEET_NAME);
  if (!s) {
    s = ss.insertSheet(SHEET_NAME);
  }
  if (s.getLastRow() === 0) {
    s.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    s.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

// Phone is the strongest identity signal; fall back to name + city.
function keyOf(name, phone, city) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.length >= 10) return 'p:' + d.slice(-10);
  return 'n:' + String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '') +
    '|' + String(city || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function append(rows) {
  if (!rows.length) return { ok: true, added: 0, duplicates: 0, total: 0 };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);                     // two batches landing at once would corrupt the dedupe
  try {
    var s = sheet();
    var last = s.getLastRow();

    // Build the set of keys already in the sheet.
    var seen = {};
    if (last > 1) {
      var iName = HEADERS.indexOf('name'), iPhone = HEADERS.indexOf('phone'), iCity = HEADERS.indexOf('city');
      var existing = s.getRange(2, 1, last - 1, HEADERS.length).getValues();
      for (var i = 0; i < existing.length; i++) {
        seen[keyOf(existing[i][iName], existing[i][iPhone], existing[i][iCity])] = true;
      }
    }

    var out = [], dupes = 0;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || {};
      var k = keyOf(row.name, row.phone, row.city);
      if (seen[k]) { dupes++; continue; }
      seen[k] = true;

      var line = [];
      for (var h = 0; h < HEADERS.length; h++) {
        var v = row[HEADERS[h]];
        // Leading + or = would be read as a formula.
        if (typeof v === 'string' && /^[=+\-@]/.test(v)) v = "'" + v;
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }

    if (out.length) {
      s.getRange(s.getLastRow() + 1, 1, out.length, HEADERS.length).setValues(out);
    }

    return { ok: true, added: out.length, duplicates: dupes, total: Math.max(0, s.getLastRow() - 1) };
  } finally {
    lock.releaseLock();
  }
}

/* ═══════════════════════════════════════════════════════════════
   EMAIL FINDER
   Run findEmails() from the editor, or Triggers ▸ time-driven to
   let it grind through the list on its own. Apps Script kills any
   run at 6 minutes, so this stops at 4.5 and picks up next time.
   ═══════════════════════════════════════════════════════════════ */

var PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/team'];
var BUDGET_MS = 4.5 * 60 * 1000;

function findEmails() {
  var s = sheet();
  var last = s.getLastRow();
  if (last < 2) return;

  var iSite = HEADERS.indexOf('website') + 1;
  var iEmail = HEADERS.indexOf('email') + 1;
  var started = Date.now();
  var done = 0;

  var sites = s.getRange(2, iSite, last - 1, 1).getValues();
  var mails = s.getRange(2, iEmail, last - 1, 1).getValues();

  for (var i = 0; i < sites.length; i++) {
    if (Date.now() - started > BUDGET_MS) break;

    var site = String(sites[i][0] || '').trim();
    if (!site || String(mails[i][0] || '').trim()) continue;   // no site, or already checked

    var hit = scrapeSite(site);
    s.getRange(i + 2, iEmail, 1, 4).setValues([[
      hit.email, hit.source, hit.confidence, new Date().toISOString()
    ]]);
    done++;
    Utilities.sleep(400);                                       // be a polite visitor
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(done + ' sites checked', 'Onyx LeadHunter', 5);
}

function scrapeSite(site) {
  var base = site.replace(/\/+$/, '');
  var found = [];

  for (var p = 0; p < PATHS.length; p++) {
    var url = base + PATHS[p];
    var html = fetchQuiet(url);
    if (!html) continue;

    var hits = extractEmails(html, base);
    for (var h = 0; h < hits.length; h++) {
      hits[h].source = url;
      found.push(hits[h]);
    }
    // A named address on the homepage is as good as it gets — stop early.
    if (found.length && found[0].confidence === 'high') break;
  }

  if (!found.length) return { email: '', source: '', confidence: 'none' };

  found.sort(function (a, b) { return score(b) - score(a); });
  return found[0];
}

function fetchQuiet(url) {
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHunter/3.0)' }
    });
    if (res.getResponseCode() >= 400) return '';
    return res.getContentText();
  } catch (e) {
    return '';
  }
}

var JUNK = /(example|sentry|wixpress|godaddy|squarespace|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|\.css|\.js)$/i;
var ROLE = /^(info|contact|hello|hi|admin|office|frontdesk|front-desk|booking|appointments|reception|team|support|sales)@/i;

function extractEmails(html, base) {
  var out = [], seen = {};
  var domain = base.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();

  // mailto: links first — an author put those there deliberately.
  var mailto = html.match(/mailto:([^"'?>\s]+)/gi) || [];
  for (var i = 0; i < mailto.length; i++) {
    push(mailto[i].replace(/^mailto:/i, ''), true);
  }

  // Then loose text, including the "name (at) domain (dot) com" dodge.
  var plain = html.replace(/\s*\(\s*at\s*\)\s*/gi, '@').replace(/\s*\(\s*dot\s*\)\s*/gi, '.');
  var text = plain.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  for (var j = 0; j < text.length; j++) push(text[j], false);

  function push(raw, fromMailto) {
    var e = String(raw || '').trim().toLowerCase().replace(/[.,;:)\]]+$/, '');
    if (!e || e.length > 90 || seen[e]) return;
    if (!/^[^@]+@[^@]+\.[a-z]{2,}$/.test(e)) return;
    if (JUNK.test(e)) return;
    seen[e] = true;

    var host = e.split('@')[1];
    var onDomain = host === domain || host.indexOf('.' + domain) > -1 || domain.indexOf(host) > -1;
    var conf = 'low';
    if (onDomain && !ROLE.test(e)) conf = 'high';        // named person at their own domain
    else if (onDomain) conf = 'medium';                  // info@theirdomain.com
    else if (fromMailto) conf = 'medium';                // gmail address they published

    out.push({ email: e, confidence: conf, source: '', mailto: fromMailto });
  }

  return out;
}

function score(h) {
  var s = h.confidence === 'high' ? 100 : h.confidence === 'medium' ? 60 : 20;
  if (h.mailto) s += 10;
  if (/^(owner|founder|ceo|director|manager)@/i.test(h.email)) s += 15;
  return s;
}
