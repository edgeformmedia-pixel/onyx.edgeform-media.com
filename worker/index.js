/* ═══════════════════════════════════════════════════════════════
   ONYX Worker v5.3 — REGISTRY-FIRST OWNER + CONTACT RESEARCH

   Cloudflare encrypted variables:
     RESEND_API_KEY   re_...
     OPENAI_API_KEY   sk-...
     ONYX_SECRET      must match CRM WORKER_SECRET
   Optional:
     OPENAI_SEARCH_MODEL optional; defaults to gpt-5.4-mini
     OPENAI_ANALYSIS_MODEL optional; defaults to gpt-5.4-mini
     NOTE: legacy OPENAI_MODEL is intentionally ignored in v5 so an old Sol override cannot silently make research expensive again
     ONYX_KV          KV binding for daily email cap
   ═══════════════════════════════════════════════════════════════ */

const ALLOWED_ORIGINS = [
  'https://onyx.edgeform-media.com',
  'https://crm.edgeform-media.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

const SEND_DOMAIN = 'edgeform-media.com';
const DAILY_CAP = 400;
// Sales-fit crawling runs inside a Worker request. Keep the synchronous HTML
// parsing budget deliberately small so a large marketing site cannot exhaust
// the Worker CPU allowance before the model call starts.
const MAX_SITE_PAGES = 5;
const MAX_HTML_CHARS_PER_PAGE = 180000;
const MAX_CRAWL_TEXT_CHARS_PER_PAGE = 3500;
const SITE_FETCH_TIMEOUT_MS = 5500;
const OPENAI_TIMEOUT_MS = 55000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);

    let body;
    try { body = await request.json(); }
    catch (_) { return json({ ok: false, error: 'Body must be JSON.' }, 400, cors); }

    if (!env.ONYX_SECRET || body.secret !== env.ONYX_SECRET) {
      return json({ ok: false, error: 'Unauthorized.' }, 401, cors);
    }

    try {
      if (body.action === 'ping') return json({ ok: true, service: 'onyx-worker-v5.3-registry-first' }, 200, cors);
      if (body.action === 'email') return json(await sendEmail(body, env), 200, cors);
      if (body.action === 'enrichOwner') return json(await enrichOwnerStage(body, env), 200, cors);
      if (body.action === 'enrichEmails') return json(await enrichEmailsStage(body, env), 200, cors);
      if (body.action === 'enrichBusiness') return json(await enrichBusinessStage(body, env), 200, cors);
      if (body.action === 'enrich') return json(await enrich(body, env), 200, cors);
      return json({ ok: false, error: 'Unknown action: ' + body.action }, 400, cors);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500, cors);
    }
  }
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors || {})
  });
}

/* ── Resend ─────────────────────────────────────────────────── */

async function sendEmail(body, env) {
  const to = String(body.to || '').trim();
  const subject = String(body.subject || '').trim();
  const html = String(body.html || body.htmlBody || '').trim();
  const text = String(body.text || body.body || '').trim();

  if (!to || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return { ok: false, error: 'Bad "to" address.' };
  if (!subject) return { ok: false, error: 'Subject is required.' };
  if (!html && !text) return { ok: false, error: 'Message body is empty.' };
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not configured.' };

  const localPart = String(body.fromLocal || 'email').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const fromName = String(body.fromName || 'Edgeform Media').replace(/["<>\r\n]/g, '').slice(0, 60);
  const from = `${fromName} <${localPart || 'email'}@${SEND_DOMAIN}>`;
  const replyTo = /@/.test(body.replyTo || '') ? body.replyTo : `${localPart || 'email'}@${SEND_DOMAIN}`;

  if (env.ONYX_KV) {
    const key = 'sent:' + new Date().toISOString().slice(0, 10);
    const used = parseInt(await env.ONYX_KV.get(key) || '0', 10);
    if (used >= DAILY_CAP) return { ok: false, error: `Daily cap of ${DAILY_CAP} reached.` };
    await env.ONYX_KV.put(key, String(used + 1), { expirationTtl: 172800 });
  }

  const payload = { from, to: [to], subject, reply_to: replyTo };
  if (html) payload.html = html;
  if (text) payload.text = text;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await res.json();
  if (!res.ok) return { ok: false, error: result.message || 'Resend rejected the message.', details: result };
  return { ok: true, id: result.id, to, from, subject };
}

/* ── Site crawler ────────────────────────────────────────────── */

function safeWebsite(value) {
  try {
    let raw = String(value || '').trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
    u.hash = '';
    return u;
  } catch (_) { return null; }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ONYX-B2B-Research/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/text\/html|application\/xhtml\+xml/i.test(type)) return null;
    const html = (await res.text()).slice(0, MAX_HTML_CHARS_PER_PAGE);
    return { url: res.url || url, html };
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function pageText(html) {
  return decodeBasicEntities(String(html || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? pageText(m[1]).slice(0, 160) : '';
}

function extractEmails(html) {
  let t = decodeBasicEntities(String(html || ''))
    .replace(/\s*(?:\[at\]|\(at\)|\sat\s)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*/gi, '.');
  const found = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi) || [];
  return uniq(found.map(x => x.replace(/^mailto:/i, '').toLowerCase()))
    .filter(e => !/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e));
}

function normalizePhoneDigits(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d;
}

function formatPhone10(value) {
  const d = normalizePhoneDigits(value);
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : String(value || '').trim();
}

function validUsPhone(value) {
  const d = normalizePhoneDigits(value);
  return d.length === 10 && !/^0/.test(d) && !/^(\d)\1{9}$/.test(d);
}

function extractPhones(html) {
  const raw = decodeBasicEntities(String(html || ''));
  const found = [];

  // tel: links are the cleanest signal.
  const telRx = /href=["']tel:([^"'?]+)[^"']*["']/gi;
  let m;
  while ((m = telRx.exec(raw))) found.push(m[1]);

  // Also capture normal US phone formatting in visible/source text.
  const text = pageText(raw);
  const rx = /(?:\+?1[\s.\-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.\-]+\d{3}[\s.\-]+\d{4}\b/g;
  const matches = text.match(rx) || [];
  found.push(...matches);

  const out = [];
  const seen = new Set();
  for (const p of found) {
    const d = normalizePhoneDigits(p);
    if (!validUsPhone(d) || seen.has(d)) continue;
    seen.add(d);
    out.push(formatPhone10(d));
  }
  return out.slice(0, 20);
}

function internalResearchLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch (_) { return []; }
  const out = [];
  const rx = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) && out.length < 80) {
    const raw = decodeBasicEntities(m[1]);
    const label = pageText(m[2]).toLowerCase();
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (u.hostname !== base.hostname) continue;
      u.hash = '';
      const key = (u.pathname + ' ' + label).toLowerCase();
      if (!/(about|team|staff|people|provider|doctor|leadership|founder|owner|contact|privacy|terms|career|meet|company)/.test(key)) continue;
      out.push(u.href);
    } catch (_) { }
  }
  return uniq(out);
}

async function crawlCompanySite(website) {
  const root = safeWebsite(website);
  if (!root) return { root: '', pages: [], emails: [], emailSources: {}, phones: [], phoneSources: {} };

  const first = await fetchHtml(root.href);
  if (!first) return { root: root.href, pages: [], emails: [], emailSources: {}, phones: [], phoneSources: {} };

  const urls = [first.url].concat(internalResearchLinks(first.html, first.url)).slice(0, MAX_SITE_PAGES);
  const rest = await Promise.all(urls.slice(1).map(fetchHtml));
  const rawPages = [first].concat(rest.filter(Boolean));
  const emailSources = {};
  const phoneSources = {};
  const pages = [];

  for (const p of rawPages) {
    const emails = extractEmails(p.html);
    const phones = extractPhones(p.html);
    for (const e of emails) {
      if (!emailSources[e]) emailSources[e] = [];
      if (!emailSources[e].includes(p.url)) emailSources[e].push(p.url);
    }
    for (const ph of phones) {
      const key = normalizePhoneDigits(ph);
      if (!phoneSources[key]) phoneSources[key] = [];
      if (!phoneSources[key].includes(p.url)) phoneSources[key].push(p.url);
    }
    pages.push({
      url: p.url,
      title: titleFromHtml(p.html),
      text: pageText(p.html).slice(0, MAX_CRAWL_TEXT_CHARS_PER_PAGE),
      emails,
      phones
    });
  }

  return { root: root.href, pages, emails: Object.keys(emailSources), emailSources, phones: Object.keys(phoneSources).map(formatPhone10), phoneSources };
}

/* ── OpenAI research ─────────────────────────────────────────── */

const CONF = ['VERIFIED', 'HIGH', 'MEDIUM', 'LOW'];

const ownerSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    decisionMakerName: { type: 'string' },
    decisionMakerTitle: { type: 'string' },
    decisionMakerConfidence: { type: 'string', enum: CONF },
    decisionMakerEvidence: { type: 'string' },
    directPhone: { type: 'string' },
    linkedin: { type: 'string' },
    instagram: { type: 'string' },
    facebook: { type: 'string' },
    ownerCandidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' }, title: { type: 'string' }, confidence: { type: 'string', enum: CONF },
          evidence: { type: 'string' }, sourceUrl: { type: 'string' }
        },
        required: ['name', 'title', 'confidence', 'evidence', 'sourceUrl']
      }
    },
    ownerSources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { source: { type: 'string' }, url: { type: 'string' }, evidence: { type: 'string' } },
        required: ['source', 'url', 'evidence']
      }
    },
    researchAttempts: { type: 'array', items: { type: 'string' } }
  },
  required: ['decisionMakerName','decisionMakerTitle','decisionMakerConfidence','decisionMakerEvidence',
    'directPhone','linkedin','instagram','facebook','ownerCandidates','ownerSources','researchAttempts']
};

const emailSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    emailCandidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          email: { type: 'string' },
          type: { type: 'string', enum: ['direct','employee','business','generic','pattern-derived','unknown'] },
          confidence: { type: 'string', enum: CONF },
          status: { type: 'string' },
          source: { type: 'string' },
          sourceUrl: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['email','type','confidence','status','source','sourceUrl','evidence']
      }
    },
    phoneCandidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          phone: { type: 'string' },
          type: { type: 'string', enum: ['owner-direct','employee-direct','business-primary','business-alternate','historical','unknown'] },
          confidence: { type: 'string', enum: CONF },
          status: { type: 'string' },
          source: { type: 'string' },
          sourceUrl: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['phone','type','confidence','status','source','sourceUrl','evidence']
      }
    },
    researchAttempts: { type: 'array', items: { type: 'string' } }
  },
  required: ['emailCandidates','phoneCandidates','researchAttempts']
};

const businessSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    services: { type: 'string' }, existingEquipment: { type: 'string' }, expansionSignals: { type: 'string' },
    reviewOpportunity: { type: 'string' }, reviewFindings: { type: 'string' }, reviewEvidence: { type: 'string' },
    serviceGap: { type: 'string' }, serviceGapEvidence: { type: 'string' },
    leadScore: { type: 'integer', minimum: 0, maximum: 100 }, buyerFit: { type: 'string' }, scoreReasoning: { type: 'string' },
    salesAngle: { type: 'string' }, angleEvidence: { type: 'string' }, bestChannel: { type: 'string' },
    openingAngle: { type: 'string' }, personalization: { type: 'string' }, suggestedMessage: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } }, researchAttempts: { type: 'array', items: { type: 'string' } }
  },
  required: ['services','existingEquipment','expansionSignals','reviewOpportunity','reviewFindings','reviewEvidence','serviceGap','serviceGapEvidence','leadScore','buyerFit','scoreReasoning',
    'salesAngle','angleEvidence','bestChannel','openingAngle','personalization','suggestedMessage','sources','researchAttempts']
};

function leadFacts(lead) {
  return [
    ['Business', lead.name], ['Category', lead.category], ['Website', lead.website], ['Phone', lead.phone],
    ['Address', [lead.street, lead.city, lead.state, lead.zip].filter(Boolean).join(', ')],
    ['Google Maps', lead.mapsUrl], ['National chain', lead.isNationalChain], ['Chain brand', lead.chainBrand],
    ['Rating', lead.rating && `${lead.rating} (${lead.reviewCount || 0} reviews)`], ['Review excerpts captured from Maps', Array.isArray(lead.reviewSnippets) ? lead.reviewSnippets.map(r => `${r.rating || 'unrated'} star: ${r.text || r}`).join(' | ') : lead.reviewSnippets], ['Years in business', lead.yearsInBusiness]
  ].filter(p => p[1]).map(p => `${p[0]}: ${p[1]}`).join('\n');
}

function crawlContext(crawl) {
  if (!crawl.pages.length) return 'No company pages could be fetched directly.';
  return crawl.pages.map((p, i) =>
    `PAGE ${i + 1}: ${p.url}\nTITLE: ${p.title}\nEMAILS FOUND: ${(p.emails || []).join(', ') || 'none'}\nPHONES FOUND: ${(p.phones || []).join(', ') || 'none'}\nTEXT: ${p.text}`
  ).join('\n\n').slice(0, 12000);
}

