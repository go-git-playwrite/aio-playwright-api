// index.js
const express = require('express');
const { chromium } = require('playwright'); // Docker公式イメージに同梱
const app = express();

// ====== ビルド識別子（確認用） ======
const BUILD_TAG = 'scrape-v4-safe-01';
const PORT = process.env.PORT || 8080;

// ====== CORS（GAS等から叩く場合に便利） ======
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ====== ヘルスチェック ======
app.get('/', (_, res) => res.status(200).json({ ok: true }));

// ====== バージョン確認（必須：動作しているコードの世代を即確認できる） ======
app.get('/__version', (_, res) => {
  res.status(200).json({
    ok: true,
    build: BUILD_TAG,
    now: new Date().toISOString()
  });
});

// ====== ユーティリティ ======
function uniq(arr) { return Array.from(new Set((arr || []).filter(Boolean))); }

function normalizeJpPhone(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^\+81[-\s()]?/, '0');     // +81 → 0
  s = s.replace(/[^\d-]/g, '');            // 数字とハイフン以外除去
  const d = s.replace(/-/g, '');
  if (!/^0\d{8,10}$/.test(d)) return null; // 9〜11桁（先頭0）

  // ざっくり整形
  if (/^0[36]\d{8}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3'); // 03/06
  if (/^\d{11}$/.test(d))     return d.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3'); // 4-3-4
  if (/^\d{10}$/.test(d))     return d.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'); // 3-3-4
  return d.replace(/^(\d{2,4})(\d{2,4})(\d{4})$/, '$1-$2-$3'); // fallback
}

function looksLikeZip7(s){ return /^(〒?\d{3}-?\d{4})$/.test(String(s).trim()); }

function stripTags(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStringsDeep(obj, collector){
  const stack = [obj];
  while (stack.length){
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === 'string'){ collector(cur); continue; }
    if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
    if (typeof cur === 'object'){ for (const k of Object.keys(cur)) stack.push(cur[k]); }
  }
}

