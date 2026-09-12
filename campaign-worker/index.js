const SEND_DOMAIN = 'onyxmedicalgroups.com';
const REPLY_TO = 'team@onyxmedicalgroups.com';
const TRACKING_ORIGIN = 'https://onyx-campaigns.edgeformmedia.workers.dev';
const MAX_BATCH_SIZE = 10;
const DAILY_CAP = 400;
const ALLOWED_ORIGINS = new Set([
  'https://onyx.edgeform-media.com',
  'https://crm.edgeform-media.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
]);

function text(value) { return String(value ?? '').trim(); }
function now() { return new Date().toISOString(); }

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
  return env.DB.prepare("SELECT u.username,u.name,u.email,u.role FROM sessions s JOIN users u ON u.username=s.username WHERE s.token=? AND s.expires>? AND u.active=1")
    .bind(token, now()).first();
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(text(value));
}

function localPart(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

async function sendThroughResend(env, message, user, trackingToken) {
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
  if (html) payload.html = html + `<img src="${TRACKING_ORIGIN}/track/${trackingToken}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden">`;
  if (plain) payload.text = plain;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `onyx-campaign/${trackingToken}`
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

async function sendBatch(env, body, user) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not configured on the Campaign Worker.' };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return { ok: false, error: 'Add at least one recipient.' };
  if (messages.length > MAX_BATCH_SIZE) return { ok: false, error: `Campaigns are limited to ${MAX_BATCH_SIZE} recipients at a time.` };
  const recipients = messages.map(message => text(message && message.to).toLowerCase());
  if (new Set(recipients).size !== recipients.length) return { ok: false, error: 'Each recipient can only appear once in a campaign.' };
  if (messages.some(message => !message || !validEmail(message.to))) return { ok: false, error: 'Correct the invalid recipient before sending.' };
  const campaign = {
    id: crypto.randomUUID(),
    name: text(body.campaignName).slice(0, 80) || `Outreach ${now().slice(0, 10)}`
  };
  const dayStart = now().slice(0, 10) + 'T00:00:00.000Z';
  const used = await env.DB.prepare("SELECT count(*) count FROM sends WHERE at>=? AND status<>'failed'").bind(dayStart).first();
  if ((Number(used && used.count) || 0) + messages.length > DAILY_CAP) return { ok: false, error: `Daily cap of ${DAILY_CAP} would be exceeded.` };

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
    env.DB.prepare("SELECT s.id,s.at,s.user,s.lead_id leadId,coalesce(l.name,'') leadName,s.recipient,s.from_local fromLocal,s.subject,s.resend_id resendId,s.status,s.opened_at openedAt,coalesce(s.open_count,0) openCount,coalesce(s.campaign_id,'') campaignId,coalesce(s.campaign_name,'') campaignName,coalesce(s.body_text,'') bodyText FROM sends s LEFT JOIN leads l ON l.id=s.lead_id ORDER BY s.at DESC LIMIT 250").all(),
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
  if (row.lead_id) {
    await env.DB.prepare("INSERT INTO activity(at,user,lead_id,lead_name,type,detail) SELECT ?,?,id,name,'email-status',? FROM leads WHERE id=?")
      .bind(now(), user.name || user.username, 'Email marked ' + status, row.lead_id).run();
  }
  return { ok: true };
}

export default {
  async fetch(request, env, ctx) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method === 'GET') {
      const match = new URL(request.url).pathname.match(/^\/track\/([a-f0-9]{32})\.gif$/i);
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
      if (body.action === 'sendBatch') return json(await sendBatch(env, body, user), 200, headers);
      if (body.action === 'listSends') return json(await listSends(env), 200, headers);
      if (body.action === 'listCampaignLeads') return json(await listCampaignLeads(env, body), 200, headers);
      if (body.action === 'setSendStatus') return json(await setSendStatus(env, body, user), 200, headers);
      return json({ ok: false, error: 'Unknown campaign action.' }, 400, headers);
    } catch (error) {
      console.error(JSON.stringify({ event: 'campaign_worker_error', message: text(error && error.message) }));
      return json({ ok: false, error: 'The campaign service could not complete the request.' }, 500, headers);
    }
  }
};
