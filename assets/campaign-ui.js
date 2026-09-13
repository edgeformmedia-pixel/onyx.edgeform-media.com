/* Shared campaign-sequence helpers: timeline rendering and the
   "Add to campaign" dialog used by Pipeline and the lead page. */

window.OnyxCampaigns = (function () {
  'use strict';

  var esc = Onyx.esc;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var STEP_COLORS = ['#c9d2db', '#0f6cbd', '#3a8fd6', '#7c5cc4', '#d98a1e', '#0d7a4c', '#b4233d', '#5f6b7a', '#2a9d8f', '#e76f51', '#264653'];

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function call(action, payload) { return Onyx.campaign(action, Object.assign({ today: today() }, payload || {})); }
  function variantLabel(v) { return v === 'existing' ? 'Has laser' : 'First laser'; }
  function statusLabel(s) {
    return { active: 'Active', paused: 'Paused', replied: 'Replied', unsubscribed: 'Unsubscribed', bounced: 'Bounced', finished: 'Finished', removed: 'Removed', archived: 'Archived' }[s] || s;
  }
  function day(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : '';
  }
  function localDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? day(iso) : MONTHS[d.getMonth()] + ' ' + d.getDate();
  }
  function dueLabel(ymd, now) {
    if (!ymd) return '';
    now = now || today();
    if (ymd < now) return 'Overdue';
    if (ymd === now) return 'Due today';
    return day(ymd);
  }

  // sends: this member's send rows. steps: [{stepNo,name}]
  function timeline(member, sends, steps, opts) {
    opts = opts || {};
    var now = opts.today || today();
    return '<div class="timeline">' + steps.map(function (step) {
      var rows = sends.filter(function (s) { return Number(s.memberId) === Number(member.id) && Number(s.stepNo) === step.stepNo; });
      var good = rows.filter(function (s) { return s.status !== 'failed'; });
      var sent = good[good.length - 1];
      var cls = '', label = '', extra = '';
      var isNext = step.stepNo === Number(member.currentStep) + 1;
      if (sent) {
        cls = 'sent';
        var opened = rows.some(function (s) { return Number(s.openCount) > 0; });
        label = '<small>' + esc(localDay(sent.at)) + '</small>' + (opened ? '<small class="open">opened</small>' : '');
      } else if (rows.length && isNext) {
        cls = 'failed'; label = '<small>failed</small>';
      }
      if (!sent && isNext && member.status === 'active' && member.nextDueAt) {
        if (member.nextDueAt <= now) {
          cls = 'due';
          label = '<small class="due">' + esc(dueLabel(member.nextDueAt, now)) + '</small>';
          if (opts.sendable) extra = '<button class="tl-send" type="button" data-send-member="' + member.id + '">Send?</button>';
        } else {
          cls = cls || 'next';
          label = label || '<small>' + esc(day(member.nextDueAt)) + '</small>';
        }
      } else if (!sent && isNext && member.status === 'paused') {
        label = '<small>paused</small>';
      }
      var title = 'Email ' + step.stepNo + (step.name ? ' · ' + step.name : '');
      return '<div class="tl-step ' + cls + '" title="' + esc(title) + '"><span class="tl-dot">' + (cls === 'sent' ? '✓' : step.stepNo) + '</span>' + label + extra + '</div>';
    }).join('') + '</div>';
  }

  /* ── Add to campaign dialog ─────────────────────────────── */

  var dialog, state;

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'campaign-dialog seq-dialog narrow';
    dialog.innerHTML =
      '<div class="dialog-shell">' +
        '<div class="dialog-header"><div><p class="eyebrow">Email sequence</p><h2>Add to campaign</h2><p class="hint" id="enrollSub"></p></div><button class="dialog-close" type="button" data-close aria-label="Close">×</button></div>' +
        '<div class="dialog-body" id="enrollBody"></div>' +
        '<div class="dialog-footer"><span class="msg" id="enrollMsg"></span><div><button class="btn quiet" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="enrollNext">Next</button></div></div>' +
      '</div>';
    document.body.appendChild(dialog);
    dialog.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) { dialog.close(); return; }
      var toggle = e.target.closest('[data-variant-lead]');
      if (toggle && state && state.plan) {
        var id = toggle.dataset.variantLead, item = state.plan.planned.find(function (p) { return String(p.leadId) === id; });
        if (!item) return;
        item.variant = item.variant === 'existing' ? 'first' : 'existing';
        state.overrides[id] = item.variant;
        toggle.className = 'seq-variant ' + item.variant;
        toggle.textContent = variantLabel(item.variant);
        renderPlanCounts();
      }
    });
    dialog.querySelector('#enrollNext').addEventListener('click', function () { if (state && state.next) state.next(); });
    return dialog;
  }

  function setMsg(text, kind) { Onyx.msg(dialog.querySelector('#enrollMsg'), text, kind); }

  function renderPlanCounts() {
    var el = dialog.querySelector('#enrollCounts');
    if (!el || !state.plan) return;
    var first = state.plan.planned.filter(function (p) { return p.variant !== 'existing'; }).length;
    el.innerHTML = '<span class="tag ok">' + state.plan.planned.length + ' will be added</span>' +
      '<span class="tag">' + first + ' first laser</span><span class="tag">' + (state.plan.planned.length - first) + ' has laser</span>' +
      (state.plan.skipped.length ? '<span class="tag review">' + state.plan.skipped.length + ' skipped</span>' : '');
  }

  function stepChoose(leadIds) {
    var body = dialog.querySelector('#enrollBody'), next = dialog.querySelector('#enrollNext');
    body.innerHTML = '<p class="hint">Loading campaigns…</p>';
    next.disabled = true; next.textContent = 'Next';
    call('listCampaigns', {}).then(function (r) {
      if (!r.ok) { body.innerHTML = '<p class="msg bad">' + esc(r.error || 'Could not load campaigns.') + '</p>'; return; }
      var open = (r.campaigns || []).filter(function (c) { return c.status !== 'archived'; });
      var senders = (Onyx.cfg.FROM_OPTIONS || ['customerrelations']);
      body.innerHTML =
        '<div class="seq-form">' +
          '<div><label for="enrollCampaign">Campaign</label><select id="enrollCampaign">' +
            open.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + ' · ' + c.total + ' leads' + (c.status === 'paused' ? ' (paused)' : '') + '</option>'; }).join('') +
            '<option value="__new">+ Create a new campaign…</option></select></div>' +
          '<div id="enrollNew" hidden class="seq-form">' +
            '<div><label for="enrollName">New campaign name</label><input id="enrollName" maxlength="80" placeholder="Detroit med spas – ' + MONTHS[new Date().getMonth()] + '"></div>' +
            '<div><label for="enrollFrom">Send from</label><select id="enrollFrom">' + senders.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '@' + esc(Onyx.cfg.SEND_DOMAIN || 'onyxmedicalgroups.com') + '</option>'; }).join('') + '</select></div>' +
          '</div>' +
          '<p class="hint">Each lead gets the “first laser” or “has laser” version of every email, picked from their researched services. You can switch any lead on the next screen.</p>' +
        '</div>';
      var select = body.querySelector('#enrollCampaign');
      function sync() { body.querySelector('#enrollNew').hidden = select.value !== '__new'; }
      if (!open.length) select.value = '__new';
      select.addEventListener('change', sync); sync();
      next.disabled = false;
      state.next = function () {
        if (select.value !== '__new') { stepReview(leadIds, select.value, select.options[select.selectedIndex].textContent.split(' · ')[0]); return; }
        var name = body.querySelector('#enrollName').value.trim();
        if (!name) { setMsg('Name the new campaign.', 'bad'); return; }
        next.disabled = true; setMsg('Creating campaign…');
        call('createCampaign', { name: name, fromLocal: body.querySelector('#enrollFrom').value }).then(function (created) {
          next.disabled = false;
          if (!created.ok) { setMsg(created.error || 'Could not create the campaign.', 'bad'); return; }
          setMsg('');
          stepReview(leadIds, created.id, name);
        });
      };
    });
  }

  function stepReview(leadIds, campaignId, campaignName) {
    var body = dialog.querySelector('#enrollBody'), next = dialog.querySelector('#enrollNext');
    body.innerHTML = '<p class="hint">Checking ' + leadIds.length + ' lead' + (leadIds.length === 1 ? '' : 's') + '…</p>';
    next.disabled = true;
    call('enrollLeads', { campaignId: campaignId, leadIds: leadIds, dryRun: true }).then(function (plan) {
      if (!plan.ok) { body.innerHTML = '<p class="msg bad">' + esc(plan.error || 'Could not check these leads.') + '</p>'; return; }
      state.plan = plan;
      body.innerHTML =
        '<p class="hint">Campaign: <b>' + esc(campaignName) + '</b>. Email 1 becomes due right away; you still click <b>Send</b> on the Campaigns tab.</p>' +
        '<div class="seq-enroll-summary" id="enrollCounts"></div>' +
        (plan.planned.length > 50 ? '<p class="seq-warning">Emails go out at most 50 at a time. For deliverability, spread large campaigns over several days instead of sending everything at once.</p>' : '') +
        (plan.planned.length ? '<div class="seq-enroll-list">' + plan.planned.map(function (p) {
          return '<div><span><b>' + esc(p.name) + '</b><small>' + esc([p.dmName, p.email].filter(Boolean).join(' · ')) + '</small><small>' + esc(p.variantReason) + '</small></span>' +
            '<button type="button" class="seq-variant ' + p.variant + '" data-variant-lead="' + esc(p.leadId) + '" title="Click to switch email version">' + variantLabel(p.variant) + '</button></div>';
        }).join('') + '</div>' : '<p class="seq-warning">None of these leads can be added.</p>') +
        (plan.skipped.length ? '<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">Why ' + plan.skipped.length + ' lead' + (plan.skipped.length === 1 ? ' was' : 's were') + ' skipped</summary><div class="seq-enroll-list skipped" style="margin-top:6px">' +
          plan.skipped.map(function (s) { return '<div><span>' + esc(s.name || s.leadId) + '</span><small>' + esc(s.reason) + '</small></div>'; }).join('') + '</div></details>' : '');
      renderPlanCounts();
      next.textContent = plan.planned.length ? 'Add ' + plan.planned.length + ' to campaign' : 'Close';
      next.disabled = false;
      state.next = function () {
        if (!plan.planned.length) { dialog.close(); return; }
        next.disabled = true; setMsg('Adding leads…');
        call('enrollLeads', { campaignId: campaignId, leadIds: plan.planned.map(function (p) { return p.leadId; }), variants: state.overrides }).then(function (done) {
          if (!done.ok) { next.disabled = false; setMsg(done.error || 'Could not add these leads.', 'bad'); return; }
          body.innerHTML = '<div class="seq-banner good"><div><b>' + done.added + ' lead' + (done.added === 1 ? '' : 's') + ' added to ' + esc(campaignName) + '</b><p>Email 1 is now waiting in “Due today” on the Campaigns tab.</p></div></div>' +
            (done.skipped && done.skipped.length ? '<p class="hint">' + done.skipped.length + ' skipped.</p>' : '');
          setMsg('');
          next.disabled = false; next.textContent = 'Open campaign';
          state.next = function () { location.href = '/campaigns/?id=' + encodeURIComponent(campaignId); };
          if (state.onDone) state.onDone(done);
        });
      };
    });
  }

  function enroll(leadIds, opts) {
    leadIds = (leadIds || []).filter(Boolean);
    if (!leadIds.length) return;
    ensureDialog();
    state = { overrides: {}, plan: null, next: null, onDone: opts && opts.onDone };
    dialog.querySelector('#enrollSub').textContent = leadIds.length + ' lead' + (leadIds.length === 1 ? '' : 's') + ' selected';
    setMsg('');
    dialog.showModal();
    stepChoose(leadIds);
  }

  return {
    today: today, call: call, day: day, localDay: localDay, dueLabel: dueLabel, variantLabel: variantLabel,
    statusLabel: statusLabel, timeline: timeline, enroll: enroll, STEP_COLORS: STEP_COLORS
  };
})();
