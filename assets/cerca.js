(function() {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = 'debug=1; path=/; expires=' + expires;
  } else if (params.get('debug') === '0') {
    document.cookie = 'debug=0; path=/; max-age=0';
  }
})();
const DEBUG = (function() {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') return true;
  if (params.get('debug') === '0') return false;
  return document.cookie.split(';').some(c => c.trim() === 'debug=1');
})();

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateToken(keyword) {
  const minute = Math.floor(Date.now() / 60000);
  const fingerprint = await sha256Hex(keyword.trim().toLowerCase());
  const mac = await hmacHex(clientKey(), minute + ':' + fingerprint);
  return btoa(minute + '.' + mac);
}

async function generateClickToken(shopId, product) {
  const minute = Math.floor(Date.now() / 60000);
  const fingerprint = await sha256Hex(shopId + '|' + product);
  const mac = await hmacHex(clientKey(), minute + ':' + fingerprint);
  return btoa(minute + '.' + mac);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function safeUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return '#';
    p.searchParams.set('utm_source', 'compraegioca');
    p.searchParams.set('utm_medium', 'referral');
    p.searchParams.set('utm_campaign', 'price_comparison');
    return p.toString();
  } catch { return '#'; }
}

function formatPrice(n) { return n.toFixed(2).replace('.', ',') + ' €'; }

const EXCLUDED_RE  = /\b(lego|puzzle|portachiavi|pendolo|collana|culla|borsa|sacca|francobolli|plancia|map\s+pack|dice\s+set|super\s+string|prophila|souvenir|funko)\b/i;
const SECONDARY_RE = /\b(sleeve|sleeves|bustina|bustine|proteggi|protezioni?|insert|inserto|organizer|organizzatore|playmat|tappetino|tappeto|accessori[o]?|ricambi?|portacarte|porta\s*carte|dado|dadi|espansione|espansioni|expansion|expansions|promo|promozione|booster|automa|scenario\s+pack|moneta|monete|goodies)\b/i;

function wb(token) {
  return new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
}

function hasQueryMatch(name, query) {
  const n = name.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(t => wb(t).test(n));
}

