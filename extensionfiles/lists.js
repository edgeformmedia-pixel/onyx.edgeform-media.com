// ══════════════════════════════════════════════════════════════
// Onyx LeadHunter — shared helpers
// ══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    terms: [
      'laser hair removal', 'med spa', 'medical spa',
      'waxing salon', 'aesthetic clinic', 'body sculpting'
    ],
    cities: ['Miami FL'],
    limit: 200,
    pagesPerQuery: 3,      // Google serves 20 local results per page
    skipSeen: true,
    skipChains: false,   // off on purpose — chains get labelled instead
    requirePhone: true,
    minDelayMs: 900,       // pause BETWEEN search queries; business clicks use event-driven waits
    maxDelayMs: 1500,
    sheetUrl: 'https://onyx-crm.edgeformmedia.workers.dev/',
    sheetSecret: 'test',
    syncToSheet: true,
    downloadCsv: true
  };

  // Franchises and national rollups — competitors, not buyers, for most B2B lists.
  // Grouped so a match can be labelled, not just dropped. Corporate chains
  // buy devices centrally; franchise brands let each owner buy their own,
  // which is where the actual laser sale lives.
  const CHAIN_GROUPS = {
    'Corporate laser': [
      'ideal image', 'milan laser', 'laseraway', 'sev laser', 'sona dermatology',
      'sono bello', 'skinspirit', 'lasertopia'
    ],
    'Franchise waxing': [
      'european wax', 'waxing the city', 'sugared + bronzed', 'sugared and bronzed',
      'wax center', 'benefit brow'
    ],
    'Franchise wellness': [
      'massage envy', 'hand and stone', 'hand & stone', 'the joint',
      'restore hyper wellness', 'amazing lash', 'drybar', 'xpress wellness'
    ],
    'Big box / retail': [
      'ulta', 'sephora', 'great clips', 'supercuts', 'lifetime', 'equinox'
    ]
  };

  // Flat list kept for the skip filter.
  const CHAINS = [
    'ideal image', 'milan laser', 'laseraway', 'sona dermatology', 'skinspirit',
    'european wax', 'waxing the city', 'sugared + bronzed', 'massage envy',
    'hand and stone', 'hand & stone', 'sono bello', 'lifetime', 'equinox',
    'ulta', 'sephora', 'great clips', 'supercuts', 'drybar', 'amazing lash',
    'the joint', 'restore hyper wellness', 'xpress wellness'
  ];

  // Returns which brand matched and what kind of buyer it implies.
  function chainInfo(name) {
    const n = String(name || '').toLowerCase();
    for (const group of Object.keys(CHAIN_GROUPS)) {
      for (const brand of CHAIN_GROUPS[group]) {
        if (n.includes(brand)) {
          return {
            isChain: true,
            chainBrand: brand.replace(/\b\w/g, c => c.toUpperCase()),
            chainType: group,
            // Franchise owners buy their own equipment; corporate does not.
            buyerType: group.indexOf('Franchise') === 0 ? 'Franchisee — owner buys' : 'Corporate — central buying'
          };
        }
      }
    }
    return { isChain: false, chainBrand: '', chainType: '', buyerType: 'Independent — owner buys' };
  }

  const isChain = name => chainInfo(name).isChain;

  const CSV_FIELDS = [
    'name', 'category', 'phone', 'website', 'street', 'city', 'state', 'zip',
    'rating', 'reviewCount', 'yearsInBusiness', 'openStatus',
    'mapsUrl', 'directionsUrl', 'googleSearchUrl',
    'isNationalChain', 'chainBrand', 'chainType', 'buyerType',
    'searchTerm', 'searchCity', 'page', 'stage', 'notes', 'scrapedAt'
  ];

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(rows) {
    const head = CSV_FIELDS.join(',');
    const body = rows.map(r => CSV_FIELDS.map(f => csvCell(r[f])).join(',')).join('\r\n');
    return head + '\r\n' + body + '\r\n';
  }

  function csvFilename(prefix) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
      `${p(d.getHours())}${p(d.getMinutes())}.csv`;
  }

  // Dedupe key. Phone is the strongest signal; fall back to name + city.
  function leadKey(l) {
    const digits = String(l.phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return 'p:' + digits.slice(-10);
    const n = String(l.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const c = String(l.city || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return 'n:' + n + '|' + c;
  }

  window.LH3 = { DEFAULT_SETTINGS, CHAINS, CHAIN_GROUPS, chainInfo, isChain, CSV_FIELDS, buildCsv, csvFilename, leadKey };
})();
