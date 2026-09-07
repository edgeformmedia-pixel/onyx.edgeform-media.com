import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve('../migration/source');
const output = path.resolve('import.sql');
const decode = (s) => String(s || '').replace(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/i, '$1')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const sql = (v) => v === null || v === undefined || v === '' ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
function rows(file) {
  const html = fs.readFileSync(path.join(source, file + '.html'), 'utf8');
  const body = (html.match(/<tbody>([\s\S]*)<\/tbody>/i) || [, ''])[1];
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => decode(c[1]))).filter((r) => r.length);
}
const tabs = Object.fromEntries(['leads','users','requests','invites','sessions','activity','sends'].map((n) => {
  const all = rows(n); const [headers, ...data] = all;
  return [n, data.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])) )];
}));
const leadCols = ['id','name','category','phone','website','city','state','rating','review_count','is_national_chain','dm_name','dm_title','email','lead_score','stage','owner','next_action_date','last_contacted','enriched_at','needs_human_review','scraped_at','updated_at','data'];
function leadRow(r) { return [r.id,r.name,r.category,r.phone,r.website,r.city,r.state,r.rating,r.reviewCount,r.isNationalChain,r.dmName,r.dmTitle,r.email,r.leadScore,r.stage,r.owner,r.nextActionDate,r.lastContacted,r.enrichedAt,r.needsHumanReview,r.scrapedAt,r.updatedAt,JSON.stringify(r)]; }
const statements = [];
for (const r of tabs.leads) statements.push(`INSERT OR REPLACE INTO leads (${leadCols.join(',')}) VALUES (${leadRow(r).map(sql).join(',')});`);
for (const r of tabs.users) statements.push(`INSERT OR REPLACE INTO users (username,name,email,role,salt,hash,active,created_at,last_login) VALUES (${[r.username,r.name,r.email,r.role,r.salt,r.hash,r.active === 'FALSE' ? 0 : 1,r.createdAt,r.lastLogin].map(sql).join(',')});`);
for (const r of tabs.sessions) statements.push(`INSERT OR REPLACE INTO sessions (token,username,expires) VALUES (${[r.token,r.username,r.expires].map(sql).join(',')});`);
for (const r of tabs.requests) statements.push(`INSERT OR REPLACE INTO requests (id,email,first_name,last_name,note,status,requested_at,decided_at,decided_by) VALUES (${[r.id,r.email,r.firstName,r.lastName,r.note,r.status,r.requestedAt,r.decidedAt,r.decidedBy].map(sql).join(',')});`);
for (const r of tabs.invites) statements.push(`INSERT OR REPLACE INTO invites (token,email,name,role,kind,expires,used_at) VALUES (${[r.token,r.email,r.name,r.role,r.kind,r.expires,r.usedAt].map(sql).join(',')});`);
for (const r of tabs.activity) statements.push(`INSERT INTO activity (at,user,lead_id,lead_name,type,detail) VALUES (${[r.at,r.user,r.leadId,r.leadName,r.type,r.detail].map(sql).join(',')});`);
for (const r of tabs.sends) statements.push(`INSERT INTO sends (at,user,lead_id,recipient,from_local,subject,resend_id,status) VALUES (${[r.at,r.user,r.leadId,r.to,r.fromLocal,r.subject,r.resendId,r.status].map(sql).join(',')});`);
fs.writeFileSync(output, statements.join('\n'));
console.log(JSON.stringify(Object.fromEntries(Object.entries(tabs).map(([k,v]) => [k,v.length]))));