function renderCards(results) {
  return results.map(r => {
    const freeShipping = r.shippingCost === 0;
    const debugBadge = (DEBUG && r._debug)
      ? '<span class="debug-badge">'
          + escHtml(r._debug.cls)
          + (r._debug.blacklistedWord
              ? ' · 🚫 <strong>"' + escHtml(r._debug.blacklistedWord) + '"</strong>'
              : '')
        + '</span>'
      : '';
    return (
      '<div class="result-card" data-shop-id="' + escHtml(r.shop) + '">' +
        (r.thumb
          ? '<img class="result-thumb" src="' + escHtml(r.thumb) + '" alt="' + escHtml(r.name) + '" loading="lazy" />'
          : '<div class="result-thumb-empty"></div>'
        ) +
        '<div class="result-body">' +
          '<div class="result-shop">' + escHtml(r.shopName) + '</div>' +
          '<div class="result-name">' + escHtml(r.name) + '</div>' +
          (r.offer ? '<span class="result-offer">In offerta</span>' : '') +
          debugBadge +
        '</div>' +
        '<div class="result-pricing">' +
          '<div class="result-price">' + formatPrice(r.price) + '</div>' +
          '<div class="result-shipping ' + (freeShipping ? 'free' : '') + '">' +
            (freeShipping ? 'Spedizione gratuita' : '+ ' + formatPrice(r.shippingCost) + ' spedizione') +
          '</div>' +
          '<a href="' + safeUrl(r.url) + '" class="btn-buy" target="_blank" rel="noopener noreferrer">Vai al negozio</a>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

function getCache(q) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    const e = cache[q.toLowerCase()];
    if (!e || Date.now() - e.ts > CACHE_TTL_MS) return null;
    return e;
  } catch { return null; }
}

function saveRecentSearch(q) {
  try {
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    const filtered = recent.filter(r => r.toLowerCase() !== q.toLowerCase());
    filtered.unshift(q);
    localStorage.setItem(RECENT_KEY, JSON.stringify(filtered.slice(0, RECENT_MAX)));
  } catch {}
}

function saveCache(q, results, shops) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    const keys = Object.keys(cache);
    if (keys.length >= 20) {
      const oldest = keys.sort((a,b) => cache[a].ts - cache[b].ts)[0];
      delete cache[oldest];
    }
    cache[q.toLowerCase()] = { ts: Date.now(), results, shops };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

let allResults = [];
let allShops = [];
let currentKeyword = '';
let activeEs = null;
let showExcluded = false;

const qInput            = document.getElementById('q');
const searchClear       = document.getElementById('searchClear');
const filterMin         = document.getElementById('filterMin');
const filterMax         = document.getElementById('filterMax');
const minVal            = document.getElementById('minVal');
const maxVal            = document.getElementById('maxVal');
const filterOnSale      = document.getElementById('filterOnSale');
const shopChecks        = document.getElementById('shopChecks');
const filtersEl         = document.getElementById('filters');
const filterToggle      = document.getElementById('filterToggle');
const filterClose       = document.getElementById('filterClose');
const filterBackdrop    = document.getElementById('filterBackdrop');
const searchProgressEl  = document.getElementById('searchProgress');
const loadingEl         = document.getElementById('loading');
const errorEl           = document.getElementById('errorMsg');
const countEl           = document.getElementById('resultCount');
const listEl            = document.getElementById('resultsList');
const noResultsEl       = document.getElementById('noResults');
const excludedBannerEl  = document.getElementById('excludedBanner');
const excludedCountEl   = document.getElementById('excludedCount');
const excludedListEl    = document.getElementById('excludedList');
const showExcludedBtn   = document.getElementById('showExcludedBtn');
const expansionSection  = document.getElementById('expansionSection');
const expansionToggle   = document.getElementById('expansionToggle');
const expansionLabel    = document.getElementById('expansionLabel');
const expansionChevron  = document.getElementById('expansionChevron');
const expansionList     = document.getElementById('expansionList');
const sortInfoBtn       = document.getElementById('sortInfoBtn');
const sortInfoModal     = document.getElementById('sortInfoModal');
const sortInfoClose     = document.getElementById('sortInfoClose');

function openMobileFilters() {
  filtersEl.classList.add('is-open');
  filterBackdrop.classList.add('is-visible');
  document.body.style.overflow = 'hidden';
}
function closeMobileFilters() {
  filtersEl.classList.remove('is-open');
  filterBackdrop.classList.remove('is-visible');
  document.body.style.overflow = '';
}

let expansionOpen = false;
expansionToggle.addEventListener('click', () => {
  expansionOpen = !expansionOpen;
  expansionList.style.display = expansionOpen ? 'flex' : 'none';
  expansionChevron.style.transform = expansionOpen ? 'rotate(180deg)' : '';
});

sortInfoBtn.addEventListener('click', () => { sortInfoModal.style.display = 'flex'; });
sortInfoClose.addEventListener('click', () => { sortInfoModal.style.display = 'none'; });
sortInfoModal.addEventListener('click', (e) => { if (e.target === sortInfoModal) sortInfoModal.style.display = 'none'; });

filterToggle.addEventListener('click', openMobileFilters);
filterClose.addEventListener('click', closeMobileFilters);
filterBackdrop.addEventListener('click', closeMobileFilters);
filterMin.addEventListener('input', () => {
  if (parseFloat(filterMin.value) > parseFloat(filterMax.value)) filterMin.value = filterMax.value;
  minVal.textContent = filterMin.value + ' €';
  applyFilters();
});
filterMax.addEventListener('input', () => {
  if (parseFloat(filterMax.value) < parseFloat(filterMin.value)) filterMax.value = filterMin.value;
  maxVal.textContent = filterMax.value + ' €';
  applyFilters();
});
filterOnSale.addEventListener('change', applyFilters);
showExcludedBtn.addEventListener('click', () => { showExcluded = true; applyFilters(); });

qInput.addEventListener('input', () => {
  searchClear.style.display = qInput.value ? 'flex' : 'none';
});
searchClear.addEventListener('click', () => {
  qInput.value = '';
  searchClear.style.display = 'none';
  qInput.focus();
});

document.getElementById('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (!q) return;
  history.pushState({}, '', '/cerca?q=' + encodeURIComponent(q));
  currentKeyword = q;
  saveRecentSearch(q);
  doSearch(q);
});

window.addEventListener('popstate', () => {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  qInput.value = q;
  currentKeyword = q;
  if (q) doSearch(q);
});

// Negozi che bloccano le richieste dall'IP condiviso delle Netlify Functions
// (WAF/anti-bot lato loro), indipendentemente da cosa risponde il server.
// TODO: rimuovere quando i negozi sbloccano l'accesso (vedi CLAUDE.md compraegioca-api).
const KNOWN_BLOCKED_SHOPS = new Set(['dungeondice', 'starshop', 'uplay']);

function buildShopChecks(withSpinners) {
  const counts = {};
  allResults.forEach(r => { counts[r.shop] = (counts[r.shop] || 0) + 1; });
  const selectAllRow =
    '<div class="shop-row shop-select-all-row">' +
      '<label class="checkbox-label shop-select-all-label">' +
        '<input type="checkbox" id="shopSelectAll" checked />' +
        'Seleziona tutto' +
      '</label>' +
    '</div>';
  const shopRows = allShops.map(({ id, name }) => {
    const blocked = KNOWN_BLOCKED_SHOPS.has(id);
    return (
      '<div class="shop-row">' +
        '<label class="checkbox-label">' +
          '<input type="checkbox" class="shopCk" value="' + escHtml(id) + '" checked' + (blocked ? ' disabled' : '') + ' />' +
          '<span class="shop-name">' + escHtml(name) + '</span> <span class="shop-count"' + (blocked || withSpinners ? ' hidden' : '') + '>' + (counts[id] ?? 0) + '</span>' +
        '</label>' +
        (blocked
          ? '<span class="shop-blocked" title="Il negozio sta bloccando le richieste automatiche">⚠</span>'
          : '<span class="shop-loading" data-shop="' + escHtml(id) + '"' + (withSpinners ? '' : ' hidden') + '></span>'
        ) +
        (blocked ? '' : '<button class="shop-only-btn" data-shop="' + escHtml(id) + '">solo</button>') +
      '</div>'
    );
  }).join('');
  shopChecks.innerHTML = selectAllRow + shopRows;

  shopChecks.querySelectorAll('.shopCk').forEach(cb => cb.addEventListener('change', applyFilters));
  shopChecks.querySelectorAll('.shop-only-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.shop;
      shopChecks.querySelectorAll('.shopCk').forEach(cb => { cb.checked = cb.value === target; });
      applyFilters();
    });
  });
  document.getElementById('shopSelectAll').addEventListener('change', (e) => {
    shopChecks.querySelectorAll('.shopCk:not(:disabled)').forEach(cb => { cb.checked = e.target.checked; });
    applyFilters();
  });
}

