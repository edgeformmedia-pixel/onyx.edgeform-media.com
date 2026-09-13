const STAGES = ['New Lead', 'Researching', 'Ready to Call', 'Contacted', 'Interested', 'Demo Booked', 'Proposal Sent', 'Won', 'Lost', 'Do Not Contact'];
const SITE_URL = 'https://onyx.edgeform-media.com';
const EMAIL_WORKER = 'https://email.edgeformmedia.workers.dev/';
const CORS = { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, accept', 'content-type': 'application/json; charset=utf-8' };
const indexed = ['name','category','phone','website','city','state','rating','reviewCount','isNationalChain','dmName','dmTitle','email','leadScore','stage','owner','nextActionDate','lastContacted','enrichedAt','needsHumanReview','scrapedAt',
  // Kept in the JSON payload rather than their own D1 columns, but explicitly
  // whitelisted here so both individual and batch research persist their work.
  'dmConfidence','dmEvidence','emailStatus','emailConfidence','directPhone','linkedin','instagram','facebook','services','existingEquipment','expansionSignals','reviewOpportunity','reviewFindings','reviewEvidence','serviceGap','serviceGapEvidence','buyerFit','scoreReasoning','salesAngle','angleEvidence','bestChannel','openingAngle','personalization','suggestedMessage','sources','emailCandidates','phoneCandidates','ownerCandidates','ownerSources','researchAttempts','researchSummary','hasLaser'];

function corsFor(request) { const origin=request.headers.get('origin')||''; const allowed=origin===SITE_URL||/^chrome-extension:\/\/[a-z]+$/i.test(origin)?origin:SITE_URL; return {...CORS,'access-control-allow-origin':allowed,'vary':'Origin'}; }
function reply(body, status = 200, headers = {...CORS,'access-control-allow-origin':SITE_URL}) { return new Response(JSON.stringify(body), { status, headers }); }
function text(v) { return String(v ?? '').trim(); }
function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function phoneKey(v) { const x = text(v).replace(/\D/g, ''); return x.length >= 10 ? x.slice(-10) : ''; }
function leadKey(row) { return phoneKey(row.phone) || `${text(row.name).toLowerCase().replace(/[^a-z0-9]/g,'')}|${text(row.city).toLowerCase().replace(/[^a-z0-9]/g,'')}`; }
async function hash(v) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join(''); }
async function safeEqual(a, b) { const aa = new TextEncoder().encode(text(a)), bb = new TextEncoder().encode(text(b)); if (aa.length !== bb.length) return false; return crypto.subtle.timingSafeEqual(aa, bb); }
function publicUser(u) { return { username:u.username, name:u.name, email:u.email, role:u.role }; }
function leadFrom(row) { const data = JSON.parse(row.data || '{}'); return { ...data, id:row.id, name:row.name, category:row.category, phone:row.phone, website:row.website, city:row.city, state:row.state, rating:row.rating, reviewCount:row.review_count, isNationalChain:row.is_national_chain, dmName:row.dm_name, dmTitle:row.dm_title, email:row.email, leadScore:row.lead_score, stage:row.stage, owner:row.owner, nextActionDate:row.next_action_date, lastContacted:row.last_contacted, enrichedAt:row.enriched_at, needsHumanReview:!!row.needs_human_review, scrapedAt:row.scraped_at, updatedAt:row.updated_at }; }
function leadColumns(r) {
  // D1 does not accept JavaScript `undefined` as a bound value. Fresh Maps
  // records intentionally omit CRM-only fields, so normalize them here.
  return [
    text(r.name), text(r.category), text(r.phone), text(r.website), text(r.city), text(r.state),
    Number(r.rating)||null, Number(r.reviewCount)||0, text(r.isNationalChain),
    text(r.dmName), text(r.dmTitle), text(r.email), Number(r.leadScore)||0,
    text(r.stage), text(r.owner), text(r.nextActionDate), text(r.lastContacted),
    text(r.enrichedAt), r.needsHumanReview ? 1 : 0, text(r.scrapedAt),
    text(r.updatedAt), JSON.stringify(r)
  ];
}
const LASER_WORDS=['laser hair','hair removal','diode laser','gentlemax','candela','soprano','splendor x','lightsheer','motus ax','elysion','cutera','lumenis','alexandrite','nd:yag'];
function laserFound(r) { const hay=(typeof r.services==='string'?r.services:JSON.stringify(r.services||''))+' '+(typeof r.existingEquipment==='string'?r.existingEquipment:JSON.stringify(r.existingEquipment||'')); const low=hay.toLowerCase(); return LASER_WORDS.some(w=>low.includes(w)) || /lhr/.test(low); }
// SQL twin of laserFound(): research mentions laser hair removal or a known laser brand.
const LASER_SQL='('+LASER_WORDS.map(w=>"lower(coalesce(json_extract(data,'$.services'),'')||' '||coalesce(json_extract(data,'$.existingEquipment'),'')) LIKE '%"+w+"%'").join(' OR ')+')';
function summary(r) { const out={laserAuto:laserFound(r)}; ['id','name','category','phone','website','city','state','isNationalChain','buyerType','dmName','dmTitle','email','emailConfidence','leadScore','buyerFit','stage','owner','nextAction','nextActionDate','lastContacted','callAttempts','callOutcome','needsHumanReview','rating','reviewCount','reviewOpportunity','reviewFindings','reviewEvidence','serviceGap','hasLaser'].forEach(k=>out[k]=r[k]); return out; }
function enrichmentWeight(row) {
  let data={};
  try { data=JSON.parse(row.data||'{}'); } catch {}
  const value=k=>text(row[k] ?? data[k]);
  let score=0;
  if(value('enriched_at'))score+=1000;
  if(value('dm_name'))score+=300;
  if(value('email'))score+=300;
  if(Number(row.lead_score||data.leadScore)>0)score+=180;
  if(value('owner'))score+=120;
  if(value('last_contacted'))score+=120;
  if(value('notes'))score+=80;
  if(value('website'))score+=30;
  if(value('phone'))score+=30;
  return score;
}
async function duplicateRows(env, lead) {
  const pk=phoneKey(lead.phone);
  if(pk)return (await env.DB.prepare("SELECT rowid AS _rowid,* FROM leads WHERE replace(replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ',''),'+','') LIKE ? ORDER BY rowid ASC LIMIT 25").bind('%'+pk).all()).results;
  return (await env.DB.prepare('SELECT rowid AS _rowid,* FROM leads WHERE lower(name)=? AND lower(city)=? ORDER BY rowid ASC LIMIT 25').bind(text(lead.name).toLowerCase(),text(lead.city).toLowerCase()).all()).results;
}
async function preserveBestDuplicate(env, rows) {
  if(rows.length<2)return 0;
  const ranked=[...rows].sort((a,b)=>enrichmentWeight(b)-enrichmentWeight(a) || Number(a._rowid)-Number(b._rowid));
  const keep=ranked[0];
  const remove=ranked.slice(1).filter(row=>row.id!==keep.id);
  if(remove.length)await env.DB.batch(remove.map(row=>env.DB.prepare('DELETE FROM leads WHERE id=?').bind(row.id)));
  return remove.length;
}
async function userFor(env, token) { if (!token) return null; const row = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.username=s.username WHERE s.token=? AND s.expires>? AND u.active=1').bind(token, now()).first(); return row ? publicUser(row) : null; }
async function log(env, who, lead, type, detail) { await env.DB.prepare('INSERT INTO activity(at,user,lead_id,lead_name,type,detail) VALUES(?,?,?,?,?,?)').bind(now(), who.name || who.username, lead?.id || '', lead?.name || '', type, text(detail).slice(0,900)).run(); }
async function getLead(env, leadId) { const row=await env.DB.prepare('SELECT * FROM leads WHERE id=?').bind(leadId).first(); return row ? leadFrom(row) : null; }
async function saveLead(env, r) { const v=leadColumns(r); await env.DB.prepare('UPDATE leads SET name=?,category=?,phone=?,website=?,city=?,state=?,rating=?,review_count=?,is_national_chain=?,dm_name=?,dm_title=?,email=?,lead_score=?,stage=?,owner=?,next_action_date=?,last_contacted=?,enriched_at=?,needs_human_review=?,scraped_at=?,updated_at=?,data=? WHERE id=?').bind(...v,r.id).run(); }
async function sendMail(env, to, subject, html) { try { const r=await fetch(EMAIL_WORKER,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'email',secret:env.ONYX_SECRET,to,subject,html,fromLocal:'noreply',fromName:'ONYX CRM'})}); return !!(await r.json()).ok; } catch { return false; } }
function mail(title, body) { return `<div style="font:15px/1.6 Arial;color:#111;max-width:520px;margin:auto;padding:24px"><div style="font-weight:700;letter-spacing:.18em;color:#2f45c5">ONYX</div><h2>${title}</h2>${body}<hr><small>Edgeform Media · ONYX CRM</small></div>`; }
function button(url,label) { return `<p><a href="${url}" style="background:#2f45c5;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">${label}</a></p><p><small>${url}</small></p>`; }
async function invite(env,email,name,role,kind) { const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''); await env.DB.prepare('INSERT INTO invites(token,email,name,role,kind,expires,used_at) VALUES(?,?,?,?,?,?,NULL)').bind(token,text(email).toLowerCase(),text(name),role||'rep',kind||'activate',new Date(Date.now()+72*3600e3).toISOString()).run(); return token; }

