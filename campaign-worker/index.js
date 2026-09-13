import { DEFAULT_SEQUENCE } from './sequence-content.js';

const SEND_DOMAIN = 'onyxmedicalgroups.com';
const REPLY_TO = 'team@onyxmedicalgroups.com';
const TRACKING_ORIGIN = 'https://onyx-campaigns.edgeformmedia.workers.dev';
const MAX_BATCH_SIZE = 50;
const DAILY_CAP = 400;
const DEFAULT_SEQUENCE_ID = 'onyx-first-outreach';
const VARIANTS = ['first', 'existing'];
const CLOSED_STAGES = ['Won', 'Lost', 'Do Not Contact'];
const OPEN_MEMBER = ['active', 'paused'];
const ALLOWED_ORIGINS = new Set([
  'https://onyx.edgeform-media.com',
  'https://crm.edgeform-media.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
]);
const LASER_RE = /laser hair|hair removal|\blhr\b|diode laser|gentlemax|candela|soprano|splendor x|lightsheer|motus ax|elysion|cutera|lumenis|alexandrite|nd:yag/i;

function text(value) { return String(value ?? '').trim(); }
function now() { return new Date().toISOString(); }
function todayFrom(body) { const t = text(body && body.today); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : now().slice(0, 10); }
function esc(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function firstWord(value) { return text(value).split(/\s+/)[0] || ''; }
function parseData(row) { try { return JSON.parse(row.data || '{}'); } catch { return {}; } }
function asText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value); }

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://onyx.edgeform-media.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

async function authenticatedUser(env, token) {
  if (!token) return null;
  return env.DB.prepare("SELECT u.username,u.name,u.email,u.role,coalesce(u.phone,'') phone,coalesce(u.sender_first_name,'') senderFirstName FROM sessions s JOIN users u ON u.username=s.username WHERE s.token=? AND s.expires>? AND u.active=1")
    .bind(token, now()).first();
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(text(value));
}

function primaryEmail(value) {
  return text(value).split(/[,;\s]+/)[0].toLowerCase();
}

