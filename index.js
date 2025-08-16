// index.js — scrape-v5-bundle+cache (phones/addresses/foundingDate/sameAs)
// 目的: DOMが空でも、JSバンドル/JSONから電話・住所・設立日・sameAsを抽出し、
//       最終採用値（pickedPhone / pickedAddress / pickedFoundingDate / pickedSameAs）を返す。
//       結果はメモリキャッシュ。デバッグに詳細も含める。

const express = require('express');
const { chromium } = require('playwright');

const BUILD_TAG = 'scrape-v5-bundle-cache-05-founded-sameas';
const app = express();
const PORT = process.env.PORT || 8080;

// -------------------- CORS --------------------
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// -------------------- ヘルス --------------------
app.get('/', (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// -------------------- Simple in-memory cache --------------------
const CACHE_TTL_MS      = Number(process.env.SCRAPE_CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 既定 6h
const CACHE_MAX_ENTRIES = Number(process.env.SCRAPE_CACHE_MAX   || 300);                 // 既定 300件
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
  // LRU リフレッシュ
  scrapeCache.delete(url);
  scrapeCache.set(url, entry);
  return { age, json: entry.json };
}

// 運用用
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
function digitsOnly(s){ return String(s||'').replace(/\D+/g,''); }

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

function isDummyPhone(n){
  if (!n) return true;
  const d = String(n).replace(/[^\d]/g, '');
  if (/^(012|000|007|017|089)/.test(d)) return true; // 典型ダミー/π断片
  if (/(\d)\1{3,}/.test(d)) return true;             // 3333, 0000 など
  if (n === '03-3333-3333') return true;             // よくあるダミー
  return false;
}
function scorePhoneBasic(n){
  let s = 0;
  if (/^03-/.test(n)) s += 3;
  else if (/^06-/.test(n)) s += 2;
  if (isDummyPhone(n)) s -= 10;
  return s;
}

const PREF_RE = /(北海道|東京都|(?:京都|大阪)府|..県)/;
function stripTags(s){ return String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }

// ---- foundingDate 正規化 ----
// 受け取り： '1999年5月6日' / '1999/05/06' / '1999-5-6' / '1999年05月' / '1999'
// 返り値： '1999-05-06'（日が無ければ '1999-05'、月も無ければ '1999'）
function normalizeJpDateToISO(raw){
  const t = String(raw||'').trim();
  if (!t) return null;
  // 優先：YYYY 年 M 月 D 日
  let m = t.match(/(19|20)\d{2}\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const y = m[0].match(/(19|20)\d{2}/)[0];
    const mo = String(m[2]).padStart(2,'0');
    const d  = String(m[3]).padStart(2,'0');
    return `${y}-${mo}-${d}`;
  }
  // YYYY[-/]M[-/]D
  m = t.match(/((19|20)\d{2})[-\/](\d{1,2})(?:[-\/](\d{1,2}))?/);
  if (m) {
    const y = m[1];
    const mo = String(m[3]).padStart(2,'0');
    if (m[4]) {
      const d = String(m[4]).padStart(2,'0');
      return `${y}-${mo}-${d}`;
    }
    return `${y}-${mo}`;
  }
  // YYYY 年 M 月
  m = t.match(/((19|20)\d{2})\s*年\s*(\d{1,2})\s*月/);
  if (m) {
    const y = m[1];
    const mo = String(m[3]).padStart(2,'0');
    return `${y}-${mo}`;
  }
  // 年だけ
  m = t.match(/((19|20)\d{2})\s*年?/);
  if (m) return m[1];
  return null;
}

// ---- “代表電話”ラベル近接用 ----
const LABEL_RE = /(代表電話|代表|電話|お問い合わせ|TEL|Tel|Phone)/i;

// ---- 正規表現セット ----
const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
const ZIP_RE   = /〒?\d{3}-?\d{4}/g;
// 設立・創業日（周辺 40 文字にキーワードがあるか・または JSON/JS 内の date 風）
const DATE_RE  = /((19|20)\d{2}[\/\-]\d{1,2}(?:[\/\-]\d{1,2})?|(19|20)\d{2}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|(19|20)\d{2}\s*年)/g;
const NEAR_FOUNDING = /(設立|創業|founded|founding|incorporated|established)/i;

// -------------------- 住所構造化 --------------------
function normalizePickedAddressJp(raw) {
  const t = String(raw || '').replace(/\s+/g,' ').trim();
  if (!t) return null;

  // 郵便番号
  const mZip = t.match(/(〒?\d{3}-?\d{4})/);
  const postalCode = mZip ? mZip[1].replace(/^〒/,'') : '';

  // 都道府県
  const mPref = t.match(/(北海道|東京都|京都府|大阪府|..県)/);
  const addressRegion = mPref ? mPref[1] : '';

  // 市区町村（都/道/府/県 の直後から「市|区|町|村」まで）
  let addressLocality = '';
  if (addressRegion) {
    const idx = t.indexOf(addressRegion);
    if (idx >= 0) {
      const tail = t.slice(idx + addressRegion.length);
      const mLoc = tail.match(/([^0-9]*?(市|区|町|村))/);
      if (mLoc) addressLocality = mLoc[1].trim();
    }
  }

  // 残りを番地/建物に
  let streetAddress = t;
  if (postalCode)     streetAddress = streetAddress.replace(postalCode, '');
  if (addressRegion)  streetAddress = streetAddress.replace(addressRegion, '');
  if (addressLocality)streetAddress = streetAddress.replace(addressLocality, '');
  streetAddress = streetAddress.replace(/[\/\|].*$/, ''); // “/ 駅 …” のような説明を切る
  streetAddress = streetAddress.replace(/\s+/g,' ').trim();
  streetAddress = streetAddress.replace(/^[-—–~・・]+/, '').trim();
  streetAddress = streetAddress.replace(/(駅|徒歩|分|出口|フロア|階|地図|アクセス).*/,'').trim();

  const obj = {
    postalCode: postalCode || undefined,
    addressRegion: addressRegion || undefined,
    addressLocality: addressLocality || undefined,
    streetAddress: streetAddress || undefined,
    addressCountry: 'JP'
  };
  Object.keys(obj).forEach(k => { if (!obj[k]) delete obj[k]; });
  return Object.keys(obj).length ? obj : null;
}

// -------------------- ピッカー --------------------
// 電話（代表ラベル > tel:リンク > バンドルスコア）
function pickBestPhone({ telLinks=[], phones=[], labelHits=[], corpusText='' } = {}){
  // 1) 代表電話などのラベル近接
  const labeled = Array.from(new Set(labelHits
    .map(normalizeJpPhone)
    .filter(n => n && !isDummyPhone(n))));
  if (labeled.length) return labeled[0];

  // 2) tel:リンク優先（ダミー除外）
  const DUMMY_PREFIX = /^(007|017|089|000)/;
  for (const raw of telLinks) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    if (!isDummyPhone(n)) return n;
  }

  // 3) バンドル抽出（本文出現で微加点）
  const cd = digitsOnly(corpusText);
  const cand = [];
  for (const raw of phones) {
    const n = normalizeJpPhone(raw);
    if (!n || isDummyPhone(n)) continue;
    const nd = digitsOnly(n);
    const ctx = nd && cd.includes(nd) ? 25 : 0;
    cand.push({ n, s: scorePhoneBasic(n) + ctx });
  }
  cand.sort((a,b) => b.s - a.s);
  return cand.length ? cand[0].n : null;
}

function looksLikeZip7(s){ return /^〒?\d{3}-?\d{4}$/.test(String(s).trim()); }

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

    return normalizePickedAddressJp([postal, pref, locality, rest].filter(Boolean).join(' '));
  }
  return null;
}

