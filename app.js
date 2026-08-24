/* ONYX CRM — application logic
   Talks to two backends: the Apps Script sheet (data) and the
   Cloudflare Worker (email + enrichment). No secrets live here. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var D = window.ONYX_DEFAULTS;
  var TPL = window.ONYX_TEMPLATES || [];

  var cfg = load();
  var session = { token: localStorage.getItem('onyx_token') || '', user: null };
  var state = { page: 0, size: 50, leads: [], stages: [], current: null, queue: [] };

  function load() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('onyx_cfg') || '{}'); } catch (e) { }
    return Object.assign({}, D, saved);
  }
  function saveCfg() {
    localStorage.setItem('onyx_cfg', JSON.stringify({
      SHEET_URL: cfg.SHEET_URL, SHEET_SECRET: cfg.SHEET_SECRET,
      WORKER_URL: cfg.WORKER_URL, WORKER_SECRET: cfg.WORKER_SECRET,
      POSTAL_ADDRESS: cfg.POSTAL_ADDRESS, UNSUBSCRIBE_LINE: cfg.UNSUBSCRIBE_LINE
    }));
  }

  /* ── transport ────────────────────────────────────────────────
     text/plain keeps these "simple requests" so the browser skips
     the preflight, which Apps Script refuses to answer. */

  function sheet(action, payload) {
    if (!cfg.SHEET_URL) return Promise.resolve({ ok: false, error: 'Set the Apps Script URL in Admin.' });
    var body = Object.assign({ action: action, secret: cfg.SHEET_SECRET, token: session.token }, payload || {});
    return fetch(cfg.SHEET_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.error === 'SESSION_EXPIRED') { signOut(true); return { ok: false, error: 'Session expired — sign in again.' }; }
        return d;
      })
      .catch(function (e) { return { ok: false, error: 'Could not reach the sheet. ' + e.message }; });
  }

  function worker(action, payload) {
    if (!cfg.WORKER_URL) return Promise.resolve({ ok: false, error: 'Set the Worker URL in Admin.' });
    var body = Object.assign({ action: action, secret: cfg.WORKER_SECRET }, payload || {});
    return fetch(cfg.WORKER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: 'Could not reach the worker. ' + e.message }; });
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function msg(id, text, kind) {
    var el = $(id); if (!el) return;
    el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* ── auth ─────────────────────────────────────────────────── */

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    msg('loginMsg', 'Signing in…');
    $('loginBtn').disabled = true;
    sheet('login', { username: $('lu').value.trim(), password: $('lp').value })
      .then(function (r) {
        $('loginBtn').disabled = false;
        if (!r.ok) { msg('loginMsg', r.error || 'Sign-in failed.', 'bad'); return; }
        session.token = r.token; session.user = r.user;
        localStorage.setItem('onyx_token', r.token);
        boot();
      });
  });

  function signOut(silent) {
    if (!silent) sheet('logout', {});
    session.token = ''; session.user = null;
    localStorage.removeItem('onyx_token');
    $('app').hidden = true; $('login').hidden = false;
    if (silent) msg('loginMsg', 'Session expired — sign in again.', 'warn');
  }
  $('logout').addEventListener('click', function () { signOut(false); });

  function boot() {
    $('login').hidden = true; $('app').hidden = false;
    $('whoName').textContent = session.user.name + (session.user.role === 'admin' ? ' · admin' : '');
    $('userPanel').style.display = session.user.role === 'admin' ? '' : 'none';
    fillConfigForm(); fillFromOptions(); fillTemplates();
    loadStats(); loadLeads();
    if (session.user.role === 'admin') loadUsers();
  }

  /* ── tabs ─────────────────────────────────────────────────── */

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      ['pipeline', 'calls', 'email', 'admin'].forEach(function (v) {
        $('view-' + v).hidden = v !== t.dataset.view;
      });
      if (t.dataset.view === 'calls' && !state.queue.length) loadQueue();
    });
  });

  /* ── stats ────────────────────────────────────────────────── */

  function loadStats() {
    sheet('stats', {}).then(function (r) {
      if (!r.ok) return;
      state.stages = r.stages || [];
      var sel = $('fStage');
      if (sel.options.length <= 1) {
        state.stages.forEach(function (s) {
          var o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
        });
      }
      var cards = [
        ['Total leads', r.total], ['Need research', r.needResearch],
        ['Missing email', r.needEmail], ['Chains', r.chains],
        ['Ready to call', r.byStage['Ready to Call'] || 0],
        ['Contacted', r.byStage['Contacted'] || 0],
        ['Demo booked', r.byStage['Demo Booked'] || 0],
        ['Won', r.byStage['Won'] || 0]
      ];
      $('statbar').innerHTML = cards.map(function (c) {
        return '<div class="stat"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>';
      }).join('');
    });
  }

  /* ── pipeline ─────────────────────────────────────────────── */

  function loadLeads() {
    $('leadRows').innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
    sheet('listLeads', {
      q: $('q').value, stage: $('fStage').value,
      hideChains: $('fChains').checked, needsEmail: $('fNoEmail').checked,
      page: state.page, size: state.size
    }).then(function (r) {
      if (!r.ok) { $('leadRows').innerHTML = '<tr><td colspan="8" class="muted">' + esc(r.error) + '</td></tr>'; return; }
      state.leads = r.leads;
      renderLeads(r);
    });
  }

  function scoreCls(n) { n = Number(n) || 0; return n >= 80 ? 'score hot' : n >= 60 ? 'score warm' : 'score'; }

  function renderLeads(r) {
    if (!r.leads.length) {
      $('leadRows').innerHTML = '<tr><td colspan="8" class="muted">No leads match. Run the LeadHunter extension to fill the sheet.</td></tr>';
    } else {
      $('leadRows').innerHTML = r.leads.map(function (l) {
        return '<tr data-id="' + esc(l.id) + '">' +
          '<td><span class="' + scoreCls(l.leadScore) + '">' + (l.leadScore || '–') + '</span></td>' +
          '<td>' + esc(l.name) + (String(l.isNationalChain) === 'Yes' ? '<span class="tag chain">chain</span>' : '') +
            (l.needsHumanReview === true || l.needsHumanReview === 'TRUE' ? '<span class="tag">review</span>' : '') + '</td>' +
          '<td>' + esc(l.city || '') + '</td>' +
          '<td>' + (l.dmName ? esc(l.dmName) + '<span class="tag">' + esc(l.dmTitle || '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (l.email ? esc(l.email) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + esc(l.phone || '') + '</td>' +
          '<td>' + esc(l.stage || '') + '</td>' +
          '<td>' + esc(l.owner || '') + '</td></tr>';
      }).join('');
    }
    var start = r.page * state.size;
    $('pageInfo').textContent = r.total ? (start + 1) + '–' + Math.min(r.total, start + state.size) + ' of ' + r.total : '0';
    $('prev').disabled = r.page === 0;
    $('next').disabled = start + state.size >= r.total;
  }

  $('leadRows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr) openLead(tr.dataset.id);
  });
  $('refresh').addEventListener('click', function () { state.page = 0; loadLeads(); loadStats(); });
  $('q').addEventListener('input', debounce(function () { state.page = 0; loadLeads(); }, 350));
  $('fStage').addEventListener('change', function () { state.page = 0; loadLeads(); });
  $('fChains').addEventListener('change', function () { state.page = 0; loadLeads(); });
  $('fNoEmail').addEventListener('change', function () { state.page = 0; loadLeads(); });
  $('prev').addEventListener('click', function () { if (state.page > 0) { state.page--; loadLeads(); } });
  $('next').addEventListener('click', function () { state.page++; loadLeads(); });

  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /* ── lead drawer ──────────────────────────────────────────── */

  function openLead(id) {
    $('drawer').hidden = false; $('scrim').hidden = false;
    $('dName').textContent = 'Loading…'; $('drawerBody').innerHTML = '';
    sheet('getLead', { id: id }).then(function (r) {
      if (!r.ok) { $('drawerBody').innerHTML = '<p class="muted">' + esc(r.error) + '</p>'; return; }
      state.current = r.lead;
      renderDrawer(r.lead, r.activity || []);
    });
  }
  function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; state.current = null; }
  $('closeDrawer').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  function renderDrawer(l, activity) {
    $('dName').textContent = l.name;
    $('dSub').textContent = [l.category, [l.city, l.state].filter(Boolean).join(', '),
      l.buyerType].filter(Boolean).join(' · ');

    var stageOpts = state.stages.map(function (s) {
      return '<option' + (s === l.stage ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');

    $('drawerBody').innerHTML =
      '<div class="dsec"><h3>Decision maker</h3>' +
        '<div class="dgrid">' +
          '<span class="k">Name</span><input id="dmName" value="' + esc(l.dmName) + '" placeholder="Not found yet">' +
          '<span class="k">Title</span><input id="dmTitle" value="' + esc(l.dmTitle) + '" placeholder="Owner, Medical Director…">' +
          '<span class="k">Email</span><input id="dmEmail" value="' + esc(l.email) + '" placeholder="owner@theirspa.com">' +
          '<span class="k">Confidence</span><input id="dmConfidence" value="' + esc(l.dmConfidence) + '" placeholder="VERIFIED / HIGH / MEDIUM / LOW">' +
          '<span class="k">Direct phone</span><input id="directPhone" value="' + esc(l.directPhone) + '">' +
          '<span class="k">LinkedIn</span><input id="linkedin" value="' + esc(l.linkedin) + '">' +
          '<span class="k">Instagram</span><input id="instagram" value="' + esc(l.instagram) + '">' +
        '</div>' +
        (l.dmEvidence ? '<p class="hint" style="margin-top:9px">Evidence: ' + esc(l.dmEvidence) + '</p>' : '') +
        '<div class="actions">' +
          '<button class="btn primary compact" id="saveDm">Save contact</button>' +
          '<button class="btn quiet compact" id="researchBtn">' + (l.enrichedAt ? 'Re-run research' : 'Research this lead') + '</button>' +
          (l.email ? '<button class="btn quiet compact" id="emailThis">Email them</button>' : '') +
        '</div><p class="msg" id="dmMsg"></p></div>' +

      '<div class="dsec"><h3>Pipeline</h3><div class="dgrid">' +
        '<span class="k">Stage</span><select id="dStage">' + stageOpts + '</select>' +
        '<span class="k">Owner</span><input id="dOwner" value="' + esc(l.owner) + '" placeholder="unassigned">' +
        '<span class="k">Next action</span><input id="dNextAction" value="' + esc(l.nextAction) + '">' +
        '<span class="k">Callback date</span><input id="dNextDate" type="date" value="' + esc(String(l.nextActionDate || '').slice(0, 10)) + '">' +
      '</div><div class="actions"><button class="btn primary compact" id="savePipe">Save</button>' +
      '<span class="hint">Attempts: ' + (l.callAttempts || 0) + (l.lastContacted ? ' · last touch ' + esc(String(l.lastContacted).slice(0, 10)) : '') + '</span></div></div>' +

      (l.leadScore || l.salesAngle ?
        '<div class="dsec"><h3>Research</h3><div class="dgrid">' +
          '<span class="k">Score</span><span>' + esc(l.leadScore) + ' — ' + esc(l.buyerFit) + '</span>' +
          '<span class="k">Angle</span><span>' + esc(l.salesAngle) + '</span>' +
          '<span class="k">Services</span><span>' + esc(l.services) + '</span>' +
          '<span class="k">Equipment</span><span>' + esc(l.existingEquipment) + '</span>' +
          '<span class="k">Signals</span><span>' + esc(l.expansionSignals) + '</span>' +
          '<span class="k">Channel</span><span>' + esc(l.bestChannel) + '</span>' +
        '</div>' +
        (l.suggestedMessage ? '<p class="hint" style="margin-top:9px">Suggested opener</p><div class="notes">' + esc(l.suggestedMessage) + '</div>' : '') +
        (l.sources ? '<p class="hint" style="margin-top:9px">Sources: ' + esc(l.sources) + '</p>' : '') +
        '</div>' : '') +

      '<div class="dsec"><h3>Notes</h3>' +
        '<textarea id="newNote" placeholder="What happened? Saved with your name and a timestamp."></textarea>' +
        '<div class="actions"><button class="btn quiet compact" id="addNote">Add note</button></div>' +
        (l.notes ? '<div class="notes" id="notesBox">' + esc(l.notes) + '</div>' : '<div class="notes" id="notesBox"></div>') +
      '</div>' +

      '<div class="dsec"><h3>Activity</h3>' +
        (activity.length ? '<div class="notes">' + activity.map(function (a) {
          return esc(String(a.at).slice(0, 16).replace('T', ' ')) + '  ' + esc(a.user) + '  ' + esc(a.type) + ' — ' + esc(a.detail);
        }).join('\n') + '</div>' : '<p class="hint">Nothing logged yet.</p>') +
      '</div>' +

      '<div class="dsec"><h3>Links</h3><div class="actions">' +
        (l.website ? '<a class="btn quiet compact" target="_blank" rel="noopener" href="' + esc(l.website) + '">Website</a>' : '') +
        (l.mapsUrl ? '<a class="btn quiet compact" target="_blank" rel="noopener" href="' + esc(l.mapsUrl) + '">Maps</a>' : '') +
        (l.phone ? '<a class="btn quiet compact" href="tel:' + esc(String(l.phone).replace(/\D/g, '')) + '">Call ' + esc(l.phone) + '</a>' : '') +
      '</div></div>';

    $('saveDm').addEventListener('click', function () {
      var f = {};
      ['dmName', 'dmTitle', 'dmConfidence', 'directPhone', 'linkedin', 'instagram'].forEach(function (k) { f[k] = $(k).value.trim(); });
      f.email = $('dmEmail').value.trim();
      if (f.email && !f.emailStatus) f.emailStatus = 'Manually entered';
      msg('dmMsg', 'Saving…');
      sheet('updateLead', { id: l.id, fields: f }).then(function (r) {
        msg('dmMsg', r.ok ? 'Saved.' : r.error, r.ok ? 'good' : 'bad');
        if (r.ok) loadLeads();
      });
    });

    $('savePipe').addEventListener('click', function () {
      sheet('updateLead', {
        id: l.id, fields: {
          stage: $('dStage').value, owner: $('dOwner').value.trim(),
          nextAction: $('dNextAction').value.trim(), nextActionDate: $('dNextDate').value
        }
      }).then(function (r) {
        msg('dmMsg', r.ok ? 'Pipeline updated.' : r.error, r.ok ? 'good' : 'bad');
        if (r.ok) { loadLeads(); loadStats(); }
      });
    });

    $('addNote').addEventListener('click', function () {
      var n = $('newNote').value.trim();
      if (!n) return;
      sheet('addNote', { id: l.id, note: n }).then(function (r) {
        if (!r.ok) { msg('dmMsg', r.error, 'bad'); return; }
        $('newNote').value = '';
        $('notesBox').textContent = r.notes;
      });
    });

    $('researchBtn').addEventListener('click', function () { research(l); });
    if ($('emailThis')) $('emailThis').addEventListener('click', function () { composeFor(l); });
  }

  /* ── enrichment ───────────────────────────────────────────── */

  function research(l) {
    msg('dmMsg', 'Researching — this takes 20 to 60 seconds…');
    $('researchBtn').disabled = true;

    worker('enrich', { lead: l }).then(function (r) {
      $('researchBtn').disabled = false;
      if (!r.ok) { msg('dmMsg', r.error || 'Research failed.', 'bad'); return; }
      var d = r.data;

      // Only write fields the model actually filled, and never clobber
      // a human-entered contact with a guess.
      var f = {};
      [['decisionMakerName', 'dmName'], ['decisionMakerTitle', 'dmTitle'],
       ['decisionMakerConfidence', 'dmConfidence'], ['decisionMakerEvidence', 'dmEvidence'],
       ['email', 'email'], ['emailStatus', 'emailStatus'], ['emailConfidence', 'emailConfidence'],
       ['directPhone', 'directPhone'], ['linkedin', 'linkedin'], ['instagram', 'instagram'],
       ['facebook', 'facebook'], ['services', 'services'], ['existingEquipment', 'existingEquipment'],
       ['expansionSignals', 'expansionSignals'], ['leadScore', 'leadScore'], ['buyerFit', 'buyerFit'],
       ['scoreReasoning', 'scoreReasoning'], ['salesAngle', 'salesAngle'], ['angleEvidence', 'angleEvidence'],
       ['bestChannel', 'bestChannel'], ['openingAngle', 'openingAngle'], ['personalization', 'personalization'],
       ['suggestedMessage', 'suggestedMessage'], ['sources', 'sources'],
       ['enrichedAt', 'enrichedAt'], ['needsHumanReview', 'needsHumanReview']]
        .forEach(function (pair) {
          var v = d[pair[0]];
          if (v === undefined || v === null || v === '' || v === 'Unknown') return;
          if (pair[1] === 'email' && l.email) return;      // keep the human's version
          f[pair[1]] = v;
        });

      if (!l.stage || l.stage === 'New Lead') f.stage = 'Researching';

      sheet('updateLead', { id: l.id, fields: f }).then(function (u) {
        if (!u.ok) { msg('dmMsg', u.error, 'bad'); return; }
        msg('dmMsg', 'Research saved' + (d.needsHumanReview ? ' — flagged for human review.' : '.'), 'good');
        openLead(l.id); loadLeads(); loadStats();
      });
    });
  }

  /* ── call list ────────────────────────────────────────────── */

  function loadQueue() {
    $('queue').innerHTML = '<li class="muted">Loading…</li>';
    sheet('callQueue', { mine: $('mineOnly').checked, size: 60 }).then(function (r) {
      if (!r.ok) { $('queue').innerHTML = '<li class="muted">' + esc(r.error) + '</li>'; return; }
      state.queue = r.queue;
      $('queueInfo').textContent = r.total + ' callable leads';
      if (!r.queue.length) { $('queue').innerHTML = '<li class="muted">Nothing to call.</li>'; return; }
      $('queue').innerHTML = r.queue.map(function (l, i) {
        return '<li data-i="' + i + '"><div class="qn">' + esc(l.name) + '</div>' +
          '<div class="qm">' + esc(l.city || '') + ' · ' + esc(l.phone || 'no phone') +
          (l.nextActionDate ? ' · due ' + esc(String(l.nextActionDate).slice(0, 10)) : '') +
          ' · score ' + (l.leadScore || '–') + '</div></li>';
      }).join('');
    });
  }
  $('loadQueue').addEventListener('click', loadQueue);
  $('mineOnly').addEventListener('change', loadQueue);

  $('queue').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-i]');
    if (!li) return;
    Array.prototype.forEach.call($('queue').children, function (x) { x.classList.remove('on'); });
    li.classList.add('on');
    showCall(state.queue[Number(li.dataset.i)]);
  });

  var OUTCOMES = ['Connected — interested', 'Connected — not now', 'Connected — no',
    'Left voicemail', 'No answer', 'Gatekeeper', 'Wrong number'];

  function showCall(l) {
    $('callCard').innerHTML =
      '<h2>' + esc(l.name) + '</h2>' +
      '<p class="hint">' + esc([l.category, l.city, l.buyerType].filter(Boolean).join(' · ')) + '</p>' +
      '<p class="bignum"><a href="tel:' + esc(String(l.phone || '').replace(/\D/g, '')) + '">' + esc(l.phone || 'No phone') + '</a></p>' +
      '<p class="hint">' + (l.dmName ? 'Ask for ' + esc(l.dmName) + (l.dmTitle ? ' (' + esc(l.dmTitle) + ')' : '') : 'Decision maker unknown — ask who handles equipment purchases.') + '</p>' +
      '<div class="outcomes">' + OUTCOMES.map(function (o) {
        return '<button class="btn quiet compact out" data-o="' + esc(o) + '">' + esc(o) + '</button>';
      }).join('') + '</div>' +
      '<textarea id="callNote" placeholder="What did they say?"></textarea>' +
      '<div class="actions">' +
        '<label class="hint">Call back <input type="date" id="callBack"></label>' +
        '<button class="btn quiet compact" id="openLeadFromCall">Open full record</button>' +
      '</div><p class="msg" id="callMsg"></p>';

    Array.prototype.forEach.call($('callCard').querySelectorAll('.out'), function (b) {
      b.addEventListener('click', function () { saveCall(l, b.dataset.o); });
    });
    $('openLeadFromCall').addEventListener('click', function () { openLead(l.id); });
  }

  function saveCall(l, outcome) {
    var stage = outcome === 'Connected — interested' ? 'Interested'
      : outcome === 'Connected — no' ? 'Lost'
      : outcome.indexOf('Connected') === 0 ? 'Contacted' : '';
    msg('callMsg', 'Saving…');
    sheet('logCall', {
      id: l.id, outcome: outcome, note: $('callNote').value.trim(),
      stage: stage, nextActionDate: $('callBack').value
    }).then(function (r) {
      msg('callMsg', r.ok ? 'Logged.' : r.error, r.ok ? 'good' : 'bad');
      if (r.ok) { loadStats(); setTimeout(loadQueue, 400); }
    });
  }

  /* ── email ────────────────────────────────────────────────── */

  function fillFromOptions() {
    var sel = $('eFrom');
    sel.innerHTML = '';
    var mine = (session.user.email || '').split('@')[0];
    var opts = (mine ? [mine] : []).concat(D.FROM_OPTIONS || []);
    opts.filter(function (v, i, a) { return v && a.indexOf(v) === i; })
      .forEach(function (v) {
        var o = document.createElement('option'); o.value = v; o.textContent = v + '@' + D.SEND_DOMAIN; sel.appendChild(o);
      });
  }

  function fillTemplates() {
    var sel = $('eTemplate');
    sel.innerHTML = '<option value="">— pick a template —</option>';
    TPL.forEach(function (t, i) {
      var o = document.createElement('option'); o.value = i; o.textContent = t.name; sel.appendChild(o);
    });
  }

  var emailLead = null;

  function composeFor(l) {
    emailLead = l;
    closeDrawer();
    document.querySelector('.tab[data-view="email"]').click();
    $('eTo').value = l.email || '';
    $('eLead').textContent = l.name;
  }

  function merge(text) {
    var l = emailLead || {};
    var first = String(l.dmName || '').trim().split(/\s+/)[0] || 'there';
    return String(text || '')
      .replace(/\{\{business\}\}/g, l.name || 'your practice')
      .replace(/\{\{firstName\}\}/g, first)
      .replace(/\{\{city\}\}/g, l.city || 'your area')
      .replace(/\{\{myName\}\}/g, session.user.name || '');
  }

  $('applyTpl').addEventListener('click', function () {
    var i = $('eTemplate').value;
    if (i === '') return;
    $('eSubject').value = merge(TPL[i].subject);
    $('eBody').value = merge(TPL[i].body);
  });

  function buildHtml(bodyText) {
    var esc2 = esc(bodyText).replace(/\n/g, '<br>');
    var foot = [];
    if (cfg.UNSUBSCRIBE_LINE) foot.push(esc(cfg.UNSUBSCRIBE_LINE));
    if (cfg.POSTAL_ADDRESS) foot.push(esc(cfg.POSTAL_ADDRESS));
    return '<div style="font:14px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111">' +
      esc2 +
      (foot.length ? '<hr style="border:0;border-top:1px solid #ddd;margin:22px 0 10px">' +
        '<div style="font-size:11px;color:#888">' + foot.join('<br>') + '</div>' : '') +
      '</div>';
  }

  $('previewEmail').addEventListener('click', function () {
    var p = $('preview');
    p.hidden = false;
    p.innerHTML = '<div style="color:#666;font-size:12px;margin-bottom:10px">' +
      esc($('eFrom').value + '@' + D.SEND_DOMAIN) + ' → ' + esc($('eTo').value) +
      '<br><b style="color:#111">' + esc($('eSubject').value) + '</b></div>' + buildHtml($('eBody').value);
  });

  $('sendEmail').addEventListener('click', function () {
    var to = $('eTo').value.trim();
    var subject = $('eSubject').value.trim();
    var body = $('eBody').value;

    if (!to) { msg('emailMsg', 'Who is this going to?', 'bad'); return; }
    if (!subject) { msg('emailMsg', 'Add a subject line.', 'bad'); return; }
    if (!body.trim()) { msg('emailMsg', 'The message is empty.', 'bad'); return; }
    if (!cfg.POSTAL_ADDRESS) { msg('emailMsg', 'Add your postal address in Admin — CAN-SPAM requires it.', 'bad'); return; }
    if (/\{\{/.test(subject + body)) { msg('emailMsg', 'There is an unfilled {{merge field}} still in there.', 'bad'); return; }

    $('sendEmail').disabled = true;
    msg('emailMsg', 'Sending…');

    worker('email', {
      to: to, subject: subject, html: buildHtml(body), text: body,
      fromLocal: $('eFrom').value, fromName: session.user.name || 'Edgeform Media',
      replyTo: session.user.email || ''
    }).then(function (r) {
      $('sendEmail').disabled = false;
      if (!r.ok) { msg('emailMsg', r.error || 'Send failed.', 'bad'); return; }
      msg('emailMsg', 'Sent to ' + to + '.', 'good');
      sheet('logSend', {
        id: emailLead ? emailLead.id : '', to: to, fromLocal: $('eFrom').value,
        subject: subject, resendId: r.id, status: 'sent'
      }).then(function () { loadStats(); loadLeads(); });
    });
  });

  /* ── admin ────────────────────────────────────────────────── */

  function fillConfigForm() {
    $('cfgSheet').value = cfg.SHEET_URL || '';
    $('cfgSheetSecret').value = cfg.SHEET_SECRET || '';
    $('cfgWorker').value = cfg.WORKER_URL || '';
    $('cfgWorkerSecret').value = cfg.WORKER_SECRET || '';
    $('cfgAddress').value = cfg.POSTAL_ADDRESS || '';
    $('cfgUnsub').value = cfg.UNSUBSCRIBE_LINE || '';
  }

  $('saveCfg').addEventListener('click', function () {
    cfg.SHEET_URL = $('cfgSheet').value.trim();
    cfg.SHEET_SECRET = $('cfgSheetSecret').value.trim();
    cfg.WORKER_URL = $('cfgWorker').value.trim();
    cfg.WORKER_SECRET = $('cfgWorkerSecret').value.trim();
    saveCfg(); msg('cfgMsg', 'Saved to this browser.', 'good');
  });

  $('testCfg').addEventListener('click', function () {
    msg('cfgMsg', 'Testing…');
    Promise.all([sheet('ping', {}), worker('ping', {})]).then(function (res) {
      var a = res[0].ok ? 'Sheet OK (' + res[0].rows + ' leads)' : 'Sheet: ' + res[0].error;
      var b = res[1].ok ? 'Worker OK' : 'Worker: ' + res[1].error;
      msg('cfgMsg', a + ' · ' + b, res[0].ok && res[1].ok ? 'good' : 'bad');
    });
  });

  $('saveFooter').addEventListener('click', function () {
    cfg.POSTAL_ADDRESS = $('cfgAddress').value.trim();
    cfg.UNSUBSCRIBE_LINE = $('cfgUnsub').value.trim();
    saveCfg(); msg('cfgMsg', 'Footer saved.', 'good');
  });

  function loadUsers() {
    sheet('listUsers', {}).then(function (r) {
      if (!r.ok) return;
      $('userRows').innerHTML = r.users.map(function (u) {
        return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.name) + '</td><td>' + esc(u.role) +
          '</td><td class="muted">' + esc(String(u.lastLogin || '').slice(0, 10)) + '</td></tr>';
      }).join('');
    });
  }

  $('addUser').addEventListener('click', function () {
    sheet('addUser', {
      username: $('nuUser').value.trim(), name: $('nuName').value.trim(),
      password: $('nuPass').value, role: $('nuRole').value
    }).then(function (r) {
      msg('userMsg', r.ok ? 'User added.' : r.error, r.ok ? 'good' : 'bad');
      if (r.ok) { $('nuUser').value = $('nuName').value = $('nuPass').value = ''; loadUsers(); }
    });
  });

  $('changePw').addEventListener('click', function () {
    sheet('setPassword', { password: $('pw1').value }).then(function (r) {
      msg('pwMsg', r.ok ? 'Password changed.' : r.error, r.ok ? 'good' : 'bad');
      if (r.ok) $('pw1').value = '';
    });
  });

  /* ── start ────────────────────────────────────────────────── */

  if (session.token && cfg.SHEET_URL) {
    sheet('me', {}).then(function (r) {
      if (r.ok) { session.user = r.user; boot(); }
      else { $('login').hidden = false; }
    });
  } else {
    $('login').hidden = false;
    if (!cfg.SHEET_URL) msg('loginMsg', 'Set SHEET_URL in config.js first.', 'warn');
  }
})();
