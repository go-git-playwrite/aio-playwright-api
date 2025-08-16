// index.js — scrape-v5-bundle+cache+jsonld
// 目的: DOMが空でも、JSバンドル/JSON/リンクから電話・郵便番号・住所を抽出し、
//       structured と 合成 JSON-LD(Organization) を返す。結果はメモリキャッシュ。

const express = require('express');
const { chromium } = require('playwright');

const BUILD_TAG = 'scrape-v5-bundle-cache-02';
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

// LRU 風に古いものを落とす
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

// ZIP 正規化＆判定（戻り値は "123-4567"、不一致なら null）←今後はコレを使う
function looksLikeZip7Strict(s) {
  const m = String(s || '').trim().match(/^〒?\s?(\d{3})-?(\d{4})$/);
  return m ? (m[1] + '-' + m[2]) : null;
}

// 電話の簡易スコア（03/06に少し加点 / 数字が多い = 完整形 を加点）
function scorePhone(num){
  if (!num) return 0;
  let s = 0;
  if (/^03-/.test(num)) s += 30;
  if (/^06-/.test(num)) s += 20;
  const d = num.replace(/\D/g,'');
  s += Math.min(10, d.length - 9); // 10〜11桁に寄るほど+（最大+10）
  return s;
}

// 住所候補行から JP Address を粗く構造化（郵便番号があるものを優先）
function parseAddressJpLoose(str){
  if (!str) return null;
  const t = String(str).replace(/\s+/g,' ').trim();

  // 郵便番号
  const zip = looksLikeZip7Strict(t);

  // 都道府県
  const prefRe = /(北海道|東京都|京都府|大阪府|[^\s　]{2,3}県)/;
  const mPref = t.match(prefRe);
  let region = mPref ? mPref[1] : '';

  // 市区町村（ざっくり：都道府県の直後から、市|区|町|村 まで）
  let locality = '';
  if (mPref) {
    const afterPref = t.slice(t.indexOf(mPref[1]) + mPref[1].length);
    const mLoc = afterPref.match(/^[^〒\d、,\s]{1,20}(市|区|町|村)/);
    if (mLoc) locality = (afterPref.slice(0, mLoc.index + mLoc[0].length)).trim();
  }

  // 残りを番地＋建物として丸ごと streetAddress とする（駅アクセスや注記は後段で除去）
  let street = t;
  if (zip) street = street.replace(zip, '');
  if (region) street = street.replace(region, '');
  if (locality) street = street.replace(locality, '');
  street = street.replace(/^[^A-Za-z0-9一-龥ぁ-んァ-ヶー]+/, '').trim();

  // ゴミ除去（駅・所要時間・地図などっぽい句を落とす）
  street = street
    .replace(/(駅[（(].*?[）)]|徒歩\d+分|地図を開く|入館方法はこちらをご覧ください。?)/g,' ')
    .replace(/\s{2,}/g,' ')
    .trim()
    .replace(/[\/|｜]\s*$/,'')
    .trim();

  // 最低限の妥当性
  if (!region && !locality && !zip) return null;

  return {
    postalCode: zip || undefined,
    addressRegion: region || undefined,
    addressLocality: locality || undefined,
    streetAddress: street || undefined,
    addressCountry: 'JP'
  };
}