function removeShopSpinner(shopId) {
  shopChecks.querySelectorAll('.shop-loading[data-shop="' + shopId + '"]')
    .forEach(el => { el.hidden = true; });
  shopChecks.querySelectorAll('.shop-row').forEach(row => {
    const cb = row.querySelector('.shopCk');
    if (cb && cb.value === shopId && !row.querySelector('.shop-blocked')) {
      row.querySelector('.shop-count').hidden = false;
    }
  });
}

function updateShopCounts() {
  const counts = {};
  allResults.forEach(r => { counts[r.shop] = (counts[r.shop] || 0) + 1; });
  shopChecks.querySelectorAll('.shop-count').forEach(el => {
    const cb = el.closest('.shop-row')?.querySelector('.shopCk');
    if (cb) el.textContent = String(counts[cb.value] ?? 0);
  });
}

function initPriceFilters() {
  const prices = allResults.map(r => r.price);
  const minP = prices.length ? Math.floor(Math.min(...prices)) : 0;
  const maxP = prices.length ? Math.ceil(Math.max(...prices)) : 200;
  filterMin.min = filterMax.min = '0';
  filterMin.max = filterMax.max = String(maxP);
  filterMin.value = String(minP);
  filterMax.value = String(maxP);
  minVal.textContent = minP + ' €';
  maxVal.textContent = maxP + ' €';
}

