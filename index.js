// index.js — scrape-v5-bundle+cache (phones/addresses, cache, jsonldSynth, robust debug)
// 目的: DOMが空でも、JSバンドル/JSONから電話・郵便番号・住所を直接抽出し、
//       最終的な採用値（pickedPhone / pickedAddress）を返す。結果はメモリキャッシュ。

const express = require('express');
const { chromium } = require('playwright');

const BUILD_TAG = 'scrape-v5-bundle-cache-03-fixed';
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

// LRU風に古いものを落とす
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
// -------------------- /cache end --------------------

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
// ---- scoring & picking helpers (phones/addresses) ----
function isDummyPhone(n){
  if (!n) return true;
  const d = String(n).replace(/[^\d]/g, '');
  if (/^(012|000|007|017|089)/.test(d)) return true;         // 典型ダミー/π断片
  if (/(\d)\1{3,}/.test(d)) return true;                     // 3333, 0000 など
  if (n === '03-3333-3333') return true;                     // よくある例
  return false;
}
function scorePhoneBasic(n){
  let s = 0;
  if (/^03-/.test(n)) s += 3;       // 都内
  else if (/^06-/.test(n)) s += 2;  // 大阪
  if (isDummyPhone(n)) s -= 10;
  return s;
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

    const postal = mZip[1] + '-' + mZip[2];          // 例: 107-0062
    const pref   = mPref[0];                         // 例: 東京都
    const afterPref = line.slice(line.indexOf(pref) + pref.length).trim();

    const locM = afterPref.match(/^([^\s、,，]+?(市|区|郡|町|村))/); // 例: 港区
    const locality = locM ? locM[1] : '';

    // ZIP を先頭に付けているケースや全角記号を掃除
    let rest = afterPref.slice(locality.length).replace(/^、|^,|^，/, '').trim();
    rest = rest.replace(/^〒?\s?\d{3}-?\d{4}\s*/, '').trim(); // 先頭に ZIP が重複してたら除去

    const addr = {
      postalCode: postal,
      addressRegion: pref,
      addressLocality: locality || undefined,
      streetAddress: rest || undefined,
      addressCountry: 'JP'
    };
    return addr; // 最初に条件を満たした行を採用
  }
  return null;
}
function digitsOnly(s){ return String(s||'').replace(/\D+/g,''); }

// 電話の重み付け（近接ラベルは今回はテキストのみで簡易スコア）
function scorePhoneByContext(num, corpusText){
  const c = String(corpusText || '');
  const n = String(num || '');
  let sc = 0;

  // ラベル近接（簡易）：電話/代表/お問い合わせ/TEL が本文にあれば+（テキストベース）
  if (/(代表|電話|お問い合わせ|TEL|Tel|Phone)/i.test(c)) sc += 20;

  // 03/06 を少し優先（大手本社で出やすいための汎用バイアス）
  if (/^03-/.test(n)) sc += 15;
  if (/^06-/.test(n)) sc += 10;

  // ページに出現していれば加点（digitsで）
  const nd = digitsOnly(n);
  const cd = digitsOnly(c);
  if (nd && cd.includes(nd)) sc += 25;

  return sc;
}

// 住所を構造化（PostalAddress）へ
function normalizePickedAddressJp(raw) {
  const t = String(raw || '').replace(/\s+/g,' ').trim();
  if (!t) return null;

  // 郵便番号
  const mZip = t.match(/(〒?\d{3}-?\d{4})/);
  const postalCode = mZip ? mZip[1].replace(/^〒/,'') : '';

  // 都道府県
  const mPref = t.match(/(東京都|道|府|..県)/);
  let addressRegion = '';
  if (mPref) {
    // “道/府” 単独マッチをもう少し丁寧に
    const pref = mPref[1];
    if (pref === '道' || pref === '府') {
      const m2 = t.match(/(北海道|京都府|大阪府|..県|東京都)/);
      addressRegion = m2 ? m2[1] : '';
    } else {
      addressRegion = pref === '道' ? '北海道' : pref;
    }
  } else {
    // 代表的な都道府県名をざっくり拾う
    const m2 = t.match(/(北海道|東京都|京都府|大阪府|..県)/);
    addressRegion = m2 ? m2[1] : '';
  }

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
  if (postalCode) streetAddress = streetAddress.replace(postalCode, '');
  if (addressRegion) streetAddress = streetAddress.replace(addressRegion, '');
  if (addressLocality) streetAddress = streetAddress.replace(addressLocality, '');
  streetAddress = streetAddress.replace(/[\/\|].*$/, ''); // “/ 駅 …” のような説明を切る
  streetAddress = streetAddress.replace(/\s+/g,' ').trim();
  streetAddress = streetAddress.replace(/^[-—–~・・]+/, '').trim();

  // 住所でない説明（駅・徒歩など）を除去
  streetAddress = streetAddress.replace(/(駅|徒歩|分|出口|フロア|階|地図|アクセス).*/,'').trim();

  const obj = {
    postalCode: postalCode || undefined,
    addressRegion: addressRegion || undefined,
    addressLocality: addressLocality || undefined,
    streetAddress: streetAddress || undefined,
    addressCountry: 'JP'
  };
  // 空を消す
  Object.keys(obj).forEach(k => { if (!obj[k]) delete obj[k]; });
  return Object.keys(obj).length ? obj : null;
}