// 設立日（周辺に“設立/創業”などがあるものを最優先、ISOへ正規化）
function pickBestFoundingDate({ domText='', jsTexts=[] } = {}){
  // 1) DOM テキスト近傍優先
  try {
    for (const m of domText.matchAll(DATE_RE)) {
      const raw = m[0];
      const idx = m.index ?? -1;
      const near = idx >= 0 ? domText.slice(Math.max(0, idx-40), Math.min(domText.length, idx+raw.length+40)) : '';
      if (NEAR_FOUNDING.test(near)) {
        const iso = normalizeJpDateToISO(raw);
        if (iso) return iso;
      }
    }
  } catch {}

  // 2) JS バンドル内の近傍
  for (const text of jsTexts) {
    try {
      for (const m of text.matchAll(DATE_RE)) {
        const raw = m[0];
        const idx = m.index ?? -1;
        const near = idx >= 0 ? text.slice(Math.max(0, idx-60), Math.min(text.length, idx+raw.length+60)) : '';
        if (NEAR_FOUNDING.test(near)) {
          const iso = normalizeJpDateToISO(raw);
          if (iso) return iso;
        }
      }
    } catch {}
  }

  // 3) 最後の保険：最初の “日付っぽいもの” を正規化
  try {
    const firstDom = (domText.match(DATE_RE) || [])[0];
    if (firstDom) {
      const iso = normalizeJpDateToISO(firstDom);
      if (iso) return iso;
    }
  } catch {}
  for (const text of jsTexts) {
    const first = (text.match(DATE_RE) || [])[0];
    if (first) {
      const iso = normalizeJpDateToISO(first);
      if (iso) return iso;
    }
  }
  return null;
}