function localPart(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function addBusinessDays(dateStr, days) {
  const date = new Date(dateStr + 'T12:00:00Z');
  let left = Math.max(0, Number(days) || 0);
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return date.toISOString().slice(0, 10);
}

async function selectIn(env, before, values, after, extra) {
  const rows = [];
  for (let i = 0; i < values.length; i += 90) {
    const part = values.slice(i, i + 90);
    const sql = before + '(' + part.map(() => '?').join(',') + ')' + (after || '');
    rows.push(...(await env.DB.prepare(sql).bind(...part, ...(extra || [])).all()).results);
  }
  return rows;
}

async function sentTodayCount(env) {
  const dayStart = now().slice(0, 10) + 'T00:00:00.000Z';
  const used = await env.DB.prepare("SELECT count(*) count FROM sends WHERE at>=? AND status<>'failed'").bind(dayStart).first();
  return Number(used && used.count) || 0;
}

async function suppressedSet(env, emails) {
  const list = [...new Set(emails.map(primaryEmail).filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await selectIn(env, 'SELECT email FROM suppressions WHERE email IN ', list);
  return new Set(rows.map(row => row.email));
}

/* ── sending ─────────────────────────────────────────────── */

async function sendThroughResend(env, message, user, trackingToken, extra) {
  const to = text(message.to), subject = text(message.subject);
  const html = text(message.html), plain = text(message.text);
  const fromLocal = localPart(message.fromLocal);
  if (!validEmail(to)) return { ok: false, error: 'Invalid recipient address.' };
  if (!fromLocal) return { ok: false, error: 'Sender name is required.' };
  if (!subject) return { ok: false, error: 'Subject is required.' };
  if (!html && !plain) return { ok: false, error: 'Message body is empty.' };

  const fromName = text(message.fromName || user.name || 'Onyx Medical Groups').replace(/["<>\r\n]/g, '').slice(0, 60);
  const payload = {
    from: `${fromName} <${fromLocal}@${SEND_DOMAIN}>`,
    to: [to],
    subject,
    reply_to: REPLY_TO
  };
  if (html) {
    const pixel = `<img src="${TRACKING_ORIGIN}/track/${trackingToken}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden">`;
    payload.html = html.includes('</body>') ? html.replace('</body>', pixel + '</body>') : html + pixel;
  }
  if (plain) payload.text = plain;
  if (extra && extra.headers) payload.headers = extra.headers;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': (extra && extra.idempotencyKey) || `onyx-campaign/${trackingToken}`
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  return response.ok ? { ok: true, id: result.id } : { ok: false, error: result.message || 'Resend rejected the email.' };
}

async function recordResult(env, user, message, result, trackingToken, campaign) {
  const at = now(), leadId = text(message.leadId), recipient = text(message.to);
  const status = result.ok ? 'waiting' : 'failed';
  await env.DB.prepare('INSERT INTO sends(at,user,lead_id,recipient,from_local,subject,resend_id,status,tracking_token,open_count,campaign_id,campaign_name,body_text) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)')
    .bind(at, user.username, leadId, recipient, localPart(message.fromLocal), text(message.subject), result.id || '', status, trackingToken,
      campaign.id, campaign.name, text(message.text).slice(0, 12000)).run();
  if (leadId && result.ok) {
    await env.DB.batch([
      env.DB.prepare("UPDATE leads SET last_contacted=?,updated_at=?,stage=CASE WHEN stage IN ('New Lead','Ready to Call') THEN 'Contacted' ELSE stage END WHERE id=?").bind(at, at, leadId),
      env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) SELECT ?,?,id,name,'email',? FROM leads WHERE id=?").bind(at, user.name || user.username, text(message.subject), leadId)
    ]);
  }
  return { leadId, to: recipient, ok: result.ok, id: result.id || '', error: result.error || '', status };
}

// One-off emails from the /email/ page.
async function sendBatch(env, body, user) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not configured on the Campaign Worker.' };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return { ok: false, error: 'Add at least one recipient.' };
  if (messages.length > MAX_BATCH_SIZE) return { ok: false, error: `Sends are limited to ${MAX_BATCH_SIZE} recipients at a time.` };
  const recipients = messages.map(message => text(message && message.to).toLowerCase());
  if (new Set(recipients).size !== recipients.length) return { ok: false, error: 'Each recipient can only appear once in a campaign.' };
  if (messages.some(message => !message || !validEmail(message.to))) return { ok: false, error: 'Correct the invalid recipient before sending.' };
  const suppressed = await suppressedSet(env, recipients);
  if (suppressed.size) return { ok: false, error: 'These recipients unsubscribed or bounced and cannot be emailed: ' + [...suppressed].join(', ') };
  const campaign = {
    id: crypto.randomUUID(),
    name: text(body.campaignName).slice(0, 80) || `Outreach ${now().slice(0, 10)}`
  };
  if (await sentTodayCount(env) + messages.length > DAILY_CAP) return { ok: false, error: `Daily cap of ${DAILY_CAP} would be exceeded.` };

  const results = [];
  for (const message of messages) {
    const trackingToken = crypto.randomUUID().replaceAll('-', '');
    try {
      results.push(await recordResult(env, user, message, await sendThroughResend(env, message, user, trackingToken), trackingToken, campaign));
    } catch (error) {
      console.error(JSON.stringify({ event: 'campaign_send_failed', recipient: text(message.to), message: text(error && error.message) }));
      results.push(await recordResult(env, user, message, { ok: false, error: 'The send request failed.' }, trackingToken, campaign));
    }
  }
  return { ok: results.some(result => result.ok), campaignId: campaign.id, campaignName: campaign.name,
    sent: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length, results };
}

async function listSends(env) {
  const dayStart = now().slice(0, 10) + 'T00:00:00.000Z';
  const [rowsResult, stats] = await Promise.all([
    env.DB.prepare("SELECT s.id,s.at,s.user,s.lead_id leadId,coalesce(l.name,'') leadName,s.recipient,s.from_local fromLocal,s.subject,s.resend_id resendId,s.status,s.opened_at openedAt,coalesce(s.open_count,0) openCount,coalesce(s.campaign_id,'') campaignId,coalesce(s.campaign_name,'') campaignName,coalesce(s.body_text,'') bodyText,s.step_no stepNo FROM sends s LEFT JOIN leads l ON l.id=s.lead_id ORDER BY s.at DESC LIMIT 250").all(),
    env.DB.prepare("SELECT count(*) total,sum(CASE WHEN at>=? AND status<>'failed' THEN 1 ELSE 0 END) sentToday,sum(CASE WHEN coalesce(open_count,0)>0 THEN 1 ELSE 0 END) opened,sum(CASE WHEN status='replied' THEN 1 ELSE 0 END) replied,sum(CASE WHEN status='waiting' THEN 1 ELSE 0 END) waiting,sum(CASE WHEN status IN ('failed','bounced') THEN 1 ELSE 0 END) failed FROM sends").bind(dayStart).first()
  ]);
  return { ok: true, sends: rowsResult.results, stats: stats || {} };
}

async function listCampaignLeads(env, body) {
  const audience = text(body.audience) || 'never';
  const terms = ["trim(coalesce(l.email,''))<>''", "l.stage NOT IN ('Won','Lost','Do Not Contact')"];
  const params = [];
  if (audience === 'never') terms.push('NOT EXISTS (SELECT 1 FROM sends sx WHERE sx.lead_id=l.id AND sx.status<>\'failed\')');
  if (audience === 'emailed') terms.push('EXISTS (SELECT 1 FROM sends sx WHERE sx.lead_id=l.id AND sx.status<>\'failed\')');
  if (text(body.stage)) { terms.push('l.stage=?'); params.push(text(body.stage)); }
  if (text(body.q)) {
    terms.push("lower(l.name||' '||coalesce(l.dm_name,'')||' '||coalesce(l.email,'')||' '||coalesce(l.city,'')||' '||coalesce(l.state,'')) LIKE ?");
    params.push('%' + text(body.q).toLowerCase() + '%');
  }
  const where = ' WHERE ' + terms.join(' AND ');
  const total = await env.DB.prepare('SELECT count(*) count FROM leads l' + where).bind(...params).first();
  const rows = (await env.DB.prepare(
    "SELECT l.id,l.name,l.email,l.dm_name dmName,l.city,l.state,l.stage,l.lead_score leadScore," +
    "(SELECT max(s.at) FROM sends s WHERE s.lead_id=l.id AND s.status<>'failed') lastEmailedAt," +
    "(SELECT count(*) FROM sends s WHERE s.lead_id=l.id AND s.status<>'failed') emailCount " +
    'FROM leads l' + where +
    " ORDER BY CASE WHEN lastEmailedAt IS NULL THEN 0 ELSE 1 END,l.lead_score DESC,l.updated_at DESC LIMIT 200"
  ).bind(...params).all()).results;
  return { ok: true, total: Number(total && total.count) || 0, leads: rows };
}

async function setSendStatus(env, body, user) {
  const status = text(body.status);
  if (!['waiting', 'replied', 'bounced', 'failed'].includes(status)) return { ok: false, error: 'Invalid email status.' };
  const row = await env.DB.prepare('SELECT * FROM sends WHERE id=?').bind(Number(body.id) || 0).first();
  if (!row) return { ok: false, error: 'Email record not found.' };
  await env.DB.prepare('UPDATE sends SET status=? WHERE id=?').bind(status, row.id).run();
  if (row.member_id && (status === 'replied' || status === 'bounced')) {
    await applyMemberStatus(env, [row.member_id], status, user);
  } else if (row.lead_id) {
    await env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) SELECT ?,?,id,name,'email-status',? FROM leads WHERE id=?")
      .bind(now(), user.name || user.username, 'Email marked ' + status, row.lead_id).run();
  }
  return { ok: true };
}

/* ── sequences ───────────────────────────────────────────── */

async function ensureDefaultSequence(env, user) {
  const existing = await env.DB.prepare('SELECT id FROM sequences WHERE id=?').bind(DEFAULT_SEQUENCE_ID).first();
  if (existing) return DEFAULT_SEQUENCE_ID;
  const at = now();
  const statements = [env.DB.prepare('INSERT OR IGNORE INTO sequences(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)')
    .bind(DEFAULT_SEQUENCE_ID, DEFAULT_SEQUENCE.name, user ? user.username : 'system', at, at)];
  for (const step of DEFAULT_SEQUENCE.steps) {
    for (const variant of VARIANTS) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO sequence_steps(sequence_id,step_no,variant,name,subject,body,delay_days) VALUES(?,?,?,?,?,?,?)')
        .bind(DEFAULT_SEQUENCE_ID, step.stepNo, variant, step.name, step[variant].subject, step[variant].body, step.delayDays));
    }
  }
  await env.DB.batch(statements);
  return DEFAULT_SEQUENCE_ID;
}

async function loadSequence(env, id) {
  const sequence = await env.DB.prepare('SELECT id,name,updated_at updatedAt FROM sequences WHERE id=?').bind(id).first();
  if (!sequence) return null;
  const rows = (await env.DB.prepare('SELECT * FROM sequence_steps WHERE sequence_id=? ORDER BY step_no').bind(id).all()).results;
  const steps = {};
  for (const row of rows) {
    const step = steps[row.step_no] || (steps[row.step_no] = { stepNo: row.step_no, name: row.name, delayDays: row.delay_days });
    step[row.variant] = { subject: row.subject, body: row.body };
  }
  sequence.steps = Object.values(steps).sort((a, b) => a.stepNo - b.stepNo);
  return sequence;
}

async function getSequence(env, body, user) {
  await ensureDefaultSequence(env, user);
  const sequence = await loadSequence(env, text(body.id) || DEFAULT_SEQUENCE_ID);
  return sequence ? { ok: true, sequence } : { ok: false, error: 'Sequence not found.' };
}

