// index.js
const express = require('express');
const { chromium } = require('playwright'); // Docker: mcr.microsoft.com/playwright:* に同梱

const app = express();
const PORT = process.env.PORT || 8080;

app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (_, res) => res.status(200).json({ ok: true }));

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) {
    return res.status(400).json({ error: 'URL parameter "url" is required.' });
  }

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    const page = await context.newPage();
    const netLog = { requestsFailed: [], responses: [], console: [], pageErrors: [] };

    page.on('requestfailed', req => {
      netLog.requestsFailed.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure() ? req.failure().errorText : 'unknown'
      });
    });

    page.on('console', msg => {
      netLog.console.push({ type: msg.type(), text: msg.text() });
    });

    page.on('pageerror', err => {
      netLog.pageErrors.push({
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
          if (txt && txt.length < 200_000) jsonSnippet = txt.slice(0, 5000);
        }
        netLog.responses.push({
          url, status, contentType: ct,
          jsonSnippetLen: jsonSnippet ? jsonSnippet.length : 0,
          jsonSnippet: jsonSnippet || null
        });
      } catch (_) {}
    });

    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    const noscriptSelector = 'noscript, p.warning';
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]';
    let noscriptHidden = false;
    let appVisible = false;

    try {
      await page.waitForSelector(noscriptSelector, { state: 'hidden', timeout: 5000 });
      noscriptHidden = true;
    } catch (_) {
      try {
        noscriptHidden = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true;
          const style = window.getComputedStyle(el);
          return (style.display === 'none' || style.visibility === 'hidden');
        }, noscriptSelector);
      } catch (_) {}
    }

    try {
      await page.waitForSelector(appSelector, { state: 'visible', timeout: 8000 });
      appVisible = true;
    } catch (_) {
      appVisible = await page.evaluate(() => {
        const t = (document.body?.innerText || '').replace(/\s+/g, '');
        return t.length > 200;
      });
    }

    await page.waitForFunction(() => {
      const b = document.body;
      if (!b) return false;
      const s = window.getComputedStyle(b);
      const hidden = (s.visibility === 'hidden') || (s.display === 'none') || (parseFloat(s.opacity || '1') === 0);
      return !hidden;
    }, { timeout: 5000 }).catch(() => {});

    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText || '').replace(/\s+/g, '');
      const key = document.querySelector('main, #app, [id*="root"], [data-reactroot], [data-v-app], footer, address, a[href^="tel:"]');
      return (t.length > 200) || !!key;
    }, { timeout: 8000 }).catch(() => {});

    // ★ カスタム要素アップグレード待ち
    const customElementsSeen = await page.evaluate(async () => {
      const tags = Array.from(document.querySelectorAll('*'))
        .map(el => el.tagName.toLowerCase())
        .filter(t => t.includes('-'));
      const unique = Array.from(new Set(tags)).slice(0, 20);
      await Promise.all(unique.map(n => {
        try { return customElements.whenDefined(n); } catch { return Promise.resolve(); }
      }));
      return unique.length;
    });

    // ★ Shadow DOM テキスト量が一定以上になるまで待つ
    await page.waitForFunction(() => {
      function grabShadowText() {
        const acc = [];
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el && el.shadowRoot) {
            const t = el.shadowRoot.innerText;
            if (t && t.trim()) acc.push(t.trim());
          }
        }
        return acc.join('\n');
      }
      const visible = (document.body?.innerText || '').replace(/\s+/g, '');
      const shadow  = grabShadowText().replace(/\s+/g, '');
      return (visible.length + shadow.length) > 200;
    }, { timeout: 5000 }).catch(() => {});

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
              out.push({ name: it.name ?? null, telephone: it.telephone ?? null, address: it.address ?? null, foundingDate: it.foundingDate ?? null, founder: it.founder ?? null, sameAs: it.sameAs ?? null, raw: it });
            }
          }
        } catch (_) {}
      }
      return out;
    });

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
        } catch (_) {}
      }
      return arr;
    });

    const [title, fullHtml] = await Promise.all([page.title(), page.content()]);

    const innerText = await page.evaluate(() => document.body?.innerText || '');
    const docText   = await page.evaluate(() => document.documentElement?.innerText || '');
    const bodyAll   = await page.evaluate(() => document.body?.textContent || '');
    const docAll    = await page.evaluate(() => document.documentElement?.textContent || '');

    const combinedVisible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();
    const combinedAll     = [bodyAll, docAll, shadowText].filter(Boolean).join('\n').trim();
    let combinedText    = combinedVisible.replace(/\s+/g, '').length >= 40 ? combinedVisible : combinedAll;

    // HTMLフォールバック
    const bodyHTML = await page.evaluate(() => document.body ? document.body.innerHTML : '');
    function stripTags(html) {
      if (!html) return '';
      return html.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    let finalText = (combinedText && combinedText.trim().length > 0)
      ? combinedText
      : stripTags(bodyHTML);

    // ★ Firestore JSONレスポンス保険
    function textFromJsonSnippet(snippet) {
      try {
        const j = JSON.parse(snippet);
        const s = JSON.stringify(j);
        const m = s.match(/[\p{L}\p{N}\p{P}\p{Zs}]{10,}/gu);
        return m ? m.join(' ') : '';
      } catch { return ''; }
    }
    let firestoreText = '';
    try {
      const jsons = (netLog.responses || [])
        .filter(r => r.contentType?.includes('application/json') && r.jsonSnippet)
        .filter(r => /firestore|firebaseio|googleapis/i.test(r.url))
        .map(r => textFromJsonSnippet(r.jsonSnippet))
        .filter(Boolean);
      firestoreText = jsons.join(' ').slice(0, 20000);
    } catch {}
    if (!finalText || finalText.replace(/\s+/g,'').length < 120) {
      const merged = [finalText || '', firestoreText].join('\n').trim();
      if (merged.replace(/\s+/g,'').length >= 120) {
        finalText = merged;
      }
    }

    const hydrated = combinedVisible.replace(/\s+/g, '').length > 200;
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
      fullHtml,
      bodyText: finalText,
      jsonld,
      debug: {
        hydrated,
        noscriptHidden,
        appVisible,
        bodyAllLen: bodyHTML.length,
        firestoreTextLen: firestoreText.length,
        customElementsSeen,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen: fullHtml.length,
        frames: framesInfo,
        telLinks,
        extractedPhones: extractedPhones || [],
        extractedAddrs,
        jsonldCount: Array.isArray(jsonld) ? jsonld.length : 0,
        elapsedMs,
        netLog
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
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});
