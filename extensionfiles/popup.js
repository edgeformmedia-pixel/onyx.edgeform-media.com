(function () {
  'use strict';

  const LH3 = window.LH3;
  const K_SET = 'lh3_settings', K_SEEN = 'lh3_seen', K_LEADS = 'lh3_leads', K_RUN = 'lh3_run';
  const $ = id => document.getElementById(id);
  const get = async (k, d) => { const o = await chrome.storage.local.get(k); return o[k] === undefined ? d : o[k]; };
  const fmt = n => Number(n).toLocaleString('en-US');

  let S = Object.assign({}, LH3.DEFAULT_SETTINGS);
  const save = () => chrome.storage.local.set({ [K_SET]: S });

  function msg(text, kind) {
    const el = $('msg');
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ── chip lists ───────────────────────────────────────────────

  function renderChips(key, listId, emptyId) {
    const list = $(listId);
    list.textContent = '';
    (S[key] || []).forEach((val, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = val;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '\u00d7';
      rm.title = `Remove ${val}`;
      rm.setAttribute('aria-label', `Remove ${val}`);
      rm.addEventListener('click', () => {
        S[key].splice(i, 1); save(); renderChips(key, listId, emptyId); renderSummary();
      });
      li.append(span, rm);
      list.appendChild(li);
    });
    if (emptyId) $(emptyId).hidden = (S[key] || []).length > 0;
  }

  function addChip(key, inputId, listId, emptyId, lower) {
    const input = $(inputId);
    const raw = input.value.trim();
    if (!raw) return;
    const v = lower ? raw.toLowerCase() : raw;
    if (!Array.isArray(S[key])) S[key] = [];
    if (S[key].includes(v)) { msg(`"${v}" is already on the list`, 'warn'); input.select(); return; }
    S[key].push(v);
    input.value = '';
    input.focus();
    msg('');
    save(); renderChips(key, listId, emptyId); renderSummary();
  }

  function renderSummary() {
    const t = (S.terms || []).length;
    const c = (S.cities || []).length;
    const p = Math.max(1, Number(S.pagesPerQuery) || 1);
    $('sumTerms').textContent = fmt(t);
    $('sumCities').textContent = fmt(c);
    $('sumPages').textContent = fmt(t * c * p);
  }

  async function renderCounts() {
    const seen = await get(K_SEEN, []);
    const leads = await get(K_LEADS, []);
    $('seenCount').textContent = fmt(seen.length);
    $('leadCount').textContent = fmt(leads.length);
    $('download').disabled = leads.length === 0;
  }

  // ── tab state ────────────────────────────────────────────────

  const isGoogle = url => /^https:\/\/www\.google\.com\/(?:search|maps)/.test(url || '');
  const isLocal = url => /^https:\/\/www\.google\.com\/maps/.test(url || '');

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function setPill(text, cls) {
    const p = $('pill');
    p.textContent = text;
    p.className = 'pill' + (cls ? ' ' + cls : '');
  }

  async function refreshState() {
    const tab = await activeTab();
    const ok = isGoogle(tab && tab.url);
    const run = await get(K_RUN, null);
    const active = !!(run && run.active);

    $('stop').hidden = !active;
    $('start').hidden = active;
    $('start').disabled = !ok;
    $('scan').disabled = !ok || active;

    if (active) {
      setPill('Running', 'live');
      $('where').textContent =
        `Search ${fmt(run.idx + 1)} of ${fmt(run.plan.length)} · ${fmt(run.total)} of ${fmt(run.limit)} leads. Leave Google Maps open.`;
    } else if (ok && isLocal(tab.url)) {
      setPill('Ready');
      $('where').textContent = 'On Google Maps. Start the sweep or scan this Maps search.';
    } else if (ok) {
      setPill('Ready');
      $('where').textContent = 'On Google. Start the sweep and LeadHunter will switch to Google Maps.';
    } else {
      setPill('No Google tab', 'off');
      $('where').textContent = 'Not on Google yet — open Google Maps or Google Search to get going.';
    }
    $('openSearch').hidden = active;
  }

  async function send(type) {
    const tab = await activeTab();
    if (!isGoogle(tab && tab.url)) { msg('That tab is not Google Search.', 'warn'); return null; }
    try {
      return await chrome.tabs.sendMessage(tab.id, { type });
    } catch (e) {
      msg('Reload the Google tab once so the extension can attach, then try again.', 'warn');
      return null;
    }
  }

  // ── init ─────────────────────────────────────────────────────

  // Clicking the toolbar icon lands you here; if you're not already on a
  // Google search we open one so Start is usable immediately.
  async function openSearchTab(explicit) {
    const term = (S.terms || [])[0] || 'med spa';
    const city = (S.cities || [])[0] || '';
    const q = [term, city].filter(Boolean).join(' ');
    const url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);

    const tab = await activeTab();
    if (tab && isGoogle(tab.url) && !explicit) return tab;

    // Reuse a Google tab if one is already open rather than piling up new ones.
    const [existing] = await chrome.tabs.query({ url: ['https://www.google.com/maps*','https://www.google.com/search*'], currentWindow: true });
    if (existing && !explicit) {
      await chrome.tabs.update(existing.id, { active: true });
      return existing;
    }

    const created = await chrome.tabs.create({ url, active: true });
    msg(`Opened Google Maps for "${q}".`, 'good');
    return created;
  }

  function sheetState(text, kind) {
    const el = $('sheetState');
    el.textContent = text;
    el.className = 'hint' + (kind ? ' ' + kind : '');
  }

  async function testSheet() {
    const url = $('sheetUrl').value.trim();
    const secret = $('sheetSecret').value.trim();
    if (!url) { sheetState('Paste the /exec URL first.', 'bad'); return; }

    S.sheetUrl = url; S.sheetSecret = secret; save();
    sheetState('Checking…');
    $('testSheet').disabled = true;

    const res = await chrome.runtime.sendMessage({
      type: 'LH3_SHEET', url, payload: { action: 'ping', secret }, timeoutMs: 20000
    });
    $('testSheet').disabled = false;

    if (res && res.ok) {
      const d = res.data || {};
      sheetState(`Connected to "${d.sheet || 'Leads'}" · ${fmt(d.rows || 0)} rows already there.`, 'ok');
    } else {
      sheetState((res && res.error) || 'No reply from the sheet.', 'bad');
    }
  }

  async function init() {
    S = Object.assign({}, LH3.DEFAULT_SETTINGS, await get(K_SET, {}));
    if (!Array.isArray(S.terms)) S.terms = [...LH3.DEFAULT_SETTINGS.terms];
    if (!Array.isArray(S.cities)) S.cities = [...LH3.DEFAULT_SETTINGS.cities];

    renderChips('terms', 'termList', 'termEmpty');
    renderChips('cities', 'cityList', null);

    $('limit').value = S.limit;
    $('pagesPerQuery').value = S.pagesPerQuery;
    $('minDelayMs').value = S.minDelayMs;
    $('maxDelayMs').value = S.maxDelayMs;
    $('sheetUrl').value = S.sheetUrl || '';
    $('sheetSecret').value = S.sheetSecret || '';
    $('syncToSheet').checked = !!S.syncToSheet;
    $('downloadCsv').checked = S.downloadCsv !== false;
    $('sheetFields').hidden = !S.syncToSheet;
    sheetState(S.sheetUrl ? 'Saved. Hit Test connection to be sure.' : 'Not connected yet.');

    $('requirePhone').checked = S.requirePhone !== false;
    $('skipChains').checked = !!S.skipChains;
    $('skipSeen').checked = S.skipSeen !== false;

    renderSummary();
    renderCounts();
    refreshState();

    $('addTerm').addEventListener('click', () => addChip('terms', 'termInput', 'termList', 'termEmpty', true));
    $('termInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addChip('terms', 'termInput', 'termList', 'termEmpty', true); }
    });
    $('addCity').addEventListener('click', () => addChip('cities', 'cityInput', 'cityList', null, false));
    $('cityInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addChip('cities', 'cityInput', 'cityList', null, false); }
    });

    const num = (id, lo, hi, after) => $(id).addEventListener('change', () => {
      S[id] = Math.max(lo, Math.min(hi, parseInt($(id).value, 10) || lo));
      $(id).value = S[id]; save(); if (after) after();
    });
    num('limit', 1, 100000);
    num('pagesPerQuery', 1, 10, renderSummary);
    num('minDelayMs', 300, 60000);
    num('maxDelayMs', 300, 60000);

    const text = id => $(id).addEventListener('change', () => {
      S[id] = $(id).value.trim(); save();
      if (id === 'sheetUrl') sheetState('Saved. Hit Test connection to be sure.');
    });
    text('sheetUrl');
    text('sheetSecret');

    const tog = id => $(id).addEventListener('change', () => { S[id] = $(id).checked; save(); });
    tog('syncToSheet');
    $('syncToSheet').addEventListener('change', () => { $('sheetFields').hidden = !$('syncToSheet').checked; });
    tog('downloadCsv');
    tog('requirePhone');
    tog('skipChains');
    tog('skipSeen');

    $('forget').addEventListener('click', async () => {
      await chrome.storage.local.set({ [K_SEEN]: [] });
      msg('History cleared — nothing will be treated as a repeat.', 'good');
      renderCounts();
    });

    $('start').addEventListener('click', async () => {
      msg('');
      const r = await send('LH3_START');
      if (!r) return;
      if (!r.ok) { msg(r.error, 'warn'); return; }
      msg(`Sweeping ${fmt(r.steps)} search combinations. Leave Google Maps open.`, 'good');
      refreshState();
    });

    $('stop').addEventListener('click', async () => {
      await send('LH3_STOP');
      msg('Stopped. Check your Downloads folder.', 'good');
      refreshState(); renderCounts();
    });

    $('scan').addEventListener('click', async () => {
      msg('');
      const r = await send('LH3_SCAN');
      if (r) { msg('Scanned the current page.', 'good'); renderCounts(); }
    });

    $('probe').addEventListener('click', async () => {
      msg('Running probe: results → scroll → click → detail elements…');
      $('probe').disabled = true;
      const r = await send('LH3_PROBE');
      $('probe').disabled = false;
      if (!r) return;
      if (!r.ok) { msg(r.error || 'Probe failed.', 'warn'); return; }
      msg(`Probe complete — tested ${r.places || 0} businesses. JSON downloaded.`, 'good');
    });

    $('download').addEventListener('click', async () => {
      const leads = await get(K_LEADS, []);
      if (!leads.length) { msg('No leads stored yet.', 'warn'); return; }
      const res = await chrome.runtime.sendMessage({
        type: 'LH3_DOWNLOAD',
        csv: '\uFEFF' + LH3.buildCsv(leads),
        filename: LH3.csvFilename('onyx-leads')
      });
      msg(res && res.ok ? `Exported ${fmt(leads.length)} leads.` : 'Export failed — check Chrome\'s download settings.',
        res && res.ok ? 'good' : 'warn');
    });

    $('openSearch').addEventListener('click', async () => {
      await openSearchTab(true);
      setTimeout(refreshState, 400);
    });

    // Auto-open on launch, but never interrupt a sweep that's already running.
    const run0 = await get(K_RUN, null);
    const tab0 = await activeTab();
    if (!(run0 && run0.active) && !isGoogle(tab0 && tab0.url)) {
      await openSearchTab(false);
      setTimeout(refreshState, 600);
    }

    $('testSheet').addEventListener('click', testSheet);

    $('showCode').addEventListener('click', async () => {
      const panel = $('codePanel');
      panel.hidden = false;
      if (!$('codeBox').value) {
        const res = await fetch(chrome.runtime.getURL('sheets-code.gs'));
        $('codeBox').value = await res.text();
      }
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('hideCode').addEventListener('click', () => { $('codePanel').hidden = true; });

    $('copyCode').addEventListener('click', async () => {
      const box = $('codeBox');
      try {
        await navigator.clipboard.writeText(box.value);
        msg('Script copied — paste it into Apps Script.', 'good');
      } catch (e) {
        box.select();                       // clipboard blocked; let them hit Ctrl+C
        msg('Press Ctrl+C to copy the highlighted script.', 'warn');
      }
    });

    setInterval(() => { refreshState(); renderCounts(); }, 2000);
  }

  init();
})();