async function saveSequence(env, body, user) {
  if (user.role !== 'admin') return { ok: false, error: 'Only admins can edit campaign emails.' };
  const id = text(body.id) || DEFAULT_SEQUENCE_ID;
  const existing = await env.DB.prepare('SELECT id FROM sequences WHERE id=?').bind(id).first();
  if (!existing) return { ok: false, error: 'Sequence not found.' };
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!steps.length || steps.length > 10) return { ok: false, error: 'A sequence needs between 1 and 10 emails.' };
  const statements = [env.DB.prepare('DELETE FROM sequence_steps WHERE sequence_id=?').bind(id)];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const delay = Math.round(Number(step.delayDays));
    if (!(delay >= 0 && delay <= 60)) return { ok: false, error: `Email ${i + 1}: wait must be 0–60 business days.` };
    for (const variant of VARIANTS) {
      const copy = step[variant] || {};
      if (!text(copy.subject) || !text(copy.body)) return { ok: false, error: `Email ${i + 1} (${variant === 'first' ? 'first laser' : 'has laser'}) needs a subject and body.` };
      statements.push(env.DB.prepare('INSERT INTO sequence_steps(sequence_id,step_no,variant,name,subject,body,delay_days) VALUES(?,?,?,?,?,?,?)')
        .bind(id, i + 1, variant, text(step.name).slice(0, 60) || `Email ${i + 1}`, text(copy.subject).slice(0, 180), String(copy.body).slice(0, 12000), delay));
    }
  }
  statements.push(env.DB.prepare('UPDATE sequences SET name=?,updated_at=? WHERE id=?').bind(text(body.name).slice(0, 80) || DEFAULT_SEQUENCE.name, now(), id));
  await env.DB.batch(statements);
  return { ok: true, sequence: await loadSequence(env, id) };
}

function detectVariant(row) {
  const data = parseData(row);
  if (data.hasLaser === 'yes') return { variant: 'existing', reason: 'Marked “has laser machine” in Pipeline' };
  if (data.hasLaser === 'no') return { variant: 'first', reason: 'Marked “no laser machine” in Pipeline' };
  const hay =[data.services, data.existingEquipment].map(asText).join(' ');
  const match = hay.match(LASER_RE);
  if (match && !/\b(no|not|doesn.t|does not|without)\b[^.]{0,30}laser/i.test(hay)) {
    return { variant: 'existing', reason: `Research mentions “${match[0]}”` };
  }
  return { variant: 'first', reason: hay.trim() ? 'No laser hair removal in researched services' : 'Services not researched — defaulted to first laser' };
}

function leadVars(lead, user) {
  const dm = text(lead.dm_name).replace(/^(dr|mr|mrs|ms)\.?\s+/i, '');
  const first = dm && !/^unknown$/i.test(dm) ? firstWord(dm) : '';
  return {
    business: text(lead.name) || 'your practice',
    firstName: first || 'there',
    city: text(lead.city) || 'your area',
    state: text(lead.state),
    repFirstName: text(user.senderFirstName) || firstWord(user.name),
    repName: text(user.name),
    repPhone: text(user.phone),
    repEmail: REPLY_TO
  };
}

function renderCopy(copy, vars) {
  const problems = new Set();
  const merge = template => String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (token, key) => {
    if (!Object.hasOwn(vars, key)) { problems.add(`Unknown variable {{${key}}}`); return token; }
    if (key === 'repPhone' && !vars.repPhone) problems.add('Add your phone number under “Your signature” on the Campaigns page.');
    if (key === 'repFirstName' && (!vars.repFirstName || /^admin$/i.test(vars.repFirstName))) problems.add('Set your sender first name under “Your signature” on the Campaigns page.');
    return vars[key];
  });
  return { subject: merge(copy.subject), body: merge(copy.body).replace(/\n{3,}/g, '\n\n').trim(), problems: [...problems] };
}

