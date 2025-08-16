// index.js  — scrape-v5-bundle
// 目的: DOMが空でも、JSバンドル/JSONから電話・郵便番号・住所を直接抽出
const express = require('express');
const { chromium } = require('playwright');

const BUILD_TAG = 'scrape-v5-bundle';
const app = express();
const PORT = process.env.PORT || 8080;

// CORS
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ヘルス
app.get('/', (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// 正規化ユーティリティ
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

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      // SWは allow：PWAでもJS配布が走るため
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

    // 軽めに待つ（“JS/Firestoreロード”と“主要コンテナ可視”）
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await Promise.race([
      page.waitForResponse(r => r.url().endsWith('.js') || r.url().includes('firestore.googleapis.com'), { timeout: 20_000 }).catch(()=>null),
      page.waitForTimeout(20_000)
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(()=>{});
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot], app-index';
    await page.waitForSelector(appSelector, { state: 'attached', timeout: 10_000 }).catch(()=>{});

    // DOMテキスト（空でもOK）
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    const hydrated = ((innerText || '').replace(/\s+/g,'').length > 120);

    // JSON-LD（参考：あれば使う）
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // ページ内から JS 候補URL取得（script[src], link[rel=modulepreload]）
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });

    // 絶対URL化
    const abs = (u) => { try { return new URL(u, urlToFetch).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // JS/JSON 本文を取得して抽出
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

    // 整理
    const phones = uniq(bundlePhones);
    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

    // bodyText のフォールバック組み立て（DOMが空のとき、抽出値を返す）
    let bodyText = innerText && innerText.trim() ? innerText : '';
    if (!bodyText) {
      const lines = [];
      if (phones.length) lines.push('TEL: ' + phones.slice(0,3).join(', '));
      if (zips.length)   lines.push('ZIP: ' + zips.slice(0,3).join(', '));
      if (addrs.length)  lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    const elapsedMs = Date.now() - t0;
    return res.status(200).json({
      url: urlToFetch,
      bodyText,
      jsonld, // 参考
      debug: {
        build: BUILD_TAG,
        hydrated,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        jsUrls: jsUrls.slice(0, 10),
        fetchedMeta: fetchedMeta.slice(0, 10),
        bundlePhones: phones.slice(0, 10),
        bundleZips: zips.slice(0, 10),
        bundleAddrs: addrs.slice(0, 10),
        elapsedMs
      }
    });

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({ error: 'scrape failed', details: err?.message || String(err), build: BUILD_TAG, elapsedMs });
  } finally {
    if (browser) try { await browser.close(); } catch(_) {}
  }
});

app.listen(PORT, () => console.log(`[${BUILD_TAG}] running on ${PORT}`));