// 電話を最終決定：telリンク > バンドル抽出（ダミー番号除外 + スコア降順）
function pickBestPhone(telLinks, phones, corpusText=''){
  const DUMMY_PREFIX = /^(007|017|089|000)/;

  // 1) tel:リンク優先
  for (const raw of telLinks || []) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    return n;
  }

  // 2) バンドル抽出（スコア付け）
  const cand = [];
  for (const raw of phones || []) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    cand.push({ n, s: scorePhoneByContext(n, corpusText) });
  }
  cand.sort((a,b) => b.s - a.s);
  return cand.length ? cand[0].n : null;
}

// 住所を最終決定：バンドル抽出 + 郵便番号の補助
function pickBestAddress(addrLines, zips) {
  // 候補行から駅/徒歩などを除去し、都道府県語を含むものを優先
  const cleaned = [];
  for (const line of addrLines || []) {
    const t = String(line || '').replace(/\s+/g,' ').trim();
    if (!t) continue;
    if (!/(東京都|北海道|..県|京都府|大阪府)/.test(t)) continue; // 県名がない行はスキップ
    const cut = t.replace(/[\/\|].*$/, ''); // “/ …” 以降を切る
    cleaned.push(cut);
  }
  if (!cleaned.length) return null;

  // 郵便番号が近くで拾えているなら先頭候補に付与
  const zip = (zips||[]).find(looksLikeZip7) || '';
  const raw = zip ? (zip.replace(/^〒/,'') + ' ' + cleaned[0]) : cleaned[0];

  return normalizePickedAddressJp(raw);
}

// -------------------- /scrape --------------------
app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  // --- CACHE CHECK (early return) ---
  try {
    const cached = cacheGet(urlToFetch);
    if (cached && cached.json) {
      const payload = JSON.parse(JSON.stringify(cached.json)); // defensive copy
      if (!payload.debug) payload.debug = {};
      payload.debug.cache = { hit: true, ageMs: cached.age, ttlMs: CACHE_TTL_MS };
      return res.status(200).json(payload);
    }
  } catch(_) {}

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                 'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                 'Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',                // PWA配布を通す
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // ---- 主要待機（軽め） ----
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await Promise.race([
      page.waitForResponse(r => {
        const u = r.url();
        return u.endsWith('.js') || u.includes('firestore.googleapis.com');
      }, { timeout: 20_000 }).catch(()=>null),
      page.waitForTimeout(20_000)
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(()=>{});
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot], app-index';
    await page.waitForSelector(appSelector, { state: 'attached', timeout: 10_000 }).catch(()=>{});

    // ---- DOMテキスト（空でもOK）----
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    const hydrated = ((innerText || '').replace(/\s+/g,'').length > 120);

    // tel:リンク（ここで必ず取得しておく）
    const telLinks = await page.$$eval('a[href^="tel:"]',
      as => as.map(a => (a.getAttribute('href') || '')
        .replace(/^tel:/i,'')
        .replace(/^\+81[-\s()]?/,'0')
        .trim()
      )
    ).catch(()=>[]);

    // ---- JSON-LD（参考）----
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // ---- script/src と modulepreload から JS 候補URLを収集 ----
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });
    const abs = (u) => { try { return new URL(u, urlToFetch).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // ---- JS/JSON 本文を取得して抽出 ----
    const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
    const ZIP_RE   = /〒?\d{3}-?\d{4}/g;

    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];
    const fetchedMeta  = [];
    const tappedUrls   = [];
    const tappedBodies = [];

    // ページが教えてくれたJS候補 & 典型的なchunk命名を少し増やす
    const jsToTap = uniq([
      ...jsUrls,
      // SPAでよくある追加エンドポイント（念のため）
      `${new URL(urlToFetch).origin}/app-index.js`
    ]);

    for (const u of jsToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 20_000 });
        if (!resp.ok()) continue;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!(ct.includes('javascript') || ct.includes('json') || u.endsWith('.js') || u.endsWith('.json'))) continue;

        const text = await resp.text();
        if (!text) continue;

        tappedUrls.push(u);
        tappedBodies.push({ url: u, ct, textLen: text.length });
        fetchedMeta.push({ url: u, ct, textLen: text.length });

        // 電話
        (text.match(PHONE_RE) || [])
          .map(normalizeJpPhone)
          .filter(Boolean)
          .forEach(v => bundlePhones.push(v));

        // 郵便番号
        (text.match(ZIP_RE) || [])
          .filter(looksLikeZip7)
          .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

        // 住所っぽい行（軽め）
        for (const line of text.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
        }
      } catch(_) {}
    }

    // ---- 整理 & 採用値の決定 ----
    const phones = uniq(bundlePhones);
    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

