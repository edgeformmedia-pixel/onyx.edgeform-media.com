// ══════════════════════════════════════════════════════════════
// LeadHunter v4 — complete, one-at-a-time Google Maps collection + ONYX sync
// Built from a live DOM probe of the current Google Maps UI.
//
// Fast path:
//   feed:      div[role="feed"]
//   card:      a.hfpxzc[href*="/maps/place/"]
//   name:      h1.DUwDvf
//   address:   button[data-item-id="address"]
//   phone:     button[aria-label^="Phone:"]   (handles phone: AND phone:tel:)
//   website:   a[data-item-id="authority"]
//   rating:    div.F7nice
//   category:  button.DkEaL
//
// Each result is opened and verified by business name. The scraper waits for
// late detail rows, hydrates the detail pane with a slow scroll, then records
// every structured Maps row before it advances to the next business.
// ══════════════════════════════════════════════════════════════

(function () {
  'use strict';
  if (window.__LH35__) return;
  window.__LH35__ = true;

  const LH3 = window.LH3;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const K_RUN='lh3_run', K_SET='lh3_settings', K_SEEN='lh3_seen', K_LEADS='lh3_leads', K_HISTORY='lh3_research_history', K_PROBE='lh3_probe', K_UPLOAD_QUEUE='lh4_upload_queue';
  const get = async (k,d) => { const o=await chrome.storage.local.get(k); return o[k]===undefined?d:o[k]; };
  const set = o => chrome.storage.local.set(o);
  const txt = el => (el ? (el.textContent || '').replace(/\s+/g,' ').trim() : '');
  const PHONE_RX = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const CARD_SELECTOR='a.hfpxzc[href*="/maps/place/"]';
  const DETAIL_TIMEOUT_MS=15000;
  const MIN_LEAD_DWELL_MS=8000;
  const RESULT_SCROLL_PAUSE_MS=900;
  const DETAIL_COOLDOWN_MS=700;

  let PANEL, STATUS_EL, META_EL, FILL_EL, TRACK_EL, START_BTN, STOP_BTN, SCAN_BTN, PROBE_BTN;
  let stepGuard=false, uploadFlushGuard=false;

  async function liveRun(gen) {
    const r=await get(K_RUN,null);
    if (!r || !r.active) return null;
    if (gen!==undefined && r.gen!==gen) return null;
    return r;
  }

  function normalizePhone(raw) {
    const d=String(raw||'').replace(/\D/g,'');
    if (d.length===11 && d[0]==='1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
    if (d.length===10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    return String(raw||'').trim();
  }

  function parseCount(s) {
    const m=String(s||'').replace(/[,\s]/g,'').match(/([\d.]+)([KMkm]?)/);
    if(!m) return 0;
    const n=parseFloat(m[1]); if(!isFinite(n)) return 0;
    const x=m[2].toLowerCase()==='k'?1000:m[2].toLowerCase()==='m'?1000000:1;
    return Math.round(n*x);
  }

  function parseAddress(raw) {
    let s=String(raw||'').replace(/^Address:\s*/i,'').trim();
    const out={street:'',city:'',state:'',zip:'',full:s};
    if(!s) return out;
    const p=s.split(',').map(x=>x.trim()).filter(Boolean);
    if(p.length>=3){
      const tail=p[p.length-1].match(/^([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/);
      if(tail){
        out.state=tail[1]; out.zip=tail[2]||'';
        out.city=p[p.length-2]||'';
        out.street=p.slice(0,-2).join(', ');
        return out;
      }
    }
    const m=s.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?$/);
    if(m){ out.street=m[1]; out.city=m[2]; out.state=m[3]; out.zip=m[4]||''; }
    return out;
  }

  function cleanWebsite(href) {
    if(!href) return '';
    try {
      const u=new URL(href,location.href);
      if(u.hostname.endsWith('google.com') && u.pathname==='/url' && u.searchParams.get('q')) return cleanWebsite(u.searchParams.get('q'));
      for(const k of [...u.searchParams.keys()]) if(/^utm_/i.test(k)) u.searchParams.delete(k);
      return u.href;
    } catch(e){ return href; }
  }

  function mapsSearchUrl(term,city) {
    const q=[term,city].filter(Boolean).join(' ');
    return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(q);
  }

  function pageBlocked() {
    return location.pathname.startsWith('/sorry/') || !!document.querySelector('form[action*="/sorry/"], #recaptcha');
  }

  async function waitFor(fn, timeout=12000, every=80) {
    const end=Date.now()+timeout;
    while(Date.now()<end){
      try { const v=fn(); if(v) return v; } catch(e){}
      await sleep(every);
    }
    return null;
  }

  function cleanCardName(s) {
    return String(s||'').replace(/\s*[·•]\s*Visited link\s*$/i,'').trim();
  }

  function normName(s) {
    return cleanCardName(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();
  }

  function nameMatches(actual, expected) {
    const a=normName(actual), e=normName(expected);
    if(!a || !e) return false;
    return a===e || (a.length>8 && e.length>8 && (a.includes(e) || e.includes(a)));
  }

  function placeKey(href) {
    try { const u=new URL(href,location.href); return isPlaceUrl(u.href) ? u.pathname : ''; }
    catch(e){ return String(href||'').split('?')[0]; }
  }

  function isPlaceUrl(href) {
    try {
      const u=new URL(href,location.href);
      return /(^|\.)google\.com$/i.test(u.hostname) && /^\/maps\/place\//i.test(u.pathname);
    } catch(e){ return false; }
  }

  function feedEl() {
    return document.querySelector('div[role="feed"]');
  }

  function feedEnded(feed) {
    if(!feed) return false;
    return /you['’]?ve reached the end|end of the list/i.test(txt(feed));
  }

  function currentCardNodes() {
    const feed=feedEl();
    if(!feed) return [];
    let nodes=[...feed.querySelectorAll(CARD_SELECTOR)];
    if(!nodes.length) nodes=[...feed.querySelectorAll('a[href][aria-label]')].filter(a=>isPlaceUrl(a.href||a.getAttribute('href')));
    return nodes.filter(a=>isPlaceUrl(a.href||a.getAttribute('href')) && cleanCardName(a.getAttribute('aria-label')||txt(a)));
  }

  function resultAnchors() {
    const feed=feedEl();
    const top=feed ? feed.scrollTop : 0;
    const seen=new Set(), out=[];
    for(const a of currentCardNodes()){
      const href=a.href || a.getAttribute('href') || '';
      const key=placeKey(href);
      if(!isPlaceUrl(href) || !key || seen.has(key)) continue;
      seen.add(key);
      out.push({href,key,name:cleanCardName(a.getAttribute('aria-label')||txt(a)),scrollTop:top});
    }
    return out;
  }

  function captureVisible(found) {
    const feed=feedEl();
    const top=feed ? feed.scrollTop : 0;
    let added=0;
    for(const p of resultAnchors()){
      if(found.has(p.key)) continue;
      p.scrollTop=top;
      found.set(p.key,p);
      added++;
    }
    return added;
  }

  async function collectPlaces(target, gen) {
    const ready=await waitFor(()=>feedEl() || currentCardNodes().length,10000,80);
    if(!ready && !currentCardNodes().length) return [];

    const found=new Map();
    const f=feedEl();
    if(!f){
      captureVisible(found);
      return [...found.values()].slice(0,target);
    }

    // Start at the top so discovery order + recorded scrollTop are stable,
    // even if the user had already clicked/scrollled a result before starting.
    f.scrollTop=0;
    f.dispatchEvent(new Event('scroll',{bubbles:true}));
    await sleep(60);
    captureVisible(found);

    let noNew=0;
    for(let round=0; round<120 && found.size<target; round++){
      if(!await liveRun(gen)) break;
      const before=found.size;
      const beforeHeight=f.scrollHeight;
      const maxTop=Math.max(0,f.scrollHeight-f.clientHeight);
      const stepPx=Math.max(420,Math.round(f.clientHeight*0.72));
      const next=Math.min(maxTop,f.scrollTop+stepPx);
      f.scrollTop = next>f.scrollTop+2 ? next : maxTop;
      f.dispatchEvent(new Event('scroll',{bubbles:true}));

      await waitFor(()=>{
        captureVisible(found);
        return found.size>before || f.scrollHeight>beforeHeight || feedEnded(f);
      },650,50);
      captureVisible(found);

      if(found.size===before) noNew++; else noNew=0;
      const atBottom=f.scrollTop+f.clientHeight>=f.scrollHeight-8;
      if(feedEnded(f) || (atBottom && noNew>=4)) break;
      if(atBottom && noNew) await sleep(180);
    }
    return [...found.values()].slice(0,target);
  }

  function detailName() {
    return txt(document.querySelector('h1.DUwDvf'));
  }

  function attrText(el) {
    if(!el) return '';
    return (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || txt(el) || '').trim();
  }

  function infoRegion(expectedName) {
    const regs=[...document.querySelectorAll('div[role="region"][aria-label^="Information for "]')];
    if(!regs.length) return null;
    const hit=regs.find(r=>nameMatches((r.getAttribute('aria-label')||'').replace(/^Information for\s+/i,''), expectedName||detailName()));
    return hit || regs[regs.length-1];
  }

  function detailPanel(expectedName) {
    const h=document.querySelector('h1.DUwDvf');
    const reg=infoRegion(expectedName);
    if(!h) return document;
    let el=h;
    for(let i=0;i<9 && el;i++,el=el.parentElement){
      if(reg && el.contains(reg)) return el;
    }
    return document;
  }

  function detailScroller(expectedName) {
    const panel=detailPanel(expectedName);
    const h=document.querySelector('h1.DUwDvf');
    let el=h || panel;
    for(let i=0;el && el!==document.body && i<12;i++,el=el.parentElement){
      try{
        const style=getComputedStyle(el);
        if(/auto|scroll/.test(style.overflowY) && el.scrollHeight>el.clientHeight+40) return el;
      }catch(e){}
    }
    return [...panel.querySelectorAll('div')].find(x=>{
      try{return /auto|scroll/.test(getComputedStyle(x).overflowY) && x.scrollHeight>x.clientHeight+40;}
      catch(e){return false;}
    }) || null;
  }

  async function hydrateDetail(expectedName, gen) {
    const scroller=detailScroller(expectedName);
    if(!scroller) return;
    const oldTop=scroller.scrollTop;
    const max=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
    for(let i=0;i<=4;i++){
      if(!await liveRun(gen)) return;
      scroller.scrollTop=Math.round(max*(i/4));
      scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
      await sleep(220);
    }
    scroller.scrollTop=Math.min(oldTop,Math.max(0,scroller.scrollHeight-scroller.clientHeight));
    scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
    await sleep(220);
  }

  function websiteFromSponsoredPanel(expectedName) {
    const panel=detailPanel(expectedName);
    const candidates=[...panel.querySelectorAll('a.bm892c[aria-label], .BK5vjc')];
    for(const el of candidates){
      const s=(el.getAttribute && el.getAttribute('aria-label')) || txt(el);
      const matches=String(s||'').match(/(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/ig) || [];
      for(let i=matches.length-1;i>=0;i--){
        const raw=matches[i].replace(/[),.;]+$/,'');
        if(/google\./i.test(raw)) continue;
        try { return cleanWebsite(/^https?:\/\//i.test(raw)?raw:'https://'+raw.replace(/^www\./i,'www.')); }
        catch(e){}
      }
    }
    return '';
  }

  function readCoreFields(expectedName) {
    const root=infoRegion(expectedName) || detailPanel(expectedName) || document;
    const addressEl=root.querySelector('button[data-item-id="address"],button[aria-label^="Address:"]');
    // Probe evidence: the button can arrive very late and the companion tel: link
    // is a useful fallback on compact layouts.
    const phoneEl=root.querySelector('button[aria-label^="Phone:"],button[data-item-id^="phone:"],a[href^="tel:"],[data-tooltip*="phone" i]');
    const webEl=root.querySelector('a[data-item-id="authority"][href],a[aria-label^="Website:"][href]');

    let phone='';
    if(phoneEl){
      const raw=((phoneEl.getAttribute('href')||'').replace(/^tel:/i,'') || attrText(phoneEl)).replace(/^Phone:\s*/i,'');
      const pm=raw.match(PHONE_RX); phone=normalizePhone(pm?pm[0]:raw);
    }
    const address=parseAddress(attrText(addressEl));
    const website=webEl ? cleanWebsite(webEl.href) : websiteFromSponsoredPanel(expectedName);
    return {address,phone,website,addressEl,phoneEl,webEl};
  }

  async function waitForDetail(expectedName, timeout=DETAIL_TIMEOUT_MS, requirePhone=true) {
    const end=Date.now()+timeout;
    let last=null, signature='', stableSince=0;
    while(Date.now()<end){
      if(!nameMatches(detailName(),expectedName)){ await sleep(100); continue; }
      const fields=readCoreFields(expectedName);
      last=fields;
      const root=infoRegion(expectedName) || detailPanel(expectedName);
      const next=[fields.phone,fields.website,fields.address.full,root.querySelectorAll('[data-item-id]').length,(root.outerHTML||'').length].join('|');
      if(next!==signature){signature=next;stableSince=Date.now();}
      const stableFor=Date.now()-stableSince;
      if(fields.phone && fields.address.full && stableFor>=700) return fields;
      if(!requirePhone && (fields.address.full || fields.website) && stableFor>=1800) return fields;
      await sleep(100);
    }
    return last || readCoreFields(expectedName);
  }

  function labeledValue(root, selectors, prefix) {
    const el=root.querySelector(selectors);
    return el ? attrText(el).replace(prefix||/^$/,'').trim() : '';
  }

  function collectMapDetails(panel) {
    const seen=new Set(), rows=[];
    for(const el of panel.querySelectorAll('[data-item-id],button[aria-label],a[aria-label],[data-tooltip]')){
      const dataItemId=el.getAttribute('data-item-id')||'';
      const ariaLabel=el.getAttribute('aria-label')||'';
      const dataTooltip=el.getAttribute('data-tooltip')||'';
      const href=el.getAttribute('href')||'';
      const value=txt(el).slice(0,1000);
      const key=[dataItemId,ariaLabel,dataTooltip,href,value].join('|');
      if(!key.replace(/\|/g,'') || seen.has(key)) continue;
      seen.add(key);
      rows.push({order:rows.length,tag:el.tagName.toLowerCase(),dataItemId,ariaLabel,dataTooltip,href,value});
      if(rows.length>=180) break;
    }
    return rows;
  }

  function hasReviewDetails(expectedName) {
    const panel=detailPanel(expectedName);
    const nice=panel.querySelector('div.F7nice');
    if(nice && /[0-5](?:\.\d)?.*?[\d,.]+/s.test(txt(nice))) return true;
    const rating=[...panel.querySelectorAll('[aria-label]')].some(x=>/\b[0-5](?:\.\d)?\s+stars?\b/i.test(x.getAttribute('aria-label')||''));
    const reviews=[...panel.querySelectorAll('[aria-label]')].some(x=>/[\d,.KkMm]+\s+reviews?/i.test(x.getAttribute('aria-label')||''));
    return rating && reviews;
  }

  function findAnchor(place) {
    const nodes=currentCardNodes();
    const byKey=nodes.find(a=>placeKey(a.href||a.getAttribute('href')||'')===place.key);
    if(byKey) return byKey;
    return nodes.find(a=>nameMatches(a.getAttribute('aria-label')||txt(a),place.name));
  }

  async function locateAnchor(place) {
    const f=feedEl();
    if(!f) return findAnchor(place);
    const base=Math.max(0,Number(place.scrollTop)||0);
    const offsets=[0,-0.38,0.38,-0.8,0.8];
    for(const mult of offsets){
      const maxTop=Math.max(0,f.scrollHeight-f.clientHeight);
      f.scrollTop=Math.max(0,Math.min(maxTop,base+mult*f.clientHeight));
      f.dispatchEvent(new Event('scroll',{bubbles:true}));
      const a=await waitFor(()=>findAnchor(place),260,35);
      if(a) return a;
    }
    return null;
  }

  function parseDetail(fallbackName, ctx, placeHref, ready) {
    const name=detailName() || cleanCardName(fallbackName) || '';
    if(!name) return null;
    const fields=ready || readCoreFields(name);
    const address=fields.address || parseAddress('');
    const phone=fields.phone || '';
    const website=fields.website || '';

    const panel=detailPanel(name);
    let category=txt(panel.querySelector('button.DkEaL'));
    if(!category){
      const c=[...panel.querySelectorAll('button')].find(b=>/category/i.test(b.getAttribute('jsaction')||''));
      category=txt(c);
    }

    let rating='', reviewCount=0;
    const nice=panel.querySelector('div.F7nice') || document.querySelector('div.F7nice');
    const niceText=txt(nice);
    const rm=niceText.match(/([0-5](?:\.\d)?)\s*\(?([\d,.KkMm]+)?/);
    if(rm){ rating=parseFloat(rm[1]); if(rm[2]) reviewCount=parseCount(rm[2]); }
    if(!rating){
      const star=[...panel.querySelectorAll('[aria-label]')].find(x=>/\bstars?\b/i.test(x.getAttribute('aria-label')||''));
      const m=star && (star.getAttribute('aria-label')||'').match(/([0-5](?:\.\d)?)/); if(m) rating=parseFloat(m[1]);
    }
    if(!reviewCount){
      const rev=[...panel.querySelectorAll('[aria-label]')].find(x=>/[\d,.KkMm]+\s+reviews?/i.test(x.getAttribute('aria-label')||''));
      const m=rev && (rev.getAttribute('aria-label')||'').match(/([\d,.KkMm]+)\s+reviews?/i); if(m) reviewCount=parseCount(m[1]);
    }

    const openStatus=txt(panel.querySelector('span.ZDu9vd'));
    const hours=labeledValue(panel,'[data-item-id="oh"],[aria-label^="Hours:" i]',/^Hours:\s*/i);
    const plusCode=labeledValue(panel,'[data-item-id*="oloc" i],[aria-label^="Plus code:" i]',/^Plus code:\s*/i);
    const locatedIn=labeledValue(panel,'[data-item-id*="locatedin" i],[aria-label^="Located in:" i]',/^Located in:\s*/i);
    const bodyText=txt(panel);
    const yearsMatch=bodyText.match(/\b(\d+\+?\s+years?\s+in\s+business)\b/i);
    const descriptionEl=panel.querySelector('.PYvSYb,.WeS02d,[data-item-id="description"]');
    const bookingEl=panel.querySelector('a[data-item-id*="appointment" i][href],a[aria-label*="appointment" i][href],a[aria-label*="book" i][href]');
    const menuEl=panel.querySelector('a[data-item-id*="menu" i][href],a[aria-label*="menu" i][href]');
    const priceMatch=bodyText.match(/(?:^|\s)(\${1,4})(?:\s|$)/);
    const coordinates=location.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    const placeId=(String(placeHref||location.href).match(/!1s([^!/?]+)/)||[])[1]||'';
    const mapDetails=collectMapDetails(panel);
    const ch=LH3.chainInfo(name);
    const mapsUrl=placeHref || location.href;
    const destination=[name,address.full].filter(Boolean).join(', ');
    return {
      name, category, phone, website, fullAddress:address.full,
      street:address.street, city:address.city, state:address.state, zip:address.zip,
      rating, reviewCount, yearsInBusiness:yearsMatch?yearsMatch[1]:'', openStatus, hours, plusCode, locatedIn,
      description:txt(descriptionEl), priceLevel:priceMatch?priceMatch[1]:'',
      bookingUrl:bookingEl?cleanWebsite(bookingEl.href):'', menuUrl:menuEl?cleanWebsite(menuEl.href):'',
      latitude:coordinates?Number(coordinates[1]):'', longitude:coordinates?Number(coordinates[2]):'', googlePlaceId:placeId,
      mapDetails,
      mapsUrl,
      directionsUrl:'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(destination),
      googleSearchUrl:'https://www.google.com/search?q='+encodeURIComponent([name,address.city,address.state].filter(Boolean).join(' ')),
      isNationalChain:ch.isChain?'Yes':'No', chainBrand:ch.chainBrand, chainType:ch.chainType, buyerType:ch.buyerType,
      searchTerm:ctx.term, searchCity:ctx.city, page:ctx.page||1,
      stage:'New Lead', notes:'', scrapedAt:new Date().toISOString()
    };
  }

  async function openAndParse(place, ctx, gen, settings) {
    const expected=cleanCardName(place.name);
    // Always spend the full phone window when needed; missing phone is no
    // longer a reason to discard an otherwise valid Google business.
    const requirePhone=true;
    let openedAt=Date.now();

    // If Maps already has this exact place open, scrape immediately.
    if(nameMatches(detailName(),expected)){
      let ready=await waitForDetail(expected,3000,requirePhone);
      await hydrateDetail(expected,gen);
      if(requirePhone && !ready.phone) ready=await waitForDetail(expected,12000,true);
      else await sleep(700);
      await waitFor(()=>hasReviewDetails(expected),4000,120);
      const remaining=MIN_LEAD_DWELL_MS-(Date.now()-openedAt);
      if(remaining>0) await sleep(remaining);
      if(!await liveRun(gen)) return null;
      return parseDetail(expected,ctx,place.href,readCoreFields(expected));
    }

    let heading='';
    for(let attempt=0; attempt<2 && !heading; attempt++){
      if(!await liveRun(gen)) return null;
      const a=await locateAnchor(place);
      if(!a) continue;
      a.scrollIntoView({block:'center',inline:'nearest'});
      await sleep(120);
      openedAt=Date.now();
      a.click();
      heading=await waitFor(()=>nameMatches(detailName(),expected) ? detailName() : null,7500,100);
      if(!heading) await sleep(250);
    }
    if(!heading){
      console.warn('[LeadHunter4] Maps card did not open after the complete wait window; skipping:', expected);
      return null;
    }

    let ready=await waitForDetail(expected,3000,requirePhone);
    await hydrateDetail(expected,gen);
    if(requirePhone && !ready.phone) ready=await waitForDetail(expected,12000,true);
    else await sleep(700);
    await waitFor(()=>hasReviewDetails(expected),4000,120);
    const remaining=MIN_LEAD_DWELL_MS-(Date.now()-openedAt);
    if(remaining>0) await sleep(remaining);
    if(!await liveRun(gen)) return null;
    const rec=parseDetail(expected,ctx,place.href,readCoreFields(expected));
    await sleep(DETAIL_COOLDOWN_MS);
    return rec;
  }

  async function saveCompletedLead(lead, settings) {
    // Collection mode uploads every unique Google business after the complete
    // detail wait. Missing fields are recorded as empty instead of dropping it.
    if(settings.badReviewMode && Number(lead.rating)>=Number(settings.minRating||0) && Number(lead.rating)<=Number(settings.maxRating||5)){
      lead.reviewOpportunity=Number(lead.rating)<=1?'Urgent: 0–1 star public rating':Number(lead.rating)<=2?'Priority: 1–2 star public rating':'';
      lead.reviewResearchStatus=lead.reviewOpportunity?'Open Google Maps reviews to validate laser-hair-removal complaint.':'';
    }

    const key=LH3.leadKey(lead);
    const leads=await get(K_LEADS,[]);
    if(leads.some(x=>LH3.leadKey(x)===key)) return {saved:false,reason:'duplicate'};
    if(new Set(await get(K_SEEN,[])).has(key)) return {saved:false,reason:'already collected'};

    leads.push(lead);
    await set({[K_LEADS]:leads});
    const history=await get(K_HISTORY,[]), known=new Set(history.map(LH3.leadKey));
    if(!known.has(key)){history.push(lead);await set({[K_HISTORY]:history.slice(-5000)});}

    await queueForUpload(lead);
    let synced='', needsSync=false;
    if(settings.syncToSheet){
      const response=await pushToSheet([lead]);
      if(response){synced=`ONYX +${response.added}`;await removeFromUploadQueue([key]);}
      else needsSync=true;
    }
    Object.defineProperty(lead,'__savedDuringCollection',{value:true,enumerable:false});
    Object.defineProperty(lead,'__needsOnyxSync',{value:needsSync,enumerable:false});
    return {saved:true,synced,needsSync};
  }

  async function scrapeMapsQuery(ctx, target, s, gen) {
    status(`Waiting for the first Maps result for “${ctx.term}” — ${ctx.city}…`);
    const feed=await waitFor(()=>feedEl(),10000,100);
    if(!feed) return [];

    feed.scrollTop=0;
    feed.dispatchEvent(new Event('scroll',{bubbles:true}));
    await sleep(RESULT_SCROLL_PAUSE_MS);

    const discovered=new Map(), rows=[];
    let cursor=0, processed=0, noNewRounds=0;
    captureVisible(discovered);

    while(processed<target){
      const loopRun=await liveRun(gen);
      if(!loopRun || Number(loopRun.total||0)>=Number(loopRun.limit||target)) break;
      const places=[...discovered.values()];

      if(cursor<places.length){
        const place=places[cursor++];
        processed++;
        status(`Opening card ${processed}/${target}: ${place.name || 'business'}…`);
        const rec=await openAndParse(place,ctx,gen,s);
        if(rec){
          rows.push(rec);
          const saved=await saveCompletedLead(rec,s);
          if(saved.saved){
            const progressRun=await liveRun(gen);
            if(progressRun){
              progressRun.total=Math.min(progressRun.limit,Number(progressRun.total||0)+1);
              await set({[K_RUN]:progressRun});
              render(progressRun);
            }
          }
          status(saved.saved
            ? `Saved card ${processed}: ${rec.name}${saved.synced?' · '+saved.synced:saved.needsSync?' · ONYX retry queued':''}`
            : `Finished card ${processed}: ${rec.name} · not saved (${saved.reason})`, saved.saved&&!saved.needsSync?'ok':'warn');
          await sleep(DETAIL_COOLDOWN_MS);
        }
        continue;
      }

      if(feedEnded(feed)) break;
      const before=discovered.size;
      const maxTop=Math.max(0,feed.scrollHeight-feed.clientHeight);
      const nextTop=Math.min(maxTop,feed.scrollTop+Math.max(420,Math.round(feed.clientHeight*0.72)));
      if(nextTop<=feed.scrollTop+2 && feed.scrollTop>=maxTop-5) noNewRounds++;
      else feed.scrollTop=nextTop;
      feed.dispatchEvent(new Event('scroll',{bubbles:true}));
      status(`Loaded ${discovered.size} cards · moving to the next result…`);
      await sleep(RESULT_SCROLL_PAUSE_MS);
      captureVisible(discovered);
      if(discovered.size===before) noNewRounds++; else noNewRounds=0;
      if(noNewRounds>=5) break;
    }
    return rows;
  }

  async function startRun() {
    const s=Object.assign({},LH3.DEFAULT_SETTINGS,await get(K_SET,{}));
    s.syncToSheet=true;
    const terms=[...new Set((s.terms||[]).map(t=>t.trim().toLowerCase()).filter(Boolean))];
    const cities=[...new Set((s.cities||[]).map(c=>c.trim()).filter(Boolean))];
    if(!terms.length) return {ok:false,error:'Add at least one search term.'};
    if(!cities.length) return {ok:false,error:'Add at least one city, e.g. "Miami FL".'};
    const perQuery=Math.max(1,Math.min(10,s.pagesPerQuery||1))*20;
    const plan=[];
    for(const city of cities) for(const term of terms) plan.push({term,city,page:1,target:perQuery});
    const run={active:true,gen:Date.now(),plan,idx:0,total:0,limit:Math.max(1,s.limit||200),settings:s,startedAt:new Date().toISOString()};
    await set({[K_RUN]:run,[K_LEADS]:[]});
    status(`Starting complete Maps collection — ${terms.length} terms × ${cities.length} cities`, 'ok');
    location.href=mapsSearchUrl(plan[0].term,plan[0].city);
    return {ok:true,steps:plan.length};
  }

  async function step() {
    if(stepGuard) return;
    stepGuard=true;
    try{
      const run=await liveRun(); if(!run) return;
      const gen=run.gen, cur=run.plan[run.idx];
      if(!cur) return finish('Worked through every search');
      if(pageBlocked()) return finish('Google served a captcha — solve it, raise the between-search delay, then restart.');
      if(!location.pathname.startsWith('/maps')) { location.href=mapsSearchUrl(cur.term,cur.city); return; }

      const s=run.settings;
      const target=Math.min(cur.target||20, Math.max(0,run.limit-run.total));
      const rows=await scrapeMapsQuery(cur,target,s,gen);
      const currentRun=await liveRun(gen); if(!currentRun) return;

      const seen=s.skipSeen?new Set(await get(K_SEEN,[])):new Set();
      const leads=await get(K_LEADS,[]); const have=new Set(leads.map(LH3.leadKey));
      let added=0; const kept=[]; const skip={chain:0,nophone:0,dupe:0,seen:0};
      for(const b of rows){
        if(currentRun.total+added>=currentRun.limit) break;
        if(b.__savedDuringCollection){if(b.__needsOnyxSync)kept.push(b);continue;}
        if(s.skipChains && LH3.isChain(b.name)){skip.chain++;continue;}
        if(s.requirePhone && !b.phone){skip.nophone++;continue;}
        if(s.badReviewMode&&!Number(b.rating)){skip.unrated=(skip.unrated||0)+1;continue;}
        if(s.badReviewMode&&(Number(b.rating)<Number(s.minRating||0)||Number(b.rating)>Number(s.maxRating||5))){skip.rating=(skip.rating||0)+1;continue;}
        if(s.badReviewMode&&s.laserOnly&&!/laser|hair removal/i.test([b.searchTerm,b.category,b.name].join(' '))){skip.laser=(skip.laser||0)+1;continue;}
        b.reviewOpportunity=Number(b.rating)<=1?'Urgent: 0–1 star public rating':Number(b.rating)<=2?'Priority: 1–2 star public rating':'';
        b.reviewResearchStatus=b.reviewOpportunity?'Open Google Maps reviews to validate laser-hair-removal complaint.':'';
        const k=LH3.leadKey(b);
        if(have.has(k)){skip.dupe++;continue;}
        if(seen.has(k)){skip.seen++;continue;}
        have.add(k); leads.push(b); kept.push(b); added++;
      }
      await set({[K_LEADS]:leads});
      if(kept.length){const history=await get(K_HISTORY,[]),known=new Set(history.map(LH3.leadKey));kept.forEach(x=>{if(!known.has(LH3.leadKey(x))){known.add(LH3.leadKey(x));history.push(x);}});await set({[K_HISTORY]:history.slice(-5000)});}
      let synced='';
      if(kept.length && s.syncToSheet){ const r=await pushToSheet(kept,s); if(r) synced=` · sheet +${r.added}`; }
      status(`“${cur.term}” ${cur.city} — kept ${added}/${rows.length}`+synced+(added?'':` · ${why(skip,rows.length)}`), added?'ok':'warn');
      return advance(currentRun,added);
    }catch(e){
      console.error('[LeadHunter4]',e);
      status('Maps scrape error: '+(e.message||e),'err');
      const run=await get(K_RUN,null); if(run&&run.active) return advance(run,0);
    }finally{ stepGuard=false; }
  }

  async function advance(run,added){
    if(!await liveRun(run.gen)) return;
    run.total+=added; run.idx++;
    if(run.total>=run.limit){await set({[K_RUN]:run}); return finish(`Hit the ${run.limit} lead cap`);}
    if(run.idx>=run.plan.length){await set({[K_RUN]:run}); return finish('Worked through every search');}
    await set({[K_RUN]:run}); render(run);
    const s=run.settings;
    // Delay only BETWEEN searches. Each business has its own completeness wait.
    const lo=Math.max(300,Number(s.minDelayMs)||900), hi=Math.max(lo,Number(s.maxDelayMs)||1500);
    const wait=Math.round(lo+Math.random()*(hi-lo));
    status(`Next Maps search in ${(wait/1000).toFixed(1)}s…`);
    await sleep(wait); if(!await liveRun(run.gen)) return;
    const next=run.plan[run.idx]; location.href=mapsSearchUrl(next.term,next.city);
  }

  function why(skip,total){
    if(!total) return 'no Maps businesses found';
    const b=[]; if(skip.nophone)b.push(`${skip.nophone} had no phone`); if(skip.chain)b.push(`${skip.chain} chains`); if(skip.seen)b.push(`${skip.seen} scraped before`); if(skip.dupe)b.push(`${skip.dupe} repeats`);
    if(skip.unrated)b.push(`${skip.unrated} had no rating`); if(skip.rating)b.push(`${skip.rating} outside star range`); if(skip.laser)b.push(`${skip.laser} outside laser context`); return b.length?'skipped '+b.join(', '):'nothing new';
  }

  async function pushToSheet(rows){
    if(!rows.length) return null;
    try{
      const res=await chrome.runtime.sendMessage({type:'LH3_SHEET',url:'https://onyx-crm.edgeformmedia.workers.dev/',payload:{action:'appendLeads',secret:'test',rows}});
      if(!res||!res.ok){status('ONYX sync failed: '+((res&&res.error)||'no reply'),'err');return null;}
      return res.data;
    }catch(e){status('ONYX sync failed: '+e.message,'err');return null;}
  }

  async function queueForUpload(lead) {
    const queue=await get(K_UPLOAD_QUEUE,[]), key=LH3.leadKey(lead);
    const next=queue.filter(item=>LH3.leadKey(item)!==key);
    next.push(lead);
    await set({[K_UPLOAD_QUEUE]:next.slice(-1000)});
  }

  async function removeFromUploadQueue(keys) {
    const wanted=new Set(keys), queue=await get(K_UPLOAD_QUEUE,[]);
    await set({[K_UPLOAD_QUEUE]:queue.filter(item=>!wanted.has(LH3.leadKey(item)))});
  }

  async function flushUploadQueue(showProgress=false) {
    if(uploadFlushGuard)return {added:0,duplicates:0,pending:(await get(K_UPLOAD_QUEUE,[])).length,busy:true};
    uploadFlushGuard=true;
    let added=0,duplicates=0,failed=false;
    try{
      const queue=await get(K_UPLOAD_QUEUE,[]);
      for(let i=0;i<queue.length;i+=100){
        const batch=queue.slice(i,i+100);
        if(showProgress)status(`Uploading ${Math.min(i+batch.length,queue.length)}/${queue.length} queued leads to ONYX…`);
        const response=await pushToSheet(batch);
        if(!response){failed=true;break;}
        added+=Number(response.added)||0;
        duplicates+=Number(response.duplicates)||0;
        await removeFromUploadQueue(batch.map(LH3.leadKey));
      }
      const pending=(await get(K_UPLOAD_QUEUE,[])).length;
      return {added,duplicates,pending,failed};
    }finally{uploadFlushGuard=false;}
  }

  async function syncAllToOnyx(leads) {
    const result={added:0,duplicates:0,failed:false};
    for(let i=0;i<leads.length;i+=100){
      const response=await pushToSheet(leads.slice(i,i+100));
      if(!response){result.failed=true;continue;}
      result.added+=Number(response.added)||0;
      result.duplicates+=Number(response.duplicates)||0;
      await removeFromUploadQueue(leads.slice(i,i+100).map(LH3.leadKey));
    }
    return result;
  }

  async function downloadCsv(leads){
    const csv='\uFEFF'+LH3.buildCsv(leads), filename=LH3.csvFilename('leadhunter-maps-complete');
    try{const r=await chrome.runtime.sendMessage({type:'LH3_DOWNLOAD',csv,filename}); if(r&&r.ok)return true; throw new Error(r&&r.error?r.error:'download blocked');}
    catch(e){status(`Couldn't save the file: ${e.message}. Use Export in the popup.`,'err');return false;}
  }

  async function finish(reason){
    const run=await get(K_RUN,null), leads=await get(K_LEADS,[]);
    if(run){run.active=false;run.gen=0;run.plan=[];await set({[K_RUN]:run});}
    if(!leads.length){status(`${reason} — nothing to export.`,'warn');render(null);return;}
    const seen=new Set(await get(K_SEEN,[])); leads.forEach(l=>seen.add(LH3.leadKey(l))); await set({[K_SEEN]:[...seen]});
    const s=(run&&run.settings)||Object.assign({},LH3.DEFAULT_SETTINGS,await get(K_SET,{}));
    let tail=''; if(s.downloadCsv!==false){await downloadCsv(leads);tail=` — downloaded ${leads.length} leads`;} else tail=` — ${leads.length} leads sent to the sheet`;
    status(reason+tail,'ok'); render(null);
  }

  async function stopRun(exportNow){
    const run=await get(K_RUN,null); if(run){run.active=false;run.gen=0;run.plan=[];await set({[K_RUN]:run});}
    if(exportNow){
      const leads=await get(K_LEADS,[]);
      let reason='Stopped';
      if(leads.length){
        status(`Stopping · final ONYX upload for ${leads.length} saved leads…`);
        const synced=await syncAllToOnyx(leads);
        reason=synced.failed
          ? `Stopped · final ONYX upload had an error`
          : `Stopped · ONYX confirmed ${synced.added} new and ${synced.duplicates} duplicates`;
      }
      return finish(reason);
    }
    status('Stopped','warn');render(null);
  }

  async function scanThisPage(){
    if(!location.pathname.startsWith('/maps')){status('Open Google Maps first.','warn');return;}
    const s=Object.assign({},LH3.DEFAULT_SETTINGS,await get(K_SET,{}));
    s.syncToSheet=true;
    const fakeGen=Date.now();
    const temp={active:true,gen:fakeGen,plan:[],idx:0,total:0,limit:Math.max(1,s.limit||200),settings:s};
    await set({[K_RUN]:temp});
    const ctx={term:'current Maps search',city:'',page:1};
    const target=Math.min(Math.max(20,(Number(s.pagesPerQuery)||1)*20),Math.max(1,s.limit||20));
    const rows=await scrapeMapsQuery(ctx,target,s,fakeGen);
    temp.active=false;temp.gen=0;await set({[K_RUN]:temp});
    const out=rows.filter(b=>b.__savedDuringCollection);
    if(!out.length){status('No new complete leads passed the current filters on this Maps search.','warn');return;}
    if(s.downloadCsv!==false)await downloadCsv(out);
    const all=new Set(await get(K_SEEN,[]));out.forEach(l=>all.add(LH3.leadKey(l)));await set({[K_SEEN]:[...all]});
    status(`Saved ${out.length} complete Maps leads to ONYX`,'ok');
  }

  // ── DOM PROBE ───────────────────────────────────────────────
  // Diagnostic pass: do not send anything to Sheets. It records the exact
  // Google Maps result/detail elements on this browser build and how long
  // each stage takes, then downloads a JSON report we can use to replace
  // broad/slow selectors with the fastest stable selectors.

  function clip(s, n=6000) {
    s=String(s||''); return s.length>n ? s.slice(0,n)+`…[clipped ${s.length-n}]` : s;
  }

  function info(el, htmlMax=5000) {
    if(!el) return null;
    return {
      tag: el.tagName || '',
      id: el.id || '',
      className: typeof el.className==='string' ? el.className : '',
      role: el.getAttribute && (el.getAttribute('role')||''),
      ariaLabel: el.getAttribute && (el.getAttribute('aria-label')||''),
      dataItemId: el.getAttribute && (el.getAttribute('data-item-id')||''),
      href: el.href || (el.getAttribute && el.getAttribute('href')) || '',
      text: clip(txt(el),1200),
      outerHTML: clip(el.outerHTML||'',htmlMax)
    };
  }

  function probeSelector(selector, root=document) {
    try {
      const els=[...root.querySelectorAll(selector)];
      return {selector,count:els.length,samples:els.slice(0,3).map(x=>info(x,1800))};
    } catch(e) { return {selector,count:-1,error:String(e.message||e)}; }
  }

  function keySignals() {
    const selectors=[
      'div[role="feed"]',
      'a.hfpxzc[href*="/maps/place/"]',
      'a[href*="/maps/place/"][aria-label]',
      'h1.DUwDvf',
      'h1',
      'button[data-item-id="address"]',
      'button[data-item-id^="phone:tel:"]',
      'a[data-item-id="authority"]',
      'button[aria-label^="Address:"]',
      'button[aria-label^="Phone:"]',
      'a[aria-label*="Website"]',
      'div.F7nice',
      'button.DkEaL'
    ];
    return selectors.map(x=>probeSelector(x));
  }

  function interactiveSnapshot(limit=90) {
    const nodes=[...document.querySelectorAll('button[data-item-id],a[data-item-id],button[aria-label],a[aria-label],a[href*="/maps/place/"]')];
    const out=[], seen=new Set();
    for(const el of nodes){
      const sig=[el.tagName,el.getAttribute('data-item-id')||'',el.getAttribute('aria-label')||'',el.getAttribute('href')||''].join('|');
      if(seen.has(sig)) continue; seen.add(sig);
      const t=txt(el), al=el.getAttribute('aria-label')||'', di=el.getAttribute('data-item-id')||'', href=el.getAttribute('href')||'';
      if(!di && !al && !/\/maps\/place\//.test(href)) continue;
      out.push({tag:el.tagName,className:typeof el.className==='string'?el.className:'',dataItemId:di,ariaLabel:al,href:clip(href,900),text:clip(t,500)});
      if(out.length>=limit) break;
    }
    return out;
  }

  function genericExtract() {
    const all=[...document.querySelectorAll('[data-item-id],[aria-label],a[href]')];
    const pick=(pred)=>all.find(pred);
    const name=detailName();
    const addressEl=pick(el=>/^address$/i.test(el.getAttribute('data-item-id')||'') || /^Address:/i.test(el.getAttribute('aria-label')||''));
    const phoneEl=pick(el=>/^phone:tel:/i.test(el.getAttribute('data-item-id')||'') || /^Phone:/i.test(el.getAttribute('aria-label')||''));
    const webEl=pick(el=>el.tagName==='A' && ((el.getAttribute('data-item-id')||'')==='authority' || /Website/i.test(el.getAttribute('aria-label')||'')));
    return {
      name,
      address: addressEl ? attrText(addressEl).replace(/^Address:\s*/i,'') : '',
      phone: phoneEl ? attrText(phoneEl).replace(/^Phone:\s*/i,'') : '',
      website: webEl ? cleanWebsite(webEl.href||'') : '',
      matched: {address:info(addressEl,2200),phone:info(phoneEl,2200),website:info(webEl,2200)}
    };
  }

  function detailRegionSnapshot() {
    const h=document.querySelector('h1.DUwDvf') || document.querySelector('h1');
    if(!h) return null;
    let el=h;
    const chain=[];
    for(let i=0;i<6 && el;i++,el=el.parentElement){
      chain.push({level:i,tag:el.tagName,id:el.id||'',className:typeof el.className==='string'?el.className:'',role:el.getAttribute('role')||'',outerHTML:clip(el.outerHTML||'', i<2?7000:12000)});
      if(el.getAttribute('role')==='main') break;
    }
    return chain;
  }

  async function probeMaps() {
    if(!location.pathname.startsWith('/maps')) return {ok:false,error:'Open a Google Maps search first.'};
    if(pageBlocked()) return {ok:false,error:'Google is showing a captcha/block page.'};

    const started=performance.now();
    const report={
      probeVersion:'3.5',
      createdAt:new Date().toISOString(),
      url:location.href,
      title:document.title,
      userAgent:navigator.userAgent,
      viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},
      searchBox:(document.querySelector('#searchboxinput')||{}).value||'',
      steps:[],
      initial:{},
      scrollTest:{},
      places:[]
    };
    const mark=(name,t0,extra={})=>report.steps.push(Object.assign({name,ms:Math.round(performance.now()-t0)},extra));

    status('PROBE 1/5 — finding Maps result feed…');
    let t=performance.now();
    const feed=await waitFor(()=>feedEl() || resultAnchors().length,12000,100);
    const anchors0=resultAnchors();
    report.initial.feed=info(feed,5000);
    report.initial.resultCount=anchors0.length;
    report.initial.results=anchors0.slice(0,8);
    report.initial.selectors=keySignals();
    mark('find-result-feed',t,{resultCount:anchors0.length,feedFound:!!feed});

    if(!anchors0.length){
      report.initial.interactive=interactiveSnapshot(120);
      await set({[K_PROBE]:report});
      await chrome.runtime.sendMessage({type:'LH3_DOWNLOAD_JSON',json:JSON.stringify(report,null,2),filename:'leadhunter-maps-probe-NO-RESULTS.json'});
      status('Probe found no /maps/place/ result links — report downloaded.','warn');
      return {ok:true,places:0};
    }

    status('PROBE 2/5 — testing result-feed scroll/virtualization…');
    t=performance.now();
    const f=feedEl();
    const beforeCount=resultAnchors().length;
    let oldTop=0;
    if(f){
      oldTop=f.scrollTop;
      f.scrollTop=Math.min(f.scrollHeight, f.scrollTop + Math.max(500, f.clientHeight*0.8));
      f.dispatchEvent(new Event('scroll',{bubbles:true}));
      await sleep(450);
    }
    const after450=resultAnchors().length;
    await sleep(450);
    const after900=resultAnchors().length;
    report.scrollTest={feedFound:!!f,beforeCount,after450,after900,scrollTop:f?f.scrollTop:0,scrollHeight:f?f.scrollHeight:0,clientHeight:f?f.clientHeight:0};
    if(f){f.scrollTop=oldTop; f.dispatchEvent(new Event('scroll',{bubbles:true})); await sleep(180);}
    mark('scroll-result-feed',t,report.scrollTest);

    const targets=resultAnchors().slice(0,3);
    for(let i=0;i<targets.length;i++){
      const place=targets[i];
      status(`PROBE 3/5 — clicking business ${i+1}/${targets.length}: ${place.name||'result'}…`);
      const pr={index:i,nameFromCard:place.name,href:place.href,card:null,timing:{},signals:[],extracted:null,interactive:[],detailAncestors:null};
      let a=findAnchor(place.href);
      if(!a && f){f.scrollTop=0; await sleep(200); a=findAnchor(place.href);}
      pr.card=info(a,9000);
      if(!a){pr.error='Could not refind result anchor after scroll test.';report.places.push(pr);continue;}

      a.scrollIntoView({block:'center'});
      const beforeName=detailName();
      const clickAt=performance.now();
      a.click();
      const heading=await waitFor(()=>{
        const n=detailName();
        if(!n) return null;
        if(place.name && n===place.name) return n;
        if(n!==beforeName) return n;
        return null;
      },7000,60);
      pr.timing.clickToHeadingMs=Math.round(performance.now()-clickAt);
      pr.headingAfterClick=heading||detailName()||'';

      status(`PROBE 4/5 — waiting for phone/address/website elements (${i+1}/${targets.length})…`);
      const dataAt=performance.now();
      await waitFor(()=>{
        const x=genericExtract();
        return x.phone || x.website || x.address;
      },3500,70);
      pr.timing.headingToDataMs=Math.round(performance.now()-dataAt);
      pr.timing.clickToDataMs=Math.round(performance.now()-clickAt);
      pr.extracted=genericExtract();
      pr.signals=keySignals();
      pr.interactive=interactiveSnapshot(100);
      pr.detailAncestors=detailRegionSnapshot();
      report.places.push(pr);
      await sleep(180);
    }

    status('PROBE 5/5 — saving exact DOM report…');
    report.totalMs=Math.round(performance.now()-started);
    report.finalUrl=location.href;
    report.finalSelectors=keySignals();
    report.notes=[
      'Use places[].extracted.matched for the exact address/phone/website elements.',
      'Use places[].card.outerHTML for the exact result-card anchor element.',
      'Use places[].timing to choose polling intervals without arbitrary multi-second sleeps.',
      'Use scrollTest to determine whether Maps is virtualizing result cards.'
    ];
    await set({[K_PROBE]:report});
    const dl=await chrome.runtime.sendMessage({type:'LH3_DOWNLOAD_JSON',json:JSON.stringify(report,null,2),filename:`leadhunter-maps-probe-${Date.now()}.json`});
    status(dl&&dl.ok ? `Probe complete — ${report.places.length} businesses tested; JSON downloaded.` : 'Probe complete, but JSON download failed.','ok');
    return {ok:true,places:report.places.length,totalMs:report.totalMs,downloaded:!!(dl&&dl.ok)};
  }

  function css(){
    const style=document.createElement('style');style.textContent=`
#lh3-panel{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;width:max-content;max-width:min(650px,calc(100vw - 40px));background:#101828;color:#eef1f7;border:1px solid #26324a;border-radius:12px;box-shadow:0 12px 32px rgba(6,10,20,.45);font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;overflow:hidden}#lh3-head{display:flex;align-items:center;gap:10px;padding:11px 13px 10px}#lh3-dot{width:7px;height:7px;border-radius:50%;background:#5f6b85}#lh3-panel.ok #lh3-dot{background:#3ec98a}#lh3-panel.warn #lh3-dot{background:#e0a33c}#lh3-panel.err #lh3-dot{background:#f2607a}#lh3-panel.live #lh3-dot{background:#5b7bff}#lh3-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:500}#lh3-meta{font-size:11px;color:#8d99b3;white-space:nowrap}#lh3-track{height:2px;background:#1c2537}#lh3-fill{height:100%;width:0;background:#5b7bff;transition:width .35s ease}#lh3-row{display:flex;gap:8px;padding:11px 13px 12px}.lh3-btn{flex:1;padding:8px 14px;border-radius:8px;border:1px solid transparent;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}.lh3-btn.primary{background:#3f5ce8;color:#fff}.lh3-btn.quiet{background:transparent;border-color:#2b3550;color:#aab5cb}.lh3-btn.stop{background:#2a1622;border-color:#5c2a3c;color:#f2607a}.lh3-btn[hidden]{display:none}`;document.documentElement.appendChild(style);
  }
  function build(){
    if(document.getElementById('lh3-panel'))return;css();PANEL=document.createElement('div');PANEL.id='lh3-panel';
    const head=document.createElement('div');head.id='lh3-head';const dot=document.createElement('span');dot.id='lh3-dot';STATUS_EL=document.createElement('div');STATUS_EL.id='lh3-status';STATUS_EL.textContent='Onyx Maps LeadHunter ready';META_EL=document.createElement('div');META_EL.id='lh3-meta';head.append(dot,STATUS_EL,META_EL);
    TRACK_EL=document.createElement('div');TRACK_EL.id='lh3-track';FILL_EL=document.createElement('div');FILL_EL.id='lh3-fill';TRACK_EL.appendChild(FILL_EL);
    const row=document.createElement('div');row.id='lh3-row';START_BTN=document.createElement('button');START_BTN.className='lh3-btn primary';START_BTN.textContent='Collect complete leads';START_BTN.addEventListener('click',async()=>{const r=await startRun();if(!r.ok)status(r.error,'warn');});SCAN_BTN=document.createElement('button');SCAN_BTN.className='lh3-btn quiet';SCAN_BTN.textContent='Collect this Maps search';SCAN_BTN.addEventListener('click',scanThisPage);PROBE_BTN=document.createElement('button');PROBE_BTN.className='lh3-btn quiet';PROBE_BTN.textContent='Probe DOM';PROBE_BTN.addEventListener('click',probeMaps);STOP_BTN=document.createElement('button');STOP_BTN.className='lh3-btn stop';STOP_BTN.textContent='Stop and download';STOP_BTN.hidden=true;STOP_BTN.addEventListener('click',()=>stopRun(true));row.append(START_BTN,SCAN_BTN,PROBE_BTN,STOP_BTN);PANEL.append(head,TRACK_EL,row);document.documentElement.appendChild(PANEL);
  }
  function status(msg,cls){if(STATUS_EL){STATUS_EL.textContent=msg;const running=PANEL.classList.contains('live');PANEL.className=cls==='ok'?'ok':cls==='warn'?'warn':cls==='err'?'err':'';if(running&&cls!=='err'&&cls!=='warn')PANEL.classList.add('live');}console.log('[LeadHunter4]',msg);}
  function render(run){if(!PANEL)return;const on=!!(run&&run.active);START_BTN.hidden=on;SCAN_BTN.hidden=on;if(PROBE_BTN)PROBE_BTN.hidden=on;STOP_BTN.hidden=!on;TRACK_EL.style.display=on?'block':'none';PANEL.classList.toggle('live',on);if(on){META_EL.textContent=`${run.idx+1}/${run.plan.length} searches · ${run.total}/${run.limit} leads`;FILL_EL.style.width=Math.min(100,(run.total/run.limit)*100)+'%';}else{META_EL.textContent='';FILL_EL.style.width='0%';}}

  chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
    if(msg.type==='LH3_START'){startRun().then(reply);return true;}
    if(msg.type==='LH3_STOP'){stopRun(true).then(()=>reply({ok:true}));return true;}
    if(msg.type==='LH3_SCAN'){scanThisPage().then(()=>reply({ok:true}));return true;}
    if(msg.type==='LH3_PROBE'){probeMaps().then(reply).catch(e=>reply({ok:false,error:String(e&&e.message||e)}));return true;}
    if(msg.type==='LH3_STATE'){get(K_RUN,null).then(r=>reply({ok:true,active:!!(r&&r.active)}));return true;}
    return false;
  });

  (async function boot(){
    build();const run=await get(K_RUN,null);render(run);
    if((await get(K_UPLOAD_QUEUE,[])).length)flushUploadQueue(false);
    if(run&&run.active&&run.plan&&run.plan.length&&run.gen){status('Resuming Maps sweep…','ok');setTimeout(step,300);}
  })();
  setInterval(()=>flushUploadQueue(false),10000);
})();
