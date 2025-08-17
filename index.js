助かった、全文くれたので一気に直せました。
いまのファイルは以下の問題で壊れてます：

foundFoundingDate の多重宣言＆未宣言参照（宣言前に使ってる箇所がある）

途中に実行不能な断片（// …DOM 成功時 などの例示コードをそのまま置いちゃってる）

innerText/docText を返却後にもう一度書いている（構文的にも位置的にもNG）

foundingDateSource を debug に入れていない


下に、これらをすべて解消した動く完全版を置きます（構造はそのまま／設立日のソースもdebug.foundingDateSourceで出します）。

// index.js — scrape-v5-bundle+cache (phones/addresses + foundingDate + sameAs, chunk-chase)

const express = require('express');
const { chromium } = require('playwright');

const BUILD_TAG = 'scrape-v5-bundle-cache-05';
const app = express();
const PORT = process.env.PORT || 8080;

// -------------------- CORS --------------------
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// -------------------- ヘルス --------------------
app.get('/', (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// -------------------- Simple in-memory cache --------------------
const CACHE_TTL_MS      = Number(process.env.SCRAPE_CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 既定6h
const CACHE_MAX_ENTRIES = Number(process.env.SCRAPE_CACHE_MAX   || 300);                 // 既定300件
const scrapeCache = new Map(); // key=url, val={ ts, json }

function cacheSet(url, json) {
  if (!url) return;
  if (scrapeCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = scrapeCache.keys().next().value; // Mapは挿入順
    if (firstKey) scrapeCache.delete(firstKey);
  }
  scrapeCache.set(url, { ts: Date.now(), json });
}
function cacheGet(url) {
  const entry = url ? scrapeCache.get(url) : null;
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age > CACHE_TTL_MS) { scrapeCache.delete(url); return null; }
  // LRUリフレッシュ
  scrapeCache.delete(url);
  scrapeCache.set(url, entry);
  return { age, json: entry.json };
}

// 運用用サブエンドポイント
app.get('/__cache/status', (_, res) => {
  res.json({ ok: true, entries: scrapeCache.size, ttlMs: CACHE_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });
});
app.get('/__cache/purge', (req, res) => {
  const u = req.query.url;
  if (u) {
    const existed = scrapeCache.delete(u);
    return res.json({ ok:true, purged: existed ? 1 : 0, url: u });
  }
  const n = scrapeCache.size;
  scrapeCache.clear();
  res.json({ ok:true, purgedAll: n });
});

// -------------------- ユーティリティ --------------------
function uniq(a){ return Array.from(new Set((a||[]).filter(Boolean))); }
function normalizeJpPhone(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^\+81[-\s()]?/, '0');   // +81→0
  s = s.replace(/[^\d-]/g, '');
  const d = s.replace(/-/g,'');
  if (!/^0\d{8,10}$/.test(d)) return null;
  if (/^0[36]\d{8}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3'); // 03/06
  if (/^\d{11}$/.test(d))     return d.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3'); // 4-3-4
  if (/^\d{10}$/.test(d))     return d.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'); // 3-3-4
  return d.replace(/^(\d{2,4})(\d{2,4})(\d{4})$/, '$1-$2-$3');
}
function looksLikeZip7(s){ return /^〒?\d{3}-?\d{4}$/.test(String(s).trim()); }

function isDummyPhone(n){
  if (!n) return true;
  const d = String(n).replace(/[^\d]/g, '');
  if (/^(012|000|007|017|089)/.test(d)) return true;
  if (/(\d)\1{3,}/.test(d)) return true;
  if (n === '03-3333-3333') return true;
  return false;
}
function scorePhoneBasic(n){
  let s = 0;
  if (/^03-/.test(n)) s += 3;
  else if (/^06-/.test(n)) s += 2;
  if (isDummyPhone(n)) s -= 10;
  return s;
}
function pickBestPhone({ telLinks=[], phones=[], labelHits=[], corpusText='' } = {}){
  const labeled = Array.from(new Set(labelHits.map(normalizeJpPhone).filter(n => n && !isDummyPhone(n))));
  if (labeled.length) return labeled[0];
  const DUMMY_PREFIX = /^(007|017|089|000)/;
  for (const raw of telLinks) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    if (!isDummyPhone(n)) return n;
  }
  const cand = [];
  for (const raw of phones) {
    const n = normalizeJpPhone(raw);
    if (!n || isDummyPhone(n)) continue;
    const nd = (n||'').replace(/\D+/g,'');
    const cd = String(corpusText||'').replace(/\D+/g,'');
    const ctx = (nd && cd.includes(nd)) ? 25 : 0;
    cand.push({ n, s: scorePhoneBasic(n) + ctx });
  }
  cand.sort((a,b) => b.s - a.s);
  return cand.length ? cand[0].n : null;
}

const PREF_RE = /(北海道|東京都|(?:京都|大阪)府|..県)/;
function stripTags(s){ return String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function parseBestAddressFromLines(lines){
  if (!lines || !lines.length) return null;
  const cleaned = lines.map(stripTags).filter(Boolean);
  for (const line of cleaned){
    const mZip  = line.match(/〒?\s?(\d{3})-?(\d{4})/);
    const mPref = line.match(PREF_RE);
    if (!mZip || !mPref) continue;
    const postal = mZip[1] + '-' + mZip[2];
    const pref   = mPref[0];
    const afterPref = line.slice(line.indexOf(pref) + pref.length).trim();
    const locM = afterPref.match(/^([^\s、,，]+?(市|区|郡|町|村))/);
    const locality = locM ? locM[1] : '';
    let rest = afterPref.slice(locality.length).replace(/^、|^,|^，/, '').trim();
    rest = rest.replace(/^〒?\s?\d{3}-?\d{4}\s*/, '').trim();
    return {
      postalCode: postal,
      addressRegion: pref,
      addressLocality: locality || undefined,
      streetAddress: rest || undefined,
      addressCountry: 'JP'
    };
  }
  return null;
}
function digitsOnly(s){ return String(s||'').replace(/\D+/g,''); }
function decodeUnicodeEscapes(s){
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// ---- foundingDate 抽出（柔らかめ判定 + ラベル近接優先）----
function tryExtractFounding(text) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ');
  // A. ラベル直後に Y-M-D
  let m = t.match(/(設立|創業)[^\d]{0,20}((?:19|20)\d{2})[^\d]{0,8}(\d{1,2})[^\d]{0,8}(\d{1,2})/);
  if (m) {
    const Y  = String(m[2]).padStart(4,'0');
    const MM = String(m[3]).padStart(2,'0');
    const DD = String(m[4]).padStart(2,'0');
    const iso = `${Y}-${MM}-${DD}`;
    const dt = new Date(iso);
    return (!Number.isNaN(+dt) && (dt.getMonth()+1) === Number(MM)) ? iso : '';
  }
  // B. 年月 or 年のみ（1日丸め）
  m = t.match(/(設立|創業)[^\d]{0,20}((?:19|20)\d{2})[^\d]{0,8}(\d{1,2})(?![^\d]{0,8}\d)/)
   || t.match(/(設立|創業)[^\d]{0,20}((?:19|20)\d{2})(?![^\d]{0,8}\d)/);
  if (m) {
    const Y  = String(m[2]).padStart(4,'0');
    const MM = String(m[3] || '1').padStart(2,'0');
    const iso = `${Y}-${MM}-01`;
    const dt = new Date(iso);
    return (!Number.isNaN(+dt) && (dt.getMonth()+1) === Number(MM)) ? iso : '';
  }
  return '';
}
function toIsoFromJpDate(s){
  const t = String(s || '').replace(/\s+/g,'');
  const m = t.match(/((19|20)\d{2})年(\d{1,2})月(\d{1,2})日?/);
  if (!m) return null;
  const Y = m[1].padStart(4,'0');
  const M = String(m[3]).padStart(2,'0');
  const D = String(m[4]).padStart(2,'0');
  return `${Y}-${M}-${D}`;
}
function tryExtractFoundingFromHtml(html) {
  if (!html) return '';
  const h = String(html);
  const m1 = h.match(/<dt[^>]*>\s*(設立|創業)\s*<\/dt>[\s\S]{0,200}?<dd[^>]*>\s*([^<]+)\s*<\/dd>/i);
  if (m1 && m1[2]) {
    const t = m1[2].replace(/\s+/g, '');
    const m = t.match(/((19|20)\d{2})\D{0,5}(\d{1,2})\D{0,5}(\d{1,2})/);
    if (m) {
      const Y = String(m[1]).padStart(4,'0');
      const M = String(m[3]).padStart(2,'0');
      const D = String(m[4]).padStart(2,'0');
      const iso = `${Y}-${M}-${D}`;
      const dt = new Date(iso);
      if (!Number.isNaN(+dt) && (dt.getMonth()+1) === Number(M)) return iso;
    }
  }
  const m2 = h.replace(/<[^>]*>/g,' ').match(/設立[^0-9]{0,10}((19|20)\d{2})[^0-9]{0,10}(\d{1,2})[^0-9]{0,10}(\d{1,2})/);
  if (m2) {
    const Y = String(m2[1]).padStart(4,'0');
    const M = String(m2[3]).padStart(2,'0');
    const D = String(m2[4]).padStart(2,'0');
    const iso = `${Y}-${M}-${D}`;
    const dt = new Date(iso);
    if (!Number.isNaN(+dt) && (dt.getMonth()+1) === Number(M)) return iso;
  }
  return '';
}

// -------------------- /scrape --------------------
app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  // CACHE CHECK
  try {
    const cached = cacheGet(urlToFetch);
    if (cached && cached.json) {
      const payload = JSON.parse(JSON.stringify(cached.json));
      if (!payload.debug) payload.debug = {};
      payload.debug.cache = { hit: true, ageMs: cached.age, ttlMs: CACHE_TTL_MS };
      return res.status(200).json(payload);
    }
  } catch(_) {}

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });
    const page = await context.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await Promise.race([
      page.waitForResponse(r => { const u = r.url(); return u.endsWith('.js') || u.includes('firestore.googleapis.com'); }, { timeout: 20_000 }).catch(()=>null),
      page.waitForTimeout(20_000)
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(()=>{});
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot], app-index';
    await page.waitForSelector(appSelector, { state: 'attached', timeout: 10_000 }).catch(()=>{});
    await page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll('dl dt, table th'));
      return nodes.some(n => /設立|創業/.test((n.textContent || '').trim()));
    }, { timeout: 8000 }).catch(()=>{});

    // ---- DOMテキスト
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    const hydrated = ((innerText || '').replace(/\s+/g,'').length > 120);

    // ---- 統一スキャン用フラグ（ここで1回だけ宣言）
    let foundFoundingDate = '';
    let foundFoundingDateSource = '';

    // ---- DOM の dt/dd からフォールバック取得
    const foundingFromDom = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      for (const dt of Array.from(document.querySelectorAll('dl dt'))) {
        if (/設立|創業/.test(dt.textContent || '')) {
          const dd = dt.nextElementSibling;
          if (dd) return clean(dd.textContent);
        }
      }
      for (const el of Array.from(document.querySelectorAll('table th, table td'))) {
        if (/設立|創業/.test(el.textContent || '')) {
          const td = el.tagName === 'TH' ? el.nextElementSibling : el;
          if (td) return clean(td.textContent);
        }
      }
      return '';
    });
    if (!foundFoundingDate && foundingFromDom) {
      const iso = toIsoFromJpDate(foundingFromDom);
      if (iso) { foundFoundingDate = iso; foundFoundingDateSource = 'dom'; }
    }

    // ---- HTMLソースも見る
    const htmlSource = await page.content().catch(() => '');
    if (!foundFoundingDate) {
      const hitHtml = tryExtractFoundingFromHtml(htmlSource);
      if (hitHtml) { foundFoundingDate = hitHtml; foundFoundingDateSource = 'html'; }
    }

    // ---- ページ中のリンクから sameAs 候補
    const bundleSameAs = [];
    const SOCIAL_HOST_RE = /(twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|linkedin\.com|note\.com|wantedly\.com|tiktok\.com)/i;
    const anchorHrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href') || '').filter(Boolean)).catch(()=>[]);
    for (const href of anchorHrefs) {
      try {
        const u = new URL(href, urlToFetch);
        if (SOCIAL_HOST_RE.test(u.hostname)) bundleSameAs.push(u.toString());
      } catch(_) {}
    }

    // ---- tel:リンク
    const telLinks = await page.$$eval('a[href^="tel:"]',
      as => as.map(a => (a.getAttribute('href') || '').replace(/^tel:/i,'').replace(/^\+81[-\s()]?/,'0').trim())
    ).catch(()=>[]);

    // ---- JSON-LD（参考）
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // ---- JS候補URL収集
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });
    const abs = (u) => { try { return new URL(u, urlToFetch).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // ---- ページで読み込まれたリソース一覧から JSON 系も拾う
    const resourceUrls = await page.evaluate(() => {
      try { return performance.getEntriesByType('resource').map(e => e.name).filter(Boolean); }
      catch { return []; }
    });
    const extraJsonUrls = uniq(resourceUrls.filter(u => /(\.json(\?|$))|googleapis|sheets|gviz|cms|data/i.test(u)));
    const jsonToTap = extraJsonUrls.filter(u => !jsUrls.includes(u));

    // ---- 正規表現
    const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
    const ZIP_RE   = /〒?\d{3}-?\d{4}/g;

    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];
    const fetchedMeta  = [];
    const tappedUrls   = [];
    const tappedBodies = [];
    const tappedAppIndexBodies = [];
    const labelHitPhones = [];
    const LABEL_RE = /(代表電話|代表|電話|お問い合わせ|TEL|Tel|Phone)/i;

    // ---- HTML直リクエストも軽くスキャン（sameAsと設立の保険）
    try {
      const resp0 = await page.request.get(urlToFetch, { timeout: 20000 });
      if (resp0.ok()) {
        const html0 = await resp0.text();
        const urlMatches0 = html0.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches0) {
          try { const host = new URL(rawUrl).hostname; if (SOCIAL_HOST_RE.test(host)) bundleSameAs.push(String(rawUrl)); } catch {}
        }
        if (!foundFoundingDate) {
          const flat = stripTags(html0);
          const scan0 = flat + '\n' + decodeUnicodeEscapes(flat);
          const hit0 = tryExtractFounding(scan0);
          if (hit0) { foundFoundingDate = hit0; foundFoundingDateSource = 'html2'; }
        }
      }
    } catch {}

    // ---- JSON APIっぽいURLも叩く（設立の保険）
    for (const u of jsonToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 10000 });
        if (!resp.ok()) continue;
        const body = await resp.text();
        if (!body) continue;
        const raw = body;
        const decoded = decodeUnicodeEscapes(raw);
        const scan = raw + '\n' + decoded;
        if (!foundFoundingDate) {
          const hit = tryExtractFounding(scan);
          if (hit) { foundFoundingDate = hit; foundFoundingDateSource = 'json'; continue; }
          const hitHtml = tryExtractFoundingFromHtml(scan);
          if (hitHtml) { foundFoundingDate = hitHtml; foundFoundingDateSource = 'jsonHtml'; continue; }
        }
      } catch {}
    }

    // ---- JS/JSON 本文を取得して抽出
    const jsToTap = uniq([...jsUrls, `${new URL(urlToFetch).origin}/app-index.js`]);

    for (const u of jsToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 20_000 });
        if (!resp.ok()) continue;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!(ct.includes('javascript') || ct.includes('json') || u.endsWith('.js') || u.endsWith('.json'))) continue;

        const text = await resp.text();
        if (/\/app-index\.js(\?|$)/.test(u)) tappedAppIndexBodies.push(text || '');
        if (!text) continue;

        const raw = text || '';
        const decoded = decodeUnicodeEscapes(raw);
        const scan = raw + '\n' + decoded;

        tappedUrls.push(u);
        tappedBodies.push({ url: u, ct, textLen: raw.length });
        fetchedMeta.push({ url: u, ct, textLen: raw.length });

        try {
          for (const m of scan.matchAll(PHONE_RE)) {
            const rawNum = m[0];
            const idx = m.index ?? -1;
            let near = '';
            if (idx >= 0) {
              const start = Math.max(0, idx - 60);
              const end   = Math.min(scan.length, idx + rawNum.length + 60);
              near = scan.slice(start, end);
            }
            if (near && LABEL_RE.test(near)) {
              const n = normalizeJpPhone(rawNum);
              if (n) labelHitPhones.push(n);
            }
          }
        } catch {}

        (scan.match(PHONE_RE) || []).map(normalizeJpPhone).filter(Boolean).forEach(v => bundlePhones.push(v));
        (scan.match(ZIP_RE)   || []).filter(looksLikeZip7).forEach(v => bundleZips.push(v.replace(/^〒/, '')));
        for (const line of scan.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
        }

        if (!foundFoundingDate) {
          const hit = tryExtractFounding(scan);
          if (hit) { foundFoundingDate = hit; foundFoundingDateSource = 'bundle'; }
        }

        const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches) {
          try { const p = new URL(rawUrl); if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString()); } catch {}
        }
      } catch(_) {}
    }

    // ---- 2nd pass: app-index.js が参照する chunk-*.js を最大 8 本だけ追撃
    try {
      const extraChunkUrls = new Set();
      for (const t of tappedAppIndexBodies) {
        const m = (t || '').match(/["'`](\/chunk-[A-Za-z0-9-]+\.js)["'`]/g) || [];
        for (const raw of m) {
          const rel = raw.replace(/^["'`]|["'`]$/g, '');
          try {
            const absUrl = new URL(rel, urlToFetch).toString();
            if (!tappedUrls.includes(absUrl)) extraChunkUrls.add(absUrl);
          } catch {}
        }
      }
      let count = 0;
      for (const u of Array.from(extraChunkUrls)) {
        if (count++ >= 8) break;
        try {
          const resp = await page.request.get(u, { timeout: 15_000 });
          if (!resp.ok()) continue;
          const ct = (resp.headers()['content-type'] || '').toLowerCase();
          if (!(ct.includes('javascript') || u.endsWith('.js'))) continue;

          const text = await resp.text();
          if (!text) continue;

          tappedUrls.push(u);
          tappedBodies.push({ url: u, ct, textLen: text.length });
          fetchedMeta.push({ url: u, ct, textLen: text.length });

          const raw = text || '';
          const decoded = decodeUnicodeEscapes(raw);
          const scan = raw + '\n' + decoded;

          (scan.match(PHONE_RE) || []).map(normalizeJpPhone).filter(Boolean).forEach(v => bundlePhones.push(v));
          (scan.match(ZIP_RE)   || []).filter(looksLikeZip7).forEach(v => bundleZips.push(v.replace(/^〒/, '')));
          for (const line of scan.split(/\n+/)) {
            if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
              bundleAddrs.push(line.replace(/\s+/g,' ').trim());
            }
          }

          if (!foundFoundingDate) {
            const hit = tryExtractFounding(scan);
            if (hit) { foundFoundingDate = hit; foundFoundingDateSource = 'chunk'; }
          }

          const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
          for (const rawUrl of urlMatches) {
            try { const p = new URL(rawUrl); if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString()); } catch {}
          }
        } catch {}
      }
    } catch {}

    // ---- 整理 & 採用値の決定
    const phones = uniq(bundlePhones);
    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

    const pickedPhone = pickBestPhone({
      telLinks,
      phones,
      labelHits: labelHitPhones,
      corpusText: innerText || docText || ''
    });
    const pickedAddress = parseBestAddressFromLines(addrs);

    // bodyText フォールバック
    let bodyText = innerText && innerText.trim() ? innerText : '';
    if (!bodyText) {
      const lines = [];
      if (pickedPhone) lines.push('TEL: ' + pickedPhone);
      if (pickedAddress) {
        const p = pickedAddress;
        const addrLine = [p.postalCode, p.addressRegion, p.addressLocality, p.streetAddress].filter(Boolean).join(' ');
        lines.push('ADDR: ' + addrLine);
      } else {
        if (zips.length)  lines.push('ZIP: ' + zips.slice(0,3).join(', '));
        if (addrs.length) lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
      }
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    // sameAs フィルタ
    const ALLOW_HOST_SNS = /(facebook\.com|instagram\.com|note\.com|twitter\.com|x\.com|youtube\.com|linkedin\.com|tiktok\.com)/i;
    const sameAsClean = Array.from(new Set(
      (bundleSameAs || [])
        .map(u => String(u || '').trim())
        .filter(u => /^https?:\/\//i.test(u))
        .filter(u => ALLOW_HOST_SNS.test((() => { try { return new URL(u).hostname; } catch { return ''; } })()))
    ));

    // 返却ペイロード
    const structured = {
      telephone: pickedPhone || null,
      address: pickedAddress || null,
      foundingDate: foundFoundingDate || null,
      sameAs: sameAsClean
    };
    const jsonldSynth = [{
      "@context": "https://schema.org",
      "@type": "Organization",
      "url": urlToFetch,
      "name": "企業情報",
      ...(pickedPhone ? { "telephone": pickedPhone } : {}),
      ...(pickedAddress ? { "address": { "@type": "PostalAddress", ...pickedAddress } } : {}),
      ...(sameAsClean && sameAsClean.length ? { "sameAs": sameAsClean } : {})
    }];

    const elapsedMs = Date.now() - t0;

    const responsePayload = {
      url: urlToFetch,
      bodyText,
      jsonld,
      structured,
      jsonldSynth,
      debug: {
        build: BUILD_TAG,
        hydrated,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        jsUrls: jsUrls.slice(0, 10),
        tappedUrls: tappedUrls.slice(0, 40),
        tappedBodiesMeta: fetchedMeta.slice(0, 10),
        bundlePhones: phones.slice(0, 10),
        bundleZips: zips.slice(0, 10),
        bundleAddrs: addrs.slice(0, 10),
        pickedPhone: pickedPhone || null,
        pickedAddressPreview: pickedAddress ? [pickedAddress.postalCode, pickedAddress.addressRegion, pickedAddress.addressLocality, pickedAddress.streetAddress].filter(Boolean).join(' ') : null,
        labelHitPhones: Array.from(new Set(labelHitPhones)).slice(0,10),
        foundingDatePicked: foundFoundingDate || null,
        foundingDateSource: foundFoundingDateSource || null, // ★ 追加
        sameAsCount: new Set(sameAsClean).size,
        elapsedMs
      }
    };

    try { cacheSet(urlToFetch, responsePayload); } catch(_){}
    return res.status(200).json(responsePayload);

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      error: 'scrape failed',
      details: err?.message || String(err),
      build: BUILD_TAG,
      elapsedMs
    });
  } finally {
    if (browser) try { await browser.close(); } catch(_) {}
  }
});

app.listen(PORT, () => console.log(`[${BUILD_TAG}] running on ${PORT}`));