async function openaiRequest(env, payload, label, timeoutMs) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || `OpenAI rejected ${label || 'request'}.`);
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`${label || 'OpenAI request'} timed out after ${Math.round((timeoutMs || OPENAI_TIMEOUT_MS) / 1000)}s.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function searchModel(env, body) {
  return body.searchModel || env.OPENAI_SEARCH_MODEL || 'gpt-5.4-mini';
}

function analysisModel(env, body) {
  return body.analysisModel || env.OPENAI_ANALYSIS_MODEL || env.OPENAI_SEARCH_MODEL || 'gpt-5.4-mini';
}

function stateRegistryDomains(state) {
  const map = {
    FL: ['search.sunbiz.org'],
    CA: ['bizfileonline.sos.ca.gov'],
    TX: ['comptroller.texas.gov','mycpa.cpa.state.tx.us'],
    NY: ['apps.dos.ny.gov','dos.ny.gov'],
    NJ: ['njportal.com'],
    GA: ['ecorp.sos.ga.gov'],
    AZ: ['ecorp.azcc.gov'],
    NV: ['esos.nv.gov','nvsos.gov'],
    NC: ['sosnc.gov'],
    SC: ['businessfilings.sc.gov'],
    IL: ['apps.ilsos.gov'],
    PA: ['file.dos.pa.gov'],
    MA: ['corp.sec.state.ma.us'],
    CT: ['business.ct.gov'],
    VA: ['cis.scc.virginia.gov','scc.virginia.gov'],
    MD: ['egov.maryland.gov'],
    DC: ['corponline.dcp.dc.gov'],
    CO: ['sos.state.co.us'],
    WA: ['ccfs.sos.wa.gov'],
    OR: ['egov.sos.state.or.us'],
    MI: ['cofs.lara.state.mi.us'],
    OH: ['businesssearch.ohiosos.gov'],
    TN: ['tnbear.tn.gov'],
    LA: ['coraweb.sos.la.gov'],
    MS: ['corp.sos.ms.gov'],
    IN: ['inbiz.in.gov'],
    WI: ['apps.dfi.wi.gov'],
    MN: ['mblsportal.sos.state.mn.us'],
    MO: ['sos.mo.gov'],
    KY: ['web.sos.ky.gov'],
    OK: ['sos.ok.gov'],
    KS: ['sos.ks.gov'],
    IA: ['sos.iowa.gov'],
    UT: ['secure.utah.gov'],
    ID: ['sosbiz.idaho.gov'],
    MT: ['biz.sosmt.gov'],
    WY: ['wyobiz.wyo.gov'],
    NM: ['portal.sos.state.nm.us'],
    AK: ['commerce.alaska.gov'],
    HI: ['hbe.ehawaii.gov'],
    ME: ['apps1.web.maine.gov'],
    NH: ['quickstart.sos.nh.gov'],
    VT: ['bizfilings.vermont.gov'],
    RI: ['business.sos.ri.gov'],
    DE: ['icis.corp.delaware.gov'],
    WV: ['apps.wv.gov'],
    AR: ['sos.arkansas.gov'],
    NE: ['sos.nebraska.gov'],
    ND: ['firststop.sos.nd.gov'],
    SD: ['sosenterprise.sd.gov']
  };
  return map[String(state || '').trim().toUpperCase()] || [];
}

function ownerPrimaryDomains(lead) {
  return uniq([
    ...stateRegistryDomains(lead && lead.state),
    'bbb.org',
    'allbiz.com',
    'chamberofcommerce.com',
    'opencorporates.com',
    'bisprofiles.com',
    'bizapedia.com'
  ]);
}

function externalContactDomains(lead) {
  const state = String(lead && lead.state || '').trim().toUpperCase();
  const medical = state === 'FL'
    ? ['mqa-internet.doh.state.fl.us']
    : [];
  return uniq([
    ...stateRegistryDomains(state),
    ...medical,
    'bbb.org',
    'allbiz.com',
    'chamberofcommerce.com',
    'opencorporates.com',
    'bisprofiles.com',
    'bizapedia.com',
    'npiregistry.cms.hhs.gov',
    'npiprofile.com',
    'pubmed.ncbi.nlm.nih.gov',
    'pmc.ncbi.nlm.nih.gov',
    'linkedin.com'
  ]);
}

// Some owner-operated local businesses trade under a name that never appears in
// their LLC filing. These independent, public business profiles are useful for
// resolving the operating name from an exact phone/address match. They are
// candidate sources only: the owner prompt requires registry corroboration
// before they can produce HIGH or VERIFIED confidence.
function ownerFallbackDomains(lead) {
  return uniq([
    ...externalContactDomains(lead),
    'countyadvisoryboard.com',
    'guidetoflorida.com',
    'fresha.com',
    'yellowpages.com',
    'manta.com',
    'mapquest.com',
    'yelp.com'
  ]);
}

async function openaiStructuredSearch(env, body, system, user, schema, name, opts) {
  opts = opts || {};
  const webTool = { type: 'web_search', search_context_size: opts.searchContextSize || 'low' };
  // v5.3 can hard-constrain ownership/contact searches to independent external domains.
  // This prevents the model from falling back to the target company's own website.
  if (Array.isArray(opts.allowedDomains) && opts.allowedDomains.length) {
    webTool.filters = { allowed_domains: uniq(opts.allowedDomains.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)).slice(0, 20) };
  }
  const payload = {
    model: searchModel(env, body),
    reasoning: { effort: opts.effort || 'low' },
    tools: [webTool],
    tool_choice: 'required',
    // Cost guard: one built-in web-search call per AI pass. v5 escalates with another pass only when needed.
    max_tool_calls: 1,
    max_output_tokens: opts.maxOutputTokens || 2600,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    text: { format: { type: 'json_schema', name, strict: true, schema } }
  };
  const data = await openaiRequest(env, payload, name, opts.timeoutMs || OPENAI_TIMEOUT_MS);
  const raw = extractText(data);
  try { return JSON.parse(raw); }
  catch (_) { throw new Error(`Could not parse ${name} output: ` + String(raw).slice(0, 350)); }
}

async function openaiStructuredNoWeb(env, body, system, user, schema, name, opts) {
  opts = opts || {};
  const payload = {
    model: analysisModel(env, body),
    reasoning: { effort: opts.effort || 'low' },
    max_output_tokens: opts.maxOutputTokens || 2400,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    text: { format: { type: 'json_schema', name, strict: true, schema } }
  };
  const data = await openaiRequest(env, payload, name, opts.timeoutMs || 40000);
  const raw = extractText(data);
  try { return JSON.parse(raw); }
  catch (_) { throw new Error(`Could not parse ${name} output: ` + String(raw).slice(0, 350)); }
}

/* ── SMART owner waterfall ───────────────────────────────────── */

const OWNER_BASE = `You are the ONYX B2B ownership investigator. Find the strongest defensible HUMAN purchasing decision-maker for this business.

NON-NEGOTIABLE SOURCE POLICY:
- DO NOT use the target company's own website as an ownership source. Do not search it, cite it, or let generic About/Contact copy determine the owner.
- Start from EXTERNAL authoritative business records. Highest priority: the state's official corporation/LLC registry (Secretary of State / Division of Corporations; in Florida use Sunbiz), current annual reports, entity detail pages, officer/member/manager records, fictitious-name/DBA records, and exact-address entity matches.
- Next priority: BBB business profiles/operator records, state professional licensing boards, NPI/NPPES/provider records, local business-license records, AllBiz/Chamber/credible business directories, and exact phone/address reverse-business results.
- Use LinkedIn, press, interviews, professional bios, social profiles, or other web results only as corroboration or fallback when registry/business records are incomplete.

