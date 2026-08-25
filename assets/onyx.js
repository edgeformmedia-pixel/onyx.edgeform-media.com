/* ONYX CRM — shared core, loaded by every page.
   Handles transport, the session, and the nav chrome. */

window.Onyx = (function () {
  'use strict';

  var CFG = window.ONYX_CONFIG || {};

  // Admin-tab overrides live per browser; config.js is the fallback.
  try {
    var saved = JSON.parse(localStorage.getItem('onyx_cfg') || '{}');
    for (var k in saved) if (saved[k]) CFG[k] = saved[k];
  } catch (e) { /* ignore */ }

  var token = localStorage.getItem('onyx_token') || '';
  var user = null;
  try { user = JSON.parse(localStorage.getItem('onyx_user') || 'null'); } catch (e) { }

  /* ── transport ──────────────────────────────────────────────
     text/plain keeps this a "simple request", so the browser skips
     the CORS preflight that Apps Script refuses to answer. */

  function sheet(action, payload) {
    if (!CFG.SHEET_URL) {
      return Promise.resolve({ ok: false, error: 'SHEET_URL is not set in assets/config.js.' });
    }
    var body = Object.assign({ action: action, secret: CFG.SHEET_SECRET, token: token }, payload || {});
    return fetch(CFG.SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.text(); })
      .then(function (txt) {
        var d;
        try { d = JSON.parse(txt); }
        catch (e) {
          return { ok: false, error: 'The sheet returned a page instead of data. Redeploy the Apps Script as a new version with access set to Anyone.' };
        }
        if (d && d.error === 'SESSION_EXPIRED') {
          clearSession();
          if (!/\/(signup|activate)\//.test(location.pathname) && location.pathname !== '/') {
            location.href = '/?expired=1';
          }
          return { ok: false, error: 'Your session expired. Sign in again.' };
        }
        return d;
      })
      .catch(function (e) { return { ok: false, error: 'Could not reach the sheet. ' + e.message }; });
  }

  function worker(action, payload) {
    if (!CFG.WORKER_URL) return Promise.resolve({ ok: false, error: 'WORKER_URL is not set.' });
    var body = Object.assign({ action: action, secret: CFG.WORKER_SECRET }, payload || {});
    return fetch(CFG.WORKER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: 'Could not reach the worker. ' + e.message }; });
  }

  /* ── session ────────────────────────────────────────────── */

  function setSession(t, u) {
    token = t; user = u;
    localStorage.setItem('onyx_token', t);
    localStorage.setItem('onyx_user', JSON.stringify(u));
  }
  function clearSession() {
    token = ''; user = null;
    localStorage.removeItem('onyx_token');
    localStorage.removeItem('onyx_user');
  }
  function signOut() {
    sheet('logout', {}).then(function () { clearSession(); location.href = '/'; });
  }

  // Every protected page calls this first.
  function requireAuth(then) {
    if (!token) { location.href = '/'; return; }
    sheet('me', {}).then(function (r) {
      if (!r.ok) { clearSession(); location.href = '/'; return; }
      user = r.user;
      localStorage.setItem('onyx_user', JSON.stringify(user));
      mountChrome();
      if (then) then(user);
    });
  }

  /* ── chrome ─────────────────────────────────────────────── */

  var NAV = [
    { href: '/home/', label: 'Home' },
    { href: '/pipeline/', label: 'Pipeline' },
    { href: '/calls/', label: 'Call list' },
    { href: '/email/', label: 'Email' },
    { href: '/admin/', label: 'Admin', adminOnly: true }
  ];

  function mountChrome() {
    var slot = document.getElementById('chrome');
    if (!slot || !user) return;
    var here = location.pathname.replace(/index\.html$/, '');

    slot.innerHTML =
      '<header class="top">' +
        '<a class="logo" href="/home/">ONYX</a>' +
        '<nav class="tabs">' +
          NAV.filter(function (n) { return !n.adminOnly || user.role === 'admin'; })
            .map(function (n) {
              return '<a class="tab' + (here.indexOf(n.href) === 0 ? ' active' : '') +
                '" href="' + n.href + '">' + n.label + '</a>';
            }).join('') +
        '</nav>' +
        '<div class="who"><span>' + esc(user.name) +
          (user.role === 'admin' ? ' <span class="tag">admin</span>' : '') +
        '</span><button class="link" id="onyxSignOut">Sign out</button></div>' +
      '</header>';

    document.getElementById('onyxSignOut').addEventListener('click', signOut);
  }

  /* ── helpers ────────────────────────────────────────────── */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function msg(id, text, kind) {
    var el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function qs(name) { return new URLSearchParams(location.search).get(name) || ''; }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms || 300); };
  }

  function scoreClass(n) {
    n = Number(n) || 0;
    return n >= 80 ? 'score hot' : n >= 60 ? 'score warm' : 'score';
  }

  function shortDate(v) {
    if (!v) return '';
    return String(v).slice(0, 10);
  }

  function saveLocalConfig(patch) {
    var cur = {};
    try { cur = JSON.parse(localStorage.getItem('onyx_cfg') || '{}'); } catch (e) { }
    for (var k in patch) cur[k] = patch[k];
    localStorage.setItem('onyx_cfg', JSON.stringify(cur));
    for (var j in patch) CFG[j] = patch[j];
  }

  return {
    cfg: CFG, sheet: sheet, worker: worker,
    setSession: setSession, clearSession: clearSession, signOut: signOut,
    requireAuth: requireAuth, mountChrome: mountChrome,
    user: function () { return user; },
    esc: esc, msg: msg, qs: qs, debounce: debounce,
    scoreClass: scoreClass, shortDate: shortDate, saveLocalConfig: saveLocalConfig
  };
})();
