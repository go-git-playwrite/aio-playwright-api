// index.js — Render/Docker 向け Playwright スクレイパ API 完全版
// ベース: mcr.microsoft.com/playwright:v1.54.2-jammy & "playwright" パッケージ

const express = require('express');
const { chromium } = require('playwright'); // ← "playwright" を使う（"playwright-chromium" ではない）

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// CORS（必要なら）
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.get('/scrape', async (req, res) => {
  const urlToFetch = sanitizeUrl(req.query.url);
  if (!urlToFetch) {
    return res.status(400).json({ error: 'URL parameter "url" is required (http/https only).' });
  }

  const t0 = Date.now();
  let browser = null;

  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);

    // 1) ページ遷移 & 初期待機
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});

    // 2) サイト固有も意識した描画完了待ち（本文量 or 代表要素 or 電話パターン）
    await page.waitForFunction(() => {
      const q = (sel) => document.querySelector(sel);
      const txt = (document.body?.innerText || '').trim();
      const txtLenOK = txt.length > 80;

      const keyEl =
        q('address') ||
        q('a[href^="tel:"]') ||
        q('footer') ||
        q('main h1, main h2') ||
        q('[data-section="company"], [data-section="about"], .company, .about');

      const hasPhone = /\b0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}\b/.test(txt);

      return txtLenOK || keyEl || hasPhone;
    }, { timeout: 12000 }).catch(() => {});

    // 3) 軽くスクロール（遅延表示ケア）
    await autoScroll(page);

    // 4) 本文・HTML 取得（メインフレーム）
    const [title, fullHtml] = await Promise.all([page.title(), page.content()]);
    const innerText = await page.evaluate(() => document.body?.innerText || '');
    const docText   = await page.evaluate(() => document.documentElement?.innerText || '');
    const shadowText = await page.evaluate(() => {
      const out = [];
      try {
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el && el.shadowRoot && el.shadowRoot.innerText) {
            out.push(el.shadowRoot.innerText.trim());
          }
        }
      } catch(_) {}
      return out.join('\n');
    });

    // 5) iframe/子フレームのテキスト & tel 抽出
    const framesDebug = [];
    const telLinksSet = new Set();
    const phonesSet   = new Set();

    // メインフレームの <a href="tel:">
    try {
      const telLinks = await page.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href')));
      telLinks.forEach((t) => telLinksSet.add(t));
    } catch(_) {}

    for (const fr of page.frames()) {
      try {
        const ftxt = await fr.evaluate(() => (document.body?.innerText || ''));
        const fLen = (ftxt || '').length;
        const ftels = await fr.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href')));
        (ftels || []).forEach(t => telLinksSet.add(t));

        framesDebug.push({
          url: safe(() => fr.url()) || '',
          textLen: fLen,
          telLinksCount: ftels ? ftels.length : 0,
        });
      } catch(_) {}
    }

    // 6) JSON-LD 取り込み（メイン＋各フレーム）
    const ld = await collectJsonLd(page);
    for (const fr of page.frames()) {
      try {
        const ldf = await collectJsonLd(fr);
        ld.push(...ldf);
      } catch(_) {}
    }

    // 7) 本文統合
    const combinedText = [innerText, docText, shadowText]
      .concat(framesDebug.map(() => '')) // フレーム本文は個別に使う場合のみ、ここでは未結合
      .filter(Boolean)
      .join('\n')
      .trim();

    // 8) 電話・住所の素朴抽出（本文＋HTML＋JSON-LD 両輪）
    const srcs = [combinedText, fullHtml, JSON.stringify(ld)];
    const extractedPhones = new Set();
    const extractedAddrs  = new Set();

    for (const s of srcs) {
      for (const p of extractPhonesFromText(s)) extractedPhones.add(p);
      for (const a of extractAddrsFromText(s))  extractedAddrs.add(a);
    }

    // <a href="tel:"> の値も加える
    for (const t of telLinksSet) {
      const norm = normalizeTel(t);
      if (norm) extractedPhones.add(norm);
    }

    const elapsedMs = Date.now() - t0;

    res.status(200).json({
      url: urlToFetch,
      title,
      fullHtml,                 // 必要に応じて短縮してもOK（.slice(0, 500000)等）
      bodyText: combinedText,   // ここを GAS 側で使う
      debug: {
        hydrated: combinedText.length > 80,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen: fullHtml.length,
        frames: framesDebug,
        telLinks: Array.from(telLinksSet),
        rawPhones: Array.from(phonesSet),
        extractedPhones: Array.from(extractedPhones).slice(0, 50),
        extractedAddrs: Array.from(extractedAddrs).slice(0, 50),
        jsonldCount: ld.length,
        elapsedMs
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred during scraping.', details: String(error && error.message || error) });
  } finally {
    if (browser) {
      try { await browser.close(); } catch(_){}
    }
  }
});

// ---------- helpers ----------
function sanitizeUrl(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const distance = 600;
        const timer = setInterval(() => {
          const { scrollHeight, scrollTop, clientHeight } = document.scrollingElement || document.documentElement;
          window.scrollBy(0, distance);
          total += distance;
          if (scrollTop + clientHeight >= scrollHeight - 2 || total > 6000) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
  } catch(_) {}
}

async function collectJsonLd(pageOrFrame) {
  try {
    const raw = await pageOrFrame.$$eval('script[type="application/ld+json"]', ns => ns.map(n => n.textContent || ''));
    const out = [];
    for (const t of raw) {
      try {
        const o = JSON.parse(t);
        if (Array.isArray(o)) out.push(...o); else out.push(o);
      } catch(_) {}
    }
    return out;
  } catch {
    return [];
  }
}

function extractPhonesFromText(s) {
  if (!s) return [];
  const phones = s.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g) || [];
  return Array.from(new Set(phones.map(normalizeTel).filter(Boolean)));
}

function normalizeTel(raw) {
  if (!raw) return '';
  const t = String(raw).replace(/^tel:/i, '').replace(/[^\d+]/g, '');
  if (!t) return '';
  // +81 → 0 置換（国内表記へ）
  const m = t.match(/^\+81(\d{1,10})$/);
  const local = m ? '0' + m[1] : t;
  // 3-4-4 などに軽整形（厳密ではない）
  return local.replace(/(\d{2,4})(\d{1,4})(\d{3,4})$/, '$1-$2-$3');
}

function extractAddrsFromText(s) {
  if (!s) return [];
  // 郵便番号と都道府県名ベースの素朴抽出
  const rxZip  = /(?:〒?\s*)?\b\d{3}-?\d{4}\b/;
  const rxPref = /(東京都|北海道|(?:京都|大阪)府|..県)/;
  const lines  = s.split(/\n+/).map(x => x.trim()).filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (rxPref.test(line) || rxZip.test(line)) {
      // 行が短すぎる/長すぎるのは捨てる
      if (line.length >= 6 && line.length <= 120) {
        out.push(line.replace(/\s+/g, ' '));
      }
    }
  }
  return Array.from(new Set(out));
}

function safe(fn, fallback = '') {
  try { return fn(); } catch { return fallback; }
}

// ---------- server ----------
app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});

// 予期しない例外ログ
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));