async function handle(env, b) {
  if (!(await safeEqual(b.secret, env.ONYX_SECRET))) return {ok:false,error:'Bad secret.'};
  if (b.action==='ping') { const x=await env.DB.prepare('SELECT count(*) n FROM leads').first(); return {ok:true,service:'ONYX CRM',leads:x.n}; }
  if (b.action==='login') { const u=await env.DB.prepare('SELECT * FROM users WHERE lower(username)=? OR lower(email)=?').bind(text(b.username).toLowerCase(),text(b.username).toLowerCase()).first(); if (!u || !u.active || !(await safeEqual(await hash(u.salt+text(b.password)),u.hash))) return {ok:false,error:'Wrong username or password.'}; const token=id()+id(); await env.DB.batch([env.DB.prepare('INSERT INTO sessions(token,username,expires) VALUES(?,?,?)').bind(token,u.username,new Date(Date.now()+12*3600e3).toISOString()),env.DB.prepare('UPDATE users SET last_login=? WHERE username=?').bind(now(),u.username),env.DB.prepare('DELETE FROM sessions WHERE expires<=?').bind(now())]); return {ok:true,token,user:publicUser(u)}; }
  if (b.action==='appendLeads') {
    const rows=Array.isArray(b.rows)?b.rows:[];
    let added=0,duplicates=0,duplicateRowsDeleted=0;
    for(const raw of rows.slice(0,200)){
      const r={...raw,id:text(raw.id)||id(),stage:text(raw.stage)||'New Lead',callAttempts:Number(raw.callAttempts)||0,updatedAt:now()};
      const matches=await duplicateRows(env,r);
      if(matches.length){
        duplicates++;
        duplicateRowsDeleted+=await preserveBestDuplicate(env,matches);
        continue;
      }
      await env.DB.prepare('INSERT INTO leads(id,name,category,phone,website,city,state,rating,review_count,is_national_chain,dm_name,dm_title,email,lead_score,stage,owner,next_action_date,last_contacted,enriched_at,needs_human_review,scraped_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(r.id,...leadColumns(r)).run();
      added++;
    }
    const total=(await env.DB.prepare('SELECT count(*) n FROM leads').first()).n;
    return {ok:true,added,duplicates,duplicateRowsDeleted,total};
  }
  if (b.action==='checkInvite') { const x=await env.DB.prepare('SELECT * FROM invites WHERE token=?').bind(b.token).first(); if(!x)return {ok:false,error:'This link is not valid.'}; if(x.used_at || Date.parse(x.expires)<=Date.now())return {ok:false,error:x.used_at?'That link was already used.':'That link has expired. Ask an admin for a new one.'}; return {ok:true,email:x.email,name:x.name,kind:x.kind}; }
  if (b.action==='activate') { const x=await env.DB.prepare('SELECT * FROM invites WHERE token=?').bind(b.token).first(); if(!x||x.used_at||Date.parse(x.expires)<=Date.now())return {ok:false,error:'This link is no longer valid.'}; if(text(b.password).length<8)return {ok:false,error:'Use at least 8 characters.'}; const existing=await env.DB.prepare('SELECT * FROM users WHERE lower(email)=?').bind(x.email.toLowerCase()).first(); const salt=id(),h=await hash(salt+text(b.password)); if(x.kind==='reset'){if(!existing)return {ok:false,error:'No account for that address.'}; await env.DB.prepare('UPDATE users SET salt=?,hash=? WHERE username=?').bind(salt,h,existing.username).run();}else{if(existing)return {ok:false,error:'That account already exists — sign in instead.'}; let username=text(b.username||x.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9._-]/g,''); if(!username)username='user'; const found=await env.DB.prepare('SELECT username FROM users WHERE username=?').bind(username).first(); if(found)username+=crypto.getRandomValues(new Uint32Array(1))[0].toString().slice(-3); await env.DB.prepare('INSERT INTO users(username,name,email,role,salt,hash,active,created_at) VALUES(?,?,?,?,?,?,1,?)').bind(username,x.name,x.email,x.role,salt,h,now()).run();} await env.DB.prepare('UPDATE invites SET used_at=? WHERE token=?').bind(now(),x.token).run(); return {ok:true,message:'Account ready. You can sign in now.'}; }
  if (b.action==='forgotPassword') { const u=await env.DB.prepare('SELECT * FROM users WHERE lower(email)=? AND active=1').bind(text(b.email).toLowerCase()).first(); if(u){const token=await invite(env,u.email,u.name,u.role,'reset'); await sendMail(env,u.email,'Reset your ONYX password',mail('Password reset',button(`${SITE_URL}/activate/?id=${token}`,'Set a new password')));} return {ok:true,message:'If that address has an account, a reset link is on its way.'}; }
  if (b.action==='requestAccess') { const email=text(b.email).toLowerCase(), first=text(b.firstName), last=text(b.lastName); if(!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email))return {ok:false,error:'That email does not look right.'}; if(!first||!last)return {ok:false,error:'First and last name are both required.'}; if(!email.endsWith('@edgeform-media.com'))return {ok:false,error:'Access is limited to edgeform-media.com addresses.'}; const user=await env.DB.prepare('SELECT username FROM users WHERE lower(email)=?').bind(email).first(); if(user)return {ok:false,error:'There is already an account for that address. Try signing in.'}; const pending=await env.DB.prepare("SELECT id FROM requests WHERE lower(email)=? AND status='pending'").bind(email).first(); if(pending)return {ok:true,pending:true,message:'Your request is already waiting on an admin.'}; await env.DB.prepare('INSERT INTO requests(id,email,first_name,last_name,note,status,requested_at) VALUES(?,?,?,?,?,?,?)').bind(id().slice(0,8),email,first,last,text(b.note).slice(0,400),'pending',now()).run(); return {ok:true,message:'Request sent. An admin will approve you shortly.'}; }
  const who=await userFor(env,b.token); if(!who)return {ok:false,error:'SESSION_EXPIRED'};
  if(b.action==='me')return {ok:true,user:who}; if(b.action==='logout'){await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(b.token).run();return {ok:true};}
  if(b.action==='pipelineFacets'){
    const cities=(await env.DB.prepare("SELECT trim(city) city, count(*) count FROM leads WHERE trim(coalesce(city,''))<>'' GROUP BY lower(trim(city)) ORDER BY lower(trim(city))").all()).results;
    return {ok:true,cities:cities.map(r=>({city:r.city,count:Number(r.count)||0}))};
  }
  if(b.action==='listLeads'){
    const terms=[],p=[];
    if(b.stage){terms.push('stage=?');p.push(b.stage)}
    if(b.owner){terms.push('owner=?');p.push(b.owner)}
    if(b.hideChains)terms.push("coalesce(is_national_chain,'') <> 'Yes'");
    if(b.emailStatus==='missing'||b.needsEmail)terms.push("trim(coalesce(email,''))='' ");
    if(b.emailStatus==='has')terms.push("trim(coalesce(email,''))<>'' ");
    if(b.decisionMakerStatus==='missing')terms.push("(trim(coalesce(dm_name,''))='' OR lower(trim(dm_name))='unknown')");
    if(b.decisionMakerStatus==='has')terms.push("trim(coalesce(dm_name,''))<>'' AND lower(trim(dm_name))<>'unknown'");
    if(b.needsResearch)terms.push("coalesce(enriched_at,'')='' ");
    if(b.laser){const marked="coalesce(json_extract(data,'$.hasLaser'),'')";
      if(b.laser==='yes'){terms.push(`(${marked}='yes' OR (${marked}='' AND ${LASER_SQL}))`)}
      if(b.laser==='no'){terms.push(`(${marked}='no' OR (${marked}='' AND NOT ${LASER_SQL}))`)}
      if(b.laser==='unmarked')terms.push(`${marked}=''`);}
    if(b.needsContactResearch)terms.push("(trim(coalesce(dm_name,''))='' OR lower(trim(dm_name))='unknown' OR trim(coalesce(email,''))='')");
    const cities=Array.isArray(b.cities)?b.cities.map(text).filter(Boolean).slice(0,100):[];
    if(cities.length){terms.push('lower(trim(city)) IN ('+cities.map(()=>'?').join(',')+')');p.push(...cities.map(x=>x.toLowerCase()))}
    if(text(b.q)){terms.push("lower(name||' '||city||' '||dm_name||' '||phone||' '||email||' '||category) LIKE ?");p.push('%'+text(b.q).toLowerCase()+'%')}
    const where=terms.length?' WHERE '+terms.join(' AND '):'';
    const total=(await env.DB.prepare('SELECT count(*) n FROM leads'+where).bind(...p).first()).n;
    const size=Math.min(1000,Math.max(1,Number(b.size)||50)),page=Math.max(0,Number(b.page)||0);
    const sort=b.sort==='city_asc'?'lower(city) ASC, name ASC':b.sort==='city_desc'?'lower(city) DESC, name ASC':'lead_score DESC, updated_at DESC';
    const rows=(await env.DB.prepare('SELECT * FROM leads'+where+' ORDER BY '+sort+' LIMIT ? OFFSET ?').bind(...p,size,page*size).all()).results.map(x=>summary(leadFrom(x)));
    return {ok:true,total,page,leads:rows};
  }
  if(b.action==='getLead'){const r=await getLead(env,b.id);if(!r)return {ok:false,error:'Lead not found.'};const activity=(await env.DB.prepare('SELECT at,user,lead_id leadId,lead_name leadName,type,detail FROM activity WHERE lead_id=? ORDER BY at DESC LIMIT 40').bind(b.id).all()).results;return {ok:true,lead:r,activity,stages:STAGES};}
  if(b.action==='updateLead'){const r=await getLead(env,b.id);if(!r)return {ok:false,error:'Lead not found.'};const changed=[];for(const k of indexed){if(k==='id'||!Object.hasOwn(b.fields||{},k))continue;const v=b.fields[k];if(String(r[k]??'')!==String(v??'')){r[k]=v;changed.push(k)}}r.updatedAt=now();await saveLead(env,r);if(changed.length)await log(env,who,r,changed.includes('stage')?'stage':'edit',changed.includes('stage')?'Stage → '+r.stage:'Updated '+changed.join(', '));return {ok:true,changed};}
  if(b.action==='addNote'){const r=await getLead(env,b.id);if(!r)return {ok:false,error:'Lead not found.'};if(!text(b.note))return {ok:false,error:'Note is empty.'};const line=`[${now().slice(0,16).replace('T',' ')} ${who.name}] ${text(b.note)}`;r.notes=(r.notes?line+'\n'+r.notes:line).slice(0,45000);r.updatedAt=now();await saveLead(env,r);await log(env,who,r,'note',b.note);return {ok:true,notes:r.notes};}
  if(b.action==='callQueue'){const d=new Date();d.setHours(23,59,59,999);let sql="SELECT * FROM leads WHERE stage NOT IN ('Won','Lost','Do Not Contact') AND coalesce(phone,'')<>''";const p=[];if(b.mine){sql+=' AND (coalesce(owner,\'\')=\'\' OR owner=?)';p.push(who.username)}sql+=' AND (coalesce(next_action_date,\'\')=\'\' OR next_action_date<=?) ORDER BY CASE WHEN coalesce(next_action_date,\'\')=\'\' THEN 1 ELSE 0 END,lead_score DESC LIMIT ?';p.push(d.toISOString(),Math.min(100,Number(b.size)||40));const q=(await env.DB.prepare(sql).bind(...p).all()).results.map(x=>summary(leadFrom(x)));return {ok:true,total:q.length,queue:q};}
  if(b.action==='logCall'){const r=await getLead(env,b.id);if(!r)return {ok:false,error:'Lead not found.'};const raw=b.details&&typeof b.details==='object'?b.details:{},details={answeredBy:text(raw.answeredBy),interest:text(raw.interest),duration:text(raw.duration),objection:text(raw.objection),nextStep:text(raw.nextStep),contactReached:text(raw.contactReached),appointmentAt:text(raw.appointmentAt)};r.callAttempts=(Number(r.callAttempts)||0)+1;r.callOutcome=text(b.outcome)||'Called';r.lastContacted=now();r.lastCallDetails=details;if(details.appointmentAt)r.appointmentAt=details.appointmentAt;if(b.stage)r.stage=b.stage;if(b.nextAction)r.nextAction=text(b.nextAction);if(b.nextActionDate)r.nextActionDate=text(b.nextActionDate);else if(details.appointmentAt)r.nextActionDate=details.appointmentAt.slice(0,10);if(!r.owner)r.owner=who.username;r.updatedAt=now();const parts=[r.callOutcome,details.answeredBy&&'Answered by: '+details.answeredBy,details.contactReached&&'Contact: '+details.contactReached,details.interest&&'Interest: '+details.interest,details.duration&&'Length: '+details.duration,details.objection&&'Objection: '+details.objection,details.nextStep&&'Next: '+details.nextStep,details.appointmentAt&&'Appointment: '+details.appointmentAt,text(b.note)&&'Notes: '+text(b.note)].filter(Boolean),detail=parts.join(' — ');await saveLead(env,r);await log(env,who,r,'call',detail);if(parts.length>1){r.notes=(`[${now().slice(0,16).replace('T',' ')} ${who.name}] ${detail}\n`+(r.notes||'')).slice(0,45000);await saveLead(env,r)}return {ok:true};}
  if(b.action==='logDialStart'){const r=await getLead(env,b.id);if(!r)return {ok:false,error:'Lead not found.'};await log(env,who,r,'dial','Call started');return {ok:true};}
  if(b.action==='dialMobileStats'){const start=text(b.dayStart)||now().slice(0,10)+'T00:00:00.000Z',end=text(b.dayEnd)||now().slice(0,10)+'T23:59:59.999Z',actor=who.name||who.username;const day=(await env.DB.prepare("SELECT type,detail FROM activity WHERE user=? AND at>=? AND at<? AND type IN ('dial','call') ORDER BY at DESC").bind(actor,start,end).all()).results;const calls=day.filter(x=>x.type==='call'),dials=day.filter(x=>x.type==='dial').length;const history=(await env.DB.prepare("SELECT at,user,lead_id leadId,lead_name leadName,type,detail FROM activity WHERE user=? AND type='call' ORDER BY at DESC LIMIT 30").bind(actor).all()).results;const isNoAnswer=x=>/^(No answer|Left voicemail)/i.test(text(x.detail));return {ok:true,today:{dials,logged:calls.length,appointments:calls.filter(x=>/^Appointment set/i.test(text(x.detail))).length,answered:calls.filter(x=>!isNoAnswer(x)).length,noAnswers:calls.filter(isNoAnswer).length},history};}
  if(b.action==='logSend'){const r=await getLead(env,b.id);await env.DB.prepare('INSERT INTO sends(at,user,lead_id,recipient,from_local,subject,resend_id,status) VALUES(?,?,?,?,?,?,?,?)').bind(now(),who.username,b.id||'',b.to||'',b.fromLocal||'',b.subject||'',b.resendId||'',b.status||'sent').run();if(r){r.lastContacted=now();if(r.stage==='New Lead'||r.stage==='Ready to Call')r.stage='Contacted';r.updatedAt=now();await saveLead(env,r);await log(env,who,r,'email',b.subject||'')}return {ok:true};}
  if(b.action==='stats'){const rows=(await env.DB.prepare('SELECT stage,email,enriched_at,is_national_chain,owner FROM leads').all()).results,byStage=Object.fromEntries(STAGES.map(s=>[s,0]));let needEmail=0,needResearch=0,chains=0,mine=0;for(const r of rows){byStage[r.stage]=(byStage[r.stage]||0)+1;if(!r.email)needEmail++;if(!r.enriched_at)needResearch++;if(r.is_national_chain==='Yes')chains++;if(r.owner===who.username)mine++}const recent=(await env.DB.prepare('SELECT at,user,lead_id leadId,lead_name leadName,type,detail FROM activity ORDER BY at DESC LIMIT 12').all()).results;const pending=who.role==='admin'?(await env.DB.prepare("SELECT count(*) n FROM requests WHERE status='pending'").first()).n:0;return {ok:true,total:rows.length,byStage,needEmail,needResearch,chains,mine,pendingRequests:pending,stages:STAGES,recent};}
  if(who.role!=='admin')return {ok:false,error:'Admins only.'};
  if(b.action==='listUsers'){const users=(await env.DB.prepare('SELECT username,name,email,role,active,last_login lastLogin FROM users').all()).results.map(x=>({...x,active:!!x.active}));return {ok:true,users};}
  if(b.action==='setUserActive'){if(b.username===who.username)return {ok:false,error:'You cannot disable your own account.'};await env.DB.prepare('UPDATE users SET active=? WHERE username=?').bind(b.active?1:0,b.username).run();return {ok:true};}
  if(b.action==='listRequests'){const requests=(await env.DB.prepare('SELECT id,email,first_name firstName,last_name lastName,note,status,requested_at requestedAt,decided_by decidedBy FROM requests ORDER BY requested_at DESC').all()).results;return {ok:true,requests};}
  if(b.action==='approveRequest'){const r=await env.DB.prepare("SELECT * FROM requests WHERE id=? AND status='pending'").bind(b.id).first();if(!r)return {ok:false,error:'Request not found or already decided.'};const token=await invite(env,r.email,`${r.first_name} ${r.last_name}`,b.role||'rep','activate'),link=`${SITE_URL}/activate/?id=${token}`,emailed=await sendMail(env,r.email,'Your ONYX account is ready',mail('You have been approved',button(link,'Create my password')));await env.DB.prepare("UPDATE requests SET status='approved',decided_at=?,decided_by=? WHERE id=?").bind(now(),who.username,b.id).run();return {ok:true,emailed,link,message:emailed?'Approved and emailed.':'Approved, but the email failed — copy the link to them.'};}
  if(b.action==='rejectRequest'){const r=await env.DB.prepare('SELECT id FROM requests WHERE id=?').bind(b.id).first();if(!r)return {ok:false,error:'Request not found.'};await env.DB.prepare("UPDATE requests SET status='rejected',decided_at=?,decided_by=? WHERE id=?").bind(now(),who.username,b.id).run();return {ok:true};}
  if(b.action==='inviteUser'){const email=text(b.email).toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email))return {ok:false,error:'Enter a valid email.'};const token=await invite(env,email,b.name||email.split('@')[0],b.role||'rep','activate'),link=`${SITE_URL}/activate/?id=${token}`,emailed=await sendMail(env,email,'You have been invited to ONYX',mail('Invitation to ONYX CRM',button(link,'Create my password')));return {ok:true,emailed,link};}
  if(b.action==='setPassword'){const target=text(b.username||who.username).toLowerCase();if(target!==who.username&&who.role!=='admin')return {ok:false,error:'You can only change your own password.'};if(text(b.password).length<8)return {ok:false,error:'Use at least 8 characters.'};const salt=id();await env.DB.prepare('UPDATE users SET salt=?,hash=? WHERE username=?').bind(salt,await hash(salt+text(b.password)),target).run();return {ok:true};}
  return {ok:false,error:'Unknown action: '+b.action};
}

export default { async fetch(request, env) { const headers=corsFor(request); if(request.method==='OPTIONS')return new Response(null,{headers}); if(request.method==='GET')return reply({ok:true,service:'ONYX CRM'},200,headers); if(request.method!=='POST')return reply({ok:false,error:'Method not allowed.'},405,headers); try { const b=await request.json(); return reply(await handle(env,b),200,headers); } catch(e) { console.error(JSON.stringify({event:'crm_error',message:e.message})); return reply({ok:false,error:'The CRM could not complete that request.'},500,headers); } } };
