// ══════════════════════════════════════════════════════════════
// LeadHunter v3 — background service worker
//
// Every request to Apps Script happens HERE, not in the content
// script. In Manifest V3 a content script inherits the page's
// origin (https://www.google.com) and is subject to CORS, but the
// service worker fetches under the extension's own origin and the
// "host_permissions" entries for script.google.com grant it a
// straight cross-origin pass. No preflight, no CORS error, and
// nothing for you to configure on the Apps Script side.
// ══════════════════════════════════════════════════════════════

const ALLOWED = /^(https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?|https:\/\/onyx-crm\.edgeformmedia\.workers\.dev\/?$/);

async function callSheet(url, payload, timeoutMs) {
  if (!ALLOWED.test(String(url || '').trim())) {
    return { ok: false, error: 'That does not look like an ONYX CRM or Apps Script URL.' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);

  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      // text/plain keeps this a "simple request". Even though the worker
      // isn't CORS-bound, Apps Script rejects an OPTIONS preflight outright,
      // so avoiding application/json keeps the redirect chain clean.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'          // Apps Script 302s to script.googleusercontent.com
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Sheet replied ${res.status}. ${short(text)}` };

    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      if (/<html|accounts\.google\.com|sign in/i.test(text)) {
        return { ok: false, error: 'Got a Google sign-in page. Redeploy with access set to "Anyone".' };
      }
      return { ok: false, error: 'Sheet sent back something that is not JSON. ' + short(text) };
    }

    if (data && data.ok === false) return { ok: false, error: data.error || 'The script reported an error.' };
    return { ok: true, data };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'Timed out waiting for the sheet.' };
    return { ok: false, error: e.message || 'Network error reaching the sheet.' };
  } finally {
    clearTimeout(timer);
  }
}

const short = s => String(s || '').replace(/\s+/g, ' ').slice(0, 140);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return false;

  if (msg.type === 'LH3_DOWNLOAD') {
    const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(msg.csv);
    chrome.downloads.download({ url, filename: msg.filename, saveAs: false }, id => {
      if (chrome.runtime.lastError) reply({ ok: false, error: chrome.runtime.lastError.message });
      else reply({ ok: true, id });
    });
    return true;
  }

  if (msg.type === 'LH3_DOWNLOAD_JSON') {
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(msg.json || '{}');
    chrome.downloads.download({ url, filename: msg.filename || 'leadhunter-maps-probe.json', saveAs: false }, id => {
      if (chrome.runtime.lastError) reply({ ok: false, error: chrome.runtime.lastError.message });
      else reply({ ok: true, id });
    });
    return true;
  }

  if (msg.type === 'LH3_SHEET') {
    callSheet(msg.url, msg.payload, msg.timeoutMs).then(reply);
    return true;
  }

  return false;
});