// ★ここから追加：良質な1件を決める（ZIPは addrs の行から優先抽出）
const pickedPhone   = pickBestPhone(telLinks, phones, innerText || docText);
const pickedAddress = parseBestAddressFromLines(addrs);

// ★bodyText フォールバックも “選ばれた値” を優先的に使う
let bodyText = innerText && innerText.trim() ? innerText : '';
if (!bodyText) {
  const lines = [];
  if (pickedPhone) lines.push('TEL: ' + pickedPhone);
  if (pickedAddress) {
    const p = pickedAddress;
    const addrLine = [p.postalCode, p.addressRegion, p.addressLocality, p.streetAddress]
      .filter(Boolean).join(' ');
    lines.push('ADDR: ' + addrLine);
  } else {
    if (zips.length)  lines.push('ZIP: ' + zips.slice(0,3).join(', '));
    if (addrs.length) lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
  }
  bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
}

    // ---- JSON-LD（最小）を合成 ----
    let jsonldSynth = [];
    try {
      const org = { '@context':'https://schema.org', '@type':'Organization', url: urlToFetch, name: '企業情報' };
      // 画像などは既知のOGPパスがあればここに足す（安全のため固定入れはしない）
      if (pickedPhone) org.telephone = pickedPhone;
      if (pickedAddress)  org.address = Object.assign({ '@type':'PostalAddress' }, pickedAddress);
      jsonldSynth = [org];
    } catch(_){}

    const elapsedMs = Date.now() - t0;

    // ---- 返却ペイロードを一度だけ組み立てる ----
const responsePayload = {
  url: urlToFetch,
  bodyText,
  jsonld,
  // ★構造化（ここを新規/更新）
  structured: {
    telephone: pickedPhone || null,
    address: pickedAddress || null
  },
  // ★合成 JSON-LD（既にある場合は置き換え）
  jsonldSynth: [{
    "@context": "https://schema.org",
    "@type": "Organization",
    "url": urlToFetch,
    "name": "企業情報",
    ...(pickedPhone ? { "telephone": pickedPhone } : {}),
    ...(pickedAddress ? { "address": { "@type": "PostalAddress", ...pickedAddress } } : {}),
    ...(jsonld && jsonld.length ? { "sameAs": [] } : {}) // 拡張余地
  }],
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
    // ★見やすいように“選ばれた値”も debug へ
    pickedPhone: pickedPhone || null,
    pickedAddressPreview: pickedAddress
      ? [pickedAddress.postalCode, pickedAddress.addressRegion, pickedAddress.addressLocality, pickedAddress.streetAddress]
          .filter(Boolean).join(' ')
      : null,
    elapsedMs
  }
};

    // --- CACHE SET（成功時のみ保存）
    try { cacheSet(urlToFetch, responsePayload); } catch(_){}

    // 返却
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