RULES:
- Use the single allowed web-search call strategically. Do NOT attempt every source on the internet.
- Stop once a human owner/managing member/president/location manager is established with HIGH or VERIFIED evidence.
- Match the exact business using name + street address + suite + city/state + phone. Similar names are not enough.
- Prefer explicit OWNER / MEMBER / MANAGING MEMBER / MANAGER / PRESIDENT / PRINCIPAL evidence. A registered agent alone is NOT proof of ownership.
- VERIFIED = official government filing or unmistakable authoritative business record tied to the exact entity/location. HIGH = strong corroborated external evidence.
- Never invent a person, role, direct phone, social profile, or source.
- directPhone is allowed only if an external professional/business source explicitly ties the number to that person. Never copy the general spa number into directPhone.
- Return useful secondary candidates and source URLs, but keep output concise.`;

const OWNER_PRIMARY_SYSTEM = OWNER_BASE + `\n\nREGISTRY-FIRST PASS. Spend the one search on the exact legal/business identity. Search the state corporation/LLC registry first (Secretary of State / Division of Corporations; Sunbiz for Florida), then BBB/operator records and exact-address/phone entity matches. Look for current officers, managers, members, principals, presidents, annual reports, filing numbers, DBA/fictitious-name links, and affiliated entities at the exact suite. DO NOT use the company website.`;

const OWNER_FALLBACK_SYSTEM = OWNER_BASE + `\n\nEXTERNAL FALLBACK / IDENTITY-RESOLUTION PASS. The registry-first pass was weak or unresolved. Do NOT use the company website. First resolve the operating business from the exact phone + full street/suite + city/state; this is especially important when the trade name differs from the LLC name. Then target missing evidence using BBB, professional licensing/NPI/provider records, state medical/nursing boards, local business licenses, AllBiz/Chamber/credible directories, exact phone/address reverse-business results, LinkedIn leadership, press/interviews, and professional/publication bios. An exact-match independent directory or owner spotlight may identify a human as a MEDIUM-confidence candidate, but it can NEVER by itself justify HIGH or VERIFIED confidence; require Sunbiz/another official record or independent corroboration to upgrade it. Do not repeat already-established sources.`;

function ownerSearchPrompt(lead, crawl, prior) {
  const priorText = prior ? `\n\nREGISTRY-FIRST RESULT:\n${JSON.stringify(prior).slice(0, 12000)}\nFind only what remains weak or missing.` : '';
  const state = String(lead.state || '').trim().toUpperCase();
  const registryHint = state === 'FL'
    ? 'STATE REGISTRY TARGET: Florida Division of Corporations / Sunbiz (search.sunbiz.org). Look for the exact LLC/corporation, current annual report, manager/member/officer names, filing number, and exact address.'
    : `STATE REGISTRY TARGET: official ${state || 'state'} Secretary of State / Division of Corporations corporation-and-LLC registry. Look for current entity/officer/member/manager records and exact-address matches.`;
  return `Resolve the decision maker using EXTERNAL records only.\n\n${leadFacts(lead)}\n\n${registryHint}${priorText}\n\nDo not use or cite the company website. Search the legal entity, LLC/corporation, BBB/operator record, exact address/suite, and exact phone. If the legal entity is unclear, explicitly use the full phone + exact suite/address to resolve the operating-name-to-owner candidate before returning Unknown. Return Unknown only if this budgeted external-record pass cannot defensibly identify a human.`;
}

function confidenceRank(v) { return ({ VERIFIED: 4, HIGH: 3, MEDIUM: 2, LOW: 1 })[v] || 0; }
function ownerKnown(o) { return !!(o && o.decisionMakerName && o.decisionMakerName !== 'Unknown'); }
function ownerStrong(o) { return ownerKnown(o) && confidenceRank(o.decisionMakerConfidence) >= 3; }

function normalizePersonName(s) {
  return String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(also|listed|spelled|as)\b/g, ' ').replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameOwner(a, b) {
  const x = normalizePersonName(a && a.decisionMakerName);
  const y = normalizePersonName(b && b.decisionMakerName);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' ').filter(Boolean), ys = y.split(' ').filter(Boolean);
  return xs.length >= 2 && ys.length >= 2 && xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

function ownerScore(o) {
  if (!ownerKnown(o)) return 0;
  return confidenceRank(o.decisionMakerConfidence) * 100 + Math.min((o.ownerSources || []).length, 8) * 4 + Math.min((o.ownerCandidates || []).length, 5);
}

function mergeOwnerReports(primary, fallback) {
  const choosePrimary = !fallback || ownerScore(primary) >= ownerScore(fallback);
  const best = Object.assign({}, choosePrimary ? primary : fallback);
  const other = choosePrimary ? fallback : primary;
  if (other) {
    best.ownerCandidates = mergeOwnerCandidates(best.ownerCandidates, other.ownerCandidates, ownerKnown(other) ? [{
      name: other.decisionMakerName,
      title: other.decisionMakerTitle || 'Unknown',
      confidence: other.decisionMakerConfidence || 'LOW',
      evidence: other.decisionMakerEvidence || '',
      sourceUrl: (other.ownerSources && other.ownerSources[0] && other.ownerSources[0].url) || ''
    }] : []);
    best.ownerSources = mergeOwnerSources(best.ownerSources, other.ownerSources);
    best.researchAttempts = uniq([...(best.researchAttempts || []), ...(other.researchAttempts || [])]);
    if (!best.directPhone && other.directPhone) best.directPhone = other.directPhone;
    if (!best.linkedin && other.linkedin) best.linkedin = other.linkedin;
    if (!best.instagram && other.instagram) best.instagram = other.instagram;
    if (!best.facebook && other.facebook) best.facebook = other.facebook;
  }
  return best;
}

async function resolveOwnerCore(body, env, lead, crawl) {
  let webPasses = 0;
  let primary = await openaiStructuredSearch(env, body, OWNER_PRIMARY_SYSTEM, ownerSearchPrompt(lead, crawl), ownerSchema, 'onyx_owner_primary', {
    searchContextSize: 'low', maxOutputTokens: 2500, effort: 'low', allowedDomains: ownerPrimaryDomains(lead)
  });
  webPasses++;

  // Common case: one strong pass and STOP. No extra scouts, no resolver call.
  if (ownerStrong(primary)) {
    primary.researchAttempts = uniq([...(primary.researchAttempts || []), 'Smart waterfall stopped after primary owner pass because evidence was HIGH/VERIFIED.']);
    return { owner: primary, webPasses, stoppedEarly: true };
  }

  let fallback = null;
  try {
    fallback = await openaiStructuredSearch(env, body, OWNER_FALLBACK_SYSTEM, ownerSearchPrompt(lead, crawl, primary), ownerSchema, 'onyx_owner_fallback', {
      searchContextSize: 'low', maxOutputTokens: 2500, effort: 'low', allowedDomains: ownerFallbackDomains(lead)
    });
    webPasses++;
  } catch (_) { fallback = null; }

  let owner = fallback ? mergeOwnerReports(primary, fallback) : primary;

  // Only if two strong passes identify DIFFERENT people do we spend a cheap no-web reconciliation call.
  if (fallback && ownerStrong(primary) && ownerStrong(fallback) && !sameOwner(primary, fallback)) {
    const system = `Reconcile two ownership reports using ONLY the supplied reports. Prefer explicit location-specific owner/managing-member/president evidence. Never invent. Return the strongest defensible decision maker and merge useful sources/candidates.`;
    try {
      owner = await openaiStructuredNoWeb(env, body, system,
        `Business:\n${leadFacts(lead)}\n\nREPORT A:\n${JSON.stringify(primary)}\n\nREPORT B:\n${JSON.stringify(fallback)}`,
        ownerSchema, 'onyx_owner_reconcile', { maxOutputTokens: 2200, effort: 'low' });
      owner.ownerCandidates = mergeOwnerCandidates(owner.ownerCandidates, primary.ownerCandidates, fallback.ownerCandidates);
      owner.ownerSources = mergeOwnerSources(owner.ownerSources, primary.ownerSources, fallback.ownerSources);
      owner.researchAttempts = uniq([...(owner.researchAttempts || []), ...(primary.researchAttempts || []), ...(fallback.researchAttempts || [])]);
    } catch (_) { /* deterministic best remains */ }
  }

  return { owner, webPasses, stoppedEarly: false };
}

/* ── SMART email waterfall ───────────────────────────────────── */

const EMAIL_BASE = `You are the ONYX B2B public contact-data investigator. Find every legitimate PUBLISHED business/professional email AND useful business/professional phone number for the target company and verified decision maker.

