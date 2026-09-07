// ══════════════════════════════════════════════════════════════
// Scraper Probe — single lead DOM recorder
//
// Purpose: open ONE Google Maps business, slowly, and write down
// everything, in order, so the reason a phone number does or does
// not appear can be read off the record instead of guessed at.
//
// What it records
//   • full document.body HTML before the click and at the end
//   • a new full HTML revision of the detail pane every time that
//     pane's markup changes, timestamped from the click
//   • every DOM mutation batch inside the pane (added / removed /
//     attribute changes) with CSS paths
//   • 12 independent phone-extraction strategies re-run on a fixed
//     tick, each one recording count, first match, and outerHTML
//   • the same for name / address / website, so you can see which
//     fields land first and which arrive late
//   • a slow scroll of the detail pane at the end, to test whether
//     the info rows are lazily rendered only once scrolled into view
//
// Output: two downloads, a .json (machine) and a .html (readable
// top to bottom, every step expandable).
//
// This extension never writes, never syncs, never touches ONYX.
// It is read-only apart from one click and one scroll.
// ══════════════════════════════════════════════════════════════

(function () {
  'use strict';
  if (window.__SCRAPER_PROBE__) return;
  window.__SCRAPER_PROBE__ = true;

  // ── configuration ────────────────────────────────────────────
  const CFG = {
    tickMs: 300,            // how often every strategy is re-run
    maxWatchMs: 30000,      // total watch window after the click
    quietStopMs: 6000,      // stop early only if quiet AND phone found
    headingTimeoutMs: 15000,
    scrollSteps: 6,         // slow scroll passes at the end
    scrollPauseMs: 700,
    maxRevisions: 60,
    maxRevisionBytes: 600000,
    maxMutations: 5000,
    maxRegexHits: 60,
    maxInfoRows: 180
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const PHONE_RX = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

  let PANEL, STATUS_EL, CLOCK_EL, FILL_EL, RUN_BTN, IDX_INPUT;
  let running = false;

  // ── small helpers ────────────────────────────────────────────
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { seg += '#' + node.id; parts.unshift(seg); break; }
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).slice(0, 3) : [];
      if (cls.length && cls[0]) seg += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
      if (node && node.tagName === 'BODY') { parts.unshift('body'); break; }
    }
    return parts.join(' > ');
  }

  function info(el, htmlMax = 4000) {
    if (!el) return null;
    const rect = (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return null; } })();
    const style = (() => { try { const s = getComputedStyle(el); return { display: s.display, visibility: s.visibility, opacity: s.opacity }; } catch (e) { return null; } })();
    return {
      tag: el.tagName,
      className: typeof el.className === 'string' ? el.className : '',
      id: el.id || '',
      role: el.getAttribute('role') || '',
      dataItemId: el.getAttribute('data-item-id') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      dataTooltip: el.getAttribute('data-tooltip') || '',
      href: el.getAttribute('href') || '',
      text: txt(el).slice(0, 600),
      cssPath: cssPath(el),
      rect,
      style,
      visible: !!(rect && rect.w > 0 && rect.h > 0 && style && style.visibility !== 'hidden' && style.display !== 'none'),
      outerHTML: (el.outerHTML || '').slice(0, htmlMax)
    };
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + str.length;
  }

  function normName(s) {
    return String(s || '')
      .replace(/\s*[·•]\s*Visited link\s*$/i, '')
      .toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function nameMatches(actual, expected) {
    const a = normName(actual), e = normName(expected);
    if (!a || !e) return false;
    return a === e || (a.length > 8 && e.length > 8 && (a.includes(e) || e.includes(a)));
  }

  const detailName = () => txt(document.querySelector('h1.DUwDvf')) || txt(document.querySelector('h1'));
  const feedEl = () => document.querySelector('div[role="feed"]');
  const attrText = el => el ? (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || txt(el) || '').trim() : '';

  // Replicates production infoRegion() exactly, so the probe can prove
  // whether that scoping is what loses the phone button.
  function infoRegion(expectedName) {
    const regs = [...document.querySelectorAll('div[role="region"][aria-label^="Information for "]')];
    if (!regs.length) return null;
    const hit = regs.find(r => nameMatches((r.getAttribute('aria-label') || '').replace(/^Information for\s+/i, ''), expectedName || detailName()));
    return hit || regs[regs.length - 1];
  }

  // Broadest sane container for the open business: the main pane.
  function detailPane() {
    const h = document.querySelector('h1.DUwDvf') || document.querySelector('h1');
    if (h) {
      const main = h.closest('div[role="main"]');
      if (main) return main;
      let el = h;
      for (let i = 0; i < 10 && el.parentElement; i++) el = el.parentElement;
      return el;
    }
    return document.querySelector('div[role="main"]') || document.body;
  }

  function scrollableAncestor(el) {
    let node = el;
    while (node && node !== document.body) {
      try {
        const s = getComputedStyle(node);
        if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 8) return node;
      } catch (e) { /* ignore */ }
      node = node.parentElement;
    }
    return null;
  }

  // ── phone / field strategies ─────────────────────────────────
  // Each strategy is deliberately independent. The point is not to
  // find the phone once, it is to see WHICH lookups see it, WHEN,
  // and which of them the production scraper is relying on.
  function strategies(expectedName) {
    const region = infoRegion(expectedName);
    const pane = detailPane();
    const doc = document;

    const q = (root, sel) => { try { return root ? [...root.querySelectorAll(sel)] : []; } catch (e) { return []; } };

    const defs = [
      { id: 'p1', field: 'phone', scope: 'infoRegion', production: true,
        note: 'Exactly what content.js readCoreFields() uses.',
        run: () => q(region, 'button[aria-label^="Phone:"],button[data-item-id^="phone:"]') },
      { id: 'p2', field: 'phone', scope: 'document',
        note: 'Same selector, unscoped. If this finds it and p1 does not, the region scoping is the bug.',
        run: () => q(doc, 'button[aria-label^="Phone:"],button[data-item-id^="phone:"]') },
      { id: 'p3', field: 'phone', scope: 'detailPane',
        note: 'Same selector scoped to role=main instead of the Information region.',
        run: () => q(pane, 'button[aria-label^="Phone:"],button[data-item-id^="phone:"]') },
      { id: 'p4', field: 'phone', scope: 'document',
        note: 'data-item-id starting phone:tel: only.',
        run: () => q(doc, '[data-item-id^="phone:tel:"]') },
      { id: 'p5', field: 'phone', scope: 'document',
        note: 'The copy-phone tooltip button.',
        run: () => q(doc, '[data-tooltip="Copy phone number"],[data-tooltip*="phone" i]') },
      { id: 'p6', field: 'phone', scope: 'document',
        note: 'Any tel: link, including the mobile/compact layout.',
        run: () => q(doc, 'a[href^="tel:"]') },
      { id: 'p7', field: 'phone', scope: 'document',
        note: 'Any aria-label anywhere that looks like a phone number.',
        run: () => q(doc, '[aria-label]').filter(el => PHONE_RX.test(el.getAttribute('aria-label') || '')) },
      { id: 'p8', field: 'phone', scope: 'detailPane',
        note: 'Leaf text nodes in the pane matching a phone pattern. Catches text-only rendering with no button.',
        run: () => q(pane, '*').filter(el => !el.children.length && PHONE_RX.test(txt(el)) && txt(el).length < 40).slice(0, CFG.maxRegexHits) },

      { id: 'n1', field: 'name', scope: 'document', production: true,
        note: 'h1.DUwDvf — production heading selector.',
        run: () => q(doc, 'h1.DUwDvf') },
      { id: 'a1', field: 'address', scope: 'infoRegion', production: true,
        note: 'Production address lookup.',
        run: () => q(region, 'button[data-item-id="address"],button[aria-label^="Address:"]') },
      { id: 'a2', field: 'address', scope: 'document',
        note: 'Unscoped address lookup.',
        run: () => q(doc, 'button[data-item-id="address"],button[aria-label^="Address:"]') },
      { id: 'w1', field: 'website', scope: 'infoRegion', production: true,
        note: 'Production website lookup.',
        run: () => q(region, 'a[data-item-id="authority"][href],a[aria-label^="Website:"][href]') },
      { id: 'w2', field: 'website', scope: 'document',
        note: 'Unscoped website lookup.',
        run: () => q(doc, 'a[data-item-id="authority"][href],a[aria-label^="Website:"][href]') }
    ];

    return defs.map(d => {
      const els = d.run();
      const first = els[0] || null;
      let value = '';
      if (first) {
        if (d.field === 'phone') {
          const raw = (first.getAttribute('href') || '').replace(/^tel:/, '') || attrText(first).replace(/^Phone:\s*/i, '');
          const m = raw.match(PHONE_RX);
          value = m ? m[0].trim() : raw.trim();
        } else if (d.field === 'website') {
          value = first.getAttribute('href') || '';
        } else {
          value = attrText(first).replace(/^(Address|Phone|Website):\s*/i, '');
        }
      }
      return {
        id: d.id, field: d.field, scope: d.scope, production: !!d.production, note: d.note,
        count: els.length, value,
        insideInfoRegion: !!(region && first && region.contains(first)),
        first: info(first, 3000)
      };
    });
  }

  function regionCensus() {
    return [...document.querySelectorAll('div[role="region"]')].map(r => ({
      ariaLabel: r.getAttribute('aria-label') || '',
      cssPath: cssPath(r),
      childCount: r.childElementCount,
      htmlLength: (r.outerHTML || '').length
    })).slice(0, 30);
  }

  function itemIdCensus() {
    const out = [];
    for (const el of document.querySelectorAll('[data-item-id]')) {
      out.push({ dataItemId: el.getAttribute('data-item-id') || '', tag: el.tagName, ariaLabel: el.getAttribute('aria-label') || '', text: txt(el).slice(0, 120), cssPath: cssPath(el) });
      if (out.length >= 60) break;
    }
    return out;
  }

  function parseCount(value) {
    const match = String(value || '').replace(/,/g, '').match(/([\d.]+)\s*([KM]?)/i);
    if (!match) return 0;
    const multiplier = match[2].toLowerCase() === 'k' ? 1000 : match[2].toLowerCase() === 'm' ? 1000000 : 1;
    return Math.round(Number(match[1]) * multiplier) || 0;
  }

  function cleanValue(el, prefix) {
    const raw = attrText(el);
    return prefix ? raw.replace(prefix, '').trim() : raw;
  }

  // A normalized one-lead record is convenient for GPT, while allInfoRows and
  // the DOM timeline preserve every raw clue needed to challenge the parsing.
  function extractCompleteLead(expectedName) {
    const pane = detailPane();
    const region = infoRegion(expectedName);
    const root = region || pane || document;
    const allStrategies = strategies(expectedName);
    const byId = Object.fromEntries(allStrategies.map(strategy => [strategy.id, strategy]));
    const phoneStrategy = ['p1', 'p3', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8'].map(id => byId[id]).find(strategy => strategy && strategy.value);
    const addressEl = root.querySelector('button[data-item-id="address"],button[aria-label^="Address:"]') || document.querySelector('button[data-item-id="address"],button[aria-label^="Address:"]');
    const websiteEl = root.querySelector('a[data-item-id="authority"][href],a[aria-label^="Website:"][href]') || document.querySelector('a[data-item-id="authority"][href],a[aria-label^="Website:"][href]');
    const categoryEl = pane.querySelector('button.DkEaL') || pane.querySelector('button[jsaction*="category" i]');
    const ratingEl = pane.querySelector('div.F7nice') || [...pane.querySelectorAll('[aria-label]')].find(el => /\bstars?\b/i.test(el.getAttribute('aria-label') || ''));
    const ratingText = [txt(ratingEl), ratingEl && ratingEl.getAttribute('aria-label')].filter(Boolean).join(' ');
    const ratingMatch = ratingText.match(/([0-5](?:\.\d)?)/);
    const reviewsMatch = ratingText.match(/([\d,.]+\s*[KM]?)\s+reviews?/i);
    const plusCodeEl = root.querySelector('[data-item-id*="oloc" i],[aria-label^="Plus code:" i]');
    const coords = location.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    const allInfoRows = [...pane.querySelectorAll('[data-item-id],button[aria-label],a[aria-label],[data-tooltip]')]
      .slice(0, CFG.maxInfoRows)
      .map((el, order) => ({ order, ...info(el, 5000) }));

    return {
      name: detailName() || expectedName || '',
      category: txt(categoryEl),
      phone: phoneStrategy ? phoneStrategy.value : '',
      phoneFoundBy: phoneStrategy ? phoneStrategy.id : '',
      address: cleanValue(addressEl, /^Address:\s*/i),
      website: websiteEl ? (websiteEl.href || websiteEl.getAttribute('href') || '') : '',
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      reviewCount: reviewsMatch ? parseCount(reviewsMatch[1]) : 0,
      openStatus: txt(pane.querySelector('span.ZDu9vd')),
      plusCode: cleanValue(plusCodeEl, /^Plus code:\s*/i),
      coordinates: coords ? { latitude: Number(coords[1]), longitude: Number(coords[2]) } : null,
      mapsUrl: location.href,
      capturedAt: new Date().toISOString(),
      allInfoRows,
      extractionStrategies: allStrategies
    };
  }

  function snapshotState(expectedName) {
    const region = infoRegion(expectedName);
    const pane = detailPane();
    return {
      url: location.href,
      heading: detailName(),
      headingMatchesCard: nameMatches(detailName(), expectedName),
      infoRegionFound: !!region,
      infoRegionLabel: region ? (region.getAttribute('aria-label') || '') : '',
      infoRegionMatchesHeading: region ? nameMatches((region.getAttribute('aria-label') || '').replace(/^Information for\s+/i, ''), detailName()) : false,
      infoRegionHtmlLength: region ? (region.outerHTML || '').length : 0,
      paneCssPath: cssPath(pane),
      paneHtmlLength: pane ? (pane.outerHTML || '').length : 0,
      regions: regionCensus(),
      itemIds: itemIdCensus(),
      strategies: strategies(expectedName)
    };
  }

  // ── report assembly ──────────────────────────────────────────
  const report = {
    probe: 'scraper-probe',
    version: '1.1',
    createdAt: '',
    url: '',
    title: '',
    userAgent: navigator.userAgent,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    searchBox: '',
    target: null,
    timeline: [],
    revisions: [],
    mutations: [],
    fullBodyBefore: '',
    fullBodyAfter: '',
    lead: null,
    verdict: null,
    config: CFG
  };

  let t0 = 0;
  const now = () => Math.round(performance.now() - t0);
  let lastRevHash = '';

  function addRevision(phase, note) {
    const pane = detailPane();
    const html = pane ? (pane.outerHTML || '') : '';
    const h = hash(html);
    if (h === lastRevHash) return null;
    lastRevHash = h;
    if (report.revisions.length >= CFG.maxRevisions) return null;
    const idx = report.revisions.length;
    report.revisions.push({
      index: idx, t: now(), phase, note: note || '',
      cssPath: cssPath(pane),
      htmlLength: html.length,
      truncated: html.length > CFG.maxRevisionBytes,
      html: html.slice(0, CFG.maxRevisionBytes)
    });
    return idx;
  }

  function addEvent(phase, note, extra) {
    report.timeline.push(Object.assign({ t: now(), phase, note: note || '' }, extra || {}));
  }

  function startMutationLog(root) {
    const obs = new MutationObserver(records => {
      for (const r of records) {
        if (report.mutations.length >= CFG.maxMutations) return;
        const entry = { t: now(), type: r.type, target: cssPath(r.target) };
        if (r.type === 'attributes') {
          entry.attribute = r.attributeName;
          entry.oldValue = (r.oldValue || '').slice(0, 200);
          try { entry.newValue = (r.target.getAttribute(r.attributeName) || '').slice(0, 200); } catch (e) { entry.newValue = ''; }
        } else {
          entry.added = r.addedNodes.length;
          entry.removed = r.removedNodes.length;
          const el = [...r.addedNodes].find(n => n.nodeType === 1);
          if (el) {
            entry.addedSample = {
              tag: el.tagName,
              className: typeof el.className === 'string' ? el.className : '',
              dataItemId: el.getAttribute ? (el.getAttribute('data-item-id') || '') : '',
              ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
              text: txt(el).slice(0, 160),
              html: (el.outerHTML || '').slice(0, 1200)
            };
            entry.containsPhone = PHONE_RX.test(el.outerHTML || '');
          }
        }
        report.mutations.push(entry);
      }
    });
    obs.observe(root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: false });
    return obs;
  }

  function buildVerdict() {
    const firstSeen = {};
    for (const ev of report.timeline) {
      if (!ev.state || !ev.state.strategies) continue;
      for (const s of ev.state.strategies) {
        if (s.count > 0 && firstSeen[s.id] === undefined) firstSeen[s.id] = { t: ev.t, value: s.value };
      }
    }
    const last = [...report.timeline].reverse().find(e => e.state && e.state.strategies);
    const finalById = {};
    if (last) for (const s of last.state.strategies) finalById[s.id] = s;

    const prodPhone = finalById.p1 || { count: 0, value: '' };
    const anyPhone = ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map(id => finalById[id]).filter(s => s && s.count > 0);

    let cause = 'unknown';
    if (prodPhone.count > 0) {
      cause = firstSeen.p1 && firstSeen.p1.t > 1800 ? 'phone-arrives-late' : 'phone-present';
    } else if (anyPhone.length) {
      const st = last ? last.state : null;
      if (!st || !st.infoRegionFound) cause = 'info-region-missing';
      else if (!st.infoRegionMatchesHeading) cause = 'info-region-name-mismatch';
      else if (!anyPhone.some(s => s.insideInfoRegion)) cause = 'phone-outside-info-region';
      else cause = 'selector-shape-miss';
    } else {
      cause = 'no-phone-in-dom';
    }

    return {
      cause,
      meaning: {
        'phone-present': 'The production selector found the phone in time. Whatever fails in the real run is not this business.',
        'phone-arrives-late': 'The phone button exists but rendered late. waitForDetail() gives up before it lands.',
        'info-region-missing': 'A phone exists in the page, but there is no div[role="region"][aria-label^="Information for "] at all, so readCoreFields() searched nothing.',
        'info-region-name-mismatch': 'The Information region exists but its name did not match the heading, so infoRegion() picked the wrong one (or the last one) and the phone was never in scope.',
        'phone-outside-info-region': 'The Information region matched correctly, but the phone element sits outside it. Scoping the lookup to that region is what loses the number.',
        'selector-shape-miss': 'The phone is in the region, but its attributes do not match button[aria-label^="Phone:"] / button[data-item-id^="phone:"].',
        'no-phone-in-dom': 'No strategy found a phone anywhere. This business genuinely has no phone listed, or the panel never finished loading.',
        'unknown': 'Inconclusive.'
      }[cause],
      firstSeenMs: firstSeen,
      finalStrategies: finalById,
      productionPhone: prodPhone.value || '',
      bestAvailablePhone: (anyPhone[0] && anyPhone[0].value) || prodPhone.value || ''
    };
  }

  // ── report rendering ─────────────────────────────────────────
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function strategyTable(list) {
    if (!list || !list.length) return '<p class="muted">no strategy data</p>';
    const rows = list.map(s => `<tr class="${s.count > 0 ? 'hit' : 'miss'}">
      <td>${esc(s.id)}</td><td>${esc(s.field)}</td><td>${esc(s.scope)}</td>
      <td>${s.production ? 'production' : ''}</td>
      <td>${s.count}</td><td>${esc(s.value)}</td><td>${s.count ? (s.insideInfoRegion ? 'in region' : 'outside') : ''}</td>
      <td>${s.first ? esc(s.first.cssPath) : ''}</td>
    </tr>`).join('');
    return `<table class="strat"><thead><tr><th>id</th><th>field</th><th>scope</th><th></th><th>count</th><th>value</th><th>in region</th><th>path</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderHtml(r) {
    const v = r.verdict || {};
    const tl = r.timeline.map(ev => {
      const st = ev.state;
      return `<details class="step">
        <summary><span class="t">${ev.t} ms</span> <span class="ph">${esc(ev.phase)}</span> ${esc(ev.note)}${st ? ` <span class="muted">heading: ${esc(st.heading || '—')} · region: ${st.infoRegionFound ? 'yes' : 'NO'}</span>` : ''}${ev.revision != null ? ` <span class="rev">DOM rev #${ev.revision}</span>` : ''}</summary>
        ${st ? `<div class="kv">
            <div><b>url</b> ${esc(st.url)}</div>
            <div><b>heading</b> ${esc(st.heading)} (matches card: ${st.headingMatchesCard})</div>
            <div><b>info region</b> ${st.infoRegionFound ? esc(st.infoRegionLabel) : 'NOT FOUND'} · matches heading: ${st.infoRegionMatchesHeading} · html length: ${st.infoRegionHtmlLength}</div>
            <div><b>pane</b> ${esc(st.paneCssPath)} · html length: ${st.paneHtmlLength}</div>
          </div>
          ${strategyTable(st.strategies)}
          <details><summary>all div[role=region] present (${st.regions.length})</summary><pre>${esc(JSON.stringify(st.regions, null, 2))}</pre></details>
          <details><summary>all [data-item-id] present (${st.itemIds.length})</summary><pre>${esc(JSON.stringify(st.itemIds, null, 2))}</pre></details>
          <details><summary>matched elements, full outerHTML</summary><pre>${esc(JSON.stringify(st.strategies.filter(s => s.first).map(s => ({ id: s.id, outerHTML: s.first.outerHTML })), null, 2))}</pre></details>`
        : '<p class="muted">no state captured for this event</p>'}
      </details>`;
    }).join('');

    const revs = r.revisions.map(rev => `<details class="rev-block">
      <summary><span class="t">${rev.t} ms</span> DOM revision #${rev.index} · ${esc(rev.phase)} · ${rev.htmlLength} chars${rev.truncated ? ' (truncated)' : ''} ${esc(rev.note)}</summary>
      <div class="muted">${esc(rev.cssPath)}</div>
      <pre>${esc(rev.html)}</pre>
    </details>`).join('');

    const muts = r.mutations.map(m => `<tr class="${m.containsPhone ? 'phonehit' : ''}">
      <td>${m.t}</td><td>${esc(m.type)}</td><td>${m.added || 0}/${m.removed || 0}</td>
      <td>${esc(m.attribute || '')}</td><td>${esc(m.target)}</td>
      <td>${m.addedSample ? esc(m.addedSample.dataItemId || m.addedSample.ariaLabel || m.addedSample.text) : esc((m.newValue || '').slice(0, 120))}</td>
    </tr>`).join('');

    return `<!doctype html><meta charset="utf-8"><title>Scraper probe — ${esc((r.target && r.target.name) || 'lead')}</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;padding:28px 32px 80px;background:#0b1018;color:#dbe2ef;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:1200px}
 h1{font-size:19px;margin:0 0 4px;letter-spacing:.01em}
 h2{font-size:14px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid #222d44;color:#9db0d6}
 .lede{color:#8d99b3;margin:0 0 22px}
 .verdict{border:1px solid #2c3a58;border-left:3px solid #5b7bff;padding:14px 16px;border-radius:0 8px 8px 0;background:#111a2b}
 .verdict .cause{font-size:15px;color:#8fa6ff;margin-bottom:6px}
 details{margin:6px 0;border:1px solid #1c2537;border-radius:6px;background:#0f1626}
 summary{cursor:pointer;padding:7px 10px;list-style:none}
 summary::-webkit-details-marker{display:none}
 summary:hover{background:#141d31}
 details>*:not(summary){padding:0 12px 10px}
 .t{color:#5b7bff;font-variant-numeric:tabular-nums}
 .ph{color:#3ec98a}
 .rev{color:#e0a33c}
 .muted{color:#6b7794}
 pre{white-space:pre-wrap;word-break:break-all;background:#080d16;border:1px solid #1a2233;border-radius:5px;padding:10px;max-height:520px;overflow:auto;font-size:11.5px;color:#a9b6cf}
 table{border-collapse:collapse;width:100%;font-size:11.5px;margin:8px 0}
 th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #18202f;vertical-align:top}
 th{color:#6b7794;font-weight:500}
 tr.hit td{color:#8fe0b8}
 tr.miss td{color:#7c869c}
 tr.phonehit td{background:#1b2436;color:#ffd9a0}
 .kv div{padding:2px 0}
 .kv b{color:#6b7794;font-weight:500;display:inline-block;min-width:96px}
</style>
<h1>Scraper probe — ${esc((r.target && r.target.name) || 'unnamed lead')}</h1>
<p class="lede">${esc(r.createdAt)} · ${esc(r.url)}</p>

<div class="verdict">
  <div class="cause">${esc(v.cause)}</div>
  <div>${esc(v.meaning)}</div>
  <div style="margin-top:8px">production selector returned: <b>${esc(v.productionPhone || '(nothing)')}</b> · best phone found by any strategy: <b>${esc(v.bestAvailablePhone || '(nothing)')}</b></div>
  <div style="margin-top:8px" class="muted">first sighting per strategy: ${esc(JSON.stringify(v.firstSeenMs))}</div>
</div>

<h2>Complete lead snapshot</h2>
<p class="muted">Normalized fields first, followed by every labeled/detail row found in DOM order. The timeline below remains the source of truth.</p>
<pre>${esc(JSON.stringify(r.lead, null, 2))}</pre>

<h2>Target</h2>
<pre>${esc(JSON.stringify(r.target, null, 2))}</pre>

<h2>Timeline — every step in order (${r.timeline.length} events)</h2>
${tl}

<h2>DOM revisions of the detail pane (${r.revisions.length})</h2>
<p class="muted">A new revision is written only when the pane markup actually changed, so reading these top to bottom shows exactly how the panel assembled itself.</p>
${revs}

<h2>Mutation log (${r.mutations.length})</h2>
<p class="muted">Rows highlighted amber contain a phone-shaped string in the added markup.</p>
<table><thead><tr><th>ms</th><th>type</th><th>+/-</th><th>attr</th><th>target</th><th>detail</th></tr></thead><tbody>${muts}</tbody></table>

<h2>Full document.body before the click</h2>
<details><summary>${r.fullBodyBefore.length} chars</summary><pre>${esc(r.fullBodyBefore)}</pre></details>

<h2>Full document.body at the end</h2>
<details><summary>${r.fullBodyAfter.length} chars</summary><pre>${esc(r.fullBodyAfter)}</pre></details>
`;
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }

  // ── the run ──────────────────────────────────────────────────
  async function run() {
    if (running) return;
    if (!location.pathname.startsWith('/maps')) { status('Open a Google Maps search first.', 'warn'); return; }
    if (location.pathname.startsWith('/sorry/')) { status('Google is showing a captcha. Solve it, then run again.', 'err'); return; }

    running = true;
    RUN_BTN.disabled = true;
    t0 = performance.now();
    report.timeline.length = 0; report.revisions.length = 0; report.mutations.length = 0;
    lastRevHash = '';
    report.createdAt = new Date().toISOString();
    report.url = location.href;
    report.title = document.title;
    report.searchBox = (document.querySelector('#searchboxinput') || {}).value || '';

    const wantIndex = Math.max(1, Math.min(20, Number(IDX_INPUT.value) || 1)) - 1;

    // 1 — find the result card
    status('Step 1 of 6 — finding the result list…');
    const feed = feedEl();
    let cards = [...(feed || document).querySelectorAll('a.hfpxzc[href*="/maps/place/"]')];
    if (!cards.length) cards = [...document.querySelectorAll('a[href*="/maps/place/"][aria-label]')];
    if (!cards.length) {
      report.fullBodyBefore = document.body.outerHTML || '';
      addEvent('abort', 'No /maps/place/ result cards found on this page.');
      finish('No result cards found — report saved anyway.', 'warn');
      return;
    }
    const card = cards[Math.min(wantIndex, cards.length - 1)];
    const cardName = (card.getAttribute('aria-label') || txt(card)).replace(/\s*[·•]\s*Visited link\s*$/i, '').trim();
    report.target = {
      requestedIndex: wantIndex + 1,
      usedIndex: Math.min(wantIndex, cards.length - 1) + 1,
      totalCardsVisible: cards.length,
      name: cardName,
      href: card.href || card.getAttribute('href') || '',
      cardHtml: card.outerHTML || '',
      cardCssPath: cssPath(card)
    };

    // 2 — record the page before anything is touched
    status(`Step 2 of 6 — recording the page before the click (${cardName})…`);
    report.fullBodyBefore = document.body.outerHTML || '';
    addEvent('pre-click', 'State before the card was clicked.', { state: snapshotState(cardName), revision: addRevision('pre-click', 'before click') });
    await sleep(600);

    // 3 — start watching, then click, slowly
    status('Step 3 of 6 — watching the DOM, then clicking the card…');
    // Watch body because Maps may replace the entire role=main node after the click.
    const obs = startMutationLog(document.body);
    try { card.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* non-scrollable context */ }
    await sleep(500);
    t0 = performance.now();          // clock resets so every ms is "since click"
    addEvent('click', `Clicked result ${report.target.usedIndex}: ${cardName}`);
    card.click();

    // 4 — tick, slowly, for the full window
    const deadline = performance.now() + CFG.maxWatchMs;
    let lastChangeAt = performance.now();
    let phoneSeen = false;
    let ticks = 0;
    while (performance.now() < deadline) {
      await sleep(CFG.tickMs);
      ticks++;
      const state = snapshotState(cardName);
      const rev = addRevision('tick', `tick ${ticks}`);
      if (rev != null) lastChangeAt = performance.now();
      addEvent('tick', `tick ${ticks}`, { state, revision: rev });

      const anyPhone = state.strategies.some(s => s.field === 'phone' && s.count > 0);
      if (anyPhone && !phoneSeen) {
        phoneSeen = true;
        addEvent('note', 'First moment any strategy saw a phone.');
      }
      const elapsed = Math.round(performance.now() - t0);
      clock(`${(elapsed / 1000).toFixed(1)}s`);
      progress(elapsed / CFG.maxWatchMs);
      status(`Step 4 of 6 — watching (${(elapsed / 1000).toFixed(1)}s) · heading: ${state.heading || '—'} · phone: ${phoneSeen ? 'seen' : 'not yet'}`);

      if (phoneSeen && performance.now() - lastChangeAt > CFG.quietStopMs) {
        addEvent('note', 'Stopping early: phone found and the pane has been quiet.');
        break;
      }
    }

    // 5 — slow scroll of the detail pane, to test lazy rendering
    status('Step 5 of 6 — scrolling the detail pane slowly to test lazy rendering…');
    const pane = detailPane();
    const scroller = scrollableAncestor(pane.querySelector('h1') || pane) || pane;
    addEvent('scroll-start', 'Scrolling the detail pane in steps.', {
      scroller: cssPath(scroller),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight
    });
    for (let i = 1; i <= CFG.scrollSteps; i++) {
      const target = Math.round((scroller.scrollHeight - scroller.clientHeight) * (i / CFG.scrollSteps));
      scroller.scrollTop = target;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(CFG.scrollPauseMs);
      const state = snapshotState(cardName);
      addEvent('scroll', `scroll step ${i}/${CFG.scrollSteps} to ${target}px`, { state, revision: addRevision('scroll', `scroll ${i}`) });
    }
    scroller.scrollTop = 0;
    await sleep(500);

    // 6 — final capture and download
    status('Step 6 of 6 — writing the report…');
    addEvent('final', 'Final state.', { state: snapshotState(cardName), revision: addRevision('final', 'end of run') });
    report.fullBodyAfter = document.body.outerHTML || '';
    obs.disconnect();
    report.verdict = buildVerdict();
    report.lead = extractCompleteLead(cardName);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (cardName || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    download(`scraper-probe-${slug}-${stamp}.json`, JSON.stringify(report, null, 2), 'application/json');
    await sleep(700);
    download(`scraper-probe-${slug}-${stamp}.html`, renderHtml(report), 'text/html');

    finish(`Done — ${report.verdict.cause}. ${report.timeline.length} steps, ${report.revisions.length} DOM revisions, ${report.mutations.length} mutations.`, 'ok');
  }

  function finish(msg, cls) {
    running = false;
    RUN_BTN.disabled = false;
    progress(0);
    clock('');
    status(msg, cls);
    console.log('[ScraperProbe]', msg, report);
  }

  // ── panel ────────────────────────────────────────────────────
  function status(msg, cls) {
    if (!STATUS_EL) return;
    STATUS_EL.textContent = msg;
    PANEL.className = cls || (running ? 'live' : '');
    console.log('[ScraperProbe]', msg);
  }
  const clock = s => { if (CLOCK_EL) CLOCK_EL.textContent = s; };
  const progress = f => { if (FILL_EL) FILL_EL.style.width = Math.max(0, Math.min(100, f * 100)) + '%'; };

  function build() {
    if (document.getElementById('sp-panel')) return;
    PANEL = document.createElement('div');
    PANEL.id = 'sp-panel';

    const head = document.createElement('div');
    head.id = 'sp-head';
    const dot = document.createElement('span'); dot.id = 'sp-dot';
    STATUS_EL = document.createElement('div'); STATUS_EL.id = 'sp-status';
    STATUS_EL.textContent = 'Scraper probe ready — records one lead in slow motion';
    CLOCK_EL = document.createElement('div'); CLOCK_EL.id = 'sp-clock';
    head.append(dot, STATUS_EL, CLOCK_EL);

    const track = document.createElement('div'); track.id = 'sp-track';
    FILL_EL = document.createElement('div'); FILL_EL.id = 'sp-fill';
    track.appendChild(FILL_EL);

    const row = document.createElement('div'); row.id = 'sp-row';
    const label = document.createElement('label');
    label.textContent = 'Result number';
    label.htmlFor = 'sp-idx';
    IDX_INPUT = document.createElement('input');
    IDX_INPUT.type = 'number'; IDX_INPUT.id = 'sp-idx'; IDX_INPUT.min = '1'; IDX_INPUT.max = '20'; IDX_INPUT.value = '1';
    RUN_BTN = document.createElement('button');
    RUN_BTN.className = 'sp-btn primary';
    RUN_BTN.textContent = 'Record this lead';
    RUN_BTN.addEventListener('click', run);
    row.append(label, IDX_INPUT, RUN_BTN);

    PANEL.append(head, track, row);
    document.documentElement.appendChild(PANEL);
  }

  build();
  new MutationObserver(() => { if (!document.getElementById('sp-panel')) build(); })
    .observe(document.documentElement, { childList: true, subtree: false });
})();
