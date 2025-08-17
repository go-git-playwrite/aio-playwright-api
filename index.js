// index.js — scrape-v5-bundle+cache (phones/addresses + foundingDate + sameAs, chunk-chase)
// 目的: DOMが空でも JS/JSON から電話・住所・設立日・sameAs を抽出し、
//       最終値（pickedPhone / pickedAddress / foundingDate / sameAs）を返す。結果はメモリキャッシュ。

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

// ====== PHONE scoring & picking (代表電話ラベル優先) ======
function isDummyPhone(n){
  if (!n) return true;
  const d = String(n).replace(/[^\d]/g, '');
  if (/^(012|000|007|017|089)/.test(d)) return true;         // 典型ダミー/π断片
  if (/(\d)\1{3,}/.test(d)) return true;                     // 3333, 0000 など
  if (n === '03-3333-3333') return true;                     // よくあるダミー
  return false;
}
function scorePhoneBasic(n){
  let s = 0;
  if (/^03-/.test(n)) s += 3;       // 都内
  else if (/^06-/.test(n)) s += 2;  // 大阪
  if (isDummyPhone(n)) s -= 10;
  return s;
}
/**
 * 代表電話などの“ラベル近接”で拾えた番号を最優先。
 * 次に tel: リンク、最後に通常スコアリング。
 */