// 複数候補から最良っぽい住所を選ぶ（郵便番号あり優先 → 文字長/情報量）
function pickBestAddress(cands){
  const scored = (cands || []).map(c => {
    let s = 0;
    if (c.postalCode) s += 30;
    if (c.addressRegion) s += 10;
    if (c.addressLocality) s += 10;
    if (c.streetAddress) s += Math.min(20, (c.streetAddress || '').length / 5);
    return { c, s };
  });
  scored.sort((a,b) => b.s - a.s);
  return scored.length ? scored[0].c : null;
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
      page.waitForResponse(r => r.url().endsWith('.js') || r.url().includes('firestore.googleapis.com'), { timeout: 20_000 }).catch(()=>null),
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

    // ---- JSON-LD（参考）----
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // ---- tel: リンクを最優先で収集（高信頼）----
    const telLinks = await page.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href'))).catch(()=>[]);
    const telFromLinks = (telLinks || [])
      .map(href => (href || '').replace(/^tel:\s*/i,''))
      .map(normalizeJpPhone)
      .filter(Boolean);

    // ---- script/src と modulepreload から JS 候補URLを収集 ----
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // ---- JS/JSON 本文を取得して抽出 ----
    const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
    const ZIP_RE   = /〒?\d{3}-?\d{4}/g;

    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];
    const fetchedMeta  = [];

    for (const u of jsUrls) {
      try {
        const resp = await page.request.get(u, { timeout: 20_000 });
        if (!resp.ok()) continue;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!(ct.includes('javascript') || ct.includes('json') || u.endsWith('.js') || u.endsWith('.json'))) continue;

        const text = await resp.text();
        if (!text) continue;

        fetchedMeta.push({ url: u, len: text.length });

        // 電話
        (text.match(PHONE_RE) || [])
          .map(normalizeJpPhone)
          .filter(Boolean)
          .forEach(v => bundlePhones.push(v));

        // 郵便番号（厳格正規化関数に置換）
        (text.match(ZIP_RE) || []).forEach(v => {
          const norm = looksLikeZip7Strict(v);
          if (norm) bundleZips.push(norm);
        });

        // 住所っぽい行（軽め）
        for (const raw of text.split(/\n+/)) {
          const line = raw.replace(/\s+/g,' ').trim();
          if (!line) continue;
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line);
          }
        }
      } catch(_) {}
    }

    // ---- 整理 ----
    const phonesRaw = uniq([ ...telFromLinks, ...bundlePhones ]);
    // ダミーっぽい 007/017/089/000 は除外
    const phones = phonesRaw.filter(p => !/^(007|017|089|000)/.test(p.replace(/\D/g,'')));
    // スコアで並べ替え（03/06 & 桁数 & tel:優先）
    const scoredPhones = phones.map(p => {
      let s = scorePhone(p);
      if (telFromLinks.includes(p)) s += 40; // tel:は最優先
      return { p, s };
    }).sort((a,b)=>b.s-a.s);
    const bestPhone = scoredPhones.length ? scoredPhones[0].p : null;

    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

    // 住所候補を構造化
    const addressCandidates = [];
    for (const line of addrs) {
      const parsed = parseAddressJpLoose(line);
      if (parsed) addressCandidates.push({ raw: line, parsed });
    }
    // ZIP がページに見えている場合は軽く拾う（DOMから）
    const domZipMatch = (innerText || '').match(/〒\s?\d{3}-?\d{4}/);
    if (domZipMatch) {
      const nz = looksLikeZip7Strict(domZipMatch[0]);
      if (nz) {
        // 既存候補に郵便番号が無ければ付ける
        if (addressCandidates.length && !addressCandidates[0].parsed.postalCode) {
          addressCandidates[0].parsed.postalCode = nz;
        } else {
          addressCandidates.push({ raw: domZipMatch[0], parsed: { postalCode: nz, addressCountry: 'JP' } });
        }
      }
    }
    const bestAddr = pickBestAddress(addressCandidates.map(x=>x.parsed));

    // bodyText のフォールバック組み立て（DOMが薄いとき、抽出値を返す）
    let bodyText = innerText && innerText.trim() ? innerText : '';
    if (!bodyText) {
      const lines = [];
      if (phones.length) lines.push('TEL: ' + phones.slice(0,3).join(', '));
      if (zips.length)   lines.push('ZIP: ' + zips.slice(0,3).join(', '));
      if (addrs.length)  lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    // ---- 合成 JSON-LD（Organization） ----
    const pageTitle = await page.title().catch(() => '');
    const ogImage = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
    const ogSiteName = await page.$eval('meta[property="og:site_name"]', el => el.content).catch(() => null);
    let orgNameSynth = (pageTitle || '').replace(/\s*\|\s*.+$| - .+$/,'').trim();
    if (!orgNameSynth && ogSiteName) orgNameSynth = ogSiteName.trim();

    // PostalAddress オブジェクト
    const postalAddress = bestAddr ? {
      "@type": "PostalAddress",
      postalCode: bestAddr.postalCode || undefined,
      addressRegion: bestAddr.addressRegion || undefined,
      addressLocality: bestAddr.addressLocality || undefined,
      streetAddress: bestAddr.streetAddress || undefined,
      addressCountry: "JP"
    } : undefined;

    const jsonldOrgSynth = {
      "@context": "https://schema.org",
      "@type": "Organization",
      "url": urlToFetch,
      ...(orgNameSynth ? { "name": orgNameSynth } : {}),
      ...(bestPhone ? { "telephone": bestPhone } : {}),
      ...(postalAddress ? { "address": postalAddress } : {}),
      ...(ogImage ? { "logo": ogImage } : {})
    };

    const elapsedMs = Date.now() - t0;

    // ---- 返却ペイロードを一度だけ組み立てる ----
    const responsePayload = {
      url: urlToFetch,
      bodyText,
      jsonld,                 // ページ生の JSON-LD（参考）
      jsonldSynth: [ jsonldOrgSynth ], // 合成 Organization JSON-LD
      structured: {
        telephone: bestPhone || null,
        address: bestAddr || null
      },
      debug: {
        build: BUILD_TAG,
        hydrated,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        telLinks: telLinks || [],
        jsUrls: jsUrls.slice(0, 10),
        fetchedMeta: fetchedMeta.slice(0, 10),
        bundlePhones: phones.slice(0, 10),
        bundleZips: zips.slice(0, 10),
        bundleAddrs: addrs.slice(0, 10),
        pickedPhone: bestPhone || null,
        pickedAddressPreview: addressCandidates.length ? addressCandidates[0].raw : null,
        elapsedMs
      }
    };

    // --- CACHE SET（成功時のみ保存）
    try { cacheSet(urlToFetch, responsePayload); } catch(_) {}

    // 返却（ここで一度だけ）
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