NON-NEGOTIABLE SOURCE POLICY:
- The target company's public website is an allowed source for published BUSINESS contact information. Include all distinct emails and business phone numbers found there, including generic inboxes and alternate lines.
- Never treat the company website as proof of ownership; ownership must remain supported by Sunbiz, another official record, or independent corroboration.
- Prioritize external authoritative/independent sources: state corporation/LLC filings and annual reports, BBB, state professional licensing boards, NPI/NPPES/provider records, AllBiz, Chamber/credible business directories, local licensing records, professional associations, publications/conference bios, press/interviews, and exact phone/address reverse-business results.
- Exact-match directory pages are valuable because they can expose principals, alternate phones, historical emails, social profiles, filing numbers, and employee names that the company site omits.

RULES:
- Use the single allowed web-search call strategically. Do NOT query every possible site.
- Never fabricate an email or phone number.
- EMAIL GOAL: collect every distinct published business/professional email, including generic inboxes. Prefer a named/professional email as the CRM primary when one is available.
- PHONE GOAL: collect every distinct current published business/professional phone number, including alternate business lines.
- Prefer direct owner/executive professional email, then named employee/manager/provider email, then other non-generic business email. Generic inboxes are fallback only.
- Preserve owner-direct/employee-direct vs business-primary/business-alternate. Never label a general line as a person's direct number.
- Search the exact business identity using legal/entity name, decision-maker name, exact current phone, exact street/suite, city/state, and domain.
- For Florida leads, specifically favor Sunbiz/entity filings plus BBB and exact-match directories. For other states, favor the official Secretary of State / corporation-and-LLC registry plus BBB.
- If an exact-match AllBiz/BBB/Chamber page exposes multiple Phone fields, return EVERY distinct current business/professional number shown.
- Historical numbers/emails may be returned only when clearly labeled historical.
- Generic addresses such as info@, contact@, hello@, office@, admin@, support@, sales@, booking@, appointments@, reception@, frontdesk@, team@, care@, inquiries@, marketing@, privacy@, legal@, careers@ and jobs@ are valuable business contacts and must be returned when publicly published.
- Personal/free-mail addresses or personal phones are allowed only when a professional/business/government source publicly lists them for that person's professional role.
- Do not harvest unrelated private household contact data from people-search sites.
- Pattern email guesses may only be returned as type pattern-derived, confidence LOW, status exactly "Pattern-derived — unverified".
- Return all useful distinct emails and phones with source URL/evidence, up to 30 of each.`;

const EMAIL_PRIMARY_SYSTEM = EMAIL_BASE + `\n\nPUBLIC CONTACT PASS. The caller has already crawled the company website. Add missing emails and alternate business phones from independent sources: state corporation/LLC records, BBB, AllBiz/Chamber/credible directories, licensing/NPI/provider records, and exact phone/address matches. If an exact directory page matches the target, inspect all contact fields, principal/contact names, alternate Phone entries, emails, filing numbers, and social/professional links.`;
const EMAIL_FALLBACK_SYSTEM = EMAIL_BASE + `\n\nPUBLIC CONTACT ESCALATION. Earlier research is still missing a published email and/or useful alternate/direct business phone. Spend this final search ONLY on the missing field(s), using external records: owner/staff + professional licensing/publications, BBB/directories, exact phone/address, state filings, and professional profiles. Do not waste this pass rediscovering a contact already found.`;

function emailSearchPrompt(lead, crawl, owner, existingEmails, existingPhones, prior) {
  const domain = companyDomain(lead);
  const ownerName = ownerKnown(owner) ? owner.decisionMakerName : '';
  const knownPhones = uniq([lead.phone, owner.directPhone].concat((existingPhones || []).map(x => x && x.phone))).filter(Boolean);
  const state = String(lead.state || '').trim().toUpperCase();
  const externalHint = state === 'FL'
    ? 'External-source priority: Sunbiz / Florida Division of Corporations, BBB, AllBiz/Chamber, Florida professional licensing/MQA, NPI/NPPES, exact phone/address results.'
    : `External-source priority: official ${state || 'state'} corporation/LLC registry, BBB, AllBiz/Chamber, professional licensing/NPI, exact phone/address results.`;
  return `Find additional published business/professional contact data from EXTERNAL sources only.\n\n${leadFacts(lead)}\nCompany domain (identity clue only — DO NOT visit company site): ${domain || 'Unknown'}\nDecision maker: ${ownerName || 'Unknown'} — ${owner.decisionMakerTitle || ''}\nOwner evidence: ${owner.decisionMakerEvidence || ''}\n${externalHint}\n\nEMAILS ALREADY FOUND:\n${JSON.stringify(existingEmails || [])}\n\nPHONES ALREADY KNOWN:\n${JSON.stringify(knownPhones)}\n\nPHONE CANDIDATES ALREADY FOUND:\n${JSON.stringify(existingPhones || [])}${prior ? `\n\nPRIMARY EXTERNAL CONTACT RESULT:\n${JSON.stringify(prior).slice(0, 12000)}` : ''}\n\nDo not use or cite the company website. Reverse-search the exact known phone and exact street/suite; inspect exact-match directory/business-record pages for principals, secondary Phone fields, emails, and filing/entity clues. If AllBiz appears and matches the exact business, inspect Business Contact + Contact Information and return all distinct current numbers.`;
}

function isGenericEmailAddress(email) {
  const local = String(email || '').trim().toLowerCase().split('@')[0];
  return /^(info|hello|contact|office|admin|support|sales|booking|bookings|appointment|appointments|reception|frontdesk|front\.?desk|team|care|inquiry|inquiries|marketing|privacy|legal|career|careers|jobs?|customerservice|customer\.?service|service|general|mail|spa|clinic)$/i.test(local);
}

function hasPreferredPublishedEmail(candidates) {
  return (candidates || []).some(c =>
    c.type !== 'pattern-derived' &&
    !isGenericEmailAddress(c.email) &&
    ['VERIFIED','HIGH','MEDIUM'].includes(c.confidence)
  );
}

function phoneCandidateScore(c) {
  const rankC = { VERIFIED: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const typeBonus = { 'owner-direct': 50, 'employee-direct': 45, 'business-alternate': 35, 'business-primary': 20, 'unknown': 10, 'historical': 0 };
  return (rankC[c && c.confidence] || 0) * 10 + (typeBonus[c && c.type] || 0);
}

function mergePhoneCandidates(...lists) {
  const map = new Map();
  for (const list of lists) for (const c of (list || [])) {
    if (!c || !validUsPhone(c.phone)) continue;
    const key = normalizePhoneDigits(c.phone);
    const normalized = Object.assign({}, c, { phone: formatPhone10(key) });
    const old = map.get(key);
    if (!old || phoneCandidateScore(normalized) > phoneCandidateScore(old)) map.set(key, normalized);
    else if (old && !old.sourceUrl && normalized.sourceUrl) old.sourceUrl = normalized.sourceUrl;
  }
  return [...map.values()].sort((a,b) => phoneCandidateScore(b) - phoneCandidateScore(a)).slice(0, 30);
}

function sitePhoneCandidates(crawl, lead, owner) {
  const primaryKey = normalizePhoneDigits(lead.phone);
  const ownerKey = normalizePhoneDigits(owner && owner.directPhone);
  return (crawl.phones || []).filter(validUsPhone).map(phone => {
    const key = normalizePhoneDigits(phone);
    const urls = (crawl.phoneSources && crawl.phoneSources[key]) || [crawl.root];
    let type = 'business-alternate';
    let status = 'Published on company website';
    if (ownerKey && key === ownerKey) { type = 'owner-direct'; status = 'Published professional/direct number'; }
    else if (primaryKey && key === primaryKey) type = 'business-primary';
    return {
      phone: formatPhone10(key), type, confidence: 'VERIFIED', status,
      source: 'Company website', sourceUrl: urls[0] || '',
      evidence: key === primaryKey ? 'Matches the lead primary business number and is published on the company website.' : 'Distinct phone number published on the company website.'
    };
  });
}

function hasAlternatePublishedPhone(candidates, lead, owner) {
  const known = new Set([normalizePhoneDigits(lead.phone), normalizePhoneDigits(owner && owner.directPhone)].filter(Boolean));
  return (candidates || []).some(c => {
    const key = normalizePhoneDigits(c.phone);
    return key && !known.has(key) && c.type !== 'historical' && ['VERIFIED','HIGH','MEDIUM'].includes(c.confidence);
  });
}

async function resolveEmailsCore(body, env, lead, crawl, owner) {
  let webPasses = 0;
  // Start with every public contact published on the company's site, then use
  // external searches to find additional emails and alternate business lines.
  const siteCrawl = crawl && Array.isArray(crawl.pages) && (crawl.pages.length || crawl.root)
    ? crawl : await getCrawl(lead, owner);
  let emailCandidates = mergeEmailCandidates(siteCandidates(siteCrawl, lead, owner));
  let phoneCandidates = mergePhoneCandidates(sitePhoneCandidates(siteCrawl, lead, owner));

  let emailDone = hasPreferredPublishedEmail(emailCandidates);
  let phoneDone = hasAlternatePublishedPhone(phoneCandidates, lead, owner);

  let primary = null;
  try {
    primary = await openaiStructuredSearch(env, body, EMAIL_PRIMARY_SYSTEM,
      emailSearchPrompt(lead, crawl, owner, emailCandidates, phoneCandidates),
      emailSchema, 'onyx_contact_primary', { searchContextSize: 'low', maxOutputTokens: 2500, effort: 'low', allowedDomains: externalContactDomains(lead) });
    webPasses++;
    emailCandidates = mergeEmailCandidates(emailCandidates, primary.emailCandidates);
    phoneCandidates = mergePhoneCandidates(phoneCandidates, primary.phoneCandidates);
  } catch (_) { primary = null; }

  emailDone = hasPreferredPublishedEmail(emailCandidates);
  phoneDone = hasAlternatePublishedPhone(phoneCandidates, lead, owner);
  if (emailDone && phoneDone) {
    return { candidates: emailCandidates, phoneCandidates, webPasses, reports: primary ? [primary] : [], stoppedEarly: true };
  }

  let fallback = null;
  try {
    fallback = await openaiStructuredSearch(env, body, EMAIL_FALLBACK_SYSTEM,
      emailSearchPrompt(lead, crawl, owner, emailCandidates, phoneCandidates, primary),
      emailSchema, 'onyx_contact_fallback', { searchContextSize: 'low', maxOutputTokens: 2500, effort: 'low', allowedDomains: externalContactDomains(lead) });
    webPasses++;
    emailCandidates = mergeEmailCandidates(emailCandidates, fallback.emailCandidates);
    phoneCandidates = mergePhoneCandidates(phoneCandidates, fallback.phoneCandidates);
  } catch (_) { fallback = null; }

  return { candidates: emailCandidates, phoneCandidates, webPasses, reports: [primary, fallback].filter(Boolean), stoppedEarly: false };
}

/* ── Sales-fit analysis ONLY: company website allowed here ───── */

const BUSINESS_SYSTEM = `You are the ONYX B2B sales-research analyst for aesthetic laser equipment.
Use only the supplied lead facts and first-party company crawl unless explicitly told web search is available.
Return concise, grounded sales intelligence. List all clearly observed relevant services/equipment, semicolon-separated. Never invent a device or service. Score 0-100 for realistic equipment-buying fit and write a short personalized outreach angle.