function pickBestPhone({ telLinks=[], phones=[], labelHits=[], corpusText='' } = {}){
  // 1) 代表電話などのラベル近接（最優先）
  const labeled = Array.from(new Set(labelHits
    .map(normalizeJpPhone)
    .filter(n => n && !isDummyPhone(n))));
  if (labeled.length) return labeled[0];

  // 2) tel:リンク優先
  const DUMMY_PREFIX = /^(007|017|089|000)/;
  for (const raw of telLinks) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    if (!isDummyPhone(n)) return n;
  }

  // 3) バンドル抽出（スコア付け）
  const cand = [];
  for (const raw of phones) {
    const n = normalizeJpPhone(raw);
    if (!n || isDummyPhone(n)) continue;
    // 超簡易：本文に出ていれば +25
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
function decodeUnicodeEscapes(s){
  // \uXXXX を実文字に変換（サロゲートペアは連結で自然に復元される）
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// ---- foundingDate 抽出（柔らかめ判定）----
const FOUNDING_RES = [
  /設立[^0-9]{0,6}((19|20)\d{2})年(\d{1,2})月(\d{1,2})日?/,
  /創業[^0-9]{0,6}((19|20)\d{2})年(\d{1,2})月(\d{1,2})日?/,
  /((19|20)\d{2})[\/\.\-年](\d{1,2})[\/\.\-月](\d{1,2})日?/
];
const FOUNDING_RES_SOFT = [
  /設立[^0-9]{0,6}((19|20)\d{2})年(\d{1,2})月(\d{1,2})?日?/,
  /創業[^0-9]{0,6}((19|20)\d{2})年(\d{1,2})月(\d{1,2})?日?/,
  /((19|20)\d{2})[\/\.\-年](\d{1,2})(?:[\/\.\-月](\d{1,2})日?)?/
];
function tryExtractFounding(text) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ');

  // 1) 「設立/創業」ラベルの直後〜120文字以内に日付
  const LABEL_NEAR_DATE = /(設立|創業)[^\d]{0,20}((?:19|20)\d{2})[^\d]{0,8}(\d{1,2})[^\d]{0,8}(\d{1,2})/;
  let m = t.match(LABEL_NEAR_DATE);
  if (!m) {
    // 2) ラベル→年のみ or 年月のみ（末尾日がないときは1日に丸め）
    const LABEL_NEAR_YYYY_MM = /(設立|創業)[^\d]{0,20}((?:19|20)\d{2})[^\d]{0,8}(\d{1,2})(?![^\d]{0,8}\d)/;
    const LABEL_NEAR_YYYY = /(設立|創業)[^\d]{0,20}((?:19|20)\d{2})(?![^\d]{0,8}\d)/;
    m = t.match(LABEL_NEAR_YYYY_MM) || t.match(LABEL_NEAR_YYYY);
    if (m) {
      const Y  = String(m[2]).padStart(4, '0');
      const MM = String(m[3] || '1').padStart(2, '0');
      const DD = '01';
      const iso = `${Y}-${MM}-${DD}`;
      const dt = new Date(iso);
      if (!Number.isNaN(+dt) && (dt.getMonth() + 1) === Number(MM)) return iso;
      return '';
    }
    return '';
  }

  // m: [全体, ラベル, 年, 月, 日]
  const Y  = String(m[2]).padStart(4, '0');
  const MM = String(m[3]).padStart(2, '0');
  const DD = String(m[4]).padStart(2, '0');
  const iso = `${Y}-${MM}-${DD}`;
  const dt = new Date(iso);
  return (!Number.isNaN(+dt) && (dt.getMonth() + 1) === Number(MM)) ? iso : '';
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

// ★ 追加：dt/th に「設立|創業」が現れるまで最大 8 秒待つ
await page.waitForFunction(() => {
  const nodes = Array.from(document.querySelectorAll('dl dt, table th'));
  return nodes.some(n => /設立|創業/.test((n.textContent || '').trim()));
}, { timeout: 8000 }).catch(()=>{});

    // ---- DOMテキスト（空でもOK）----
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    const hydrated = ((innerText || '').replace(/\s+/g,'').length > 120);

// --- HTMLソース（タグあり）も拾っておく
const htmlSource = await page.content().catch(() => '');

// タグをまたいでも拾える“超ゆる”マッチ
function tryExtractFoundingFromHtml(html) {
  if (!html) return '';
  const h = String(html);
  // 例: <dt>設立</dt>\n  <dd>1999年5月6日</dd> のようなパターン
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
  // “設立1999年5月6日” のように連続したケース（タグ関係なし）
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

let foundFoundingDate = ''; // ここで一度だけ宣言
if (!foundFoundingDate) {
   const hitHtml = tryExtractFoundingFromHtml(htmlSource);
   if (hitHtml) foundFoundingDate = hitHtml;
 }

// --- DOM の dt/dd から「設立」を拾う（フォールバック用） ---
function toIsoFromJpDate(s){
  const t = String(s || '').replace(/\s+/g,'');
  const m = t.match(/((19|20)\d{2})年(\d{1,2})月(\d{1,2})日?/);
  if (!m) return null;
  const Y = m[1].padStart(4,'0');
  const M = String(m[3]).padStart(2,'0');  // ← ここ重要
  const D = String(m[4]).padStart(2,'0');  // ← ここ重要
  return `${Y}-${M}-${D}`;
}

// === DOM直読みで設立/創業日を拾う（dt/dd・表のth/td対応） ===
const foundingFromDom = await page.evaluate(() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // 1) <dl><dt>設立</dt><dd>1999年5月6日</dd>
  for (const dt of Array.from(document.querySelectorAll('dl dt'))) {
    if (/設立|創業/.test(dt.textContent || '')) {
      const dd = dt.nextElementSibling;
      if (dd) return clean(dd.textContent);
    }
  }
  // 2) <table><tr><th>設立</th><td>...</td></tr> など
  for (const el of Array.from(document.querySelectorAll('table th, table td'))) {
    if (/設立|創業/.test(el.textContent || '')) {
      const td = el.tagName === 'TH' ? el.nextElementSibling : el;
      if (td) return clean(td.textContent);
    }
  }
  return '';
});

// 文字列 → ISO(YYYY-MM-DD) へ軽整形
(function () {
  const t = String(foundingFromDom || '').replace(/[.\u30fb]/g, '/'); // 句点などゆる変換
  // 「1999年5月6日」「1999-5-6」「1999/5/6」などを許容
  const m = t.match(/(19|20)\d{2}\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
  if (!m) return;
  const Y = String(m[0].match(/(19|20)\d{2}/)[0]).padStart(4, '0');
  const parts = m[0].replace(/[^\d]/g, ' ').trim().split(/\s+/);
  // parts から月日を推定（Y 以外の最初の2つ）
  const nums = parts.map(Number).filter(n => n > 0);
  // nums 例: [1999, 5, 6] or [1999, 05, 06]
  const Yidx = nums.findIndex(n => n >= 1900 && n <= 2100);
  const MM = String(nums[(Yidx === -1 ? 0 : Yidx + 1)] || '').padStart(2, '0');
  const DD = String(nums[(Yidx === -1 ? 1 : Yidx + 2)] || '').padStart(2, '0');
  if (!MM || !DD) return;
  const iso = `${Y}-${MM}-${DD}`;
  const dt = new Date(iso);
  if (!Number.isNaN(+dt) && (dt.getMonth() + 1) === Number(MM)) {
    foundFoundingDate = iso;
  }
})();

    // tel:リンク
    const telLinks = await page.$$eval('a[href^="tel:"]',
      as => as.map(a => (a.getAttribute('href') || '')
        .replace(/^tel:/i,'')
        .replace(/^\+81[-\s()]?/,'0')
        .trim()
      )
    ).catch(()=>[]);

// sameAs 候補（ページ内 a[href]）
const bundleSameAs = [];
const SOCIAL_HOST_RE = /(twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|linkedin\.com|note\.com|wantedly\.com|tiktok\.com)/i;
const anchorHrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href') || '').filter(Boolean)).catch(()=>[]);
for (const href of anchorHrefs) {
  try {
    const u = new URL(href, urlToFetch);
    if (SOCIAL_HOST_RE.test(u.hostname)) bundleSameAs.push(u.toString());
  } catch(_) {}
}

// --- NEW: 生HTMLのソースもスキャン（Unicodeエスケープも両取り）---
try {
  const resp0 = await page.request.get(urlToFetch, { timeout: 20000 });
  if (resp0.ok()) {
    const html0 = await resp0.text();

    // sameAs を HTML 直書きからも追加（フッター等の a 以外・JS に埋め込まれたURLも拾える）
    const urlMatches0 = html0.match(/https?:\/\/[^\s"'<>]+/g) || [];
    for (const rawUrl of urlMatches0) {
      try {
        const host = new URL(rawUrl).hostname;
        if (SOCIAL_HOST_RE.test(host)) bundleSameAs.push(String(rawUrl));
      } catch (_) {}
    }

    // HTML → テキスト化（タグ剥がし） → Unicode デコード → 設立日の再スキャン
    const flat = stripTags(html0);
    const scan0 = flat + '\n' + decodeUnicodeEscapes(flat);

    if (!foundFoundingDate) {
      const hit0 = tryExtractFounding(scan0);
      if (hit0) foundFoundingDate = hit0;
    }
  }
} catch (_) {}

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

// --- ページで読み込まれたリソース一覧から JSON 系も拾う
const resourceUrls = await page.evaluate(() => {
  try {
    return performance.getEntriesByType('resource')
      .map(e => e.name)
      .filter(Boolean);
  } catch { return []; }
});

// JSON/GoogleAPIっぽいものだけ追加スキャン対象に
const extraJsonUrls = uniq(resourceUrls.filter(u =>
  /(\.json(\?|$))|googleapis|sheets|gviz|cms|data/i.test(u)
));

// 既に叩いたURLと重複しないものだけ
const jsonToTap = extraJsonUrls.filter(u => !jsUrls.includes(u));

for (const u of jsonToTap) {
  try {
    const resp = await page.request.get(u, { timeout: 10000 });
    if (!resp.ok()) continue;
    const body = await resp.text();
    if (!body) continue;

    const raw = body;
    const decoded = decodeUnicodeEscapes(raw);
    const scan = raw + '\n' + decoded;

    // 設立日候補
    if (!foundFoundingDate) {
      const hit = tryExtractFounding(scan);
      if (hit) { foundFoundingDate = hit; continue; }
      // HTMLっぽいJSONならタグまたぎで再スキャン
      const hitHtml = tryExtractFoundingFromHtml(scan);
      if (hitHtml) { foundFoundingDate = hitHtml; continue; }
    }
  } catch {}
}

    // ---- JS/JSON 本文を取得して抽出 ----
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

// ページが教えてくれたJS候補 + 典型的なエントリ
const jsToTap = uniq([
  ...jsUrls,
  `${new URL(urlToFetch).origin}/app-index.js`
]);

for (const u of jsToTap) {
  try {
    const resp = await page.request.get(u, { timeout: 20_000 });
    if (!resp.ok()) continue;
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (!(ct.includes('javascript') || ct.includes('json') || u.endsWith('.js') || u.endsWith('.json'))) continue;

    const text = await resp.text();
    if (/\/app-index\.js(\?|$)/.test(u)) {
      tappedAppIndexBodies.push(text || '');
    }
    if (!text) continue;

    // ★ ここからスキャン
    const raw = text || '';
    const decoded = decodeUnicodeEscapes(raw);
    const scan = raw + '\n' + decoded;

    tappedUrls.push(u);
    tappedBodies.push({ url: u, ct, textLen: raw.length });
    fetchedMeta.push({ url: u, ct, textLen: raw.length });

    // ラベル近接での電話抽出
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

    // 電話
    (scan.match(PHONE_RE) || [])
      .map(normalizeJpPhone)
      .filter(Boolean)
      .forEach(v => bundlePhones.push(v));

    // 郵便番号
    (scan.match(ZIP_RE) || [])
      .filter(looksLikeZip7)
      .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

    // 住所っぽい行（軽め）
    for (const line of scan.split(/\n+/)) {
      if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
        bundleAddrs.push(line.replace(/\s+/g,' ').trim());
      }
    }

    // 設立日（1st pass）
    if (!foundFoundingDate) {
      const hit = tryExtractFounding(scan);
      if (hit) foundFoundingDate = hit;
    }

    // sameAs らしき URL（スクリプト内の直書き）
    const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
    for (const rawUrl of urlMatches) {
      try {
        const p = new URL(rawUrl);
        if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
      } catch(_) {}
    }
  } catch(_) {}
} // ←★★ この閉じカッコが抜けていました（for のおしまい）

// -------- 2nd pass: app-index.js が参照する chunk-*.js を最大 8 本だけ追撃 --------
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
    if (count++ >= 8) break; // 取りすぎ防止
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

      // ★ 追加：Unicodeデコードしてからスキャン
      const raw = text || '';
      const decoded = decodeUnicodeEscapes(raw);
      const scan = raw + '\n' + decoded;

      // 電話
      (scan.match(PHONE_RE) || [])
        .map(normalizeJpPhone)
        .filter(Boolean)
        .forEach(v => bundlePhones.push(v));

      // 郵便番号
      (scan.match(ZIP_RE) || [])
        .filter(looksLikeZip7)
        .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

      // 住所っぽい行
      for (const line of scan.split(/\n+/)) {
        if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
          bundleAddrs.push(line.replace(/\s+/g,' ').trim());
        }
      }

      // 設立日（2nd pass）
      if (!foundFoundingDate) {
        const hit = tryExtractFounding(scan);
        if (hit) foundFoundingDate = hit;
      }

      // sameAs
      const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const rawUrl of urlMatches) {
        try {
          const p = new URL(rawUrl);
          if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
        } catch(_) {}
      }
    } catch {}
  }
} catch {}
// -------- 2nd pass end --------

    // ---- 整理 & 採用値の決定 ----
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
        const addrLine = [p.postalCode, p.addressRegion, p.addressLocality, p.streetAddress]
          .filter(Boolean).join(' ');
        lines.push('ADDR: ' + addrLine);
      } else {
        if (zips.length)  lines.push('ZIP: ' + zips.slice(0,3).join(', '));
        if (addrs.length) lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
      }
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    // --- sameAs フィルタ＆重複排除（SNS系のみ残す） ---
    const ALLOW_HOST_SNS = /(facebook\.com|instagram\.com|note\.com|twitter\.com|x\.com|youtube\.com|linkedin\.com|tiktok\.com)/i;
    const sameAsClean = Array.from(new Set(
      (bundleSameAs || [])
        .map(u => String(u || '').trim())
        .filter(u => /^https?:\/\//i.test(u))
        .filter(u => ALLOW_HOST_SNS.test((() => { try { return new URL(u).hostname; } catch { return ''; } })()))
    ));

    // ---- 返却ペイロードを組み立て ----
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
        pickedAddressPreview: pickedAddress
          ? [pickedAddress.postalCode, pickedAddress.addressRegion, pickedAddress.addressLocality, pickedAddress.streetAddress]
              .filter(Boolean).join(' ')
          : null,
        labelHitPhones: Array.from(new Set(labelHitPhones)).slice(0,10),
        foundingDatePicked: foundFoundingDate || null,
        sameAsCount: new Set(sameAsClean).size,
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
