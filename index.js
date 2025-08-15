// index.js
const express = require('express');
const { chromium } = require('playwright'); // Docker: mcr.microsoft.com/playwright:* に同梱

const app = express();
const PORT = process.env.PORT || 8080;

// CORS（GAS などから叩く想定なら付けておくとラク）
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
    // Playwright 起動
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const context = await browser.newContext({
      // レンダリング差分が出にくい UA を固定
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      // SW によるオフライン/キャッシュの影響を回避
      serviceWorkers: 'block',
      // 画面幅固定（レスポンシブ分岐を抑える）
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
    });

    // 画像/フォント/メディア/スタイルはスキップして高速化（必要に応じて外してOK）
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    const page = await context.newPage();

    // ナビゲーション（SPA 対策でしっかり待つ）
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500); // ちょい追い

    // “可視テキスト量” or “代表要素”の出現を待機（最大 8 秒）
    await page.waitForFunction(() => {
      const txtLen = (document.body?.innerText || '').replace(/\s+/g, '').length;
      const hasKey = !!document.querySelector('main, #app, [id*="root"], footer, address, a[href^="tel:"]');
      return txtLen > 80 || hasKey;
    }, { timeout: 8000 }).catch(() => {});

    // JSON-LD（Organization/Corporation を抽出）
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

    // Shadow DOM のテキスト再帰抽出
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
    });

    // iframe（同一オリジンのみ）情報
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
          // クロスオリジンでアクセス不可のものはスキップ
        }
      }
      return arr;
    });

    // 本文テキスト（複数パス）
    const [title, fullHtml] = await Promise.all([page.title(), page.content()]);
    const innerText = await page.evaluate(() => document.body?.innerText || '');
    const docText   = await page.evaluate(() => document.documentElement?.innerText || '');
    const combinedText = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();

    // 電話・住所・telリンク抽出
    const telLinks = await page.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href')));
    const extractedPhones = await page.evaluate(() => {
      const text = (document.body?.innerText || '');
      const m = text.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g);
      return m ? Array.from(new Set(m)) : [];
    });
    const extractedAddrs = await page.evaluate(() => {
      const text = (document.body?.innerText || '');
      const zips = text.match(/〒?\d{3}-?\d{4}/g) || [];
      const pref = /(北海道|東京都|京都府|大阪府|..県)/.exec(text)?.[1] || '';
      return { zips: Array.from(new Set(zips)), hasPref: !!pref };
    });

    const elapsedMs = Date.now() - t0;

    res.status(200).json({
      url: urlToFetch,
      title,
      fullHtml,              // JS 実行後の HTML 全文
      bodyText: combinedText, // 画面表示テキスト（innerText/docText/Shadow 結合）
      jsonld,                // 組織系 JSON-LD の抽出結果
      debug: {
        hydrated: combinedText.length > 0,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen: fullHtml.length,
        frames: framesInfo,
        telLinks,
        rawPhones: extractedPhones,
        extractedPhones,
        extractedAddrs,
        jsonldCount: jsonld.length,
        elapsedMs
      }
    });
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    res.status(500).json({
      error: 'An error occurred during scraping.',
      details: err?.message || String(err),
      elapsedMs
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});