async function doSearch(q) {
  activeEs?.close();
  activeEs = null;

  searchProgressEl.style.display = 'block';
  loadingEl.style.display = 'flex';
  filtersEl.style.display = 'none';
  filterToggle.style.display = 'none';
  sortInfoBtn.style.display = 'none';
  errorEl.style.display = 'none';
  countEl.style.display = 'none';
  listEl.innerHTML = '';
  excludedListEl.innerHTML = '';
  noResultsEl.style.display = 'none';
  excludedBannerEl.style.display = 'none';
  expansionSection.style.display = 'none';
  expansionList.innerHTML = '';
  expansionOpen = false;
  expansionChevron.style.transform = '';
  allResults = [];
  allShops = [];
  showExcluded = false;
  closeMobileFilters();

  const cached = getCache(q);
  if (cached) {
    allResults = cached.results;
    allShops = cached.shops;
    searchProgressEl.style.display = 'none';
    loadingEl.style.display = 'none';
    initPriceFilters();
    filterOnSale.checked = false;
    filtersEl.style.display = '';
    filterToggle.style.display = 'flex';
    sortInfoBtn.style.display = 'flex';
    buildShopChecks(false);
    applyFilters();
    return;
  }

  let pending = [];
  let isDone = false;

  const token = await generateToken(q);
  const es = new EventSource(API_URL + '?q=' + encodeURIComponent(q) + '&t=' + encodeURIComponent(token));
  activeEs = es;

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'shops') {
      allShops = msg.shops;
      filterOnSale.checked = false;
      filtersEl.style.display = '';
      filterToggle.style.display = 'flex';
      buildShopChecks(true);
      sortInfoBtn.style.display = 'flex';

    } else if (msg.type === 'chunk') {
      pending = [...pending, ...msg.results];
      pending.sort((a, b) => a.price - b.price);
      allResults = pending.map(({ _rank, ...r }) => r);
      loadingEl.style.display = 'none';
      if (msg.shop) removeShopSpinner(msg.shop);
      updateShopCounts();
      applyFilters();

    } else if (msg.type === 'done') {
      isDone = true;
      es.close();
      activeEs = null;
      searchProgressEl.style.display = 'none';
      loadingEl.style.display = 'none';
      shopChecks.querySelectorAll('.shop-loading').forEach(el => { el.hidden = true; });
      shopChecks.querySelectorAll('.shop-row .shop-count').forEach(el => {
        if (!el.closest('.shop-row').querySelector('.shop-blocked')) el.hidden = false;
      });
      pending.sort((a, b) => a.price - b.price);
      allResults = pending.map(({ _rank, ...r }) => r);
      initPriceFilters();
      saveCache(q, allResults, allShops);
      applyFilters();
      if (typeof gtag !== 'undefined') gtag('event', 'search', { search_term: q });
    }
  };

  es.onerror = () => {
    if (!isDone) {
      es.close();
      activeEs = null;
      searchProgressEl.style.display = 'none';
      loadingEl.style.display = 'none';
      if (allResults.length === 0) {
        errorEl.textContent = 'Errore durante la ricerca — riprova tra poco';
        errorEl.style.display = 'block';
      }
    }
  };
}