// ONYX_EMAIL_DESIGN — keep identical in campaign-worker/index.js and email/index.html.
function onyxEmailHtml(bodyText, opts) {
  opts = opts || {};
  var escHtml = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  var blocks = String(bodyText || '').replace(/\r/g, '').trim().split(/\n{2,}/).map(function (part) {
    var lines = part.split('\n');
    if (lines.every(function (l) { return /^\s*[•\-–]\s+/.test(l); })) {
      return '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:2px 0 18px;border-collapse:collapse">' + lines.map(function (l) {
        var item = escHtml(l.replace(/^\s*[•\-–]\s+/, '')).replace(/^([^—:]{2,60})(\s+—\s+|:\s+)/, '<strong style="color:#111111">$1</strong>$2');
        return '<tr><td valign="top" style="padding:3px 12px 3px 2px;font:15px/1.6 ' + font + ';color:#b08d57">&#9670;</td><td style="padding:3px 0;font:15px/1.6 ' + font + ';color:#2b2b2b">' + item + '</td></tr>';
      }).join('') + '</table>';
    }
    if (/^(best|thanks|thank you|regards|kind regards|cheers|talk soon),?$/i.test(lines[0].trim()) && lines.length > 1) {
      return '<p style="margin:26px 0 0;font:15px/1.6 ' + font + ';color:#2b2b2b">' + escHtml(lines[0]) + '</p>' +
        '<p style="margin:2px 0 0;font:600 16px/1.5 ' + font + ';color:#111111">' + escHtml(lines[1]) + '</p>' +
        (lines.length > 2 ? '<p style="margin:2px 0 0;font:13px/1.6 ' + font + ';color:#6b6b6b">' + lines.slice(2).map(escHtml).join('<br>') + '</p>' : '');
    }
    if (/^\s*[“"]/.test(part) && /[”"]\s*$/.test(part)) {
      return '<p style="margin:0 0 18px;padding:4px 0 4px 16px;border-left:3px solid #b08d57;font:italic 16px/1.6 Georgia,serif;color:#3a3a3a">' + escHtml(part).replace(/\n/g, '<br>') + '</p>';
    }
    return '<p style="margin:0 0 18px;font:15px/1.7 ' + font + ';color:#2b2b2b">' + escHtml(part).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  var footerLines = [];
  if (opts.postal) footerLines.push(escHtml(opts.postal));
  if (opts.optOutHtml) footerLines.push(opts.optOutHtml);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>' +
    '<body style="margin:0;padding:0;background:#f3f2ef">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f2ef;border-collapse:collapse"><tr><td align="center" style="padding:28px 12px">' +
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid #e6e3dd;border-radius:12px">' +
    '<tr><td style="height:4px;line-height:4px;font-size:0;background:#111111;border-radius:12px 12px 0 0">&nbsp;</td></tr>' +
    '<tr><td style="padding:36px 40px 18px">' + blocks + '</td></tr>' +
    '<tr><td style="padding:0 40px"><div style="height:1px;line-height:1px;font-size:0;background:#ece9e3">&nbsp;</div></td></tr>' +
    '<tr><td align="center" style="padding:26px 40px 30px">' +
    '<a href="https://www.instagram.com/onyxmedicalgroups/" style="text-decoration:none"><img src="https://onyx.edgeform-media.com/assets/onyx-medical-groups-logo.jpg" width="92" height="92" alt="Onyx Medical Groups" style="display:block;width:92px;height:92px;border:0;margin:0 auto"></a>' +
    '<p style="margin:10px 0 0;font:12px/1.6 ' + font + ';color:#6b6b6b">Equipment, training &amp; launch support for medical aesthetics practices</p>' +
    '<p style="margin:6px 0 0;font:12px/1.6 ' + font + '"><a href="https://www.instagram.com/onyxmedicalgroups/" style="color:#b08d57;text-decoration:none;font-weight:600">@onyxmedicalgroups</a></p>' +
    (footerLines.length ? '<p style="margin:14px 0 0;font:11px/1.6 ' + font + ';color:#9a9a9a">' + footerLines.join('<br>') + '</p>' : '') +
    '</td></tr></table>' +
    '</td></tr></table></body></html>';
}

function sequenceEmailHtml(body, unsubUrl, postal) {
  return onyxEmailHtml(body, {
    postal,
    optOutHtml: `Not the right fit? <a href="${unsubUrl}" style="color:#9a9a9a;text-decoration:underline">Unsubscribe</a> and we won’t email you again.`
  });
}

function sequenceEmailText(body, unsubUrl, postal) {
  return `${body}\n\n--\nOnyx Medical Groups · ${postal}\nUnsubscribe: ${unsubUrl}`;
}

/* ── settings + profile ──────────────────────────────────── */

async function settingsMap(env) {
  const rows = (await env.DB.prepare('SELECT key,value FROM campaign_settings').all()).results;
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

async function saveSettings(env, body, user) {
  const statements = [];
  if (Object.hasOwn(body, 'postalAddress')) {
    if (user.role !== 'admin') return { ok: false, error: 'Only admins can change the postal address.' };
    statements.push(env.DB.prepare('INSERT INTO campaign_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .bind('postalAddress', text(body.postalAddress).slice(0, 200), now(), user.username));
  }
  if (Object.hasOwn(body, 'phone') || Object.hasOwn(body, 'senderFirstName')) {
    const phone = text(body.phone).replace(/[^\d+().\-\s]/g, '').slice(0, 30);
    const senderFirstName = text(body.senderFirstName).replace(/[^\p{L}\p{M}'\- ]/gu, '').slice(0, 40);
    statements.push(env.DB.prepare('UPDATE users SET phone=?,sender_first_name=? WHERE username=?').bind(phone, senderFirstName, user.username));
  }
  if (statements.length) await env.DB.batch(statements);
  return { ok: true };
}

/* ── campaigns ───────────────────────────────────────────── */

async function createCampaign(env, body, user) {
  const name = text(body.name).slice(0, 80);
  const fromLocal = localPart(body.fromLocal);
  if (!name) return { ok: false, error: 'Name the campaign.' };
  if (!fromLocal) return { ok: false, error: 'Choose a sender address.' };
  const sequenceId = text(body.sequenceId) || await ensureDefaultSequence(env, user);
  const sequence = await env.DB.prepare('SELECT id FROM sequences WHERE id=?').bind(sequenceId).first();
  if (!sequence) return { ok: false, error: 'Sequence not found.' };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO outreach_campaigns(id,name,sequence_id,from_local,status,created_by,created_at) VALUES(?,?,?,?,'active',?,?)")
    .bind(id, name, sequenceId, fromLocal, user.username, now()).run();
  return { ok: true, id };
}

async function updateCampaign(env, body) {
  const campaign = await env.DB.prepare('SELECT * FROM outreach_campaigns WHERE id=?').bind(text(body.id)).first();
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  const status = Object.hasOwn(body, 'status') ? text(body.status) : campaign.status;
  if (!['active', 'paused', 'archived'].includes(status)) return { ok: false, error: 'Invalid campaign status.' };
  const name = Object.hasOwn(body, 'name') ? text(body.name).slice(0, 80) : campaign.name;
  const fromLocal = Object.hasOwn(body, 'fromLocal') ? localPart(body.fromLocal) : campaign.from_local;
  if (!name || !fromLocal) return { ok: false, error: 'Campaign name and sender are required.' };
  await env.DB.prepare('UPDATE outreach_campaigns SET name=?,status=?,from_local=? WHERE id=?').bind(name, status, fromLocal, campaign.id).run();
  return { ok: true };
}

async function listCampaigns(env, body, user) {
  await ensureDefaultSequence(env, user);
  const today = todayFrom(body), since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [campaigns, counts, sendStats, stepCounts, settings, sentToday, health, sequences] = await Promise.all([
    env.DB.prepare('SELECT c.id,c.name,c.sequence_id sequenceId,c.from_local fromLocal,c.status,c.created_by createdBy,c.created_at createdAt,s.name sequenceName FROM outreach_campaigns c LEFT JOIN sequences s ON s.id=c.sequence_id ORDER BY CASE c.status WHEN \'active\' THEN 0 WHEN \'paused\' THEN 1 ELSE 2 END,c.created_at DESC').all(),
    env.DB.prepare("SELECT campaign_id,status,current_step,count(*) n,sum(CASE WHEN status='active' AND next_due_at<=? THEN 1 ELSE 0 END) due FROM campaign_members GROUP BY campaign_id,status,current_step").bind(today).all(),
    env.DB.prepare("SELECT campaign_id,sum(CASE WHEN status<>'failed' THEN 1 ELSE 0 END) sent,count(DISTINCT CASE WHEN coalesce(open_count,0)>0 THEN member_id END) opened FROM sends WHERE member_id IS NOT NULL GROUP BY campaign_id").all(),
    env.DB.prepare('SELECT sequence_id,count(DISTINCT step_no) steps FROM sequence_steps GROUP BY sequence_id').all(),
    settingsMap(env),
    sentTodayCount(env),
    env.DB.prepare("SELECT (SELECT count(*) FROM sends WHERE at>=? AND status<>'failed') sent,(SELECT count(*) FROM suppressions WHERE at>=? AND reason='bounced') bounced,(SELECT count(*) FROM suppressions WHERE at>=? AND reason='unsubscribed') unsubscribed").bind(since, since, since).first(),
    env.DB.prepare('SELECT id,name FROM sequences ORDER BY created_at').all()
  ]);
  const stepsBySequence = Object.fromEntries(stepCounts.results.map(row => [row.sequence_id, Number(row.steps) || 0]));
  const sendsByCampaign = Object.fromEntries(sendStats.results.map(row => [row.campaign_id, row]));
  let dueTotal = 0;
  const list = campaigns.results.map(campaign => {
    const steps = stepsBySequence[campaign.sequenceId] || 0;
    const out = { ...campaign, steps, total: 0, due: 0, byStatus: {}, byStep: Array(steps + 1).fill(0), sent: 0, opened: 0 };
    for (const row of counts.results) {
      if (row.campaign_id !== campaign.id) continue;
      const n = Number(row.n) || 0;
      out.total += n;
      out.byStatus[row.status] = (out.byStatus[row.status] || 0) + n;
      if (OPEN_MEMBER.includes(row.status)) out.byStep[Math.min(steps, Number(row.current_step) || 0)] += n;
      if (campaign.status === 'active') out.due += Number(row.due) || 0;
    }
    const stats = sendsByCampaign[campaign.id];
    if (stats) { out.sent = Number(stats.sent) || 0; out.opened = Number(stats.opened) || 0; }
    dueTotal += out.due;
    return out;
  });
  return {
    ok: true, today, campaigns: list, dueTotal, sentToday, dailyCap: DAILY_CAP, maxBatch: MAX_BATCH_SIZE,
    health: { sent30: Number(health.sent) || 0, bounced30: Number(health.bounced) || 0, unsubscribed30: Number(health.unsubscribed) || 0 },
    settings: { postalAddress: settings.postalAddress || '' },
    profile: { name: user.name, role: user.role, phone: user.phone, senderFirstName: user.senderFirstName, repFirstName: text(user.senderFirstName) || firstWord(user.name) },
    sequences: sequences.results
  };
}

async function getCampaign(env, body) {
  const campaign = await env.DB.prepare('SELECT id,name,sequence_id sequenceId,from_local fromLocal,status,created_by createdBy,created_at createdAt FROM outreach_campaigns WHERE id=?').bind(text(body.id)).first();
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  const [sequence, members, sends] = await Promise.all([
    loadSequence(env, campaign.sequenceId),
    env.DB.prepare("SELECT m.id,m.lead_id leadId,m.email,m.variant,m.variant_reason variantReason,m.status,m.current_step currentStep,m.next_due_at nextDueAt,m.last_sent_at lastSentAt,m.enrolled_at enrolledAt,m.status_at statusAt,coalesce(l.name,'(deleted lead)') leadName,coalesce(l.dm_name,'') dmName,coalesce(l.city,'') city,coalesce(l.state,'') state,coalesce(l.stage,'') stage FROM campaign_members m LEFT JOIN leads l ON l.id=m.lead_id WHERE m.campaign_id=? ORDER BY m.enrolled_at DESC LIMIT 3000").bind(campaign.id).all(),
    env.DB.prepare('SELECT id,member_id memberId,step_no stepNo,at,status,coalesce(open_count,0) openCount,opened_at openedAt,subject FROM sends WHERE campaign_id=? AND member_id IS NOT NULL ORDER BY at').bind(campaign.id).all()
  ]);
  return { ok: true, today: todayFrom(body), campaign, sequence, members: members.results, sends: sends.results };
}

async function dueQueue(env, body) {
  const today = todayFrom(body), params = [today];
  let filter = '';
  if (text(body.campaignId)) { filter = ' AND c.id=?'; params.push(text(body.campaignId)); }
  const rows = (await env.DB.prepare(
    "SELECT m.id,m.lead_id leadId,m.email,m.variant,m.current_step currentStep,m.next_due_at nextDueAt,c.id campaignId,c.name campaignName,c.from_local fromLocal," +
    "coalesce(l.name,'') leadName,coalesce(l.city,'') city,coalesce(l.stage,'') stage,st.name stepName,st.subject stepSubject " +
    "FROM campaign_members m JOIN outreach_campaigns c ON c.id=m.campaign_id AND c.status='active' LEFT JOIN leads l ON l.id=m.lead_id " +
    "LEFT JOIN sequence_steps st ON st.sequence_id=c.sequence_id AND st.step_no=m.current_step+1 AND st.variant=m.variant " +
    "WHERE m.status='active' AND m.next_due_at<=?" + filter + ' ORDER BY m.next_due_at,c.name,l.name LIMIT 500'
  ).bind(...params).all()).results;
  return { ok: true, today, due: rows };
}

async function memberContext(env, memberId) {
  const member = await env.DB.prepare(
    "SELECT m.*,c.name campaign_name,c.from_local,c.sequence_id,c.status campaign_status,l.name lead_name,l.dm_name,l.city,l.state,l.stage lead_stage FROM campaign_members m JOIN outreach_campaigns c ON c.id=m.campaign_id LEFT JOIN leads l ON l.id=m.lead_id WHERE m.id=?"
  ).bind(Number(memberId) || 0).first();
  if (!member) return null;
  const stepNo = member.current_step + 1;
  const [step, nextStep, last] = await Promise.all([
    env.DB.prepare('SELECT * FROM sequence_steps WHERE sequence_id=? AND step_no=? AND variant=?').bind(member.sequence_id, stepNo, member.variant).first(),
    env.DB.prepare('SELECT delay_days FROM sequence_steps WHERE sequence_id=? AND step_no=? AND variant=?').bind(member.sequence_id, stepNo + 1, member.variant).first(),
    env.DB.prepare('SELECT max(step_no) steps FROM sequence_steps WHERE sequence_id=?').bind(member.sequence_id).first()
  ]);
  return { member, stepNo, step, nextStep, totalSteps: Number(last && last.steps) || 0 };
}

function composeFor(ctx, user, postal) {
  const { member, step } = ctx;
  const vars = leadVars({ name: member.lead_name, dm_name: member.dm_name, city: member.city, state: member.state }, user);
  const rendered = renderCopy({ subject: step.subject, body: step.body }, vars);
  const unsubUrl = `${TRACKING_ORIGIN}/u/${member.unsub_token}`;
  const problems = [...rendered.problems];
  if (!postal) problems.push('An admin needs to add the company postal address on the Campaigns page.');
  return {
    subject: rendered.subject,
    body: rendered.body,
    html: sequenceEmailHtml(rendered.body, unsubUrl, postal || '[postal address]'),
    text: sequenceEmailText(rendered.body, unsubUrl, postal || '[postal address]'),
    from: `${vars.repFirstName || 'Onyx'} at Onyx Medical Groups <${member.from_local}@${SEND_DOMAIN}>`,
    fromName: `${vars.repFirstName || 'Onyx'} at Onyx Medical Groups`,
    unsubUrl, problems
  };
}

async function previewMember(env, body, user) {
  const ctx = await memberContext(env, body.id);
  if (!ctx) return { ok: false, error: 'Campaign lead not found.' };
  if (!ctx.step) return { ok: false, error: 'This lead has no more emails in the sequence.' };
  const settings = await settingsMap(env);
  const email = composeFor(ctx, user, settings.postalAddress);
  const today = todayFrom(body);
  if (ctx.member.status !== 'active') email.problems.unshift(`This lead is ${ctx.member.status}.`);
  else if (!ctx.member.next_due_at || ctx.member.next_due_at > today) email.problems.unshift(`Not due until ${ctx.member.next_due_at || 'later'} — use “Make due today” to send early.`);
  return { ok: true, to: ctx.member.email, from: email.from, replyTo: REPLY_TO, subject: email.subject, html: email.html, text: email.text,
    stepNo: ctx.stepNo, stepName: ctx.step.name, totalSteps: ctx.totalSteps, variant: ctx.member.variant, campaignName: ctx.member.campaign_name,
    leadName: ctx.member.lead_name, problems: email.problems };
}

async function sendMembers(env, body, user) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not configured on the Campaign Worker.' };
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => n > 0))];
  if (!ids.length) return { ok: false, error: 'Choose at least one lead to email.' };
  if (ids.length > MAX_BATCH_SIZE) return { ok: false, error: `Send at most ${MAX_BATCH_SIZE} emails at a time.` };
  const settings = await settingsMap(env);
  if (!settings.postalAddress) return { ok: false, error: 'An admin needs to add the company postal address on the Campaigns page before sending.' };
  const sentToday = await sentTodayCount(env);
  if (sentToday + ids.length > DAILY_CAP) return { ok: false, error: `Daily cap of ${DAILY_CAP} would be exceeded (${sentToday} sent today).` };
  const today = todayFrom(body);

  const results = [];
  for (const id of ids) {
    const result = { memberId: id, ok: false };
    results.push(result);
    try {
      const ctx = await memberContext(env, id);
      if (!ctx) { result.error = 'Not found.'; continue; }
      const { member } = ctx;
      Object.assign(result, { leadName: member.lead_name || '', email: member.email, stepNo: ctx.stepNo });
      if (member.status !== 'active') { result.error = `Lead is ${member.status}.`; continue; }
      if (member.campaign_status !== 'active') { result.error = 'Campaign is paused.'; continue; }
      if (!member.next_due_at || member.next_due_at > today) { result.error = `Email ${ctx.stepNo} isn’t due until ${member.next_due_at || 'later'}. Use “Make due today” to send it early.`; continue; }
      if (CLOSED_STAGES.includes(member.lead_stage)) { result.error = `Lead stage is ${member.lead_stage}.`; continue; }
      if ((await suppressedSet(env, [member.email])).size) {
        await env.DB.prepare("UPDATE campaign_members SET status='unsubscribed',status_at=?,next_due_at=NULL WHERE id=?").bind(now(), member.id).run();
        result.error = 'Address is unsubscribed or bounced.'; continue;
      }
      if (!ctx.step) {
        await env.DB.prepare("UPDATE campaign_members SET status='finished',status_at=?,next_due_at=NULL WHERE id=?").bind(now(), member.id).run();
        result.error = 'Sequence already finished.'; continue;
      }
      const email = composeFor(ctx, user, settings.postalAddress);
      if (email.problems.length) { result.error = email.problems.join(' '); continue; }

      const staleClaim = new Date(Date.now() - 10 * 60e3).toISOString();
      const claim = await env.DB.prepare("UPDATE campaign_members SET sending_at=? WHERE id=? AND status='active' AND current_step=? AND (sending_at IS NULL OR sending_at<?)")
        .bind(now(), member.id, member.current_step, staleClaim).run();
      if (!claim.meta || claim.meta.changes !== 1) { result.error = 'Already being sent.'; continue; }

      const trackingToken = crypto.randomUUID().replaceAll('-', '');
      let sent;
      try {
        sent = await sendThroughResend(env, { to: member.email, subject: email.subject, html: email.html, text: email.text, fromLocal: member.from_local, fromName: email.fromName }, user, trackingToken, {
          idempotencyKey: `onyx-seq/${member.id}/${ctx.stepNo}`,
          headers: { 'List-Unsubscribe': `<${email.unsubUrl}>, <mailto:${REPLY_TO}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        });
      } catch (error) {
        console.error(JSON.stringify({ event: 'sequence_send_failed', memberId: member.id, message: text(error && error.message) }));
        sent = { ok: false, error: 'The send request failed.' };
      }

      const at = now();
      const statements = [
        env.DB.prepare('INSERT INTO sends(at,user,lead_id,recipient,from_local,subject,resend_id,status,tracking_token,open_count,campaign_id,campaign_name,body_text,member_id,step_no) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)')
          .bind(at, user.username, member.lead_id, member.email, member.from_local, email.subject, sent.id || '', sent.ok ? 'waiting' : 'failed', trackingToken,
            member.campaign_id, member.campaign_name, email.body.slice(0, 12000), member.id, ctx.stepNo)
      ];
      if (sent.ok) {
        const finished = !ctx.nextStep;
        statements.push(
          env.DB.prepare('UPDATE campaign_members SET current_step=?,last_sent_at=?,sending_at=NULL,next_due_at=?,status=?,status_at=CASE WHEN ?=\'finished\' THEN ? ELSE status_at END WHERE id=?')
            .bind(ctx.stepNo, at, finished ? null : addBusinessDays(today, ctx.nextStep.delay_days), finished ? 'finished' : 'active', finished ? 'finished' : 'active', at, member.id),
          env.DB.prepare("UPDATE leads SET last_contacted=?,updated_at=?,stage=CASE WHEN stage IN ('New Lead','Researching','Ready to Call') THEN 'Contacted' ELSE stage END WHERE id=?").bind(at, at, member.lead_id),
          env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) SELECT ?,?,id,name,'email',? FROM leads WHERE id=?")
            .bind(at, user.name || user.username, `${member.campaign_name} · Email ${ctx.stepNo} of ${ctx.totalSteps}: ${email.subject}`, member.lead_id)
        );
      } else {
        statements.push(env.DB.prepare('UPDATE campaign_members SET sending_at=NULL WHERE id=?').bind(member.id));
      }
      await env.DB.batch(statements);
      result.ok = sent.ok;
      if (!sent.ok) result.error = sent.error;
    } catch (error) {
      console.error(JSON.stringify({ event: 'sequence_member_error', memberId: id, message: text(error && error.message) }));
      result.error = 'Could not send this email.';
    }
  }
  const sent = results.filter(result => result.ok).length;
  return { ok: sent > 0, sent, failed: results.length - sent, results, sentToday: sentToday + sent, dailyCap: DAILY_CAP };
}

async function enrollLeads(env, body, user) {
  const campaign = await env.DB.prepare('SELECT * FROM outreach_campaigns WHERE id=?').bind(text(body.campaignId)).first();
  if (!campaign) return { ok: false, error: 'Choose a campaign.' };
  if (campaign.status === 'archived') return { ok: false, error: 'That campaign is archived.' };
  const leadIds = [...new Set((Array.isArray(body.leadIds) ? body.leadIds : []).map(text).filter(Boolean))].slice(0, 1000);
  if (!leadIds.length) return { ok: false, error: 'Select at least one lead.' };
  const overrides = body.variants && typeof body.variants === 'object' ? body.variants : {};
  const today = todayFrom(body);

  const [leads, memberships, firstStep] = await Promise.all([
    selectIn(env, 'SELECT id,name,email,stage,dm_name,data FROM leads WHERE id IN ', leadIds),
    selectIn(env, "SELECT m.lead_id,m.campaign_id,m.status,c.name FROM campaign_members m JOIN outreach_campaigns c ON c.id=m.campaign_id WHERE m.lead_id IN ", leadIds),
    env.DB.prepare('SELECT min(delay_days) delay FROM sequence_steps WHERE sequence_id=? AND step_no=1').bind(campaign.sequence_id).first()
  ]);
  const suppressed = await suppressedSet(env, leads.map(lead => lead.email));
  const byId = Object.fromEntries(leads.map(lead => [lead.id, lead]));
  const planned = [], skipped = [];
  for (const leadId of leadIds) {
    const lead = byId[leadId];
    if (!lead) { skipped.push({ leadId, name: '', reason: 'Lead not found' }); continue; }
    const email = primaryEmail(lead.email);
    const skip = reason => skipped.push({ leadId, name: lead.name, reason });
    if (!validEmail(email)) { skip('No valid email'); continue; }
    if (CLOSED_STAGES.includes(lead.stage)) { skip(`Stage is ${lead.stage}`); continue; }
    if (suppressed.has(email)) { skip('Unsubscribed or bounced'); continue; }
    const mine = memberships.filter(row => row.lead_id === leadId);
    if (mine.some(row => row.campaign_id === campaign.id)) { skip('Already in this campaign'); continue; }
    const other = mine.find(row => OPEN_MEMBER.includes(row.status));
    if (other && !body.allowMultiple) { skip(`Already active in “${other.name}”`); continue; }
    const detected = detectVariant(lead);
    const override = VARIANTS.includes(overrides[leadId]) ? overrides[leadId] : '';
    planned.push({ leadId, name: lead.name, email, dmName: text(lead.dm_name), variant: override || detected.variant,
      variantReason: override && override !== detected.variant ? 'Chosen manually' : detected.reason });
  }
  if (body.dryRun) return { ok: true, dryRun: true, planned, skipped };

  const at = now(), dueAt = addBusinessDays(today, firstStep && firstStep.delay);
  for (let i = 0; i < planned.length; i += 50) {
    await env.DB.batch(planned.slice(i, i + 50).map(item =>
      env.DB.prepare("INSERT OR IGNORE INTO campaign_members(campaign_id,lead_id,email,variant,variant_reason,status,current_step,next_due_at,enrolled_at,enrolled_by,unsub_token) VALUES(?,?,?,?,?,'active',0,?,?,?,?)")
        .bind(campaign.id, item.leadId, item.email, item.variant, item.variantReason, dueAt, at, user.username, crypto.randomUUID().replaceAll('-', ''))));
    await env.DB.batch(planned.slice(i, i + 50).map(item =>
      env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) VALUES(?,?,?,?,'campaign',?)")
        .bind(at, user.name || user.username, item.leadId, item.name, `Added to campaign “${campaign.name}” (${item.variant === 'existing' ? 'has laser' : 'first laser'} emails)`)));
  }
  return { ok: true, added: planned.length, planned, skipped };
}

async function applyMemberStatus(env, ids, status, user) {
  const at = now();
  const members = await selectIn(env, 'SELECT m.*,c.name campaign_name,l.name lead_name FROM campaign_members m JOIN outreach_campaigns c ON c.id=m.campaign_id LEFT JOIN leads l ON l.id=m.lead_id WHERE m.id IN ', ids);
  const statements = [];
  const labels = { active: 'Resumed', paused: 'Paused', replied: 'Marked replied', unsubscribed: 'Unsubscribed', bounced: 'Marked bounced', removed: 'Removed from campaign' };
  for (const member of members) {
    if (status === 'active') {
      if ((await suppressedSet(env, [member.email])).size) continue;
      statements.push(env.DB.prepare("UPDATE campaign_members SET status='active',status_at=?,next_due_at=coalesce(next_due_at,?) WHERE id=? AND status<>'finished'").bind(at, at.slice(0, 10), member.id));
    } else {
      statements.push(env.DB.prepare('UPDATE campaign_members SET status=?,status_at=?,next_due_at=CASE WHEN ?=\'paused\' THEN next_due_at ELSE NULL END,sending_at=NULL WHERE id=?').bind(status, at, status, member.id));
    }
    if (status === 'unsubscribed' || status === 'bounced') {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO suppressions(email,reason,lead_id,at) VALUES(?,?,?,?)').bind(member.email, status, member.lead_id, at));
      statements.push(env.DB.prepare("UPDATE campaign_members SET status=?,status_at=?,next_due_at=NULL WHERE email=? AND status IN ('active','paused')").bind(status, at, member.email));
    }
    if (status === 'unsubscribed') statements.push(env.DB.prepare("UPDATE leads SET stage='Do Not Contact',updated_at=? WHERE id=?").bind(at, member.lead_id));
    if (status === 'replied') statements.push(env.DB.prepare("UPDATE sends SET status='replied' WHERE member_id=? AND status='waiting'").bind(member.id));
    statements.push(env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) VALUES(?,?,?,?,'campaign',?)")
      .bind(at, user ? (user.name || user.username) : 'Recipient', member.lead_id, member.lead_name || '', `${labels[status] || status} · ${member.campaign_name}`));
  }
  if (statements.length) await env.DB.batch(statements);
  return members.length;
}

async function updateMembers(env, body, user) {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter(n => n > 0))].slice(0, 1000);
  if (!ids.length) return { ok: false, error: 'Choose at least one lead.' };
  const op = text(body.op);
  if (['active', 'paused', 'replied', 'unsubscribed', 'bounced', 'removed'].includes(op)) {
    return { ok: true, updated: await applyMemberStatus(env, ids, op, user) };
  }
  if (op === 'variant') {
    if (!VARIANTS.includes(text(body.variant))) return { ok: false, error: 'Invalid email version.' };
    for (let i = 0; i < ids.length; i += 50) {
      await env.DB.batch(ids.slice(i, i + 50).map(id => env.DB.prepare("UPDATE campaign_members SET variant=?,variant_reason='Chosen manually' WHERE id=?").bind(text(body.variant), id)));
    }
    return { ok: true, updated: ids.length };
  }
  if (op === 'dueToday') {
    const today = todayFrom(body);
    for (let i = 0; i < ids.length; i += 50) {
      await env.DB.batch(ids.slice(i, i + 50).map(id => env.DB.prepare("UPDATE campaign_members SET next_due_at=? WHERE id=? AND status='active'").bind(today, id)));
    }
    return { ok: true, updated: ids.length };
  }
  if (op === 'skip') {
    const today = todayFrom(body);
    for (const id of ids) {
      const ctx = await memberContext(env, id);
      if (!ctx || !OPEN_MEMBER.includes(ctx.member.status) || !ctx.step) continue;
      const finished = !ctx.nextStep;
      await env.DB.prepare('UPDATE campaign_members SET current_step=?,next_due_at=?,status=? WHERE id=?')
        .bind(ctx.stepNo, finished ? null : addBusinessDays(today, 0), finished ? 'finished' : ctx.member.status, id).run();
    }
    return { ok: true, updated: ids.length };
  }
  return { ok: false, error: 'Unknown change.' };
}

async function leadCampaigns(env, body) {
  const leadId = text(body.leadId);
  const members = (await env.DB.prepare(
    "SELECT m.id,m.campaign_id campaignId,c.name campaignName,c.status campaignStatus,c.sequence_id sequenceId,m.email,m.variant,m.variant_reason variantReason,m.status,m.current_step currentStep,m.next_due_at nextDueAt,m.enrolled_at enrolledAt," +
    "(SELECT count(DISTINCT step_no) FROM sequence_steps st WHERE st.sequence_id=c.sequence_id) steps " +
    'FROM campaign_members m JOIN outreach_campaigns c ON c.id=m.campaign_id WHERE m.lead_id=? ORDER BY m.enrolled_at DESC'
  ).bind(leadId).all()).results;
  const sends = members.length ? await selectIn(env, 'SELECT id,member_id memberId,step_no stepNo,at,status,coalesce(open_count,0) openCount,opened_at openedAt,subject FROM sends WHERE member_id IN ', members.map(m => m.id), ' ORDER BY at') : [];
  const lead = await env.DB.prepare('SELECT id,name,email,stage,dm_name,data FROM leads WHERE id=?').bind(leadId).first();
  const suppressed = lead ? (await suppressedSet(env, [lead.email])).size > 0 : false;
  return { ok: true, today: todayFrom(body), members, sends, suggestedVariant: lead ? detectVariant(lead) : null, suppressed };
}

/* ── suppression list (manual unsubscribes) ──────────────── */

async function suppressEmail(env, email, reason, user) {
  const at = now(), who = user ? (user.name || user.username) : 'Recipient';
  const leads = (await env.DB.prepare("SELECT id,name FROM leads WHERE lower(trim(email))=?").bind(email).all()).results;
  const statements = [
    env.DB.prepare('INSERT INTO suppressions(email,reason,lead_id,at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason,at=excluded.at')
      .bind(email, reason, leads[0] ? leads[0].id : null, at),
    env.DB.prepare("UPDATE campaign_members SET status=?,status_at=?,next_due_at=NULL,sending_at=NULL WHERE email=? AND status IN ('active','paused')").bind(reason, at, email)
  ];
  for (const lead of leads) {
    if (reason === 'unsubscribed') statements.push(env.DB.prepare("UPDATE leads SET stage='Do Not Contact',updated_at=? WHERE id=?").bind(at, lead.id));
    statements.push(env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) VALUES(?,?,?,?,'campaign',?)")
      .bind(at, who, lead.id, lead.name, `${reason === 'bounced' ? 'Marked bounced' : 'Unsubscribed'}: ${email}`));
  }
  await env.DB.batch(statements);
  return leads.length;
}

async function addSuppression(env, body, user) {
  const emails = [...new Set(String(body.emails || body.email || '').split(/[\s,;]+/).map(primaryEmail).filter(Boolean))].slice(0, 200);
  if (!emails.length) return { ok: false, error: 'Enter an email address.' };
  const invalid = emails.filter(email => !validEmail(email));
  if (invalid.length) return { ok: false, error: 'Not a valid email: ' + invalid.join(', ') };
  const reason = text(body.reason) === 'bounced' ? 'bounced' : 'unsubscribed';
  let leads = 0;
  for (const email of emails) leads += await suppressEmail(env, email, reason, user);
  return { ok: true, added: emails.length, leads };
}

async function listSuppressions(env, body) {
  const q = text(body.q).toLowerCase();
  const rows = (await env.DB.prepare(
    "SELECT s.email,s.reason,s.at,s.lead_id leadId,coalesce(l.name,'') leadName FROM suppressions s LEFT JOIN leads l ON l.id=s.lead_id" +
    (q ? ' WHERE s.email LIKE ?' : '') + ' ORDER BY s.at DESC LIMIT 300'
  ).bind(...(q ? ['%' + q + '%'] : [])).all()).results;
  const total = await env.DB.prepare('SELECT count(*) n FROM suppressions').first();
  return { ok: true, suppressions: rows, total: Number(total && total.n) || 0 };
}

async function removeSuppression(env, body, user) {
  if (user.role !== 'admin') return { ok: false, error: 'Only admins can re-allow an unsubscribed address.' };
  const email = primaryEmail(body.email);
  await env.DB.prepare('DELETE FROM suppressions WHERE email=?').bind(email).run();
  return { ok: true };
}

/* ── unsubscribe ─────────────────────────────────────────── */

function unsubscribePage(title, message, form) {
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + esc(title) + '</title></head>' +
    '<body style="margin:0;background:#f4f4f2;font:15px/1.6 Arial,Helvetica,sans-serif;color:#1d1d1d"><div style="max-width:460px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e3e3e0;border-radius:8px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#555">ONYX MEDICAL GROUPS</div><h1 style="font-size:22px;margin:14px 0 8px">' + esc(title) + '</h1><p style="margin:0 0 18px;color:#4a4a4a">' + esc(message) + '</p>' +
    (form || '') + '</div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function unsubscribe(env, token) {
  const member = await env.DB.prepare('SELECT id FROM campaign_members WHERE unsub_token=?').bind(token).first();
  if (member) await applyMemberStatus(env, [member.id], 'unsubscribed', null);
  return !!member;
}

export default {
  async fetch(request, env, ctx) {
    const headers = corsHeaders(request);
    const url = new URL(request.url);
    const unsubMatch = url.pathname.match(/^\/u\/([a-f0-9]{32})$/i);
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (unsubMatch && request.method === 'GET') {
      return unsubscribePage('Unsubscribe', 'Click below and we will stop emailing this address.',
        `<form method="post" action="/u/${unsubMatch[1]}"><button type="submit" style="padding:11px 18px;border:0;border-radius:6px;background:#111;color:#fff;font:600 14px Arial,Helvetica,sans-serif;cursor:pointer">Unsubscribe me</button></form>`);
    }
    if (unsubMatch && request.method === 'POST') {
      try {
        await unsubscribe(env, unsubMatch[1].toLowerCase());
        return unsubscribePage('You’re unsubscribed', 'You won’t receive any more emails from this Onyx Medical Groups campaign. Sorry for the interruption.');
      } catch (error) {
        console.error(JSON.stringify({ event: 'unsubscribe_failed', message: text(error && error.message) }));
        return unsubscribePage('Something went wrong', 'Please reply to the email with “unsubscribe” and we will remove you right away.');
      }
    }
    if (request.method === 'GET') {
      const match = url.pathname.match(/^\/track\/([a-f0-9]{32})\.gif$/i);
      if (match) {
        const openedAt = now();
        ctx.waitUntil(env.DB.prepare('UPDATE sends SET opened_at=coalesce(opened_at,?),open_count=coalesce(open_count,0)+1 WHERE tracking_token=?')
          .bind(openedAt, match[1].toLowerCase()).run());
        return new Response(Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,255,255,255,0,0,0,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]), {
          headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Content-Length': '43' }
        });
      }
      return json({ ok: false, error: 'Not found.' }, 404, headers);
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'POST only.' }, 405, headers);
    try {
      const body = await request.json();
      const user = await authenticatedUser(env, text(body.token));
      if (!user) return json({ ok: false, error: 'SESSION_EXPIRED' }, 401, headers);
      const actions = {
        sendBatch, listSends, listCampaignLeads, setSendStatus,
        listCampaigns, getCampaign, createCampaign, updateCampaign, dueQueue, previewMember, sendMembers,
        enrollLeads, updateMembers, leadCampaigns, getSequence, saveSequence, saveSettings,
        addSuppression, listSuppressions, removeSuppression
      };
      const handler = Object.hasOwn(actions, body.action) ? actions[body.action] : null;
      if (!handler) return json({ ok: false, error: 'Unknown campaign action.' }, 400, headers);
      return json(await handler(env, body, user), 200, headers);
    } catch (error) {
      console.error(JSON.stringify({ event: 'campaign_worker_error', message: text(error && error.message) }));
      return json({ ok: false, error: 'The campaign service could not complete the request.' }, 500, headers);
    }
  }
};