// ====== メイン：描画後HTML/テキスト＋Firestore由来の抽出を安全に返す ======
app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) {
    return res.status(400).json({ error: 'URL parameter "url" is required.' });
  }

  let browser = null;
  const t0 = Date.now();

  // ここに集約して catch 側でも返す
  let debugOut = {
    hydrated: false,
    noscriptHidden: false,
    appVisible: false,
    innerTextLen: 0,
    docTextLen: 0,
    shadowTextLen: 0,
    fullHtmlLen: 0,
    frames: [],
    firestoreTextLen: 0,
    firestorePhones: [],
    firestoreZips: [],
    firestoreAddrs: [],
    sampleJsonUrls: [],
    jsonldCount: 0,
    netLog: { requestsFailed: [], responses: [], console: [], pageErrors: [] },
  };

  try {
    // ===== Playwright 起動 =====
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                 'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                 'Chrome/122.0.0.0 Safari/537.36',
      // Service Worker の影響を回避（必要なら 'allow' に）
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // 速度と確実性のバランス：CSS/フォント/画像は通す（innerText 0 を避ける）
    // メディアだけ止めたい場合は下のコメントアウトを外す
    // await context.route('**/*', (route) => {
    //   const type = route.request().resourceType();
    //   if (type === 'media') return route.abort();
    //   route.continue();
    // });

    const page = await context.newPage();

    // ===== ネットワーク/コンソール/エラーを収集 =====
    page.on('requestfailed', req => {
      debugOut.netLog.requestsFailed.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || 'unknown'
      });
    });

    page.on('console', msg => {
      debugOut.netLog.console.push({ type: msg.type(), text: msg.text() });
    });

    page.on('pageerror', err => {
      debugOut.netLog.pageErrors.push({
        message: err.message,
        name: err.name,
        stack: (err.stack || '').slice(0, 5000)
      });
    });

    page.on('response', async (r) => {
      try {
        const url = r.url();
        const status = r.status();
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        let jsonSnippet = null;
        if (ct.includes('application/json')) {
          const txt = await r.text();
          if (txt && txt.length < 200_000) jsonSnippet = txt.slice(0, 10_000);
        }
        debugOut.netLog.responses.push({
          url, status, contentType: ct,
          jsonSnippetLen: jsonSnippet ? jsonSnippet.length : 0,
          jsonSnippet: jsonSnippet || null
        });
      } catch (_) {}
    });

    // ===== ナビゲーション（待機を分厚く） =====
    page.setDefaultNavigationTimeout(45_000);
    page.setDefaultTimeout(12_000);

    // まずは networkidle まで待つ（初回ロード）
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 45_000 });

    // noscript/p.warning が消える or 非表示になるまで（JS有効化後の目安）
    const noscriptSelector = 'noscript, p.warning';
    try {
      await page.waitForSelector(noscriptSelector, { state: 'hidden', timeout: 5_000 });
      debugOut.noscriptHidden = true;
    } catch(_) {
      try {
        debugOut.noscriptHidden = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true; // そもそも無いならOK
          const st = window.getComputedStyle(el);
          return (st.display === 'none' || st.visibility === 'hidden');
        }, noscriptSelector);
      } catch(_) { /* ignore */ }
    }

    // SPAコンテナが可視になるまで（なければ可視テキスト量）
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]';
    try {
      await page.waitForSelector(appSelector, { state: 'visible', timeout: 10_000 });
      debugOut.appVisible = true;
    } catch(_) {
      debugOut.appVisible = await page.evaluate(() => {
        const t = (document.body?.innerText || '').replace(/\s+/g, '');
        return t.length > 200;
      }).catch(()=>false);
    }

    // body が非表示でないことを担保
    await page.waitForFunction(() => {
      const b = document.body; if (!b) return false;
      const s = window.getComputedStyle(b);
      const hidden = (s.visibility === 'hidden') || (s.display === 'none') || (parseFloat(s.opacity || '1') === 0);
      return !hidden;
    }, { timeout: 6_000 }).catch(()=>{});

    // 可視テキスト一定量 or 代表要素
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText || '').replace(/\s+/g, '');
      const key = document.querySelector('main, #app, [id*="root"], [data-reactroot], [data-v-app], footer, address, a[href^="tel:"]');
      return (t.length > 200) || !!key;
    }, { timeout: 10_000 }).catch(()=>{});

    // ===== JSON-LD（Organization/Corporation）抽出 =====
    const jsonld = await page.evaluate(() => {
      const out = [];
      const nodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of nodes) {
        try {
          const j = JSON.parse(s.textContent.trim());
          const items = Array.isArray(j['@graph']) ? j['@graph'] : [j];
          for (const it of items) {
            const typ = it['@type'];
            const isOrg =
              typ === 'Organization' ||
              typ === 'Corporation' ||
              (Array.isArray(typ) && typ.some(t => t === 'Organization' || t === 'Corporation'));
            if (isOrg) {
              out.push({
                name: it.name ?? null,
                telephone: it.telephone ?? null,
                address: it.address ?? null,
                foundingDate: it.foundingDate ?? null,
                founder: it.founder ?? null,
                sameAs: it.sameAs ?? null,
                raw: it
              });
            }
          }
        } catch (_) {}
      }
      return out;
    });
    debugOut.jsonldCount = Array.isArray(jsonld) ? jsonld.length : 0;

    // ===== Shadow DOM テキスト（再帰） =====
    const shadowText = await page.evaluate(() => {
      function collectShadow(root, acc) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el && el.shadowRoot) {
            const t = el.shadowRoot.innerText;
            if (t && t.trim()) acc.push(t.trim());
            collectShadow(el.shadowRoot, acc);
          }
        }
      }
      const out = [];
      collectShadow(document, out);
      return out.join('\n');
    }).catch(()=>'');

    // ===== iframe（同一オリジンのみ） =====
    const framesInfo = await page.evaluate(() => {
      const arr = [];
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const doc = f.contentDocument;
          if (!doc) continue;
          const url = f.src || '';
          const txt = (doc.body?.innerText || '').trim();
          arr.push({
            url,
            textLen: txt.length,
            telLinksCount: doc.querySelectorAll('a[href^="tel:"]').length || 0
          });
        } catch (_) {
          // クロスオリジンはアクセス不可
        }
      }
      return arr;
    });
    debugOut.frames = framesInfo;

    // ===== 本文テキスト（可視/非可視の両系統） =====
    const [title, fullHtml] = await Promise.all([
      page.title().catch(()=> ''),
      page.content().catch(()=> '')
    ]);
    debugOut.fullHtmlLen = fullHtml.length;

    // 可視テキスト
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    debugOut.innerTextLen = innerText.length;
    debugOut.docTextLen   = docText.length;

    // 非可視も含む
    const [bodyAllText, docAllText] = await Promise.all([
      page.evaluate(() => document.body?.textContent || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.textContent || '').catch(()=> '')
    ]);

    const combinedVisible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();
    const combinedAll     = [bodyAllText, docAllText, shadowText].filter(Boolean).join('\n').trim();
    debugOut.shadowTextLen = shadowText.length;

    // innerHTML → テキスト化（最終フォールバック用）
    const bodyInnerHTML = await page.evaluate(() => document.body ? document.body.innerHTML : '').catch(()=> '');
    let finalText = (combinedVisible.replace(/\s+/g,'').length >= 40)
      ? combinedVisible
      : (combinedAll || stripTags(bodyInnerHTML));

    // ===== Firestore / JSON レスポンスから抽出（安全設計） =====
    const parsedPhones = [];
    const parsedZips   = [];
    const parsedAddrs  = [];
    const jsonUrls     = [];
    const jsonBodies   = [];

    // 1) ネットワークログから候補を拾う
    for (const r of debugOut.netLog.responses) {
      const u  = (r.url || '');
      const ct = (r.contentType || '').toLowerCase();
      const likelyJson = ct.includes('application/json') || u.toLowerCase().endsWith('.json') || u.includes('firestore');
      if (!likelyJson) continue;
      if (!r.jsonSnippet) continue;

      jsonUrls.push(u);
      const dump = r.jsonSnippet;

      // 粗抽出（正規表現）
      (dump.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g) || [])
        .map(normalizeJpPhone).filter(Boolean).forEach(v => parsedPhones.push(v));
      (dump.match(/〒?\d{3}-?\d{4}/g) || [])
        .filter(looksLikeZip7).forEach(v => parsedZips.push(v.replace(/^〒/, '')));

      // 構造的パース（投げっぱなしにせず try/catch で無害化）
      try {
        const j = JSON.parse(dump);
        const PHONE_KEYS = /^(tel|telephone|phone|phoneNumber|contactPhone)$/i;
        const ZIP_KEYS   = /^(zip|postal|postalCode|postcode|post_code)$/i;
        const ADDR_KEYS  = /^(address|addr|addressLine1|address1|address_line1|pref|prefecture|city|ward|street|streetAddress)$/i;

        (function walk(o){
          if (o == null) return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (typeof o === 'object'){
            for (const [k,v] of Object.entries(o)){
              if (PHONE_KEYS.test(k) && typeof v === 'string'){
                const n = normalizeJpPhone(v); if (n) parsedPhones.push(n);
              }
              if (ZIP_KEYS.test(k) && typeof v === 'string'){
                const z = v.trim(); if (looksLikeZip7(z)) parsedZips.push(z.replace(/^〒/,''));
              }
              if (ADDR_KEYS.test(k) && typeof v === 'string'){
                const s = v.trim(); if (s && s.length >= 6) parsedAddrs.push(s);
              }
              walk(v);
            }
          }
        })(j);

        // すべての文字列からも保険で抽出
        extractStringsDeep(j, (s) => {
          const p = normalizeJpPhone(s); if (p) parsedPhones.push(p);
          const mZip = s.match(/〒?\d{3}-?\d{4}/);
          if (mZip && looksLikeZip7(mZip[0])) parsedZips.push(mZip[0].replace(/^〒/,''));
          if (/[都道府県]|市|区|町|村|丁目/.test(s) && s.length >= 6) {
            parsedAddrs.push(s.replace(/\s+/g,' ').trim());
          }
        });

        jsonBodies.push(dump);
      } catch(_) {
        // JSONとしては壊れていても粗抽出は済んでいるので無視
      }
    }

    const fsPhones = uniq(parsedPhones);
    const fsZips   = uniq(parsedZips);
    const fsAddrs  = uniq(parsedAddrs);
    debugOut.firestorePhones = fsPhones;
    debugOut.firestoreZips   = fsZips;
    debugOut.firestoreAddrs  = fsAddrs;
    debugOut.sampleJsonUrls  = jsonUrls.slice(0, 10);
    debugOut.firestoreTextLen = jsonBodies.join('\n\n').length;

    // DOMテキストが薄い場合は JSON由来の情報で少し補う（検証の足がかり）
    if ((finalText || '').length < 60) {
      const lines = [finalText || ''];
      if (fsPhones.length) lines.push('TEL: ' + fsPhones.slice(0,3).join(', '));
      if (fsZips.length)   lines.push('ZIP: ' + fsZips.slice(0,3).join(', '));
      if (fsAddrs.length)  lines.push('ADDR: ' + fsAddrs.slice(0,2).join(' / '));
      finalText = lines.filter(Boolean).join('\n');
    }

    // 可視テキスト量で「水和したか」をざっくり判定
    debugOut.hydrated = (combinedVisible.replace(/\s+/g,'').length > 200) || debugOut.appVisible;

    // ===== レスポンス返却 =====
    const elapsedMs = Date.now() - t0;
    return res.status(200).json({
      ok: true,
      build: BUILD_TAG,
      url: urlToFetch,
      title,
      fullHtml,
      bodyText: finalText,    // ← combinedVisible ではなく finalText（フォールバック済み）
      jsonld,
      debug: { ...debugOut, elapsedMs }
    });

  } catch (err) {
    // 途中で失敗しても、ここまでに集めた debugOut は返す
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      ok: false,
      build: BUILD_TAG,
      error: 'An error occurred during scraping.',
      details: err?.message || String(err),
      debug: { ...debugOut, elapsedMs }
    });
  } finally {
    if (browser) { try { await browser.close(); } catch(_){} }
  }
});

// ====== 起動 ======
app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT} (${BUILD_TAG})`);
});

// ====== 落ちた時の保険ログ ======
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