function applyFilters() {
  const minPrice = parseFloat(filterMin.value);
  const maxPrice = parseFloat(filterMax.value);
  const onSaleOnly = filterOnSale.checked;
  const selectedShops = new Set(
    [...shopChecks.querySelectorAll('.shopCk:checked')].map(cb => cb.value)
  );
  const filtered = allResults.filter(r => {
    if (r.price < minPrice || r.price > maxPrice) return false;
    if (!selectedShops.has(r.shop)) return false;
    if (onSaleOnly && !r.offer) return false;
    return true;
  });

  const classify = r => {
    if (r.price < 3 || EXCLUDED_RE.test(r.name) || !hasQueryMatch(r.name, currentKeyword)) return 'excluded';
    if (SECONDARY_RE.test(r.name)) return 'secondary';
    return 'relevant';
  };

  const classified = filtered.map(r => {
    const cls = classify(r);
    const blacklistedWord = cls === 'secondary' ? (SECONDARY_RE.exec(r.name)?.[0] ?? null) : null;
    return { r, cls, blacklistedWord };
  });

  if (DEBUG) {
    classified.forEach(({ r, cls, blacklistedWord }) => {
      r._debug = { cls, blacklistedWord: blacklistedWord ?? null };
    });
  }

  const relevant   = classified.filter(({ cls }) => cls === 'relevant').map(({ r }) => r);
  const expansions = classified.filter(({ cls }) => cls === 'secondary').map(({ r }) => r);
  const excluded   = classified.filter(({ cls }) => cls === 'excluded').map(({ r }) => r);

  countEl.textContent = relevant.length + ' risultat' + (relevant.length === 1 ? 'o' : 'i') + ' inerent' + (relevant.length === 1 ? 'e' : 'i') + ' trovat' + (relevant.length === 1 ? 'o' : 'i');
  countEl.style.display = 'block';

  if (expansions.length > 0) {
    expansionSection.style.display = 'block';
    const n = expansions.length;
    expansionLabel.textContent = n + ' accessor' + (n === 1 ? 'io' : 'i') + ' ed espansioni';
    expansionList.innerHTML = renderCards(expansions);
  } else {
    expansionSection.style.display = 'none';
    expansionList.innerHTML = '';
  }

  if (excluded.length > 0 && !showExcluded) {
    excludedBannerEl.style.display = 'flex';
    excludedCountEl.textContent = excluded.length + ' risultat' + (excluded.length === 1 ? 'o' : 'i') + ' meno pertinent' + (excluded.length === 1 ? 'e' : 'i') + ' nascost' + (excluded.length === 1 ? 'o' : 'i') + '.';
  } else {
    excludedBannerEl.style.display = 'none';
  }

  if (relevant.length === 0 && expansions.length === 0 && (excluded.length === 0 || !showExcluded)) {
    noResultsEl.style.display = 'block';
    listEl.innerHTML = '';
    return;
  }

  noResultsEl.style.display = 'none';

  listEl.innerHTML = renderCards(relevant);

  if (showExcluded && excluded.length > 0) {
    excludedListEl.innerHTML =
      '<div class="results-separator">Risultati meno pertinenti</div>' +
      renderCards(excluded);
  } else {
    excludedListEl.innerHTML = '';
  }
}

listEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-buy');
  if (!btn) return;
  const card = btn.closest('.result-card');
  const shopId = card?.dataset.shopId ?? '';
  const item = card?.querySelector('.result-name')?.textContent?.trim() ?? '';
  if (typeof gtag !== 'undefined') gtag('event', 'shop_click', { shop_name: shopId, item_name: item });
  if (shopId && item) {
    generateClickToken(shopId, item).then(t => {
      fetch(CLICK_URL, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop: shopId, product: item, t }),
      }).catch(() => {});
    });
  }
});

const initKeyword = new URLSearchParams(location.search).get('q') ?? '';
if (initKeyword) {
  qInput.value = initKeyword;
  currentKeyword = initKeyword;
  saveRecentSearch(initKeyword);
  doSearch(initKeyword);
}
