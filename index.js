// index.js
const express = require('express');
const { chromium } = require('playwright'); // Docker公式イメージに同梱

const app = express();
const PORT = process.env.PORT || 8080;

// CORS（GAS 等から叩くなら付けておくと便利）
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ヘルスチェック
app.get('/', (_, res) => res.status(200).json({ ok: true }));

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) {
    return res.status(400).json({ error: 'URL parameter "url" is required.' });
  }

  let browser = null;
  const t0 = Date.now();

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
      serviceWorkers: 'block',                // SWの影響を避ける
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // 速度優先でメディアだけブロック（CSSは通す）
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'media') return route.abort(); // 画像/フォントは通す
      route.continue();
    });

    const page = await context.newPage();

    // ===== ネットワーク/コンソール/エラーを収集 =====
    const netLog = { requestsFailed: [], responses: [], console: [], pageErrors: [] };

    page.on('requestfailed', req => {
      netLog.requestsFailed.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || 'unknown'
      });
    });
    page.on('console', msg => { netLog.console.push({ type: msg.type(), text: msg.text() }); });
    page.on('pageerror', err => {
      netLog.pageErrors.push({
        message: err.message, name: err.name,
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
        netLog.responses.push({
          url, status, contentType: ct,
          jsonSnippetLen: jsonSnippet ? jsonSnippet.length : 0,
          jsonSnippet: jsonSnippet || null
        });
      } catch (_) {}
    });

    // ===== ナビゲーション（待機を分厚く） =====
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(8_000);

    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(()=>{});
    await page.waitForLoadState('networkidle', { timeout: 7_000 }).catch(()=>{});
    await page.waitForTimeout(800).catch(()=>{});

    // noscript/p.warning が消える or 非表示になるまで
    const noscriptSelector = 'noscript, p.warning';
    let noscriptHidden = false;
    try {
      await page.waitForSelector(noscriptSelector, { state: 'hidden', timeout: 3000 });
      noscriptHidden = true;
    } catch(_) {
      try {
        noscriptHidden = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true; // そもそも無ければOK
          const st = window.getComputedStyle(el);
          return (st.display === 'none' || st.visibility === 'hidden');
        }, noscriptSelector);
      } catch(_) {}
    }

    // SPAコンテナが可視になるまで（なければテキスト量で判定）
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]';
    let appVisible = false;
    try {
      await page.waitForSelector(appSelector, { state: 'visible', timeout: 5000 });
      appVisible = true;
    } catch(_) {
      appVisible = await page.evaluate(() => {
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
    }, { timeout: 5000 }).catch(()=>{});

    // 可視テキスト一定量 or 代表要素
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText || '').replace(/\s+/g, '');
      const key = document.querySelector('main, #app, [id*="root"], [data-reactroot], [data-v-app], footer, address, a[href^="tel:"]');
      return (t.length > 200) || !!key;
    }, { timeout: 8000 }).catch(()=>{});

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

    // ===== 本文テキスト（可視/非可視の両系統） =====
    const [title, fullHtml] = await Promise.all([
      page.title().catch(()=> ''),
      page.content().catch(()=> '')
    ]);

    // 可視テキスト
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);

    // 非可視も含む（テキストノード）
    const [bodyAllText, docAllText] = await Promise.all([
      page.evaluate(() => document.body?.textContent || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.textContent || '').catch(()=> '')
    ]);

    const combinedVisible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();
    const combinedAll     = [bodyAllText, docAllText, shadowText].filter(Boolean).join('\n').trim();

    function stripTags(html) {
      if (!html) return '';
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // innerHTML → テキスト化（最終フォールバック用）
    const bodyInnerHTML = await page.evaluate(() => document.body ? document.body.innerHTML : '').catch(()=> '');
    // 表示テキストを優先、薄ければ HTML→テキスト化
    let finalText = (combinedVisible.replace(/\s+/g,'').length >= 40)
      ? combinedVisible
      : (combinedAll || stripTags(bodyInnerHTML));

    // ===== Firestore / JSON レスポンスから抽出（構造的パース＋粗抽出） =====
    function uniq(a){ return Array.from(new Set(a.filter(Boolean))); }
    function normalizeJpPhone(raw){
      if (!raw) return null;
      let s = String(raw).trim();
      s = s.replace(/^\+81[-\s()]?/, '0');   // +81 → 0
      s = s.replace(/[^\d-]/g, '');          // 数字とハイフン以外除去
      const d = s.replace(/-/g,'');
      if (!/^0\d{8,10}$/.test(d)) return null;

      if (/^0[36]\d{8}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3'); // 03/06
      if (/^\d{11}$/.test(d))     return d.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3'); // 4-3-4
      if (/^\d{10}$/.test(d))     return d.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'); // 3-3-4
      return d.replace(/^(\d{2,4})(\d{2,4})(\d{4})$/, '$1-$2-$3'); // fallback
    }
    function looksLikeZip7(s){ return /^(〒?\d{3}-?\d{4})$/.test(String(s).trim()); }
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

    const parsedPhones = [];
    const parsedZips   = [];
    const parsedAddrs  = [];
    const jsonUrls     = [];
    const jsonBodies   = [];

    for (const r of netLog.responses) {
      const u  = (r.url || '');
      const ct = (r.contentType || '').toLowerCase();
      const isJson = ct.includes('application/json') || u.toLowerCase().endsWith('.json') || u.includes('firestore');
      if (!isJson) continue;
      if (!r.jsonSnippet) continue;

      jsonUrls.push(u);
      const dump = r.jsonSnippet;

      // 粗抽出（正規表現）
      (dump.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g) || [])
        .map(normalizeJpPhone).filter(Boolean).forEach(v => parsedPhones.push(v));
      (dump.match(/〒?\d{3}-?\d{4}/g) || [])
        .filter(looksLikeZip7).forEach(v => parsedZips.push(v.replace(/^〒/, '')));

      // 構造的パース（フィールド名から推測）
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
      } catch(_) {}
    }

    const fsPhones = uniq(parsedPhones);
    const fsZips   = uniq(parsedZips);
    const fsAddrs  = uniq(parsedAddrs);
    const firestoreTextLen = jsonBodies.join('\n\n').length;

    // DOMテキストが薄い場合は JSON由来の情報で少し補う（検証の足がかり）
    if (finalText.length < 60) {
      const lines = [finalText];
      if (fsPhones.length) lines.push('TEL: ' + fsPhones.slice(0,3).join(', '));
      if (fsZips.length)   lines.push('ZIP: ' + fsZips.slice(0,3).join(', '));
      if (fsAddrs.length)  lines.push('ADDR: ' + fsAddrs.slice(0,2).join(' / '));
      finalText = lines.filter(Boolean).join('\n');
    }

    // 可視テキスト量で「水和したか」をざっくり判定
    const hydrated = (combinedVisible.replace(/\s+/g,'').length > 200);

    // ===== レスポンス返却 =====
    const elapsedMs = Date.now() - t0;
    res.status(200).json({
      url: urlToFetch,
      title,
      fullHtml,
      bodyText: finalText,               // ← combinedText ではなく finalText
      jsonld,
      debug: {
        hydrated,
        noscriptHidden,
        appVisible,

        // テキストの量
        innerTextLen: innerText.length,
        docTextLen:   docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen:  fullHtml.length,

        // iframe情報
        frames: framesInfo,

        // JSON/Firestore 由来の抽出結果
        firestoreTextLen,
        firestorePhones: fsPhones,
        firestoreZips:   fsZips,
        firestoreAddrs:  fsAddrs,
        sampleJsonUrls:  jsonUrls.slice(0, 10),

        // JSON-LD 件数
        jsonldCount: Array.isArray(jsonld) ? jsonld.length : 0,

        // ネットワークログと処理時間
        netLog,
        elapsedMs
      }
    });

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      error: 'An error occurred during scraping.',
      details: err?.message || String(err),
      elapsedMs
    });
  } finally {
    if (browser) { try { await browser.close(); } catch(_){} }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});