// ソーシャル sameAs 収集
const SOCIAL_HOSTS = [
  'twitter.com','x.com','facebook.com','instagram.com','linkedin.com','youtube.com','tiktok.com',
  'github.com','note.com','qiita.com'
];
function isSocial(u){
  try { const h = new URL(u).hostname.replace(/^www\./,'').toLowerCase();
        return SOCIAL_HOSTS.some(s => h === s || h.endsWith('.'+s)); } catch { return false; }
}
function normalizeUrl(u){
  try { return new URL(u).toString(); } catch { return null; }
}

// -------------------- /scrape --------------------
app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  // --- CACHE CHECK ---
  try {
    const cached = cacheGet(urlToFetch);
    if (cached && cached.json) {
      const payload = JSON.parse(JSON.stringify(cached.json));
      if (!payload.debug) payload.debug = {};
      payload.debug.cache = { hit: true, ageMs: cached.age, ttlMs: CACHE_TTL_MS };
      return res.status(200).json(payload);
    }
  } catch {}

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // ---- 軽めの待機 ----
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await Promise.race([
      page.waitForResponse(r => { const u = r.url(); return u.endsWith('.js') || u.includes('firestore.googleapis.com'); }, { timeout: 20_000 }).catch(()=>null),
      page.waitForTimeout(20_000)
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(()=>{});
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot], app-index';
    await page.waitForSelector(appSelector, { state: 'attached', timeout: 10_000 }).catch(()=>{});

    // ---- DOM テキスト ----
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    const hydrated = ((innerText || '').replace(/\s+/g,'').length > 120);

    // tel: リンク
    const telLinks = await page.$$eval('a[href^="tel:"]',
      as => as.map(a => (a.getAttribute('href') || '').replace(/^tel:/i,'').replace(/^\+81[-\s()]?/,'0').trim())
    ).catch(()=>[]);

    // sameAs 候補（リンクから）
    const linkSameAs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(Boolean)).catch(()=>[]);
    const sameAsFromLinks = uniq(linkSameAs.map(h => {
      try { return new URL(h, location.href).toString(); } catch { return null; }
    }).filter(u => u && u.startsWith('http') ));

    // JSON-LD
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // script/src と modulepreload
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });

    const abs = (u) => { try { return new URL(u, urlToFetch).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // ---- バンドル抽出 ----
    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];
    const bundleDates  = []; // raw dates（文字列）
    const fetchedMeta  = [];
    const tappedUrls   = [];
    const jsBodies     = []; // foundingDate 判定用に本文保持
    const labelHitPhones = [];

    const jsToTap = uniq([...jsUrls, `${new URL(urlToFetch).origin}/app-index.js`]);

    for (const u of jsToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 20_000 });
        if (!resp.ok()) continue;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!(ct.includes('javascript') || ct.includes('json') || u.endsWith('.js') || u.endsWith('.json'))) continue;

        const text = await resp.text();
        if (!text) continue;

        tappedUrls.push(u);
        fetchedMeta.push({ url: u, ct, textLen: text.length });
        jsBodies.push(text);

        // 電話（代表ラベル近接）
        try {
          for (const m of text.matchAll(PHONE_RE)) {
            const raw = m[0];
            const idx = m.index ?? -1;
            const near = idx >= 0 ? text.slice(Math.max(0, idx-60), Math.min(text.length, idx+raw.length+60)) : '';
            if (near && LABEL_RE.test(near)) {
              const n = normalizeJpPhone(raw); if (n) labelHitPhones.push(n);
            }
          }
        } catch {}

        // 電話（全般）
        (text.match(PHONE_RE) || []).map(normalizeJpPhone).filter(Boolean).forEach(v => bundlePhones.push(v));

        // 郵便番号
        (text.match(ZIP_RE) || []).forEach(v => bundleZips.push(v.replace(/^〒/, '')));

        // 住所っぽい行
        for (const line of text.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
        }

        // 日付候補（設立/創業 近傍チェックは pick 時に）
        (text.match(DATE_RE) || []).forEach(v => bundleDates.push(v));

      } catch {}
    }

    // ---- sameAs 候補の統合 ----
    let sameAsCandidates = [];
    // JSON-LD の sameAs
    try {
      for (const node of jsonld || []) {
        const arr = Array.isArray(node) ? node : [node];
        for (const n of arr) {
          if (n && typeof n === 'object' && n.sameAs) {
            const xs = Array.isArray(n.sameAs) ? n.sameAs : [n.sameAs];
            sameAsCandidates.push(...xs.map(normalizeUrl).filter(Boolean));
          }
        }
      }
    } catch {}
    // ページ内リンク由来（ソーシャルのみ）
    sameAsCandidates.push(...sameAsFromLinks.filter(isSocial));
    const pickedSameAs = uniq(sameAsCandidates).slice(0, 10);

    // ---- 採用値の決定 ----
    const phones = uniq(bundlePhones);
    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

    const pickedPhone   = (function(){
      return pickBestPhone({
        telLinks,
        phones,
        labelHits: labelHitPhones,
        corpusText: innerText || docText || ''
      });
    })();

    const pickedAddress = parseBestAddressFromLines(addrs);

    const pickedFoundingDate = (function(){
      // DOM + JS の近傍判定
      const iso = pickBestFoundingDate({ domText: innerText || docText || '', jsTexts: jsBodies });
      return iso || null;
    })();

    // ---- bodyText フォールバック（見やすい行） ----
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
      if (pickedFoundingDate) lines.push('FOUNDED: ' + pickedFoundingDate);
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    // ---- JSON-LD（最小）合成 ----
    let jsonldSynth = [];
    try {
      const org = { '@context':'https://schema.org', '@type':'Organization', url: urlToFetch, name: '企業情報' };
      if (pickedPhone)         org.telephone = pickedPhone;
      if (pickedAddress)       org.address   = Object.assign({ '@type':'PostalAddress' }, pickedAddress);
      if (pickedFoundingDate)  org.foundingDate = pickedFoundingDate;
      if (pickedSameAs && pickedSameAs.length) org.sameAs = pickedSameAs;
      jsonldSynth = [org];
    } catch {}

    const elapsedMs = Date.now() - t0;

    // ---- 返却ペイロード ----
    const responsePayload = {
      url: urlToFetch,
      bodyText,
      jsonld,
      structured: {
        telephone: pickedPhone || null,
        address: pickedAddress || null,
        foundingDate: pickedFoundingDate || null,
        sameAs: pickedSameAs || []
      },
      jsonldSynth,
      debug: {
        build: BUILD_TAG,
        hydrated,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        jsUrls: jsUrls.slice(0, 10),
        tappedUrls: tappedUrls.slice(0, 20),
        tappedBodiesMeta: fetchedMeta.slice(0, 10),
        bundlePhones: phones.slice(0, 10),
        bundleZips: zips.slice(0, 10),
        bundleAddrs: addrs.slice(0, 10),
        bundleDates: bundleDates.slice(0, 10),
        pickedPhone: pickedPhone || null,
        pickedAddressPreview: pickedAddress
          ? [pickedAddress.postalCode, pickedAddress.addressRegion, pickedAddress.addressLocality, pickedAddress.streetAddress].filter(Boolean).join(' ')
          : null,
        pickedFoundingDate: pickedFoundingDate || null,
        labelHitPhones: Array.from(new Set(labelHitPhones)).slice(0,10),
        sameAsCandidates: pickedSameAs.slice(0,10),
        elapsedMs
      }
    };

    try { cacheSet(urlToFetch, responsePayload); } catch {}
    return res.status(200).json(responsePayload);

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({ error: 'scrape failed', details: err?.message || String(err), build: BUILD_TAG, elapsedMs });
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
});

app.listen(PORT, () => console.log(`[${BUILD_TAG}] running on ${PORT}`));
