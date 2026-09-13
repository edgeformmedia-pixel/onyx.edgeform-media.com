/* Background owner + email research queue.
   The queue lives in localStorage, so it survives clicking into a lead or
   another tab: every CRM page loads this file and resumes where it left off.
   Only one browser tab runs the queue at a time (heartbeat lock). */

window.OnyxResearch = (function () {
  'use strict';

  var QUEUE_KEY = 'onyx_research_queue', LOCK_KEY = 'onyx_research_lock';
  var LOCK_STALE_MS = 9000, HEARTBEAT_MS = 2500;
  var tabId = Math.random().toString(36).slice(2);
  var running = false, heartbeat = null, bar = null, listeners = [];

  function read() {
    try {
      var q = JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null');
      if (q && Array.isArray(q.items)) return q;
    } catch (e) { }
    return { items: [], done: 0, failed: 0, total: 0, paused: false, current: '', errors: [], finishedAt: '' };
  }
  function write(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) { } render(); }

  function lockHeldByOther() {
    try {
      var lock = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      return !!(lock && lock.tab !== tabId && Date.now() - lock.at < LOCK_STALE_MS);
    } catch (e) { return false; }
  }
  function takeLock() {
    if (lockHeldByOther()) return false;
    try { localStorage.setItem(LOCK_KEY, JSON.stringify({ tab: tabId, at: Date.now() })); } catch (e) { }
    clearInterval(heartbeat);
    heartbeat = setInterval(function () {
      try { localStorage.setItem(LOCK_KEY, JSON.stringify({ tab: tabId, at: Date.now() })); } catch (e) { }
    }, HEARTBEAT_MS);
    return true;
  }
  function releaseLock() {
    clearInterval(heartbeat); heartbeat = null;
    try {
      var lock = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      if (lock && lock.tab === tabId) localStorage.removeItem(LOCK_KEY);
    } catch (e) { }
  }

  /* ── research one lead ──────────────────────────────────── */

  // force: re-research overwrites earlier AI results, but never an email a person typed in.
  function fieldsFrom(data, lead, force) {
    var map = [
      ['decisionMakerName', 'dmName'], ['decisionMakerConfidence', 'dmConfidence'], ['decisionMakerEvidence', 'dmEvidence'],
      ['email', 'email'], ['emailStatus', 'emailStatus'], ['emailConfidence', 'emailConfidence'], ['sources', 'sources'],
      ['enrichedAt', 'enrichedAt'], ['needsHumanReview', 'needsHumanReview']
    ], fields = {};
    map.forEach(function (pair) {
      var value = data && data[pair[0]];
      if (value === undefined || value === null || value === '' || value === 'Unknown') return;
      if (!force && ['dmName', 'dmConfidence', 'dmEvidence'].indexOf(pair[1]) > -1 && lead.dmName && String(lead.dmName).toLowerCase() !== 'unknown') return;
      if (['email', 'emailStatus', 'emailConfidence'].indexOf(pair[1]) > -1 && lead.email && (!force || /^Entered by /i.test(String(lead.emailStatus || '')))) return;
      if (pair[1] === 'sources') value = [lead.sources, value].filter(Boolean).join('\n');
      fields[pair[1]] = value;
    });
    return fields;
  }

  function researchLead(id, force) {
    return Onyx.sheet('getLead', { id: id }).then(function (full) {
      if (!full.ok) throw new Error(full.error || 'Could not load lead.');
      var lead = full.lead;
      var q = read();
      q.currentName = lead.name || '';
      write(q);
      return Onyx.worker('enrichContact', { lead: lead }).then(function (result) {
        if (!result.ok) throw new Error(result.error || 'Owner and email research failed.');
        var fields = fieldsFrom(result.data || {}, lead, force);
        if (!lead.stage || lead.stage === 'New Lead') fields.stage = 'Researching';
        return Onyx.sheet('updateLead', { id: lead.id, fields: fields }).then(function (saved) {
          if (!saved.ok) throw new Error(saved.error || 'Could not save owner and email.');
          return { lead: lead, fields: fields };
        });
      });
    });
  }

  /* ── queue runner ───────────────────────────────────────── */

  function emit(type, detail) { listeners.forEach(function (fn) { try { fn(type, detail); } catch (e) { } }); }

  function run() {
    if (running) return;
    var q = read();
    if (!q.items.length || q.paused) { render(); return; }
    if (!takeLock()) { render(); setTimeout(run, LOCK_STALE_MS); return; }
    running = true;
    step();
  }

  function step() {
    var q = read();
    if (!q.items.length || q.paused) {
      running = false; releaseLock();
      if (!q.items.length && q.total && !q.finishedAt) { q.finishedAt = new Date().toISOString(); q.current = ''; q.currentName = ''; write(q); emit('finished', q); }
      render();
      return;
    }
    var item = q.items[0];
    q.current = item.id; q.currentName = item.name || '';
    write(q);
    researchLead(item.id, item.force).then(function (res) {
      finish(item, null, res);
    }, function (err) {
      finish(item, err);
    });
  }

  function finish(item, err, res) {
    var q = read();
    // The item may have been removed by Stop in the meantime.
    if (q.items.length && q.items[0].id === item.id) q.items.shift();
    if (err) {
      q.failed++;
      q.errors = [{ id: item.id, name: q.currentName || item.name || '', error: String(err && err.message || err) }].concat(q.errors || []).slice(0, 20);
    } else {
      q.done++;
    }
    q.current = ''; write(q);
    emit(err ? 'failed' : 'done', { id: item.id, result: res, error: err });
    setTimeout(step, 250);
  }

  function add(leads, opts) {
    opts = opts || {};
    var q = read();
    if (!q.items.length) { q = { items: [], done: 0, failed: 0, total: 0, paused: false, current: '', errors: [], finishedAt: '' }; }
    var have = {};
    q.items.forEach(function (it) { have[it.id] = true; });
    var added = 0;
    (leads || []).forEach(function (lead) {
      var id = typeof lead === 'object' ? String(lead.id) : String(lead);
      if (!id || have[id]) return;
      have[id] = true; added++;
      q.items.push({ id: id, name: typeof lead === 'object' ? (lead.name || '') : '', force: !!opts.force });
    });
    q.total += added; q.paused = false; q.finishedAt = '';
    write(q);
    run();
    return added;
  }

  function pause() { var q = read(); q.paused = true; write(q); }
  function resume() { var q = read(); q.paused = false; write(q); run(); }
  function stop() {
    var q = read();
    q.items = []; q.paused = false; q.finishedAt = new Date().toISOString();
    write(q);
  }
  function dismiss() { try { localStorage.removeItem(QUEUE_KEY); } catch (e) { } render(); }

  /* ── bottom bar ─────────────────────────────────────────── */

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'research-queue';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<div class="rq-main"><span class="rq-spinner" aria-hidden="true"></span><div class="rq-text"><strong id="rqTitle"></strong><small id="rqSub"></small></div></div>' +
      '<div class="rq-progress"><i id="rqFill"></i></div>' +
      '<div class="rq-actions"><button type="button" data-rq="pause">Pause</button><button type="button" data-rq="resume">Resume</button><button type="button" data-rq="stop">Stop</button><button type="button" data-rq="errors">Show failures</button><button type="button" data-rq="dismiss" aria-label="Dismiss">×</button></div>' +
      '<div class="rq-errors" id="rqErrors" hidden></div>';
    document.body.appendChild(bar);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rq]'); if (!b) return;
      var action = b.dataset.rq;
      if (action === 'pause') pause();
      if (action === 'resume') resume();
      if (action === 'stop' && confirm('Stop researching? Leads not started yet are removed from the queue. The lead in progress still finishes.')) stop();
      if (action === 'dismiss') dismiss();
      if (action === 'errors') { var el = document.getElementById('rqErrors'); el.hidden = !el.hidden; }
    });
    return bar;
  }

  function render() {
    if (!document.body) return;
    var q = read();
    var active = q.items.length > 0, visible = active || (q.total > 0 && q.finishedAt);
    document.body.classList.toggle('research-queue-on', !!visible);
    if (!visible) { if (bar) bar.hidden = true; return; }
    ensureBar(); bar.hidden = false;
    var processed = q.done + q.failed, pct = q.total ? Math.round(processed / q.total * 100) : 0;
    var otherTab = active && !running && lockHeldByOther();
    bar.classList.toggle('running', active && !q.paused);
    bar.classList.toggle('finished', !active);
    document.getElementById('rqFill').style.width = pct + '%';
    document.getElementById('rqTitle').textContent = !active
      ? 'Research finished: ' + q.done + ' researched' + (q.failed ? ', ' + q.failed + ' failed' : '')
      : q.paused ? 'Research paused · ' + processed + ' of ' + q.total + ' done'
      : 'Researching ' + Math.min(processed + 1, q.total) + ' of ' + q.total + (q.currentName ? ' · ' + q.currentName : '');
    document.getElementById('rqSub').textContent = !active
      ? 'Owner names and emails are saved to each lead.'
      : otherTab ? 'Running in another CRM tab.'
      : 'Keeps going while you use the CRM. Closing every CRM tab pauses it until you come back.';
    bar.querySelector('[data-rq=pause]').hidden = !active || q.paused;
    bar.querySelector('[data-rq=resume]').hidden = !active || !q.paused;
    bar.querySelector('[data-rq=stop]').hidden = !active;
    bar.querySelector('[data-rq=dismiss]').hidden = active;
    bar.querySelector('[data-rq=errors]').hidden = !(q.errors && q.errors.length);
    document.getElementById('rqErrors').innerHTML = (q.errors || []).map(function (x) {
      return '<div><a href="/lead/?id=' + encodeURIComponent(x.id) + '">' + Onyx.esc(x.name || x.id) + '</a> — ' + Onyx.esc(x.error) + '</div>';
    }).join('');
  }

  // Another tab changed the queue: repaint, and take over if the runner tab went away.
  window.addEventListener('storage', function (e) {
    if (e.key === QUEUE_KEY || e.key === LOCK_KEY) { render(); if (!running) setTimeout(run, 500); }
  });
  window.addEventListener('pagehide', releaseLock);

  function start() {
    if (!localStorage.getItem('onyx_token')) return; // signed out: leave the queue for next sign-in
    render(); run();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  return {
    add: add, pause: pause, resume: resume, stop: stop, researchLead: researchLead,
    state: read, on: function (fn) { listeners.push(fn); }
  };
})();