Also return reputation and service-gap evidence:
- reviewOpportunity: "Priority" only when a captured public review is rated 1-3 and reports a relevant treatment/device problem; otherwise "None identified". An overall business rating by itself is not a review finding.
- reviewFindings: use only captured 1-3-star review excerpts that specifically mention laser, laser hair removal, hair removal, waxing/wax, a treatment, or a device/machine problem. Keep the exact relevant excerpt short in quotation marks and name the issue. If no such captured excerpt exists, say "No captured low-rating laser/wax-related review." Never invent or paraphrase a review you did not see.
- reviewEvidence: identify the supplied Google Maps public-review excerpt and its rating. Do not cite a review that was not supplied.
- serviceGap: identify a relevant opportunity such as "No published laser hair-removal service observed" only when the supplied crawl/service menu is reasonably complete and lacks it. Otherwise say "No verified service gap." Never state that a service is unavailable.
- serviceGapEvidence: explain the observed menu/service evidence and use the phrase "not publicly listed" for an omission.`;

const BUSINESS_WEB_SYSTEM = BUSINESS_SYSTEM + `\nThe first-party crawl is sparse, so use the single allowed web-search call to fill only the missing sales-fit facts from credible public sources.`;

async function researchBusinessSmart(env, body, lead, crawl, owner) {
  const user = `Research this lead for sales fit.\n\n${leadFacts(lead)}\nDecision maker: ${owner.decisionMakerName || 'Unknown'} — ${owner.decisionMakerTitle || ''}\n\nFIRST-PARTY COMPANY CRAWL:\n${crawlContext(crawl)}`;
  const usableText = (crawl.pages || []).reduce((n, p) => n + String(p.text || '').length, 0);
  if (usableText >= 800) {
    const result = await openaiStructuredNoWeb(env, body, BUSINESS_SYSTEM, user, businessSchema, 'onyx_business_first_party', { maxOutputTokens: 2200, effort: 'low' });
    return { result, webPasses: 0 };
  }
  const result = await openaiStructuredSearch(env, body, BUSINESS_WEB_SYSTEM, user, businessSchema, 'onyx_business_web', {
    searchContextSize: 'low', maxOutputTokens: 2200, effort: 'low'
  });
  return { result, webPasses: 1 };
}

/* ── Merge/rank ──────────────────────────────────────────────── */

function uniq(arr) { return [...new Set((arr || []).filter(Boolean))]; }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(e || '').trim()); }

function companyDomain(lead) {
  const u = safeWebsite(lead.website);
  return u ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
}

function ownerTokens(owner) {
  return String(owner && owner.decisionMakerName || '').toLowerCase().split(/[^a-z]+/).filter(x => x.length > 1 && x !== 'unknown');
}

function usablePublicContactEmail(email) {
  if (!validEmail(email)) return false;
  const domain = String(email).trim().toLowerCase().split('@')[1] || '';
  // Template examples and booking/website-platform mailboxes often appear in
  // page markup. They are not contact addresses for the target business.
  return !/^(?:mystore\.com|example\.com|yourdomain\.com|vagaro\.com|fresha\.com|booksy\.com|glossgenius\.com|mindbodyonline\.com|acuityscheduling\.com|calendly\.com|wix\.com|wixsite\.com|squareup\.com)$/i.test(domain);
}

function classifySiteEmail(email, lead, owner) {
  const local = String(email).split('@')[0].toLowerCase();
  const generic = /^(info|hello|contact|office|admin|support|sales|booking|appointments?|reception|frontdesk|team|care|inquiries|marketing)$/i.test(local);
  const tokens = ownerTokens(owner);
  const direct = tokens.length && tokens.some(t => local.includes(t));
  return direct ? 'direct' : generic ? 'generic' : 'business';
}

function siteCandidates(crawl, lead, owner) {
  const dom = companyDomain(lead);
  const junkDomains = /(?:wixpress|sentry|cloudflare|wordpress|example\.com|schema\.org)$/i;
  return (crawl.emails || []).filter(usablePublicContactEmail).filter(email => !junkDomains.test(email.split('@')[1] || '')).map(email => {
    const eDom = email.split('@')[1].toLowerCase();
    const firstUrl = (crawl.emailSources[email] || [crawl.root])[0] || '';
    return {
      email,
      type: classifySiteEmail(email, lead, owner),
      confidence: 'VERIFIED',
      status: 'Published on company website',
      source: 'Company website',
      sourceUrl: firstUrl,
      evidence: eDom === dom ? 'Published on the company website and uses the company domain.' : 'Published on the company website as a business contact.'
    };
  });
}

function emailCandidateScore(c) {
  const rankC = { VERIFIED: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const typeBonus = { direct: 40, employee: 35, business: 25, generic: 10, unknown: 5, 'pattern-derived': 0 };
  return (rankC[c && c.confidence] || 0) * 10 + (typeBonus[c && c.type] || 0);
}

function mergeEmailCandidates(...lists) {
  const map = new Map();
  for (const list of lists) for (const c of (list || [])) {
    if (!c || !usablePublicContactEmail(c.email)) continue;
    const key = c.email.toLowerCase();
    const old = map.get(key);
    const score = emailCandidateScore(c);
    const oldScore = old ? emailCandidateScore(old) : -1;
    if (!old || score > oldScore) map.set(key, Object.assign({}, c, { email: key }));
    else if (old && !old.sourceUrl && c.sourceUrl) old.sourceUrl = c.sourceUrl;
  }
  return [...map.values()].sort((a, b) => emailCandidateScore(b) - emailCandidateScore(a)).slice(0, 30);
}

function mergeOwnerCandidates(...lists) {
  const rank = { VERIFIED: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const map = new Map();
  for (const list of lists) for (const c of (list || [])) {
    if (!c || !c.name || c.name === 'Unknown') continue;
    const key = normalizePersonName(c.name) || String(c.name).trim().toLowerCase();
    const old = map.get(key);
    if (!old || (rank[c.confidence] || 0) > (rank[old.confidence] || 0)) map.set(key, Object.assign({}, c));
    else if (old && !old.sourceUrl && c.sourceUrl) old.sourceUrl = c.sourceUrl;
  }
  return [...map.values()].sort((a,b) => (rank[b.confidence] || 0) - (rank[a.confidence] || 0)).slice(0, 12);
}

function mergeOwnerSources(...lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const s of (list || [])) {
    if (!s || !s.url) continue;
    const key = String(s.url).trim();
    if (seen.has(key)) continue;
    seen.add(key); out.push(s);
  }
  return out.slice(0, 24);
}

function cachedCrawl(owner) {
  const c = owner && owner._crawl;
  if (!c || !Array.isArray(c.pages) || !Array.isArray(c.emails)) return null;
  return c;
}

async function getCrawl(lead, owner) {
  return cachedCrawl(owner) || crawlCompanySite(lead.website);
}

function compactCrawl(crawl) {
  return {
    root: crawl.root || '',
    emails: (crawl.emails || []).slice(0, 20),
    emailSources: crawl.emailSources || {},
    phones: (crawl.phones || []).slice(0, 20),
    phoneSources: crawl.phoneSources || {},
    pages: (crawl.pages || []).slice(0, MAX_SITE_PAGES).map(p => ({
      url: p.url || '', title: p.title || '', emails: p.emails || [], phones: p.phones || [], text: String(p.text || '').slice(0, MAX_CRAWL_TEXT_CHARS_PER_PAGE)
    }))
  };
}

/* ── Staged endpoints ────────────────────────────────────────── */

async function enrichOwnerStage(body, env) {
  const lead = body.lead || {};
  if (!lead.name) return { ok: false, error: 'Lead needs at least a business name.' };
  const started = Date.now();
  // Registry-first: do not crawl or feed the business website into ownership research.
  const crawl = { root: '', pages: [], emails: [], emailSources: {}, phones: [], phoneSources: {} };
  const resolved = await resolveOwnerCore(body, env, lead, crawl);
  const owner = resolved.owner || {};
  const unknown = !ownerKnown(owner);
  const urls = uniq([...(owner.ownerSources || []).map(s => s && s.url).filter(Boolean)]).slice(0, 30);

  return {
    ok: true,
    stage: 'owner',
    data: {
      decisionMakerName: unknown ? 'Unknown' : owner.decisionMakerName,
      decisionMakerTitle: owner.decisionMakerTitle || 'Unknown',
      decisionMakerConfidence: owner.decisionMakerConfidence || 'LOW',
      decisionMakerEvidence: owner.decisionMakerEvidence || 'No defensible ownership evidence found.',
      directPhone: owner.directPhone || lead.directPhone || '',
      linkedin: owner.linkedin || '', instagram: owner.instagram || '', facebook: owner.facebook || '',
      ownerCandidates: owner.ownerCandidates || [], ownerSources: owner.ownerSources || [],
      researchAttempts: uniq(['Company website intentionally skipped for owner discovery', ...(owner.researchAttempts || [])]),
      researchSummary: `REGISTRY-FIRST: owner ${unknown ? 'unresolved' : owner.decisionMakerName + ' (' + (owner.decisionMakerConfidence || 'LOW') + ')'}; ${resolved.webPasses} external-record web-search pass(es); company website skipped; ${resolved.stoppedEarly ? 'stopped early on strong evidence' : 'fallback used'}; ${Date.now() - started} ms.`,
      sources: urls.join('\n'),
      needsHumanReview: unknown || confidenceRank(owner.decisionMakerConfidence) < 3,
      _researchMeta: { mode: 'registry-first', ownerWebPasses: resolved.webPasses, ownerMs: Date.now() - started }
    }
  };
}

async function enrichEmailsStage(body, env) {
  const lead = body.lead || {};
  const owner = body.owner || {};
  if (!lead.name) return { ok: false, error: 'Lead needs at least a business name.' };
  const started = Date.now();
  // Start with the company's published business contact details, then enrich
  // with independent public sources for owner-facing and alternate contacts.
  const crawl = await getCrawl(lead, owner);
  const resolved = await resolveEmailsCore(body, env, lead, crawl, owner);
  const candidates = resolved.candidates || [];
  const phoneCandidates = resolved.phoneCandidates || [];
  // If we found a legitimate non-generic address, make it the primary CRM email even when info@ is VERIFIED.
  const best = candidates.find(c => c.type !== 'pattern-derived' && !isGenericEmailAddress(c.email) && ['VERIFIED','HIGH','MEDIUM'].includes(c.confidence)) || candidates[0] || null;
  const reports = resolved.reports || [];
  const attempts = uniq([
    'Company website crawled for published business emails and phone numbers',
    ...reports.flatMap(r => r.researchAttempts || []),
    resolved.stoppedEarly ? 'Smart waterfall stopped once published email and alternate-phone goals were met.' : 'Final contact pass used to complete missing published emails or alternate business numbers.'
  ]);
  const urls = uniq([...candidates.map(c => c.sourceUrl).filter(Boolean), ...phoneCandidates.map(c => c.sourceUrl).filter(Boolean)]).slice(0, 30);
  const weak = !best || best.type === 'pattern-derived' || best.confidence === 'LOW';

  return {
    ok: true,
    stage: 'emails',
    data: {
      email: best ? best.email : '',
      emailStatus: best ? best.status : 'Not found after budgeted smart-waterfall research',
      emailConfidence: best ? best.confidence : 'LOW',
      emailCandidates: candidates,
      phoneCandidates: phoneCandidates,
      researchAttempts: attempts,
      researchSummary: `PUBLIC CONTACT ENRICHMENT: ${candidates.length} email candidate(s); ${phoneCandidates.length} phone candidate(s); ${resolved.webPasses} external-record web-search pass(es); company website scanned; ${resolved.stoppedEarly ? 'contact goals satisfied' : 'public-source fallback completed'}; ${Date.now() - started} ms.`,
      sources: urls.join('\n'),
      bestChannel: best ? 'Email' : (owner.directPhone || lead.phone ? 'Phone' : (owner.linkedin ? 'LinkedIn' : 'Unknown')),
      needsHumanReview: weak,
      _researchMeta: { mode: 'registry-first', emailWebPasses: resolved.webPasses, contactWebPasses: resolved.webPasses, emailMs: Date.now() - started }
    }
  };
}

async function enrichBusinessStage(body, env) {
  const lead = body.lead || {};
  const owner = body.owner || {};
  if (!lead.name) return { ok: false, error: 'Lead needs at least a business name.' };
  const started = Date.now();
  // Website is reserved for services/equipment/sales-fit only, never ownership/contact discovery.
  const crawl = await crawlCompanySite(lead.website);
  try {
    const researched = await researchBusinessSmart(env, body, lead, crawl, owner);
    const business = researched.result;
    return {
      ok: true,
      stage: 'business',
      data: {
        services: business.services || 'Unknown', existingEquipment: business.existingEquipment || 'Unknown',
        expansionSignals: business.expansionSignals || 'Unknown', reviewOpportunity: business.reviewOpportunity || 'None identified',
        reviewFindings: business.reviewFindings || 'No specific public review excerpt captured.', reviewEvidence: business.reviewEvidence || '',
        serviceGap: business.serviceGap || 'No verified service gap.', serviceGapEvidence: business.serviceGapEvidence || '', leadScore: business.leadScore || 0,
        buyerFit: business.buyerFit || '', scoreReasoning: business.scoreReasoning || '', salesAngle: business.salesAngle || '',
        angleEvidence: business.angleEvidence || '', bestChannel: business.bestChannel || '', openingAngle: business.openingAngle || '',
        personalization: business.personalization || '', suggestedMessage: business.suggestedMessage || '',
        researchAttempts: business.researchAttempts || [],
        researchSummary: `Sales-fit analysis: ${researched.webPasses} web-search pass(es); ${crawl.pages.length} cached company page(s); ${Date.now() - started} ms.`,
        sources: uniq([...(business.sources || []), ...(crawl.pages || []).map(p => p.url)]).slice(0, 30).join('\n'),
        _researchMeta: { mode: 'smart-waterfall', businessWebPasses: researched.webPasses, businessMs: Date.now() - started }
      }
    };
  } catch (e) {
    return { ok: false, error: 'Sales-fit research failed: ' + String(e && e.message || e) };
  }
}

// Backward-compatible one-shot action. The CRM uses staged actions, but older clients can still call enrich.
async function enrich(body, env) {
  const lead = body.lead || {};
  if (!lead.name) return { ok: false, error: 'Lead needs at least a business name.' };
  const ownerRes = await enrichOwnerStage(body, env);
  if (!ownerRes.ok) return ownerRes;
  const owner = ownerRes.data || {};
  const [emailRes, businessRes] = await Promise.all([
    enrichEmailsStage(Object.assign({}, body, { owner }), env),
    enrichBusinessStage(Object.assign({}, body, { owner }), env)
  ]);
  const data = Object.assign({}, owner);
  delete data._crawl;
  if (emailRes.ok) Object.assign(data, emailRes.data || {});
  if (businessRes.ok) Object.assign(data, businessRes.data || {});
  delete data._researchMeta;
  data.enrichedAt = new Date().toISOString();
  return { ok: true, data };
}

function extractText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  let out = '';
  for (const item of data.output || []) {
    for (const c of item.content || []) if (typeof c.text === 'string') out += c.text;
  }
  return out;
}
