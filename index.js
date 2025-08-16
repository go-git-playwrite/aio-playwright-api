// index.js — scrape-v5-bundle+cache+nettap
// 目的: DOMが空でも、ネットワーク経由の .js / Firestore / .json 本文から
//       電話・郵便番号・住所を直接抽出し、結果をキャッシュ
//       （script[src] が取れないケースでも動くよう network tap を追加）

const express = require('express');
const { chromium } = require('playwright');

const BUILD_TAG = 'scrape-v5-bundle-cache-03';
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

    // ---- network tap: .js / .json / Firestore を直接収集 ----
    const tappedBodies = [];   // { url, ct, textLen, text (trimmed) }
    const tappedUrls   = [];   // URL一覧（重複なし）
    let tappedBytes = 0;       // メモリ安全のため累計に上限
    const TAPPED_MAX_BYTES = 1_200_000; // ~1.2MB

    page.on('response', async (r) => {
      try {
        const url = r.url();
        const ct  = (r.headers()['content-type'] || '').toLowerCase();
        const isJs = /\.js(\?|$)/i.test(url) || ct.includes('javascript');
        const isFs = url.includes('firestore.googleapis.com');
        const isJson = ct.includes('application/json') || /\.json(\?|$)/i.test(url);
        if (!(isJs || isFs || isJson)) return;

        const txt = await r.text();
        if (!txt) return;

        tappedUrls.push(url);
        if (tappedBytes < TAPPED_MAX_BYTES) {
          const room = TAPPED_MAX_BYTES - tappedBytes;
          const slice = txt.slice(0, Math.max(0, Math.min(room, 400_000))); // 1レスポンスにつき最大40万文字
          tappedBodies.push({ url, ct, textLen: txt.length, text: slice });
          tappedBytes += slice.length;
        }
      } catch(_) {}
    });

    // ---- 主要待機 ----
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await Promise.race([
      page.waitForResponse(r => {
        const u = r.url();
        const h = (r.headers()['content-type'] || '').toLowerCase();
        return /\.js(\?|$)/i.test(u) || u.includes('firestore.googleapis.com') || h.includes('application/json');
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

    // ---- tel: リンク（最優先候補）----
    const telLinks = await page.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href'))).catch(()=>[]);
    const telFromLinks = uniq((telLinks||[]).map(h => h.replace(/^tel:/i,'').trim()).map(normalizeJpPhone)).filter(Boolean);

    // ---- JSON-LD（参考）----
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // ---- script/src と modulepreload から JS 候補URLを収集（DOM経由）----
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch { return null; } };
    const jsUrlsDom = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // ---- ネットワーク経由で掴んだ本文から抽出（本筋）----
    const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
    const ZIP_RE   = /〒?\d{3}-?\d{4}/g;

    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];

    for (const t of tappedBodies) {
      try {
        // 電話
        (t.text.match(PHONE_RE) || [])
          .map(normalizeJpPhone)
          .filter(Boolean)
          .forEach(v => bundlePhones.push(v));

        // 郵便番号
        (t.text.match(ZIP_RE) || [])
          .filter(looksLikeZip7)
          .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

        // 住所っぽい行（軽め）
        for (const line of t.text.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
        }
      } catch(_) {}
    }

    // ---- 追加で DOM 由来の URL を個別フェッチ（tap で拾えなかったときの保険）----
    const fetchedMeta = [];
    if (tappedBodies.length === 0 && jsUrlsDom.length > 0) {
      // 代表的なJSだけ先頭数件を試す
      const tryUrls = jsUrlsDom.slice(0, 6);
      for (const u of tryUrls) {
        try {
          const resp = await page.request.get(u, { timeout: 20_000 });
          if (!resp.ok()) continue;
          const ct = (resp.headers()['content-type'] || '').toLowerCase();
          if (!(ct.includes('javascript') || ct.includes('json') || /\.js(\?|$)/i.test(u) || /\.json(\?|$)/i.test(u))) continue;
          const text = await resp.text();
          if (!text) continue;
          fetchedMeta.push({ url: u, len: text.length });

          (text.match(PHONE_RE) || [])
            .map(normalizeJpPhone)
            .filter(Boolean)
            .forEach(v => bundlePhones.push(v));

          (text.match(ZIP_RE) || [])
            .filter(looksLikeZip7)
            .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

          for (const line of text.split(/\n+/)) {
            if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
              bundleAddrs.push(line.replace(/\s+/g,' ').trim());
            }
          }
        } catch(_) {}
      }
    }

    // ---- 整理 & bodyText フォールバック ----
    const phones = uniq([...(telFromLinks||[]), ...(bundlePhones||[])]);
    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

    let bodyText = innerText && innerText.trim() ? innerText : '';
    if (!bodyText) {
      const lines = [];
      if (phones.length) lines.push('TEL: ' + phones.slice(0,3).join(', '));
      if (zips.length)   lines.push('ZIP: ' + zips.slice(0,3).join(', '));
      if (addrs.length)  lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    const elapsedMs = Date.now() - t0;

    // ---- 返却ペイロード ----
    const responsePayload = {
      url: urlToFetch,
      bodyText,
      jsonld,
      debug: {
        build: BUILD_TAG,
        hydrated,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        telLinks: telLinks || [],
        // DOM 由来と network tap 由来を分けて見せる
        jsUrls: jsUrlsDom.slice(0, 10),
        tappedUrls: uniq(tappedUrls).slice(0, 20),
        tappedBodiesMeta: tappedBodies.slice(0, 10).map(x => ({ url: x.url, ct: x.ct, textLen: x.textLen })),
        fetchedMeta: fetchedMeta.slice(0, 10),
        bundlePhones: phones.slice(0, 10),
        bundleZips: zips.slice(0, 10),
        bundleAddrs: addrs.slice(0, 10),
        elapsedMs
      }
    };

    // --- CACHE SET（成功時のみ保存）
    try { cacheSet(urlToFetch, responsePayload); } catch(_) {}

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
