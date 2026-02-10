// index.js — scrape-v5-bundle+cache (phones/addresses + sameAs, foundingDate=STRICT DOM/HTML)
// 目的: DOMが空でも JS/JSON から電話・住所・sameAs を抽出。
//       設立日は「誤検出防止のため」DOM/HTML構造からのみ抽出（非必須）。

// === scoring config (ADD) ===
const { GoogleGenerativeAI } = require('@google/generative-ai');
const WEIGHTS5 = {
  dataStructure: 35,       // データ構造
  expressionClarity: 20,   // 表現の明確さ
  coverage: 20,            // 情報網羅性
  documentStructure: 15,   // 文書構造
  trust: 10                // 信頼性
};
const USE_REAL_SCORE = process.env.USE_REAL_SCORE !== 'false';

function clamp100(n){ const x = Number(n); return Math.max(0, Math.min(100, isFinite(x)?Math.round(x):0)); }
function weightedOverall5(ax){
  const sum = (WEIGHTS5.dataStructure    * clamp100(ax.dataStructure))
            + (WEIGHTS5.expressionClarity* clamp100(ax.expressionClarity))
            + (WEIGHTS5.coverage         * clamp100(ax.coverage))
            + (WEIGHTS5.documentStructure* clamp100(ax.documentStructure))
            + (WEIGHTS5.trust            * clamp100(ax.trust));
  return Math.round(sum / 100);
}

// === scorer (FIX v2: structured prompt + rationales + confidence) ===
async function scoreWithGemini5axes({ url, scrape }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

  // 安全ガード
  const ix = Number(scrape.innerTextLen || 0);
  const jc = Array.isArray(scrape.jsonld) ? scrape.jsonld.length : 0;
  const sig = scrape.signals || {};
  const s = {
    h1: sig.h1 || 0,
    h2: sig.h2 || 0,
    lists: sig.lists || 0,
    tables: sig.tables || 0,
    links: sig.links || 0,
    hasTel: !!sig.hasTel,
    hasAddress: !!sig.hasAddress,
    jsonldTypes: Array.isArray(sig.jsonldTypes) ? sig.jsonldTypes : []
  };

  // モデルへの厳密プロンプト
  const prompt = `
You are an auditor scoring a website's AI-readiness across 5 axes. 
Use ONLY the provided numeric/boolean signals; do not invent missing data.
Return STRICT JSON matching this schema:

{
 "axes5": {
   "dataStructure": 0-100,
   "expressionClarity": 0-100,
   "coverage": 0-100,
   "documentStructure": 0-100,
   "trust": 0-100
 },
 "rationales": {
   "dataStructure": [ "<<=50 chars each" ],
   "expressionClarity": [ "<=50" ],
   "coverage": [ "<=50" ],
   "documentStructure": [ "<=50" ],
   "trust": [ "<=50" ]
 }
}

Scoring policy (Japanese site):
- dataStructure (35): JSON-LD presence/types, machine-identifiable facts (tel/address).
- expressionClarity (20): clear nouns, concise content (use innerTextLen proxy and lists).
- coverage (20): breadth/depth proxies (innerTextLen, links).
- documentStructure (15): h1/h2 counts, lists, tables.
- trust (10): tel/address presence, policy/contact hints.

Signals:
- hydrated: ${scrape.hydrated}
- innerTextLen: ${ix}
- jsonldCount: ${jc}
- jsonldTypes: ${JSON.stringify(s.jsonldTypes)}
- h1: ${s.h1}, h2: ${s.h2}, lists: ${s.lists}, tables: ${s.tables}, links: ${s.links}
- hasTel: ${s.hasTel}, hasAddress: ${s.hasAddress}

Rules:
- Output integers 0–100 only.
- Provide at most 2 rationale bullets per axis, each <= 50 chars.
- No prose outside JSON.
`.trim();

  let axes5;
  let rationales = {
    dataStructure: [], expressionClarity: [], coverage: [], documentStructure: [], trust: []
  };

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    axes5 = parsed.axes5;
    rationales = parsed.rationales || rationales;
  } catch (_) {
    // フォールバック：信号に基づく簡易ルール
    const ds = (jc > 0 || s.hasTel || s.hasAddress) ? 70 : 40;
    const dc = Math.min(90, 30 + s.h1*10 + s.h2*5 + s.lists*5 + s.tables*5);
    const ec = Math.min(90, 40 + Math.floor(ix/100) + s.lists*3);
    const cov = Math.min(90, 40 + Math.floor(ix/80) + Math.floor(s.links/10));
    const tr  = (s.hasTel || s.hasAddress) ? 75 : 50;
    axes5 = {
      dataStructure: clamp100(ds),
      expressionClarity: clamp100(ec),
      coverage: clamp100(cov),
      documentStructure: clamp100(dc),
      trust: clamp100(tr)
    };
    rationales = {
      dataStructure: jc>0 ? ["JSON-LDあり"] : ["JSON-LD無し","本文に電話/住所="+(s.hasTel||s.hasAddress)],
      expressionClarity: [ "本文長:"+ix, "箇条書き:"+s.lists ],
      coverage: [ "本文長:"+ix, "リンク数:"+s.links ],
      documentStructure: [ "h1:"+s.h1+" h2:"+s.h2, "リスト/表:"+s.lists+"/"+s.tables ],
      trust: [ "電話:"+s.hasTel, "住所:"+s.hasAddress ]
    };
  }

  // overall（重み 35/20/20/15/10）
  const overall = weightedOverall5(axes5);

  // 簡易 confidence（0-1）：材料が多い & JSON-LD あり & hydrated で上がる
  const confBase = Math.max(0, Math.min(1, (ix/1500)));
  const confBoost = (scrape.hydrated ? 0.1 : 0) + (jc>0 ? 0.15 : 0);
  const confidence = Math.max(0.3, Math.min(0.98, confBase + confBoost));

  return {
    overall,
    axes5: {
      dataStructure: clamp100(axes5.dataStructure),
      expressionClarity: clamp100(axes5.expressionClarity),
      coverage: clamp100(axes5.coverage),
      documentStructure: clamp100(axes5.documentStructure),
      trust: clamp100(axes5.trust)
    },
    weights5: WEIGHTS5,
    rationales,
    evidence: {
      innerTextLen: ix, jsonldCount: jc, jsonldTypes: s.jsonldTypes,
      h1: s.h1, h2: s.h2, lists: s.lists, tables: s.tables, links: s.links,
      hasTel: s.hasTel, hasAddress: s.hasAddress
    },
    confidence,
    source: 'GEMINI_VIA_SCRAPE'
  };
}

const express = require('express');
const { chromium } = require('playwright');
const PQueue = require('p-queue').default;

const BUILD_TAG = 'scrape-v5-bundle-cache-07-scoring-fallback';
const app = express();
const PORT = process.env.PORT || 8080;

// === helper: lazyload対応の自動スクロール ===
async function autoScroll(page, { step = 1000, pauseMs = 250, maxScrolls = 6 } = {}) {
  let total = 0;
  for (let i = 0; i < maxScrolls; i++) {
    total = await page.evaluate((s) => {
      window.scrollBy(0, s);
      return window.scrollY || document.documentElement.scrollTop || 0;
    }, step);
    await page.waitForTimeout(pauseMs);
  }
  // 先頭に戻す（見出し抽出が安定）
  await page.evaluate(() => window.scrollTo(0, 0));
}

// === ADD: JSON-LD 待機＋コピーライト抽出（収集ペイロード） ==================
// 目的：SPA でも「一瞬でも出た main/header/footer/nav/h1」をラッチして取りこぼさない。
// 戻り値は probe 側(snake_case)で統一：buildAuditSigFromPage 側で header_present→headerPresent に合流する想定。
async function probeJsonLdAndCopyright(page, { maxWaitMs = 15000, pollMs = 200 } = {}) {
  const t0 = Date.now();

  // Playwright のロード状態は「補助」。これだけでは SPA の DOM 出現を保証できない。
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  console.log('[DBG][DOM-TOPOLOGY][ENTER]', { url: await page.url(), t: Date.now() });
  try { console.log('[DBG][DOM-TOPOLOGY][FRAMECOUNT]', page.frames().length); } catch(_){}

  // === [DBG][DOM-TOPOLOGY v1] 1回で「観測対象ズレ」を潰す ===
  try {
    const topo = await page.evaluate(() => {
      const out = {};

      // ---- 基本カウント（現ドキュメント）----
      out.url = location.href;
      out.readyState = document.readyState;
      out.title = document.title || '';
      out.bodyChildCount = document.body ? document.body.childElementCount : -1;

      out.counts = {
        header: document.querySelectorAll('header,[role="banner"]').length,
        footer: document.querySelectorAll('footer,[role="contentinfo"]').length,
        main:   document.querySelectorAll('main,[role="main"]').length,
        nav:    document.querySelectorAll('nav,[role="navigation"]').length,
        h1:     document.querySelectorAll('h1').length,
        ldjson:  document.querySelectorAll('script[type*="ld+json" i]').length,
        module:  document.querySelectorAll('script[type="module"][src]').length,
        iframe:  document.querySelectorAll('iframe').length
      };

      // ---- 画面に実体があるか（超ざっくり）----
      out.metrics = {
        innerTextLen: (document.documentElement?.innerText || '').length,
        bodyTextLen:  (document.body?.innerText || '').length,
      };

      // ---- JS進行の目安（1回で「JSが動いてるか」を見る）----
      out.runtime = {
        perfNow: (typeof performance !== 'undefined' && performance.now) ? Math.floor(performance.now()) : null,
        hasHydrationMarks: !!document.querySelector('script[type="module"], link[rel="modulepreload"]'),
        rafCallable: false
      };

      try {
        // requestAnimationFrame が存在して呼べる＝JSの実行環境としては動いている目安
        out.runtime.rafCallable = (typeof requestAnimationFrame === 'function');
      } catch (_) {
        out.runtime.rafCallable = false;
      }

      // ---- iframe: 同一オリジンだけ覗ける範囲で「中にmain等があるか」----
      const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12);
      out.iframes = iframes.map((f, idx) => {
        let ok = false, counts = null, src = '';
        try {
          src = f.getAttribute('src') || '';
          const d = f.contentDocument; // cross-origin だと例外/ null
          if (d) {
            ok = true;
            counts = {
              header: d.querySelectorAll('header,[role="banner"]').length,
              footer: d.querySelectorAll('footer,[role="contentinfo"]').length,
              main:   d.querySelectorAll('main,[role="main"]').length,
              nav:    d.querySelectorAll('nav,[role="navigation"]').length,
              h1:     d.querySelectorAll('h1').length,
              ldjson: d.querySelectorAll('script[type*="ld+json" i]').length
            };
          }
        } catch (e) {
          ok = false;
        }
        return { idx, src: src.slice(0, 160), sameOriginReadable: ok, counts };
      });

      // ---- Shadow DOM: open root の有無だけ（closed は“推定”もできないので存在確認はここまで）----
      const nodes = Array.from(document.querySelectorAll('*'));
      let openRoots = 0;
      for (const el of nodes) if (el.shadowRoot) openRoots++;

      // ---- Shadow DOM(open) の中に main/header/footer/nav/h1 が居ないかをスキャン ----
      try {
        // open shadowRoot だけ辿る（closed は辿れない）
        const roots = [];
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el && el.shadowRoot) roots.push(el.shadowRoot);
        }

        const shadowCounts = {
          roots: roots.length,
          header: 0,
          footer: 0,
          main: 0,
          nav: 0,
          h1: 0
        };

        // ルートごとにカウント（重複は許容：まず “居る/居ない” を確定したい）
        for (const r of roots) {
          try {
            shadowCounts.header += r.querySelectorAll('header,[role="banner"]').length;
            shadowCounts.footer += r.querySelectorAll('footer,[role="contentinfo"]').length;
            shadowCounts.main   += r.querySelectorAll('main,[role="main"]').length;
            shadowCounts.nav    += r.querySelectorAll('nav,[role="navigation"]').length;
            shadowCounts.h1     += r.querySelectorAll('h1').length;
          } catch (_) {}
        }

        out.shadowCounts = shadowCounts;

        // “main が Shadow 内にある” をフラグで返す
        out.shadowHasMain = shadowCounts.main > 0;

        // ついでに「Shadow の最上位タグ」を少しだけサンプル（観測用）
        out.shadowTopology = {
          samples: roots.slice(0, 3).map((r, i) => {
            try {
              const top = Array.from(r.children || []).slice(0, 8).map(el => ({
                tag: (el.tagName || '').toLowerCase(),
                id: el.id || '',
                cls: (el.className && String(el.className).split(/\s+/).slice(0, 4).join(' ')) || '',
                child: el.childElementCount
              }));
              return { i, top };
            } catch (e) {
              return { i, err: String(e && (e.message || e)) };
            }
          })
        };
      } catch (e) {
        out.shadowCounts = { err: String(e && (e.message || e)) };
      }

      // ---- 代表的な SPA ルート候補（あれば名前を見る）----
      const roots = ['#app', '#root', '#__next', '#svelte', '#nuxt', '#main', '#content'];
      out.spaRoots = roots
        .map(sel => ({ sel, hit: !!document.querySelector(sel) }))
        .filter(x => x.hit);

      return out;
    });

    // ---- Playwright frames: evaluateできる範囲で main 等を各frameで確認 ----
    try {
      const frames = page.frames();
      const framesInfo = [];
      for (const f of frames) {
        try {
          const r = await f.evaluate(() => ({
            url: location.href,
            hasMain: !!document.querySelector('main,[role="main"]'),
            hasHeader: !!document.querySelector('header,[role="banner"]'),
            hasFooter: !!document.querySelector('footer,[role="contentinfo"]'),
            navCount: document.querySelectorAll('nav,[role="navigation"]').length,
            h1Count: document.querySelectorAll('h1').length,
            bodyTextLen: (document.body?.innerText || '').length
          }));
          framesInfo.push(r);
        } catch (e) {
          framesInfo.push({ url: String(f.url()), err: String(e && (e.message || e)) });
        }
      }
      console.log('[DBG][DOM-TOPOLOGY][FRAMES]', { frameCount: frames.length, frames: framesInfo });
    } catch (e) {
      console.log('[DBG][DOM-TOPOLOGY][FRAMES][ERR]', String(e && (e.message || e)));
    }

    console.log('[DBG][DOM-TOPOLOGY]', topo);

    try{
      // 1) 展開できない問題を確実に潰す
      console.log('[DBG][DOM-TOPOLOGY][JSON]', JSON.stringify(topo));
    }catch(e){
      console.log('[DBG][DOM-TOPOLOGY][JSON][ERR]', String(e && (e.message || e)));
    }

    try{
      // 2) Shadow の “先頭だけ” を人間が読める形で抜く（JSONより見やすいことが多い）
      const s = topo && topo.shadowTopology && topo.shadowTopology.samples;
      console.log('[DBG][DOM-TOPOLOGY][SHADOW-SAMPLES]', Array.isArray(s) ? s : '(none)');
    }catch(e){
      console.log('[DBG][DOM-TOPOLOGY][SHADOW-SAMPLES][ERR]', String(e && (e.message || e)));
    }

    try{
      // 3) 重要シグナルだけを短く1行で（ログ検索が楽）
      console.log('[DBG][DOM-TOPOPOLOGY][SIG]', {
        url: topo && topo.url,
        module: topo && topo.counts && topo.counts.module,
        bodyTextLen: topo && topo.metrics && topo.metrics.bodyTextLen,
        openShadowRoots: topo && topo.shadowCounts && topo.shadowCounts.roots,
        shadowHasMain: topo && topo.shadowHasMain
      });
    }catch(_){}

    // === [DBG][DOM-ROOT-CHECK v1] 1回で「どこにDOMがあるか」を確定 ===
    try {
      // 1) 現在フレームの URL と、最終的に見てるページ URL のズレ
      const pageUrl = await page.url();
      const mainFrameUrl = page.mainFrame().url();
      console.log('[DBG][DOM-ROOT-CHECK][URL]', { pageUrl, mainFrameUrl });

      // 2) 画面が “真っ白” なのか / テキストはあるのか / body自体があるのか
      const surface = await page.evaluate(() => ({
        readyState: document.readyState,
        hasBody: !!document.body,
        bodyChildren: document.body ? document.body.childElementCount : -1,
        docElChildren: document.documentElement ? document.documentElement.childElementCount : -1,
        innerTextLen: (document.documentElement?.innerText || '').length,
        bodyTextLen: (document.body?.innerText || '').length,
        bodyHTMLLen: (document.body?.innerHTML || '').length,
        title: document.title || '',
        locationHref: location.href
      }));
      console.log('[DBG][DOM-ROOT-CHECK][SURFACE]', surface);

      // 3) “mainが無い”のではなく「別のセレクタで main 相当がある」ケースを拾う
      const altMain = await page.evaluate(() => {
        const candidates = [
          '#app', '#root', '#__next', '#nuxt', '#svelte',
          '#content', '#contents', '#main', '.main', '.l-main', '.site-main',
          '[data-testid="main"]', '[data-main]', '[role="document"]'
        ];

        const hits = [];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const txtLen = (el.innerText || '').length;
          const child = el.childElementCount;
          hits.push({ sel, child, txtLen });
        }

        // body直下の代表タグを列挙（何で構成されてるか）
        const bodyTop = Array.from(document.body ? document.body.children : [])
          .slice(0, 20)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            cls: (el.className && String(el.className).split(/\s+/).slice(0, 4).join(' ')) || '',
            child: el.childElementCount
          }));

        return { altRoots: hits, bodyTop };
      });
      console.log('[DBG][DOM-ROOT-CHECK][ALT_MAIN]', altMain);

      // 4) “main等が0”の原因が Shadow DOM かを一発で判断（open rootsだけでも十分ヒントになる）
      const shadow = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('*'));
        let openRoots = 0;
        let openRootTags = [];
        for (const el of nodes) {
          if (el.shadowRoot) {
            openRoots++;
            if (openRootTags.length < 12) openRootTags.push(el.tagName.toLowerCase());
          }
        }
        return { openRoots, openRootTags };
      });
      console.log('[DBG][DOM-ROOT-CHECK][SHADOW]', shadow);

      // 5) iframe が “別ドキュメント本体” になっていないか（cross-originかどうかも見える）
      const iframeInfo = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12);
        return iframes.map((f, i) => ({
          i,
          src: (f.getAttribute('src') || '').slice(0, 180),
          hasSrcdoc: !!f.getAttribute('srcdoc')
        }));
      });
      console.log('[DBG][DOM-ROOT-CHECK][IFRAMES]', iframeInfo);

    } catch (e) {
      console.log('[DBG][DOM-ROOT-CHECK][ERR]', String(e && (e.stack || e)));
    }

  } catch (e) {
    console.log('[DBG][DOM-TOPOLOGY][ERR]', String(e && (e.message || e)));
  }

  // --- DOM スナップショット（1回分） ---
  const snapshot = async () => {
    return await page.evaluate(() => {
      // --------- helpers ----------
      const q = (root, sel) => {
        try { return root ? root.querySelector(sel) : null; } catch (_) { return null; }
      };
      const qa = (root, sel) => {
        try { return root ? Array.from(root.querySelectorAll(sel)) : []; } catch (_) { return []; }
      };
      const textLen = (root) => {
        try { return (root && root.innerText) ? root.innerText.length : 0; } catch (_) { return 0; }
      };

      // --------- shadow roots (open only) ----------
      const hosts = Array.from(document.querySelectorAll('*'));
      const openRoots = [];
      for (const el of hosts) {
        if (el && el.shadowRoot) openRoots.push({ tag: el.tagName.toLowerCase(), root: el.shadowRoot });
        if (openRoots.length >= 8) break; // 多すぎると重いので上限
      }

      // Light DOM counts
      const light = {
        header: qa(document, 'header,[role="banner"]').length,
        footer: qa(document, 'footer,[role="contentinfo"]').length,
        main:   qa(document, 'main,[role="main"]').length,
        nav:    qa(document, 'nav,[role="navigation"]').length,
        h1:     qa(document, 'h1').length,
        ldjson: qa(document, 'script[type*="ld+json" i]').length,
        module: qa(document, 'script[type="module"][src]').length
      };

      // Shadow DOM counts（open root を合算）
      const shadow = {
        openRoots: openRoots.length,
        counts: { header: 0, footer: 0, main: 0, nav: 0, h1: 0, ldjson: 0 },
        textLenMax: 0,
        samples: [] // どのhostに入ってるかのヒント
      };

      for (const it of openRoots) {
        const r = it.root;
        const c = {
          header: qa(r, 'header,[role="banner"]').length,
          footer: qa(r, 'footer,[role="contentinfo"]').length,
          main:   qa(r, 'main,[role="main"]').length,
          nav:    qa(r, 'nav,[role="navigation"]').length,
          h1:     qa(r, 'h1').length,
          ldjson: qa(r, 'script[type*="ld+json" i]').length
        };
        shadow.counts.header += c.header;
        shadow.counts.footer += c.footer;
        shadow.counts.main   += c.main;
        shadow.counts.nav    += c.nav;
        shadow.counts.h1     += c.h1;
        shadow.counts.ldjson += c.ldjson;

        const tl = textLen(r);
        if (tl > shadow.textLenMax) shadow.textLenMax = tl;

        if (shadow.samples.length < 6) {
          shadow.samples.push({ host: it.tag, ...c, textLen: tl });
        }
      }

      // --------- JSON-LD 検出（Light + Shadow） ----------
      const allScriptsLight = qa(document, 'script');
      const allScriptsShadow = openRoots.flatMap(it => qa(it.root, 'script'));
      const allScripts = allScriptsLight.concat(allScriptsShadow);

      let scripts = allScripts.filter(el => {
        const t = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase().trim();
        return t.includes('ld+json');
      });

      if (scripts.length === 0) {
        scripts = allScripts.filter(el => {
          const t = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase().trim();
          if (t && t !== 'application/json' && t !== 'text/plain' && t !== 'text/template') return false;
          const txt = String(el.textContent || '').trim();
          return txt.includes('"@context"') && txt.includes('"@type"');
        });
      }

      const jsonldCount = scripts.length;
      const jsonldSampleHead = String(scripts[0]?.textContent || '').slice(0, 200);

      // ★ 追加：jsonldTypesAll 抽出（最大5本・各テキスト最大50KB） + parseFailed
      let jsonldParseFailed = false;
      let jsonldTypesAll = [];
      try{
        const typeSet = new Set();

        const take = scripts.slice(0, 5);
        for (const sc of take){
          let txt = '';
          try{ txt = String(sc && sc.textContent || ''); }catch(_){ txt=''; }
          txt = txt.trim();
          if (!txt) continue;
          if (txt.length > 50000) txt = txt.slice(0, 50000); // ★重さ対策

          try{
            const obj = JSON.parse(txt);

            const nodes = Array.isArray(obj) ? obj : [obj];
            for (const node of nodes){
              if (!node || typeof node !== 'object') continue;
              const t = node['@type'];
              const types = Array.isArray(t) ? t : (t ? [t] : []);
              for (const tt of types){
                if (typeof tt === 'string' && tt) typeSet.add(tt);
              }
            }
          }catch(_e){
            // JSON-LD scriptがあるのにパースできない → “存在はするが確定不能”の重要シグナル
            jsonldParseFailed = true;
          }
        }

        jsonldTypesAll = Array.from(typeSet);
      }catch(_){
        jsonldParseFailed = true;
      }

      // --------- semantic DOM flags（Light OR Shadow） ----------
      const headerPresent = (light.header > 0) || (shadow.counts.header > 0);
      const footerPresent = (light.footer > 0) || (shadow.counts.footer > 0);
      const hasMainLandmark = (light.main > 0) || (shadow.counts.main > 0);
      const navCount = light.nav + shadow.counts.nav;
      const h1Count  = light.h1  + shadow.counts.h1;

      // --------- module script srcs（Lightのみで十分） ----------
      const moduleScriptSrcs = qa(document, 'script[type="module"][src]')
        .map(el => el.getAttribute('src') || '')
        .filter(Boolean);

      return {
        // JSON-LD
        jsonldCount,
        jsonldSampleHead,
        jsonldTypesAll,        // ★ 追加
        jsonldParseFailed,     // ★ 追加

        // SPA観測（Shadow込み）
        headerPresent,
        footerPresent,
        hasMainLandmark,
        navCount,
        h1Count,

        // デバッグ
        moduleScriptSrcs,
        shadowTopology: shadow,

        // 参考：Light側テキスト長（shadowはshadowTopology.textLenMax）
        innerTextLen: (document.documentElement?.innerText || '').length,
        bodyTextLen:  (document.body?.innerText || '').length
      };
    });
  };

  // --- ラッチ（取りこぼし防止） ---
  let headerSeen = false;
  let footerSeen = false;
  let mainSeen   = false;
  let navMax     = 0;
  let h1Max      = 0;

  let lastSnap = null;

  // まずは「JS描画で必要そうな要素が1つでも出る」まで軽く待つ（最大8秒）
  try {
    await page.waitForFunction(() => {
      const hasMain   = !!document.querySelector('main,[role="main"]');
      const hasHeader = !!document.querySelector('header,[role="banner"]');
      const hasFooter = !!document.querySelector('footer,[role="contentinfo"]');
      const hasLdJson = !!document.querySelector('script[type*="ld+json" i]');
      const hasModule = !!document.querySelector('script[type="module"][src]');
      return hasMain || hasHeader || hasFooter || hasLdJson || hasModule;
    }, { timeout: 8000 });
  } catch (_) {}

  // ★★★★★ ここに「IFRAME-CHECK」を挿入（この1箇所だけ） ★★★★★
  try {
    const iframes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map((f, i) => ({
        index: i,
        src: f.getAttribute('src'),
        id: f.id || null,
        class: f.className || null
      }));
    });
    console.log('[DEBUG][IFRAME-CHECK]', iframes);
  } catch (e) {
    console.log('[DEBUG][IFRAME-CHECK][ERR]', e && e.message);
  }

  // ★★★★★ A11Y（アクセシビリティツリー）経由の landmark 検出 ★★★★★
  let a11yMainSeen = false;

  try {
    // Playwright の role selector（closed shadow でも見える可能性あり）
    const a11yMainCount = await page.getByRole('main').count().catch(() => 0);
    const a11yBanner    = await page.getByRole('banner').count().catch(() => 0);
    const a11yFooter    = await page.getByRole('contentinfo').count().catch(() => 0);

    console.log('[DBG][A11Y-LANDMARKS]', {
      main: a11yMainCount,
      banner: a11yBanner,
      footer: a11yFooter
    });

    if (a11yMainCount > 0) a11yMainSeen = true;
  } catch (e) {
    console.log('[DBG][A11Y-LANDMARKS][ERR]', String(e && (e.message || e)));
  }

  // --- ポーリング：JSON-LD or semantic DOM の出現を待ちつつ、最大値をラッチ ---
  while (Date.now() - t0 < maxWaitMs) {
    const r = await snapshot();
    lastSnap = r;

    if (!a11yMainSeen) {
      const c = await page.getByRole('main').count().catch(() => 0);
      if (c > 0) a11yMainSeen = true;
    }

    if (r.headerPresent) headerSeen = true;
    if (r.footerPresent) footerSeen = true;
    if (r.hasMainLandmark || a11yMainSeen) mainSeen = true;

    if (Number(r.navCount || 0) > navMax) navMax = Number(r.navCount || 0);
    if (Number(r.h1Count  || 0) > h1Max)  h1Max  = Number(r.h1Count  || 0);

    // JSON-LD が DOM で出たら即勝ち
    if (Number(r.jsonldCount || 0) > 0) {
      return {
        jsonld_detected_once: true,
        jsonld_detect_count: Number(r.jsonldCount || 0),
        jsonld_types_all: Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [],
        jsonld_types:     Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [], // 互換
        jsonld_wait_ms:   Date.now() - t0,
        jsonld_timed_out: false,

        // ★ 追加：進捗状態（永続未判定の切り分け用）
        jsonld_scan_started: true,
        jsonld_scan_finished: true,
        jsonld_parse_failed: !!(r && r.jsonldParseFailed),

        // ★ 追加：同意壁の疑い（ここはDOM成功なので基本false）
        consent_wall_suspected: false,

        jsonld_sample_head: String(r.jsonldSampleHead || ''),

        // ★ ラッチ結果（snake_case）
        header_present: headerSeen,
        footer_present: footerSeen,
        nav_count: navMax,
        h1_count: h1Max,
        hasMainLandmark: mainSeen,

        // copyright（snake_case）
        copyright_footer_present: !!(r.footerElementPresent || footerSeen),
        copyright_hit: !!r.copyrightHit,
        copyright_hit_token: String(r.copyrightHitToken || ''),
        copyright_excerpt: String(r.copyrightExcerpt || '')
      };
    }

    // JSON-LD は無くても、semantic DOM が一度でも出たら「観測値」は確保できる
    // ただし JSON-LD をもう少し待ちたいので、ここでは抜けない（maxWaitMs まで続ける）

    await page.waitForTimeout(pollMs);
  }

  // --- タイムアウト時：最後のスナップでラッチを更新 ---
  const r = lastSnap || await snapshot();

  if (r.headerPresent) headerSeen = true;
  if (r.footerPresent) footerSeen = true;
  if (r.hasMainLandmark || a11yMainSeen) mainSeen = true;

  if (Number(r.navCount || 0) > navMax) navMax = Number(r.navCount || 0);
  if (Number(r.h1Count  || 0) > h1Max)  h1Max  = Number(r.h1Count  || 0);

  // --- フォールバック：DOMに JSON-LD が出ない SPA 用（module script から探索） ---
  // module script を 1本だけ GET して "@context" & "@type" を探す（軽量）
  try {
    if (Number(r.jsonldCount || 0) === 0) {
      // module src 候補（相対/絶対を正規化）
      let moduleSrcs = Array.isArray(r.moduleScriptSrcs) ? r.moduleScriptSrcs : [];

      // 相対パスを絶対化
      const pageUrl = await page.url();
      try {
        moduleSrcs = moduleSrcs.map(s => {
          try { return new URL(s, pageUrl).toString(); } catch(_) { return s; }
        });
      } catch(_) {}

      if (moduleSrcs.length > 0) {
        // app-index.js 優先、それ以外は先頭
        const target =
          moduleSrcs.find(u => String(u).includes('app-index.js')) ||
          moduleSrcs[0];

        if (target) {
          const resp = await page.context().request.get(target).catch(() => null);
          if (resp && resp.ok()) {
            const jsText = await resp.text();
            const idxContext = jsText.indexOf('"@context"');
            const idxType    = jsText.indexOf('"@type"');

            if (idxContext !== -1 && idxType !== -1) {
              // "@type" を列挙
              let typeNames = [];
              try {
                const mAll = jsText.matchAll(/"@type"\s*:\s*"([^"]+)"/g);
                for (const m of mAll) if (m && m[1]) typeNames.push(m[1]);
              } catch (_) {}

              // sample head
              const head = jsText.slice(Math.max(0, idxContext - 40), idxContext + 240);

              // detect_count は type の出現数をざっくり採用（最低1）
              const typeMatches = jsText.match(/"@type"\s*:/g);
              const count = typeMatches ? Math.max(1, typeMatches.length) : 1;

              return {
                jsonld_detected_once: true,
                jsonld_detect_count: count,
                jsonld_types_all: typeNames,
                jsonld_types:     typeNames, // 互換
                jsonld_wait_ms:   Date.now() - t0,
                jsonld_timed_out: false,

                // ★ 追加：進捗状態
                jsonld_scan_started: true,
                jsonld_scan_finished: true,
                jsonld_parse_failed: false,          // jsTextから拾えたのでparse失敗ではない

                // ★ 追加：同意壁疑い（timeout経由なのであり得る）
                consent_wall_suspected: false,       // ※ここは後で必要なら推定する（今は固定でOK）

                jsonld_sample_head: String(head || ''),

                header_present: headerSeen,
                footer_present: footerSeen,
                nav_count: navMax,
                h1_count: h1Max,
                hasMainLandmark: mainSeen,

                copyright_footer_present: !!(r.footerElementPresent || footerSeen),
                copyright_hit: !!r.copyrightHit,
                copyright_hit_token: String(r.copyrightHitToken || ''),
                copyright_excerpt: String(r.copyrightExcerpt || '')
              };
            }
          }
        }
      }
    }
  } catch (_) {
    // フォールバック失敗は無視して通常の timeout 結果へ
  }

  // --- ここまで来たら「見つからなかった」 ---
  return {
    jsonld_detected_once: false,
    jsonld_detect_count: Number(r.jsonldCount || 0),
    jsonld_types_all: Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [],
    jsonld_types:     Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [], // 互換
    jsonld_wait_ms:   Date.now() - t0,
    jsonld_timed_out: true,
    jsonld_sample_head: String(r.jsonldSampleHead || ''),

    header_present: headerSeen,
    footer_present: footerSeen,
    nav_count: navMax,
    h1_count: h1Max,
    hasMainLandmark: mainSeen,

    copyright_footer_present: !!(r.footerElementPresent || footerSeen),
    copyright_hit: !!r.copyrightHit,
    copyright_hit_token: String(r.copyrightHitToken || ''),
    copyright_excerpt: String(r.copyrightExcerpt || '')
  };
}

// === [AIO][HEAD_META v1] head/meta 情報を抽出するヘルパー ==================
async function extractHeadMetaV1(page) {
  // title
  let titleText = '';
  try {
    // <title> が無い場合は空文字 or 例外になるので try/catch
    titleText = (await page.title()) || '';
  } catch (_) {
    titleText = '';
  }
  const hasTitle = !!titleText.trim();

  // meta description
  let descText = '';
  try {
    // head 内の <meta name="description">（大文字小文字ゆらぎも吸収）
    const handle = await page.$('head meta[name="description" i]');
    if (handle) {
      const content = await handle.getAttribute('content');
      descText = (content || '').trim();
      await handle.dispose();
    }
  } catch (_) {
    descText = '';
  }

  const hasMetaDescription = !!descText;
  const metaDescriptionLen = descText.length;

  return {
    hasTitle,
    titleText,
    hasMetaDescription,
    metaDescriptionLen,
    metaDescriptionText: descText
  };
}

// === [AIO][AUDIT_SIG v1] JSON-LD / コピーライト / head meta / ナビ導線 を集約するヘルパー ===
async function buildAuditSigFromPage(page) {
  // === [AIO][JSONLD_WAIT v1] JSON-LDの出現待ち＋状態を付けて probe をラップ ===
  async function probeJsonLdAndCopyrightWithWaitV1(page, opt){
    opt = opt || {};
    const T_MS = Number(opt.timeoutMs || 7000); // ★ 5〜8秒：まずは7秒
    const out = {
      jsonld_scan_started: false,
      jsonld_scan_finished: false,
      jsonld_parse_failed: false,
      consent_wall_suspected: false,
      jsonld_wait_ms: 0
    };

    const t0 = Date.now();
    out.jsonld_scan_started = true;

    // 1) まず “出現待ち” をする（無ければ timeout）
    //    - type="application/ld+json" だけでなく、typeゆらぎや中身("@context"+"@type")でも拾う
    let selectorFound = false;
    try{
      await page.waitForFunction(() => {
        // 1) 正攻法：ld+json
        const ld = document.querySelector('script[type*="ld+json" i]');
        if (ld) return true;

        // 2) typeゆらぎ救済：type無し/別typeでも中身で判定（重くしない）
        const scripts = Array.from(document.querySelectorAll('script')).slice(0, 50);
        return scripts.some(s => {
          const t = String(s.getAttribute('type') || '').toLowerCase().trim();

          // JSONっぽいtype or type無しだけ対象（雑に広げすぎない）
          if (t && !(t.includes('json') || t.includes('ld+json'))) return false;

          const txt = String(s.textContent || '').trim();
          if (!txt) return false;

          // 最小条件：JSON-LDっぽいキーが両方ある
          return txt.includes('"@context"') && txt.includes('"@type"');
        });
      }, { timeout: T_MS });

      selectorFound = true;
    }catch(_){
      selectorFound = false;
    }
    out.jsonld_wait_ms = Date.now() - t0;

    // 2) consent wall 疑い（timeoutのときだけ軽く判定）
    if (!selectorFound){
      try{
        const htmlLower = String(await page.content() || '').toLowerCase();
        // 最小セット：cookie/同意/consent が濃いと疑う
        out.consent_wall_suspected =
          /cookie|consent|同意|クッキー|プライバシー|privacy/.test(htmlLower) &&
          /同意|accept|agree|consent|許可/.test(htmlLower);
      }catch(_){
        out.consent_wall_suspected = false;
      }
    }

    // 3) 既存プローブを実行（ここは既存資産を活かす）
    let jp = {};
    try{
      jp = await probeJsonLdAndCopyright(page);
    }catch(e){
      jp = { jsonld_scan_failed: true, jsonld_probe_err: String(e && (e.stack||e.message||e)) };
    }

    // 4) 状態を jp にマージして返す（snake_caseで揃える）
    //    - “出現待ちtimeout” が起きた場合のみ timed_out を真にする（雑な0件=timeoutを防ぐ）
    try{
      const detectCount = Number((jp && jp.jsonld_detect_count) || 0);
      const scanFailed  = !!(jp && jp.jsonld_scan_failed);

      jp = jp || {};
      jp.jsonld_scan_started = out.jsonld_scan_started;
      jp.jsonld_scan_finished = true;
      jp.jsonld_parse_failed = !!(jp && jp.jsonld_parse_failed); // 既存があれば尊重
      jp.consent_wall_suspected = out.consent_wall_suspected;
      jp.jsonld_wait_ms = out.jsonld_wait_ms;

      // ★ timeout判定は “出現待ち” 基準に統一
      //    - selectorが見つかったなら timed_out=false
      //    - 見つからず、かつ検出0で、scanFailedでないなら timed_out=true
      if (selectorFound){
        jp.jsonld_timed_out = false;
      }else{
        jp.jsonld_timed_out = (!scanFailed && detectCount === 0);
      }
    }catch(_){}

    return jp;
  }

  // それぞれのヘルパーを並列で実行
  const [headMeta, jsonldProbe] = await Promise.all([
    extractHeadMetaV1(page),
    probeJsonLdAndCopyrightWithWaitV1(page, { timeoutMs: 7000 })
  ]);

  const hm = headMeta || {};
  const jp = jsonldProbe || {};

  // JSON-LD 関連
  const jsonldCount    = Number(jp.jsonld_detect_count || 0);
  const jsonldDetected = jsonldCount > 0;
  const jsonldTimedOut = !!jp.jsonld_timed_out;
  const jsonldTypesAll = Array.isArray(jp.jsonld_types_all)
    ? jp.jsonld_types_all
    : [];

  // ★ 追加：どこまで進んだか（永続未判定の原因切り分け用）
  const jsonldScanStarted   = !!jp.jsonld_scan_started;
  const jsonldScanFinished  = !!jp.jsonld_scan_finished;
  const jsonldParseFailed   = !!jp.jsonld_parse_failed;
  const consentWallSuspected = !!jp.consent_wall_suspected;
  const jsonldWaitMs        = Number(jp.jsonld_wait_ms || 0);

  // head/meta 関連（タイトル・description）
  const hasTitle            = !!hm.hasTitle;
  const hasMetaDescription  = !!hm.hasMetaDescription;
  const metaDescriptionLen  = Number(hm.metaDescriptionLen || 0);
  const metaDescriptionText = String(hm.metaDescriptionText || '');
  const titleText           = String(hm.titleText || '');

  // コピーライト関連
  const copyrightHit           = !!jp.copyright_hit;
  const copyrightExcerpt       = String(jp.copyright_excerpt || '');
  const copyrightFooterPresent = !!jp.copyright_footer_present;
  const copyrightHitToken      = String(jp.copyright_hit_token || '');

  // ★ SPA観測値（probe 側のラッチ結果を拾う）
  const hasMainLandmark = !!jp.hasMainLandmark;

  // probe 側が snake_case で返してくる想定（header_present / nav_count / h1_count）
  const headerPresent = !!jp.header_present;
  const footerPresent = !!jp.footer_present;
  const navCount      = Number(jp.nav_count || 0);
  const h1Count       = Number(jp.h1_count  || 0);

  // --- NEW: ナビ/フッターを含めた coverage 導線フラグ検出 ---
  let coverageNav = {
    hasCompanyNav: false,
    hasServiceNav: false,
    hasContactNav: false,
    hasFaqNav: false
  };

  try {
    const html = await page.content();
    const htmlStr   = String(html || '');
    const htmlLower = htmlStr.toLowerCase();

    function hasJP(re) {
      try { return re.test(htmlStr); }
      catch (_) { return false; }
    }

    function hasEN(re) {
      try { return re.test(htmlLower); }
      catch (_) { return false; }
    }

    // 会社情報 / 企業情報 / コーポレート系
    const hasCompanyNav =
      hasJP(/会社情報|会社概要|企業情報|企業概要|会社案内/) ||
      hasEN(/about\s+us|about\s+company|company(\s+(info|information|profile))?|corporate(\s+(profile|info))?/);

    // サービス / 事業内容 / ソリューション / 製品
    const hasServiceNav =
      hasJP(/サービス(一覧|紹介)?|事業内容|事業紹介|ソリューション|製品情報|プロダクト/) ||
      hasEN(/services|our\s+services|products|solutions/);

    // お問い合わせ / 資料請求 / CONTACT
    const hasContactNav =
      hasJP(/お問い合わせ|お問合せ|問合せ|お問い合せ|資料請求/) ||
      hasEN(/contact(\s+us)?/);

    // FAQ / よくある質問 / Q&A
    const hasFaqNav =
      hasJP(/FAQ|ＦＡＱ|よくある質問|よくあるご質問|Q＆A|Q&A/) ||
      hasEN(/\bfaq\b/);

    coverageNav = {
      hasCompanyNav: !!hasCompanyNav,
      hasServiceNav: !!hasServiceNav,
      hasContactNav: !!hasContactNav,
      hasFaqNav:     !!hasFaqNav
    };
  } catch (_) {
    // 失敗しても coverageNav はデフォルト(false)のまま
  }

  console.log('[AUDIT_SIG][coverageNav]', coverageNav);

  const traceId = `covnav|${(await page.url()).replace(/[#?].*$/,'').replace(/\/+$/,'')}|${Date.now()}`;

  console.log('[TRACE_COVNAV][NODE][auditSig-ready]', {
    traceId,
    url: await page.url(),
    coverageNav,
    htmlLen: (await page.content()).length
  });

  console.log(
    '[AUDIT_SIG][FINAL]',
    {
      url: await page.url(),
      hasMainLandmark_from_probe: jp.hasMainLandmark,
      hasMainLandmark_final: hasMainLandmark
    }
  );

  console.log('[AUDIT_SIG][HAS-SPA4]', { headerPresent, footerPresent, navCount, h1Count });

  return {
    // JSON-LD 周り
    jsonldDetected,
    jsonldCount,
    jsonldTimedOut,
    jsonldWaitMs,                 // ★ 既にsigKeysにあったが、確実にここで埋める
    jsonldScanStarted,            // ★ 追加
    jsonldScanFinished,           // ★ 追加
    jsonldParseFailed,            // ★ 追加
    consentWallSuspected,         // ★ 追加
    jsonldSampleHead: String(jp.jsonld_sample_head || ''),
    jsonldTypes: jsonldTypesAll,

    // ★ 追加（ここ）
    hasMainLandmark,

    // ★ 追加（SPA観測値）
    headerPresent,
    footerPresent,
    navCount,
    h1Count,

    // head/meta 周り
    hasTitle,
    hasMetaDescription,
    metaDescriptionLen,
    metaDescriptionText,
    titleText,

    // コピーライト周り
    copyrightHit,
    copyrightExcerpt,
    copyrightFooterPresent,
    copyrightHitToken,

    // NEW: ナビ導線フラグ
    coverageNav
  };
}

// === [COV_NAV][DETECT v2] HTML から会社情報/サービス/お問い合わせ/FAQ 導線をざっくり検出 ===
function detectCoverageNavFromHtml_FOR_SCORING_ONLY(html) {
  try {
    html = String(html || '');
    if (!html) {
      return {
        hasCompanyNav: false,
        hasServiceNav: false,
        hasContactNav: false,
        hasFaqNav: false
      };
    }

    const htmlLower = html.toLowerCase();

    const hasJP = (re) => {
      try { return re.test(html); } catch (_) { return false; }
    };
    const hasEN = (re) => {
      try { return re.test(htmlLower); } catch (_) { return false; }
    };

    // 会社情報 / 企業情報 / コーポレート系
    const hasCompanyInfoLink =
      hasJP(/会社情報|会社概要|企業情報|企業概要|会社案内/) ||
      hasEN(/corporate\s+profile|corporate\s+info|about\s+us|about\s+company/);

    // サービス / 事業内容 / ソリューション / 製品
    const hasServicePageLink =
      hasJP(/サービス(一覧|紹介)?|事業内容|事業紹介|ソリューション|製品情報|プロダクト/) ||
      hasEN(/services|our\s+services|products|solutions/);

    // お問い合わせ / 資料請求 / CONTACT
    const hasContactLink =
      hasJP(/お問い合わせ|お問合せ|問合せ|お問い合せ|資料請求/) ||
      hasEN(/contact\s*us|contact/);

    // 採用情報 / CAREER
    const hasRecruitLink =
      hasJP(/採用情報|求人情報|キャリア採用|新卒採用|中途採用/) ||
      hasEN(/careers?|recruit/);

    // FAQ / よくある質問
    const hasFaqLink =
      hasJP(/FAQ|ＦＡＱ|よくある質問|よくあるご質問|Q＆A|Q&A/) ||
      hasEN(/faq/);

      const flags = {
        hasCompanyNav: !!hasCompanyInfoLink,
        hasServiceNav: !!hasServicePageLink,
        hasContactNav: !!hasContactLink,
        hasFaqNav:     !!hasFaqLink
      };

    try {
      console.log('[COV_NAV][FLAGS]', flags);
    } catch (_) {}

    return flags;
  } catch (e) {
    try {
      console.warn('[COV_NAV][ERR]', e);
    } catch (_) {}

    return {
      hasCompanyInfoLink: false,
      hasServicePageLink: false,
      hasContactLink: false,
      hasRecruitLink: false,
      hasFaqLink: false
    };
  }
}

const playwright = require('playwright');
// === minimal Playwright scrape (QUALITY MODE) ===
async function playScrapeMinimal(url) {
  const browser = await playwright.chromium.launch({
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage({ javaScriptEnabled: true });

  // 画像・フォント・メディアはブロック（テキスト優先で高速化）
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image','font','media'].includes(t)) return route.abort();
    return route.continue();
  });

  // 1) 初期ロード（DOM完成）→ ネットワーク静穏を1回待つ
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch(_) {}

  // ★ここに追加
  const metaDescription = await page.evaluate(() => {
    const el =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[property="og:description"]') ||
      document.querySelector('meta[name="twitter:description"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  });

  // 2) SPAレンダ待ち（候補セレクタ）
  const waitSelectors = ['main', '#app', '[id*="root"]', 'body'];
  for (const sel of waitSelectors) {
    try { await page.waitForSelector(sel, { timeout: 6000 }); break; } catch (_) {}
  }

  // 3) 遅延読込対策：自動スクロール（下のヘルパを後で追加します）
  try { await autoScroll(page, { step: 1200, pauseMs: 300, maxScrolls: 8 }); } catch (_) {}

  // 4) スクリプト後レンダ対策：再度 networkidle を短く
  try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch(_) {}

  // 5) 十分な本文長になるまで“しつこく待つ” （質優先）
  //    閾値は 600 文字に上げます（以前は 200）
  const THRESH = 600;
  try {
    await page.waitForFunction(
      (n) => document.body && document.body.innerText && document.body.innerText.length > n,
      { timeout: 12000 },
      THRESH
    );
  } catch (_) {
    // ここは妥協点。超えなくても続行。
  }

  // 6) 抽出
  const fullHtml = await page.content();
  const innerText = await page.evaluate(() => (document.body?.innerText || '').trim());
  const jsonldRaw = await page.$$eval(
    'script[type="application/ld+json"]',
    nodes => nodes.map(n => n.textContent).filter(Boolean)
  );

  // ★ coverage ナビ導線フラグ（会社情報・サービス・お問い合わせなど）
  const coverageNavFlags = detectCoverageNavFromHtml_FOR_SCORING_ONLY(fullHtml);

  // ★ 互換：GAS側が hasCompanyNav 等を見る場合に備えて“同義キー”も用意（既存を壊さない）
  const coverageNavCompat = (function(){
    try{
      const f = coverageNavFlags || {};
      // すでに hasCompanyNav 形式ならそのまま
      if (typeof f.hasCompanyNav === 'boolean' ||
          typeof f.hasServiceNav === 'boolean' ||
          typeof f.hasContactNav === 'boolean' ||
          typeof f.hasFaqNav === 'boolean') {
        return f;
      }
      // FOR_SCORING_ONLY が hasCompanyInfoLink 形式ならマップする
      return {
        hasCompanyNav: !!f.hasCompanyInfoLink,
        hasServiceNav: !!f.hasServicePageLink,
        hasContactNav: !!f.hasContactLink,
        hasFaqNav:     !!f.hasFaqLink
      };
    }catch(_){
      return coverageNavFlags || { hasCompanyNav:false, hasServiceNav:false, hasContactNav:false, hasFaqNav:false };
    }
  })();

  // JSON-LD パース
  const jsonld = [];
  for (const t of jsonldRaw) {
    try { const j = JSON.parse(t); Array.isArray(j) ? jsonld.push(...j) : jsonld.push(j); }
    catch (_) {}
  }

  await browser.close();

  return {
    innerText,
    html: fullHtml,
    jsonld,

    // ★ 互換キーも返す
    metaDescription,                  // ← page.evaluate で取ったやつ
    coverageNav: coverageNavCompat,   // ← GAS互換（hasCompanyNav形式）
    coverageNavRaw: coverageNavFlags, // ← 元の検出結果（デバッグ/後方互換）

    // ★ SSOT：下流がどこを見ても拾えるようにここに入れる
    facts: {
      auditSig: {
        coverageNav: coverageNavCompat,     // ← “互換の正” を入れるのが安全
        coverageNavRaw: coverageNavFlags    // ← 元も残すならここにも
      }
    },

    waitStrategy:'quality:domcontentloaded→networkidle→autoscroll→networkidle→len>600',
    blockedResources:['image','font','media'],
    fallbackJsonld:{}
  };
}

// === scrape adapter (FIX v3: signals) ===
/**
 * 役割：
 * - /scrape が返す bodyText/html を最優先で拾う
 * - それでも innerText が空なら、cheerio で HTML→本文を復元
 * - JSON-LD はなければ HTML から抽出
 */
async function scrapeForScoring(url) {
  const r = (typeof playScrapeMinimal === 'function')
    ? await playScrapeMinimal(url)
    : await yourExistingScrape(url);

  let innerText = r.innerText || r.bodyText || r.text || '';
  const fullHtml = r.html || r.fullHtml || '';

  // 既存 /scrape の bodyText が内文より長い場合は優先して採用
  const altText = r.bodyText || '';
  if (altText.length > innerText.length) innerText = altText;

  // innerText が空なら HTML→本文復元
  if ((!innerText || innerText.length === 0) && fullHtml) {
    try {
      const $ = cheerio.load(fullHtml);
      innerText = $('body').text().replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    } catch (_) {}
  }

  // --- 追加：DOMシグナル抽出（根拠用） ---
  let h1 = 0, h2 = 0, lists = 0, tables = 0, links = 0;
  let hasTel = false, hasAddress = false;
  let jsonldArr = Array.isArray(r.jsonld) ? r.jsonld : [];

  if (fullHtml) {
    try {
      const $ = cheerio.load(fullHtml);
      h1 = $('h1').length;
      h2 = $('h2').length;
      lists = $('ul,ol').length;
      tables = $('table').length;
      links = $('a[href]').length;

      // JSON-LD 抽出（なければ）
      if (!jsonldArr || jsonldArr.length === 0) {
        jsonldArr = $('script[type="application/ld+json"]').toArray().flatMap(n => {
          const t = $(n).text();
          try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch { return []; }
        });
      }
    } catch (_) {}
  }

  // 連絡先の簡易検出（日本語サイト向け・HTMLテキストも併用）
  try {
    const $all = fullHtml ? cheerio.load(fullHtml) : null;
    const htmlText = $all ? $all('body').text() : '';
    // innerText + HTMLテキストを結合して判定
    const joined = ((innerText || '') + ' ' + (htmlText || '')).trim();

    // 全角→半角、全角ハイフン→半角
    const z2hMap = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '－': '-', 'ー': '-', '―': '-' };
    const norm = joined.replace(/[０-９ー―－]/g, ch => z2hMap[ch] || ch).replace(/\s+/g, ' ').trim();

    // 電話番号（国内パターンを緩めに網羅）
    const telRe = /(TEL[:：]?\s*)?(\(0\d{1,4}\)|0\d{1,4})[\s-]?\d{1,4}[\s-]?\d{3,4}/i;
    hasTel = telRe.test(norm);

    // 住所（郵便番号 or 都道府県名）
    const zipRe = /(〒?\s*\d{3}-\d{4})/;
    const prefRe = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/;
    hasAddress = zipRe.test(norm) || prefRe.test(norm);

    // デバッグしやすいようにサンプルも保持
    var innerTextSample = norm.slice(0, 160);
  } catch (e) {
    console.warn('[adapter] contact regex failed:', e && e.message ? e.message : e);
  }

  // === [SITE-FACTS-LITE v1] 汎用の “存在事実” を抽出して auditSig に保存 ===
  // 目的: LLMの推測で「採用がない/OGPがない/更新日がない/実績がない」等の嘘カードが出るのを恒久的に防ぐ
  let __siteFactsLite = null;
    try{
      const __html = String(fullHtml || '');
      const __text = String(innerText || '');

      // meta: OGP/Twitter
      const __og = (__html.match(/<meta[^>]+property=["']og:/ig) || []).length;
      const __tw = (__html.match(/<meta[^>]+name=["']twitter:/ig) || []).length;
      const __ogpDetected = (__og + __tw) > 0;

      // links: 採用/実績/お知らせ/FAQ の導線（href とテキスト両方で汎用検知）
      const __hrefs = Array.from(__html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/ig)).map(m=>String(m[1]||''));
      const __aTexts = Array.from(__html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/ig)).map(m=>String(m[1]||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());

      const __H = (' ' + __hrefs.join(' ') + ' ').toLowerCase();
      const __T = (' ' + __aTexts.join(' ') + ' ').toLowerCase();

      const __hasRecruit = /\/recruit\b|\/career\b|\/jobs?\b/.test(__H) || /(採用|求人|キャリア)/.test(__T);
      const __hasWorks   = /\/case\b|\/works\b|\/portfolio\b/.test(__H) || /(実績|事例|works|case|portfolio)/.test(__T);
      const __hasNews    = /\/information\b|\/news\b|\/press\b|\/info\b/.test(__H) || /(お知らせ|ニュース|press|information)/.test(__T);
      const __hasFaq     = /\/faq\b/.test(__H) || /(faq|よくある質問)/.test(__T);

      // sections: 日付シグナル（ニュース欄や更新日らしき表示）
      const __dateRe = /(\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})|(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/g;
      const __dates = Array.from(new Set((__text.match(__dateRe) || []).map(s=>String(s).trim()))).slice(0,20);

      // sections: 実績件数の目安（liの繰り返し or "role=listitem"）
      const __roleListitem = (__html.match(/role=["']listitem["']/ig) || []).length;
      const __liCount = (__html.match(/<li\b/ig) || []).length;
      const __worksCount = Math.max(__roleListitem, __liCount);

      __siteFactsLite = {
        meta: { ogCount: __og, twCount: __tw, ogpDetected: __ogpDetected },
        links: { hasRecruit: __hasRecruit, hasWorks: __hasWorks, hasNews: __hasNews, hasFaq: __hasFaq },
        sections: { dates: __dates, worksCount: __worksCount }
      };

      // ★ auditSig にマージ（SSOTに残すのが目的）
      try{
        r.facts = r.facts || {};
        r.facts.auditSig = r.facts.auditSig || {};
        r.facts.auditSig.siteFactsLite = __siteFactsLite;

        // 互換用ショートフラグ（後段のカード制御が書きやすい）
        r.facts.auditSig.hasOgpMetaLite       = !!__ogpDetected;
        r.facts.auditSig.hasRecruitLinkLite   = !!__hasRecruit;
        r.facts.auditSig.hasWorksLinkLite     = !!__hasWorks;
        r.facts.auditSig.hasNewsLinkLite      = !!__hasNews;
        r.facts.auditSig.newsDatesCountLite   = __dates.length;
        r.facts.auditSig.worksCountLite       = __worksCount;
      }catch(_){}

      // ★ 保険：auditSig の直下にも同じものを持たせる（取り回し差異に負けない）
      try{
        r.auditSig = r.auditSig || {};
        if (r.auditSig.siteFactsLite === undefined) r.auditSig.siteFactsLite = __siteFactsLite;

        if (r.auditSig.hasOgpMetaLite       === undefined) r.auditSig.hasOgpMetaLite       = !!__ogpDetected;
        if (r.auditSig.hasRecruitLinkLite   === undefined) r.auditSig.hasRecruitLinkLite   = !!__hasRecruit;
        if (r.auditSig.hasWorksLinkLite     === undefined) r.auditSig.hasWorksLinkLite     = !!__hasWorks;
        if (r.auditSig.hasNewsLinkLite      === undefined) r.auditSig.hasNewsLinkLite      = !!__hasNews;
        if (r.auditSig.newsDatesCountLite   === undefined) r.auditSig.newsDatesCountLite   = __dates.length;
        if (r.auditSig.worksCountLite       === undefined) r.auditSig.worksCountLite       = __worksCount;
      }catch(_){}
    }catch(e){
    // 抽出に失敗してもスクレイプ自体は継続（空でよい）
    __siteFactsLite = null;
  }
  // === [SITE-FACTS-LITE v1] ここまで ===

  const signals = {
    h1, h2, lists, tables, links,
    hasTel, hasAddress,
    jsonldTypes: (jsonldArr || []).map(x => x && x['@type']).filter(Boolean)
  };

  return {
    fromScrape: true,
    hydrated: (innerText && innerText.length > 600) ? true : false,
    innerTextLen: innerText ? innerText.length : 0,
    fullHtmlLen: fullHtml ? fullHtml.length : 0,
    jsonld: jsonldArr,
    waitStrategy: r.waitStrategy || 'main|#app|[id*=root]',
    blockedResources: r.blockedResources || ['font','media'],
    facts: r.facts || {},
    fallbackJsonld: r.fallbackJsonld || {},
    signals,                      // ← 既存ならOK
    innerTextSample: (innerText || '').slice(0, 160), // ← 追加
  };
}

// -------------------- CORS --------------------
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// -------------------- ヘルス --------------------
app.get('/', (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// 軽量ヘルスチェック（RSS を見るとメモリ傾向を掴みやすい）
app.get('/healthz', (_, res) => {
  const m = process.memoryUsage();
  res.status(200).json({ ok: true, rss: m.rss, heapUsed: m.heapUsed });
});

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

// -------------------- ユーティリティ --------------------
function uniq(a){ return Array.from(new Set((a||[]).filter(Boolean))); }
function stripTags(s){ return String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function digitsOnly(s){ return String(s||'').replace(/\D+/g,''); }

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
function decodeUnicodeEscapes(s){
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}
// ===== JSON-LD 抽出・正規化まわり =====

// URL 正規化（クエリ・ハッシュ除去）
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return String(u || '');
  }
}

// HTML文字列から <script type="application/ld+json"> を全部抜いて JSON.parse
function extractJsonLdFromHtml(html) {
  const out = [];
  if (!html) return out;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      // JSON-LD には配列とオブジェクトの両方が来る
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch(_) {}
  }
  return out;
}

// === [COVNAV][NODE-DETECT v1] HTMLから会社情報/サービス/お問い合わせ/FAQナビをざっくり検出 ===
function detectCoverageNavFromHtmlNode(html) {
  try {
    html = String(html || '');
    if (!html) {
      return {
        hasCompanyNav: false,
        hasServiceNav: false,
        hasContactNav: false,
        hasFaqNav:     false
      };
    }

    const htmlLower = html.toLowerCase();

    const hasJP = (re) => {
      try { return re.test(html); } catch { return false; }
    };
    const hasEN = (re) => {
      try { return re.test(htmlLower); } catch { return false; }
    };

    // 会社情報 / 企業情報 / コーポレート系
    const hasCompanyNav =
      hasJP(/会社情報|会社概要|企業情報|企業概要|会社案内/) ||
      hasEN(/corporate\s+profile|corporate\s+info|about\s+us|about\s+company/);

    // サービス / 事業内容 / ソリューション / 製品
    const hasServiceNav =
      hasJP(/サービス(一覧|紹介)?|事業内容|事業紹介|ソリューション|製品情報|プロダクト/) ||
      hasEN(/services|our\s+services|products|solutions/);

    // お問い合わせ / 資料請求 / CONTACT
    const hasContactNav =
      hasJP(/お問い合わせ|お問合せ|問合せ|お問い合せ|資料請求/) ||
      hasEN(/contact\s*us|contact/);

    // FAQ / よくある質問 / Q&A
    const hasFaqNav =
      hasJP(/FAQ|ＦＡＱ|よくある質問|よくあるご質問|Q＆A|Q&A/) ||
      hasEN(/faq/);

    return {
      hasCompanyNav: !!hasCompanyNav,
      hasServiceNav: !!hasServiceNav,
      hasContactNav: !!hasContactNav,
      hasFaqNav:     !!hasFaqNav
    };
  } catch {
    return {
      hasCompanyNav: false,
      hasServiceNav: false,
      hasContactNav: false,
      hasFaqNav:     false
    };
  }
}

// JSON-LD から Organization/Corporation 類や住所/電話/設立が入っていそうなノードだけを抽出
function pickOrgNodes(jsonldArray) {
  const arr = Array.isArray(jsonldArray) ? jsonldArray : [];
  const okType = /^(Organization|Corporation|LocalBusiness|NGO|EducationalOrganization|GovernmentOrganization)$/i;
  const picked = [];

  const flatten = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(flatten); return; }
    if (node['@graph']) { flatten(node['@graph']); }
    if (node['@type']) {
      const t = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type']||'');
      if (okType.test(t)) picked.push(node);
    }
  };

  arr.forEach(flatten);
  return picked.length ? picked : arr; // 見つからなければ全体を返す（比較用）
}

// GTM/外部タグの有無を検知（json-ld 注入のリスク記録用）
function hasGtmOrExternal(html) {
  if (!html) return false;
  return /googletagmanager\.com|googletagservices\.com|gtm\.js|google-analytics\.com/i.test(html);
}

// トップと /about の JSON-LD を比較して “/about 優先” で返す
function preferAboutJsonLd(topArr, aboutArr) {
  const topOrg = pickOrgNodes(topArr);
  const aboutOrg = pickOrgNodes(aboutArr);
  if (aboutOrg && aboutOrg.length) return aboutOrg;  // /about を優先
  return topOrg || [];
}

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
function pickBestPhone({ telLinks=[], phones=[], labelHits=[], corpusText='' } = {}){
  const labeled = Array.from(new Set(labelHits
    .map(normalizeJpPhone)
    .filter(n => n && !isDummyPhone(n))));
  if (labeled.length) return labeled[0];
  const DUMMY_PREFIX = /^(007|017|089|000)/;
  for (const raw of telLinks) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    if (!isDummyPhone(n)) return n;
  }
  const cand = [];
  for (const raw of phones) {
    const n = normalizeJpPhone(raw);
    if (!n || isDummyPhone(n)) continue;
    const nd = (n||'').replace(/\D+/g,'');
    const cd = String(corpusText||'').replace(/\D+/g,'');
    const ctx = (nd && cd.includes(nd)) ? 25 : 0;
    cand.push({ n, s: scorePhoneBasic(n) + ctx });
  }
  cand.sort((a,b) => b.s - a.s);
  return cand.length ? cand[0].n : null;
}

const PREF_RE = /(北海道|東京都|(?:京都|大阪)府|..県)/;
function parseBestAddressFromLines(lines){
  if (!lines || !lines.length) return null;
  const cleaned = lines.map(stripTags).filter(Boolean);
  for (const line of cleaned){
    const mZip  = line.match(/〒?\s?(\d{3})-?(\d{4})/);
    const mPref = line.match(PREF_RE);
    if (!mZip || !mPref) continue;

    const postal = mZip[1] + '-' + mZip[2];
    const pref   = mPref[0];
    const afterPref = line.slice(line.indexOf(pref) + pref.length).trim();

    const locM = afterPref.match(/^([^\s、,，]+?(市|区|郡|町|村))/);
    const locality = locM ? locM[1] : '';

    let rest = afterPref.slice(locality.length).replace(/^、|^,|^，/, '').trim();
    rest = rest.replace(/^〒?\s?\d{3}-?\d{4}\s*/, '').trim();

    const addr = {
      postalCode: postal,
      addressRegion: pref,
      addressLocality: locality || undefined,
      streetAddress: rest || undefined,
      addressCountry: 'JP'
    };
    return addr;
  }
  return null;
}

// -------------------- 設立（STRICT: DOM/HTML構造のみ） --------------------
const FOUNDED_MODE = process.env.SCRAPE_FOUNDED_MODE || 'strict'; // 'strict' | 'off'

function parseJpDateToISO(input) {
  if (!input) return '';
  const t = String(input).replace(/\s+/g, '');
  const m = t.match(/((?:19|20)\d{2})\D{0,5}(\d{1,2})\D{0,5}(\d{1,2})/);
  if (!m) return '';
  const Y = String(m[1]).padStart(4, '0');
  const M = String(m[2]).padStart(2, '0');
  const D = String(m[3]).padStart(2, '0');
  const iso = `${Y}-${M}-${D}`;
  const dt = new Date(iso);
  return (!Number.isNaN(+dt) && (dt.getUTCMonth() + 1) === Number(M)) ? iso : '';
}

async function getFoundingFromDOM(page) {
  try {
    const txt = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      // 1) <dl><dt>設立</dt><dd>…</dd>
      for (const dt of Array.from(document.querySelectorAll('dl dt'))) {
        if (/設立|創業/.test(dt.textContent || '')) {
          const dd = dt.nextElementSibling;
          if (dd) return clean(dd.textContent || '');
        }
      }
      // 2) <table><th>設立</th><td>…</td>
      for (const th of Array.from(document.querySelectorAll('table th'))) {
        if (/設立|創業/.test(th.textContent || '')) {
          const td = th.nextElementSibling;
          if (td) return clean(td.textContent || '');
        }
      }
      return '';
    }).catch(() => '');
    return parseJpDateToISO(txt) || '';
  } catch { return ''; }
}

function getFoundingFromHTML(html) {
  if (!html) return '';
  const h = String(html);

  // dt/dd
  let m = h.match(/<dt[^>]*>\s*(?:設立|創業)\s*<\/dt>[\s\S]{0,200}?<dd[^>]*>\s*([\s\S]*?)\s*<\/dd>/i);
  if (m && m[1]) {
    const raw = m[1].replace(/<[^>]+>/g, ' ');
    const iso = parseJpDateToISO(raw);
    if (iso) return iso;
  }
  // th/td
  m = h.match(/<th[^>]*>\s*(?:設立|創業)\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
  if (m && m[1]) {
    const raw = m[1].replace(/<[^>]+>/g, ' ');
    const iso = parseJpDateToISO(raw);
    if (iso) return iso;
  }
  // タグ剥がし後の「設立/創業 19xx …」
  const flat = h.replace(/<[^>]+>/g, ' ');
  const near = flat.match(/(設立|創業)[^\d]{0,30}((?:19|20)\d{2})[^\d]{0,8}(\d{1,2})[^\d]{0,8}(\d{1,2})/);
  if (near) {
    return parseJpDateToISO(`${near[2]}-${near[3]}-${near[4]}`);
  }
  return '';
}

// ================== Scoring core (add to index.js) ==================
const cheerio = require('cheerio');

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function pct(x, min, max){
  if (max <= min) return 0;
  return clamp01((x - min) / (max - min));
}
function toScore(x){ return Math.round(clamp01(x) * 100); }
function safe(s){ return (s==null?'':String(s)); }

function parseJsonLdList(jsonldRaw) {
  // jsonldRaw は配列 or 文字列 or オブジェクトの可能性がある
  if (!jsonldRaw) return [];
  if (Array.isArray(jsonldRaw)) return jsonldRaw.filter(Boolean);
  if (typeof jsonldRaw === 'string') {
    try { 
      const v = JSON.parse(jsonldRaw);
      return Array.isArray(v) ? v : [v];
    } catch { return []; }
  }
  if (typeof jsonldRaw === 'object') return [jsonldRaw];
  return [];
}
function flatTypesFromJsonLd(arr) {
  const types = new Set();
  for (const node of arr) {
    const t = node && node['@type'];
    if (!t) continue;
    if (Array.isArray(t)) t.forEach(x => types.add(String(x)));
    else types.add(String(t));
    // @graph 内まで掘る
    if (node['@graph'] && Array.isArray(node['@graph'])) {
      for (const g of node['@graph']) {
        const tg = g && g['@type'];
        if (Array.isArray(tg)) tg.forEach(x => types.add(String(x)));
        else if (tg) types.add(String(tg));
      }
    }
  }
  return Array.from(types);
}
function countIf(arr, pred){ return arr.reduce((a,x)=>a+(pred(x)?1:0),0); }

function analyzeHtmlBasics(html) {
  const $ = cheerio.load(html || '');
  const title = $('head > title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const lang = $('html').attr('lang') || '';

  // セマンティック要素
  const semanticTags = ['header','nav','main','article','section','aside','footer'];
  const semanticCount = semanticTags.reduce((a,t)=>a + $(t).length, 0);

  // 見出し
  const h1s = $('h1');
  const h2s = $('h2');
  const h3s = $('h3');
  const headings = $('h1,h2,h3,h4,h5,h6').get().map(e => Number(e.tagName.slice(1)));
  // レベル飛び検出（例: h2→h4 など）
  let levelJumps = 0;
  for (let i=1; i<headings.length; i++) {
    const prev = headings[i-1], cur = headings[i];
    if (cur > prev+1) levelJumps++;
  }

  // 画像の alt 率
  const imgs = $('img');
  const imgCount = imgs.length;
  const imgAltCount = imgs.filter((_,el)=>!!$(el).attr('alt')).length;
  const imgAltRatio = imgCount ? (imgAltCount / imgCount) : 1;

  // aタグのラベル性（hrefだけ、"詳しくはこちら"のみ等は弱い）
  const links = $('a').get();
  const meaningfulLinks = links.filter(a=>{
    const txt = ($(a).text() || '').trim();
    if (!txt) return false;
    const ng = ['こちら','click','詳しくはこちら','more','詳細','read more'];
    return !ng.includes(txt.toLowerCase());
  }).length;
  const linkRatio = links.length ? meaningfulLinks/links.length : 1;

  // Open Graph / Twitter Card
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogDesc  = $('meta[property="og:description"]').attr('content') || '';
  const twCard  = $('meta[name="twitter:card"]').attr('content') || '';

  // パンくず（構造 or 見た目）
  const hasBreadcrumbDom = $('.breadcrumb, nav[aria-label="breadcrumb"]').length > 0;

  return {
    title, metaDesc, lang, semanticCount,
    h1Count: h1s.length, h2Count: h2s.length, h3Count: h3s.length,
    levelJumps, imgCount, imgAltRatio, linkRatio,
    hasBreadcrumbDom, hasOg: !!(ogTitle||ogDesc), hasTwitterCard: !!twCard,
  };
}

function analyzeTextReadability(bodyText) {
  const text = safe(bodyText);
  // 句点で文を割る（日本語想定）
  const sentences = text.split(/。|\n/).map(s=>s.trim()).filter(Boolean);
  const charLen = (s)=>s.replace(/\s/g,'').length;

  const lens = sentences.map(charLen);
  const totalChars = lens.reduce((a,b)=>a+b,0);
  const avgLen = sentences.length ? totalChars / sentences.length : 0;

  // 長すぎる文の割合（80文字超）
  const longRatio = sentences.length ? (countIf(lens, L=>L>80) / sentences.length) : 0;

  // 箇条書きの有無（"- "や"・"の頻度）
  const bullets = (text.match(/(^|\n)\s*[-・＊*●◼︎]/g) || []).length;

  // 漢字だらけ判定を軽く（記号除去後のひらがなカタカナ比率）
  const onlyChars = text.replace(/[\s0-9!-~、。・…—―「」『』（）【】［］【】\u3000]/g,'');
  const hiraKata = (onlyChars.match(/[ぁ-んァ-ヶ]/g) || []).length;
  const ratioHiraKata = onlyChars.length ? (hiraKata / onlyChars.length) : 0;

  return { sentences: sentences.length, avgLen, longRatio, bullets, ratioHiraKata };
}

function analyzeCoverage(bodyText, html) {
  const hay = (safe(bodyText) + '\n' + safe(html)).toLowerCase();
  // 意思決定に効く情報がサイトに揃っているか（キーワード網羅）
  const keys = [
    'サービス','製品','特徴','強み','実績','事例','導入','料金','価格','費用',
    '比較','プラン','サポート','faq','よくある質問','お問い合わせ','連絡先',
    '会社概要','アクセス','採用','メンバー','チーム','ブログ','ニュース'
  ];
  const hits = countIf(keys, k => hay.indexOf(k.toLowerCase()) >= 0);
  // セクションの多様性（article/section/ul/table）
  const $ = cheerio.load(html||'');
  const diversity = ['article','section','ul','ol','table','dl','figure'].reduce((a,t)=>a + ($(t).length>0?1:0), 0);
  return { keysTotal: keys.length, keysHit: hits, diversity };
}

function analyzeTrust(bodyText, html, url) {
  const text = (safe(bodyText) + '\n' + safe(html)).toLowerCase();
  const trustKeys = [
    '会社概要','企業情報','特定商取引','プライバシーポリシー','個人情報保護','利用規約',
    '住所','所在地','電話','tel','お問い合わせ','責任者','監修','著者','発行日','更新日'
  ];
  const trustHits = countIf(trustKeys, k => text.indexOf(k.toLowerCase()) >= 0);

  // 住所・電話の露出（実体文字）
  const hasPhone = /tel[:：]?\s*\+?\d|\d{2,4}-\d{2,4}-\d{3,4}/i.test(text);
  const hasAddr  = /(東京都|北海道|京都府|大阪府|..県|..市|丁目|番地)/.test(text);

  // 組織系のJSON-LD
  // 呼び出し側で typesFromJsonLd を渡してもらう
  return { trustHits, hasPhone, hasAddr, isHttps: /^https:\/\//i.test(url||'') };
}

// ---- 各スコア（0-100） ----
function scoreDataStructure(htmlBasics, types) {
  // 要素: title, meta desc, セマンティック要素数, 画像alt率, 意味のあるリンク率, OG/TwitterCard, パンくず, JSON-LDの量
  const hasTitle = htmlBasics.title.length > 0;
  const hasDesc  = htmlBasics.metaDesc.length > 30;
  const semScore = clamp01(htmlBasics.semanticCount / 4);   // 4種以上で頭打ち
  const altScore = htmlBasics.imgAltRatio;                  // 0-1
  const linkScore= htmlBasics.linkRatio;                    // 0-1
  const ogScore  = htmlBasics.hasOg ? 1 : 0;
  const twScore  = htmlBasics.hasTwitterCard ? 1 : 0;
  const bcScore  = htmlBasics.hasBreadcrumbDom ? 1 : 0;
  const jsonldScore = clamp01(types.length / 4);            // 4タイプ（WebSite/WebPage/Org/Breadcrumb/FAQ等）で満点

  const w = {title:.10, desc:.10, sem:.15, alt:.10, link:.10, og:.05, tw:.05, bc:.05, jsonld:.30};
  const v = (hasTitle?w.title:0) + (hasDesc?w.desc:0) + semScore*w.sem + altScore*w.alt +
            linkScore*w.link + ogScore*w.og + twScore*w.tw + bcScore*w.bc + jsonldScore*w.jsonld;
  return toScore(v);
}

function scoreDocumentStructure(htmlBasics, html) {
  const $ = cheerio.load(html||'');
  const headings = $('h1,h2,h3,h4,h5,h6').get().map(e => Number(e.tagName.slice(1)));
  const hasH1 = htmlBasics.h1Count === 1;            // h1は1つが理想
  const hasH2 = htmlBasics.h2Count > 0;
  const notJump = htmlBasics.levelJumps === 0;
  const paraCount = $('p').length;
  const listCount = $('ul,ol').length;
  const tableCount = $('table').length;

  const w = {h1:.25, h2:.15, notJump:.20, para:.20, list:.10, table:.10};
  const paraScore = clamp01(paraCount / 10);     // 段落10以上で頭打ち
  const listScore = clamp01(listCount / 3);      // 3つ以上で頭打ち
  const tableScore= clamp01(tableCount / 1);     // 1つでOK

  const v = (hasH1?w.h1:0) + (hasH2?w.h2:0) + (notJump?w.notJump:0) +
            paraScore*w.para + listScore*w.list + tableScore*w.table;
  return toScore(v);
}

function scoreClarity(textStats) {
  // 平均文長が短く、長文比が低く、箇条書きある、ひらカナ比率がそれなりにある → 高得点
  const sLen = 1 - clamp01((textStats.avgLen - 40) / (120 - 40)); // 40〜120 で線形
  const sLong= 1 - clamp01(textStats.longRatio);                   // 長文比が低いほど良い
  const sBul = clamp01(textStats.bullets / 5);                     // 箇条書き（最大5で頭打ち）
  const sKana= clamp01(textStats.ratioHiraKata / 0.5);             // かな比 0.5 で満点（難語だらけ抑制）

  const w = {len:.35,long:.25,bul:.20,kana:.20};
  const v = clamp01(sLen)*w.len + clamp01(sLong)*w.long + sBul*w.bul + sKana*w.kana;
  return toScore(v);
}

function scoreCoverage(cov) {
  const k = clamp01(cov.keysHit / Math.max(6, cov.keysTotal)); // 主要6個以上で頭打ち
  const d = clamp01(cov.diversity / 5);                         // 5要素で満点
  const v = k*0.7 + d*0.3;
  return toScore(v);
}

function scoreTrust(tr, types) {
  const hasOrg = types.includes('Organization') || types.includes('LocalBusiness') || types.includes('Corporation');
  const hasContact = types.includes('ContactPoint');
  const hasBreadcrumb = types.includes('BreadcrumbList');
  const base = clamp01(tr.trustHits / 6);     // 信頼系の露出 6項目で満点
  const bonus = (tr.hasPhone?0.1:0) + (tr.hasAddr?0.1:0) + (tr.isHttps?0.1:0) +
                (hasOrg?0.1:0) + (hasContact?0.05:0) + (hasBreadcrumb?0.05:0);
  return toScore(clamp01(base + bonus));
}

function rankFromAvg(avg){
  const n = Number(avg)||0;
  if (n >= 85) return 'A';
  if (n >= 70) return 'B';
  if (n >= 55) return 'C';
  if (n >= 40) return 'D';
  return 'E';
}

function buildDescriptions({data,doc,clar,cov,tr}) {
  return {
    'データ構造': `title/description/セマンティック要素:${data.semanticCount}，画像alt率:${Math.round(data.imgAltRatio*100)}%，リンク可読率:${Math.round(data.linkRatio*100)}%。JSON-LDタイプ:${data.types.join(', ') || 'なし'}`,
    '文書構造': `h1:${doc.h1Count}，h2:${doc.h2Count}，見出しのレベル飛び:${doc.levelJumps}。段落・箇条書き・表の整備状況を評価。`,
    '表現の明確さ': `平均文長:${Math.round(clar.avgLen)}字，長文比:${Math.round(clar.longRatio*100)}%，箇条書き:${clar.bullets}，かな比:${Math.round(clar.ratioHiraKata*100)}%。`,
    '情報網羅性': `意思決定キーワード命中:${cov.keysHit}/${cov.keysTotal}，コンテンツ多様性:${cov.diversity}。`,
    '信頼性': `信頼キーワード命中:${tr.trustHits}，電話:${tr.hasPhone?'◯':'×'}，住所:${tr.hasAddr?'◯':'×'}，HTTPS:${tr.isHttps?'◯':'×'}. JSON-LD(Org/Contact/Breadcrumb):${data.flags.org? '◯':'×'}/${data.flags.contact? '◯':'×'}/${data.flags.bc? '◯':'×'}`,
  };
}

// scraped: { url, html, bodyText, jsonld, structured, jsonldSynth }
function buildScoresFromScrape(scraped) {
  const url = scraped.url || '';
  const html = (scraped.scoring && scraped.scoring.html)     || scraped.html  || '';
  const body = (scraped.scoring && scraped.scoring.bodyText) || scraped.bodyText || '';

  // JSON-LD（現状=Before）
  const jsonldArr = parseJsonLdList(scraped.jsonld);
  const types = flatTypesFromJsonLd(jsonldArr);

  const htmlBasics = analyzeHtmlBasics(html);
  const textStats  = analyzeTextReadability(body);
  const cov        = analyzeCoverage(body, html);
  const tr         = analyzeTrust(body, html, url);

  const sData = scoreDataStructure({...htmlBasics, types, flags:{
    org: types.includes('Organization') || types.includes('LocalBusiness') || types.includes('Corporation'),
    contact: types.includes('ContactPoint'),
    bc: types.includes('BreadcrumbList')
  }}, types);
  const sDoc  = scoreDocumentStructure(htmlBasics, html);
  const sClr  = scoreClarity(textStats);
  const sCov  = scoreCoverage(cov);
  const sTr   = scoreTrust(tr, types);

  const beforeScores = [sData, sDoc, sClr, sCov, sTr];
  const avgBefore = Math.round(beforeScores.reduce((a,b)=>a+b,0)/beforeScores.length);

  // ==== After（JSON-LD強化があれば “その分だけ” 反映）====
  // scraped.jsonldSynth に FAQPage / BreadcrumbList / Organization 等が含まれていれば、
  // データ構造＋（該当時のみ）網羅性を実増。文書構造/明確さ/信頼性は基本据え置き。
  let afterScores = beforeScores.slice(0);
  const synthArr = parseJsonLdList(scraped.jsonldSynth || scraped.structured);
  if (synthArr.length) {
    const t2 = flatTypesFromJsonLd(synthArr);

    // データ構造の再計算（types を置換）
    const sDataAfter = scoreDataStructure({...htmlBasics, types:t2, flags:{
      org: t2.includes('Organization') || t2.includes('LocalBusiness') || t2.includes('Corporation'),
      contact: t2.includes('ContactPoint'),
      bc: t2.includes('BreadcrumbList')
    }}, t2);

    // FAQPageやItemListが入った場合のみ “情報網羅性” を小幅に見直す
    const hasFaq = t2.includes('FAQPage');
    const hasItemList = t2.includes('ItemList');
    const sCovAfter = hasFaq || hasItemList ? Math.max(sCov, Math.min(100, sCov + 10)) : sCov;

    afterScores = [sDataAfter, sDoc, sClr, sCovAfter, sTr];
  }

  const avgAfter = Math.round(afterScores.reduce((a,b)=>a+b,0)/afterScores.length);

  return {
    url,
    beforeScores,
    afterScores,
    avgBeforeScore: avgBefore,
    avgAfterScore:  avgAfter,
    beforeRank: rankFromAvg(avgBefore),
    afterRank:  rankFromAvg(avgAfter),
    descriptions: buildDescriptions({
      data:{...htmlBasics, types, flags:{
        org: types.includes('Organization') || types.includes('LocalBusiness') || types.includes('Corporation'),
        contact: types.includes('ContactPoint'),
        bc: types.includes('BreadcrumbList')
      }},
      doc: htmlBasics, clar: textStats, cov, tr
    }),
    meta: {
      scoringVersion: '1.0.0 (/scrape integrated)',
      generatedAt: new Date().toISOString(),
    }
  };
}
// ================== end Scoring core ==================

// -------------------- /scrape --------------------
// 同時実行を抑制して OOM を予防（環境変数 SCRAPE_CONCURRENCY で調整可能）
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 2);
const queue = new PQueue({ concurrency: CONCURRENCY });

app.get('/scrape', async (req, res) => {
  // キューに積んだ Promise を必ず返す（Express が先に切られないように）
  return queue.add(() => scrapeOnce(req, res)).catch(err => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'queue_error', message: String(err) });
    }
  });
});

async function scrapeOnce(req, res) {
  const urlToFetch = req.query.url;

  // allow: /scrape?url=...&nocache=1 でキャッシュをバイパス
  const noCache = String(req.query.nocache || '').toLowerCase() === '1';

  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  // --- CACHE CHECK (early return) ---
  try {
    if (!noCache) {
      const cached = cacheGet(urlToFetch);
      if (cached && cached.json) {
        const payload = JSON.parse(JSON.stringify(cached.json));
        if (!payload.debug) payload.debug = {};
        payload.debug.cache = { hit: true, ageMs: cached.age, ttlMs: CACHE_TTL_MS, nocache: false };

        console.log('[TRACE_COVNAV][NODE][cache-hit-return]', {
          url: urlToFetch,
          hasAuditSig: !!payload.auditSig,
          hasCoverageNav: !!(payload.auditSig && payload.auditSig.coverageNav),
          coverageNav: payload.auditSig && payload.auditSig.coverageNav
        });

        return res.status(200).json(payload);
      }
    }
  } catch(_) {}

  // メモリが既に逼迫している場合はソフトフェイル（Render の再起動ループ回避）
  const RSS_HARD_LIMIT = Number(process.env.RSS_HARD_LIMIT || 900 * 1024 * 1024); // ~900MB 目安
  if (process.memoryUsage().rss > RSS_HARD_LIMIT) {
    return res.status(503).json({ error: 'over_memory_limit', hint: 'reduce concurrency or upgrade instance' });
  }

  let browser = null;
  let context = null;
  let page = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      // 共有メモリ不足・GPU初期化失敗・権限周りのクラッシュを抑止
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                 'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                 'Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    page = await context.newPage();
    // デフォルトタイムアウト（ENV で調整可）
    const NAV_TIMEOUT_MS   = Number(process.env.SCRAPE_NAV_TIMEOUT_MS   || 20000);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

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

    // === ここから追記（本文長しきい値で待機）===
    await page.waitForFunction(() => {
      const hasHeader = !!document.querySelector('header,[role="banner"]');
      const hasFooter = !!document.querySelector('footer,[role="contentinfo"]');
      const hasMain   = !!document.querySelector('main,[role="main"]');
      return hasHeader || hasFooter || hasMain;
    }, { timeout: 8000 }).catch(()=>{});

    // ---- dt/th に「設立|創業」が現れるまで最大 8 秒待つ（柔らかく）----
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

  // === ここから追記（Shadow DOMも含めて深くテキストを収集）===
  const deepText = await page.evaluate(() => {
    const seen = new WeakSet();
    const getText = (root) => {
      let out = '';
      const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (node.nodeType === Node.TEXT_NODE) {
          out += (node.nodeValue || '') + '\n';
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const sr = node.shadowRoot;
          if (sr) Array.from(sr.childNodes).forEach(walk);   // Shadow root
          Array.from(node.childNodes).forEach(walk);         // 通常DOM
        }
      };
      walk(root);
      return out.replace(/\s+\n/g, '\n').trim();
    };
    return getText(document.documentElement);
  }).catch(() => '');

  // === ここからさらに追記（meta description を head から直接取る）===
  const metaDescription = await page.evaluate(() => {
    const el = document.head?.querySelector(
      'meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]'
    );
    return el?.getAttribute('content')?.replace(/\s+/g, ' ').trim() || '';
  });

  // “描画本文”として優先利用
  const renderedText = (deepText && deepText.replace(/\s+/g,'').length > 120)
    ? deepText
    : (innerText || docText || '');

  // --- トップと /about の JSON-LD を比較 ---
  const targetUrl = normalizeUrl(urlToFetch);
  const u = new URL(targetUrl);
  const topUrl   = u.origin + '/';
  const aboutUrl = u.origin + '/about';

  // HTML を取得（ナビゲーションはしない・request 経由）
  let topHtml = '';
  let aboutHtml = '';
  try {
    const r1 = await page.request.get(topUrl, { timeout: 20000 });
    if (r1.ok()) topHtml = await r1.text();
  } catch(_) {}
  try {
    const r2 = await page.request.get(aboutUrl, { timeout: 20000 });
    if (r2.ok()) aboutHtml = await r2.text();
  } catch(_) {}

  const jsonldTopAll   = extractJsonLdFromHtml(topHtml);
  const jsonldAboutAll = extractJsonLdFromHtml(aboutHtml);
  const jsonldPref     = preferAboutJsonLd(jsonldTopAll, jsonldAboutAll);

  const gtmTop   = hasGtmOrExternal(topHtml);
  const gtmAbout = hasGtmOrExternal(aboutHtml);

  // 既存の jsonld（動的レンダリングで拾った分）があればそのまま維持しつつ、比較結果は debug に載せる

    // ---- HTMLソース（タグあり）----
    const htmlSource = await page.content().catch(() => '');

    // ---- 設立（STRICT: DOM/HTML 構造のみ）----
    let foundFoundingDate = '';
    let foundFoundingDateSource = null;

    if (FOUNDED_MODE !== 'off') {
      const domIso = await getFoundingFromDOM(page);
      if (domIso) { foundFoundingDate = domIso; foundFoundingDateSource = 'dom'; }
      if (!foundFoundingDate) {
        const htmlIso = getFoundingFromHTML(htmlSource);
        if (htmlIso) { foundFoundingDate = htmlIso; foundFoundingDateSource = 'html'; }
      }
    }

    // ---- sameAs（ページ内 a[href] & HTML直書きURL）----
    const bundleSameAs = [];
    const SOCIAL_HOST_RE = /(twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|linkedin\.com|note\.com|wantedly\.com|tiktok\.com)/i;

    const anchorHrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href') || '').filter(Boolean)).catch(()=>[]);
    for (const href of anchorHrefs) {
      try {
        const u = new URL(href, urlToFetch);
        if (SOCIAL_HOST_RE.test(u.hostname)) bundleSameAs.push(u.toString());
      } catch(_) {}
    }
    try {
      const resp0 = await page.request.get(urlToFetch, { timeout: 20000 });
      if (resp0.ok()) {
        const html0 = await resp0.text();
        const urlMatches0 = html0.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches0) {
          try {
            const host = new URL(rawUrl).hostname;
            if (SOCIAL_HOST_RE.test(host)) bundleSameAs.push(String(rawUrl));
          } catch (_) {}
        }
      }
    } catch {}

    // ---- JSON-LD（参考）----
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // === [JSONLD][ORG-WEBSITE-FLAGS v1] Org / WebSite 用フラグを算出 ===
    // /about 優先の JSON-LD（jsonldPref）があればそれを SSOT として採用し、
    // 無ければ DOM から拾った jsonld を使う。
    const jsonldForFlags = (Array.isArray(jsonldPref) && jsonldPref.length)
      ? jsonldPref
      : (Array.isArray(jsonld) ? jsonld : []);

    const jsonldTypesAll = flatTypesFromJsonLd(jsonldForFlags);

    // const hasJsonLdFlag =
    //   Array.isArray(jsonldForFlags) && jsonldForFlags.length > 0;

    // const hasOrgJsonLdFlag = jsonldTypesAll.some(t =>
    //   /^(Organization|Corporation|LocalBusiness)$/i.test(String(t))
    // );

    // const hasWebsiteJsonLdFlag = jsonldTypesAll.some(t =>
    //   /^(WebSite|WebPage)$/i.test(String(t))
    // );

    // ---- script/src と modulepreload から JS 候補URLを収集 ----
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });
    const abs = (u) => { try { return new URL(u, urlToFetch).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // --- ページで読み込まれたリソース一覧から JSON 系も拾う（電話/住所/同社SNSのみに使用）---
    const resourceUrls = await page.evaluate(() => {
      try {
        return performance.getEntriesByType('resource')
          .map(e => e.name)
          .filter(Boolean);
      } catch { return []; }
    });
    const extraJsonUrls = uniq(resourceUrls.filter(u =>
      /(\.json(\?|$))|googleapis|sheets|gviz|cms|data/i.test(u)
    ));
    const jsonToTap = extraJsonUrls.filter(u => !jsUrls.includes(u));

    // ---- 正規表現（電話/郵便のみ）----
    const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
    const ZIP_RE   = /〒?\d{3}-?\d{4}/g;

    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];
    const fetchedMeta  = [];
    const tappedUrls   = [];
    const tappedAppIndexBodies = [];
    const labelHitPhones = [];
    const LABEL_RE = /(代表電話|代表|電話|お問い合わせ|TEL|Tel|Phone)/i;

    // tel:リンク
    const telLinks = await page.$$eval('a[href^="tel:"]',
      as => as.map(a => (a.getAttribute('href') || '')
        .replace(/^tel:/i,'')
        .replace(/^\+81[-\s()]?/,'0')
        .trim()
      )
    ).catch(()=>[]);

    // --- リソース由来の JSON（電話/住所/同社SNSのみに使用）---
    for (const u of jsonToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 10000 });
        if (!resp.ok()) continue;
        const body = await resp.text();
        if (!body) continue;

        const raw = body;
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

        // sameAs（JSON内の直書きURL）
        const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches) {
          try {
            const p = new URL(rawUrl);
            if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
          } catch(_) {}
        }
      } catch {}
    }

    // ページが教えてくれたJS候補 + 典型的なエントリ
    const jsToTap = uniq([
      ...jsUrls,
      `${new URL(urlToFetch).origin}/app-index.js`
    ]);

    // ---- JS/JSON 本文を取得して抽出（※設立は見ない）----
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

        const raw = text || '';
        const decoded = decodeUnicodeEscapes(raw);
        const scan = raw + '\n' + decoded;

        tappedUrls.push(u);
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

        // 住所っぽい行
        for (const line of scan.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
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
    }

    // -------- 2nd pass: app-index.js が参照する chunk-*.js を最大 8 本だけ追撃（※設立は見ない）--------
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
        if (count++ >= 8) break;
        try {
          const resp = await page.request.get(u, { timeout: 15_000 });
          if (!resp.ok()) continue;
          const ct = (resp.headers()['content-type'] || '').toLowerCase();
          if (!(ct.includes('javascript') || u.endsWith('.js'))) continue;

          const text = await resp.text();
          if (!text) continue;

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

    // === ここから追記（“採点に使う素材”を決定：Rendered > 静的HTML）===
    const scoringHtml  = (aboutHtml || topHtml || htmlSource || '');
    const scoringBodyA = renderedText || '';
    const scoringBodyB = stripTags(scoringHtml);
    const scoringBody  = (scoringBodyA.replace(/\s+/g,'').length >= 200) ? scoringBodyA : scoringBodyB;

    // === JSON-LD の実出現をピンポイント待機（最大 20 秒に延長） ===
    await page.waitForFunction(() => {
      return !!document.querySelector('script[type="application/ld+json" i]');
    }, { timeout: 20000 }).catch(()=>{}); // ← 12s→20s に延長

    // === 出現後スナップショット（短時間プローブ） ===
    const __probe = await probeJsonLdAndCopyright(page, { maxWaitMs: 600, pollMs: 100 });

    // === Fallback: app-index.js 内の JSON-LD リテラル検出（DOM挿入前でも実装あり扱い） ===
    try {
      if (!__probe.jsonld_detected_once) {
        const jsBodies = Array.isArray(tappedAppIndexBodies) ? tappedAppIndexBodies : [];
        const hit = jsBodies.find(txt =>
          /"@context"\s*:\s*"https?:\/\/schema\.org"/i.test(txt) ||
          /type\s*[:=]\s*["']application\/ld\+json["']/i.test(txt)
        );
        if (hit) {
          const start = hit.indexOf('{');
          const head = start >= 0 ? hit.slice(start, start + 80) : hit.slice(0, 80);

          // 1) JSON-LD が「ありそう」というフラグ類
          __probe.jsonld_detected_once = true;
          __probe.jsonld_detect_count  = Math.max(1, __probe.jsonld_detect_count || 0);
          __probe.jsonld_timed_out     = false;
          __probe.jsonld_sample_head   = head;

          // 2) "@type" をざっくり抜き出して jsonld_types に積む
          try {
            const types = [];
            const re = /"@type"\s*:\s*"([^"]+)"/g;
            let m;
            while ((m = re.exec(hit)) !== null) {
              const typ = (m[1] || '').trim();
              if (typ) types.push(typ);
            }
            if (types.length) {
              const uniqTypes = Array.from(new Set(types));
              if (!Array.isArray(__probe.jsonld_types)) {
                __probe.jsonld_types = uniqTypes;
              } else {
                __probe.jsonld_types = Array.from(
                  new Set(__probe.jsonld_types.concat(uniqTypes))
                );
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // === Fallback（コピーライト）：CSR前でも静的/レンダ済みから検知 ===
    try {
      if (!__probe.copyright_hit) {
        const hayA = (typeof scoringHtml === 'string' ? scoringHtml : '') + '\n' + (renderedText || '');
        const hayB = htmlSource || '';
        const re = /©|&copy;|&#169;|copyright|コピーライト|著作権/i;

        const hitA = re.test(hayA);
        const hitB = re.test(hayB);

        if (hitA || hitB) {
          const src = hitA ? hayA : hayB;
          const i = src.search(re);
          const excerpt = i >= 0 ? src.slice(Math.max(0, i - 10), i + 90) : src.slice(0, 100);

          __probe.copyright_hit = true;
          __probe.copyright_hit_token = '©';
          __probe.copyright_excerpt = excerpt;
        }
      }
    } catch (_) {}

    // === Fallback: app-index.js 内の JSON-LD リテラル検出（DOM挿入前でも実装ありとみなす） ===
    try {
      if (!__probe.jsonld_detected_once) {
        // すでに上流で収集済み（/app-index.js の本文）
        const jsBodies = Array.isArray(tappedAppIndexBodies) ? tappedAppIndexBodies : [];
        const hit = jsBodies.find(txt =>
          /"@context"\s*:\s*"https?:\/\/schema\.org"/i.test(txt) ||
          /type\s*[:=]\s*["']application\/ld\+json["']/i.test(txt)
        );
        if (hit) {
          const start = hit.indexOf('{');
          const head = start >= 0 ? hit.slice(start, start + 80) : hit.slice(0, 80);
          __probe.jsonld_detected_once = true;
          __probe.jsonld_detect_count = Math.max(1, __probe.jsonld_detect_count || 0);
          __probe.jsonld_timed_out = false;
          __probe.jsonld_sample_head = head;
        }
      }
    } catch (_) {}

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
      "url": normalizeUrl(urlToFetch),
      "name": "企業情報",
      ...(pickedPhone ? { "telephone": pickedPhone } : {}),
      ...(pickedAddress ? { "address": { "@type": "PostalAddress", ...pickedAddress } } : {}),
      ...(sameAsClean && sameAsClean.length ? { "sameAs": sameAsClean } : {}),
      ...(foundFoundingDate ? { "foundingDate": foundFoundingDate } : {})
    }];

    const elapsedMs = Date.now() - t0;

    // === JSON-LD 種別フラグ（Org / WebSite）を算出 ===
    let hasJsonLdFlag = false;
    let hasOrgJsonLdFlag = false;
    let hasWebsiteJsonLdFlag = false;

    try {
      // /about 側を優先して JSON-LD を見る（なければトップ or DOM 由来）
      const baseJsonLd = Array.isArray(jsonldPref) && jsonldPref.length
        ? jsonldPref
        : jsonld;

      const flatTypes = flatTypesFromJsonLd(baseJsonLd || []);

      hasJsonLdFlag = !!(baseJsonLd && baseJsonLd.length > 0);
      hasOrgJsonLdFlag = flatTypes.some(t =>
        /^(Organization|LocalBusiness|Corporation)$/i.test(String(t))
      );
      hasWebsiteJsonLdFlag = flatTypes.some(t =>
        /^(WebSite|WebPage)$/i.test(String(t))
      );

      // （必要ならデバッグ用ログ）
      // console.log('[JSONLD-FLAGS][probe]', {
      //   hasJsonLdFlag, hasOrgJsonLdFlag, hasWebsiteJsonLdFlag, flatTypes
      // });
    } catch (_) {
      // フラグ計算に失敗しても全体は止めない
    }

    // ★ 追加: head/meta + JSON-LD + コピーライトをまとめた auditSig を構築
    let auditSig = null;
    try {
      auditSig = await buildAuditSigFromPage(page);
    } catch (_) {
      auditSig = null;  // 失敗しても全体は止めない
    }

    // ★ 追記: auditSig.jsonldTypes で Org / WebSite フラグを補強
    try {
      if (auditSig && Array.isArray(auditSig.jsonldTypes)) {
        const typesFromAudit = auditSig.jsonldTypes.map(t => String(t || ''));

        // 何か 1 つでも type があれば「JSON-LD あり」とみなす
        if (!hasJsonLdFlag && typesFromAudit.length > 0) {
          hasJsonLdFlag = true;
        }

        // Organization / Corporation / LocalBusiness が 1 つでもあれば Org フラグ ON
        if (!hasOrgJsonLdFlag &&
            typesFromAudit.some(t => /(Organization|Corporation|LocalBusiness)/i.test(t))) {
          hasOrgJsonLdFlag = true;
        }

        // WebSite / WebPage があれば WebSite フラグ ON（あれば）
        if (!hasWebsiteJsonLdFlag &&
            typesFromAudit.some(t => /(WebSite|WebPage)/i.test(t))) {
          hasWebsiteJsonLdFlag = true;
        }
      }
    } catch (_) {
      // 補強に失敗しても全体は止めない
    }

  // ★ coverage ナビフラグ：/about やトップのHTMLを優先しつつ検出
  const coverageNav = detectCoverageNavFromHtmlNode(
    topHtml || htmlSource || scoringHtml || bodyText
  );

  // ★ 追加：auditSig にも載せる（GAS 側で auditSig.coverageNav を参照できるように）
  if (auditSig && typeof auditSig === 'object') auditSig.coverageNav = coverageNav;

  // === XML サイトマップ有無チェック（/sitemap.xml 簡易判定） ===
  let hasSitemapXml = false;
  try {
    let origin = null;
    try {
      origin = new URL(urlToFetch).origin;
    } catch (_) {
      origin = null;
    }

    if (origin) {
      const sitemapUrl = origin.replace(/\/+$/, '') + '/sitemap.xml';

      const sitemapResp = await page.request.get(sitemapUrl, { timeout: 8000 });
      if (sitemapResp.ok()) {
        const ctype = (sitemapResp.headers()['content-type'] || '').toLowerCase();

        // content-type に xml が含まれていればほぼ sitemap とみなす
        if (ctype.includes('xml')) {
          hasSitemapXml = true;
        } else {
          // content-type が微妙な場合は先頭だけテキストを見て XML っぽいか確認
          const head = (await sitemapResp.text()).slice(0, 512);
          if (/^\s*</.test(head)) {
            hasSitemapXml = true;
          }
        }
      }
    }

    // auditSig があれば、ついでにそこにも載せておく（GAS 側互換用）
    if (auditSig && typeof auditSig === 'object') {
      auditSig.hasSitemapXml = hasSitemapXml;
    }
  } catch (_) {
    // 失敗しても診断全体は止めない（hasSitemapXml は false のまま）
  }

  const responsePayload = {
    url: urlToFetch,
    bodyText,
    html: htmlSource,

    // ★ 追加：レンダリング後のテキスト（deepText 優先）
    //   - GAS 側のナビ検出・嘘カードフィルタは、今後はこれを見る前提にする
    renderedText,

    jsonld,
    structured,
    jsonldSynth,
    scoring: { html: scoringHtml, bodyText: scoringBody },
    metaDescription,

    // ★ ADD: HTTPS 判定（GAS facts 用）
    isHttps: urlToFetch.startsWith('https://'),

    // ★ ADD: XML サイトマップ有無（GAS facts 用）
    hasSitemapXml,

    // ★ Org / WebSite JSON-LD フラグ（GAS v2 facts 用）
    hasJsonLd: hasJsonLdFlag,
    hasOrgJsonLd: hasOrgJsonLdFlag,
    hasWebsiteJsonLd: hasWebsiteJsonLdFlag,

    // === HEAD / META 情報を GAS に直接渡すフラグ（v2 facts 用） ===
    // Playwright 側の auditSig をそのまま噛ませる
    hasTitle:           auditSig ? !!auditSig.hasTitle           : false,
    hasMetaDescription: auditSig ? !!auditSig.hasMetaDescription : (
      typeof metaDescription === 'string' && metaDescription.trim().length > 0
    ),
    metaDescriptionLen: auditSig && typeof auditSig.metaDescriptionLen === 'number'
      ? auditSig.metaDescriptionLen
      : (typeof metaDescription === 'string' ? metaDescription.length : 0),

    // ★ NEW: JSON-LD 種別フラグ（Organization / WebSite）を計算して auditSig ＋トップレベルに載せる
    ...(function () {
      try {
        if (!auditSig || typeof auditSig !== 'object') return {};

        // JSON-LD ノード集合（優先: jsonldPref → なければ top+about）
        var nodes = [];
        if (Array.isArray(jsonldPref) && jsonldPref.length) {
          nodes = jsonldPref.slice();
        } else {
          if (Array.isArray(jsonldTopAll))   nodes = nodes.concat(jsonldTopAll);
          if (Array.isArray(jsonldAboutAll)) nodes = nodes.concat(jsonldAboutAll);
        }

        var hasOrg  = false;
        var hasSite = false;

        nodes.forEach(function (node) {
          if (!node || typeof node !== 'object') return;
          var t = node['@type'];
          var types = Array.isArray(t) ? t : (t ? [t] : []);

          types.forEach(function (tt) {
            if (typeof tt !== 'string') return;
            if (/Organization|Corporation|LocalBusiness/i.test(tt)) {
              hasOrg = true;
            }
            if (/WebSite/i.test(tt)) {
              hasSite = true;
            }
          });
        });

        // auditSig 自体にもフラグを書き込む（GAS 側では auditSig.hasOrgJsonLd で参照）
        auditSig.hasOrgJsonLd     = hasOrg;
        auditSig.hasWebsiteJsonLd = hasSite;

        // Node 環境なので console.log を使う
        try {
          console.log('[PW][JSONLD-FLAGS]', {
            hasOrgJsonLd: hasOrg,
            hasWebsiteJsonLd: hasSite,
            nodeCount: nodes.length
          });
        } catch (e) {}

        // トップレベル facts にもコピーして返す
        return {
          hasOrgJsonLd: hasOrg,
          hasWebsiteJsonLd: hasSite
        };
      } catch (e) {
        try {
          console.log('[PW][JSONLD-FLAGS][ERR]', String(e && e.stack || e));
        } catch (_) {}
        return {};
      }
    })(),

    // ★ NEW: GAS 側に渡す auditSig オブジェクト（従来通り＋新フラグ付き）
    auditSig,

    // === ADD: Playwright→GAS I/F（トップレベルで返す・互換用） ===
    jsonld_detected_once: auditSig ? auditSig.jsonldDetected       : __probe.jsonld_detected_once,
    jsonld_detect_count:  auditSig ? auditSig.jsonldCount          : __probe.jsonld_detect_count,
    jsonld_wait_ms:       __probe.jsonld_wait_ms,
    jsonld_timed_out:     auditSig ? auditSig.jsonldTimedOut       : __probe.jsonld_timed_out,
    jsonld_sample_head:   auditSig ? auditSig.jsonldSampleHead     : __probe.jsonld_sample_head,
    copyright_footer_present: auditSig ? auditSig.copyrightFooterPresent : __probe.copyright_footer_present,
    copyright_hit:           auditSig ? auditSig.copyrightHit           : __probe.copyright_hit,
    copyright_hit_token:     auditSig ? auditSig.copyrightHitToken      : __probe.copyright_hit_token,
    copyright_excerpt:       auditSig ? auditSig.copyrightExcerpt       : __probe.copyright_excerpt,

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
      jsonldTopCount: Array.isArray(jsonldTopAll) ? jsonldTopAll.length : 0,
      jsonldAboutCount: Array.isArray(jsonldAboutAll) ? jsonldAboutAll.length : 0,
      jsonldPreferredCount: Array.isArray(jsonldPref) ? jsonldPref.length : 0,
      jsonldPreferredHint: (Array.isArray(jsonldPref) && jsonldPref.length) ? 'about>top' : 'top_only_or_none',
      hasGtmTop: !!gtmTop,
      hasGtmAbout: !!gtmAbout,
      normalizedUrl: normalizeUrl(urlToFetch),
      labelHitPhones: Array.from(new Set(labelHitPhones)).slice(0,10),
      foundingDatePicked: foundFoundingDate || null,
      foundingDateSource: foundFoundingDate ? (foundFoundingDateSource || 'dom/html') : null,
      sameAsCount: new Set(sameAsClean).size,
      elapsedMs,

      // === ADD: デバッグ用にプローブ結果も残す（任意）
      jsonldProbe: __probe
    }
  }; // ← ここで必ず閉じる！

  // --- 追加: /scrape で採点も実施して返す ---
  const scoreBundle = buildScoresFromScrape(responsePayload); // 採点
  const out = { ...responsePayload, data: scoreBundle };      // data に採点結果を格納

  // --- CACHE SET（成功時のみ保存）
  try { if (!noCache) cacheSet(urlToFetch, out); } catch(_) {}

  out.debug = out.debug || {};
  if (noCache) out.debug.cache = { hit: false, nocache: true };

  // ★ COVNAV 最終スナップショット（必ず1回出る・検索しやすい）
  try{
    const covTop  = out && (out.coverageNav || out.coverageNavRaw);
    const covSig  = out && out.auditSig && out.auditSig.coverageNav;
    const covFact = out && out.facts && out.facts.auditSig && out.facts.auditSig.coverageNav;

    console.log('[COVNAV][SCRAPE][OUT v1]', {
      url: urlToFetch,
      has_cov_top:  !!covTop,
      has_cov_sig:  !!covSig,
      has_cov_fact: !!covFact,
      cov_top:  covTop || null,
      cov_sig:  covSig || null,
      cov_fact: covFact || null,
      auditSig_keys: out && out.auditSig ? Object.keys(out.auditSig).slice(0,40) : []
    });
  }catch(e){
    console.log('[COVNAV][SCRAPE][OUT v1][ERR]', String(e && (e.stack||e)));
  }

  // 正常終了
  return res.status(200).json(out);

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      error: 'scrape failed',
      details: err?.message || String(err),
      build: BUILD_TAG,
      elapsedMs
    });
  } finally {
    // 終了順：page → context → browser（全て握りつぶし）
    try { if (page)    await page.close(); } catch(_) {}
    try { if (context) await context.close(); } catch(_) {}
    try { if (browser) await browser.close(); } catch(_) {}
  }
}

// === /api/score route (ADD) ===
app.get('/api/score', async (req, res) => {
  const url = req.query.url;
  const force = req.query.force; // 'real' | 'dummy'
  if (!url) return res.status(400).json({ error: 'missing url' });

  const t0 = Date.now();
  let s = null;
  try {
    s = await scrapeForScoring(url); // ← ブロックBの関数
  } catch (e) {
    console.error('[scrapeForScoring] failed:', e);
    s = { fromScrape:false, hydrated:false, innerTextLen:0, fullHtmlLen:0, jsonld:[], waitStrategy:'(failed)', blockedResources:[], facts:{}, fallbackJsonld:{} };
  }

  // ダミー（5軸）
  const dummy = {
    overall: 65,
    axes5: {
      dataStructure: 68,
      expressionClarity: 62,
      coverage: 64,
      documentStructure: 60,
      trust: 66
    },
    weights5: WEIGHTS5,
    source: 'DUMMY_FIXTURE'
  };

  // 実スコア
  let real = null;
  if ((USE_REAL_SCORE || force === 'real') && force !== 'dummy') {
    try {
      real = await scoreWithGemini5axes({ url, scrape: s });
    } catch (e) {
      console.error('[scoreWithGemini5axes] failed:', e);
    }
  }

  const payload = {
    meta: {
      targetUrl: url,
      generatedAt: new Date().toISOString(),
      'j-from-scrape': !!s?.fromScrape,
      hydrated: !!s?.hydrated,
      innerTextLen: s?.innerTextLen || 0,
      fullHtmlLen: s?.fullHtmlLen || 0,
      jsonldCount: Array.isArray(s?.jsonld) ? s.jsonld.length : 0,
      elapsedMs: Date.now() - t0
    },
    scores: { real, dummy },
    before: { source: 'SCRAPE', facts: s?.facts || {} },
    after: { source: 'FALLBACK_BUILD', jsonld: s?.fallbackJsonld || {} },
    afterObj: { source: 'FALLBACK_BUILD', jsonld: s?.fallbackJsonld || {} },
    debug: { wait: s?.waitStrategy, blockedResources: s?.blockedResources, scorerModel: real ? 'gemini-1.5-pro' : 'dummy' }
  };

  if (!payload.auditSig) payload.auditSig = {};

  // === [AUDITSIG-MERGE v1] facts.auditSig を payload.auditSig に合流（coverageNav 以外も運ぶ） ===
  try{
    const srcAuditSig =
      s?.facts?.auditSig ||
      s?.facts?.auditSigV2 ||
      s?.auditSig ||
      null;

    if (srcAuditSig && typeof srcAuditSig === 'object'){
      // 既存payload.auditSigを優先しつつ、足りないキーだけ補完
      payload.auditSig = payload.auditSig || {};
      Object.keys(srcAuditSig).forEach(k=>{
        if (payload.auditSig[k] === undefined) payload.auditSig[k] = srcAuditSig[k];
      });
    }
  }catch(e){
    console.log('[AUDITSIG-MERGE][ERR]', String(e && (e.stack || e)));
  }
  // === [AUDITSIG-MERGE v1] ここまで ===

  if (payload.auditSig.coverageNav == null) { // null/undefined のときだけ補完
    payload.auditSig.coverageNav =
      s?.auditSig?.coverageNav ||
      s?.facts?.auditSig?.coverageNav ||
      s?.facts?.coverageNav ||
      null;
  }

  try {
    const covNav =
      payload?.auditSig?.coverageNav ||
      payload?.before?.facts?.auditSig?.coverageNav ||
      payload?.before?.facts?.coverageNav ||
      s?.auditSig?.coverageNav ||
      s?.facts?.auditSig?.coverageNav ||
      null;

    console.log('[TRACE_COVNAV][NODE][payload-ready]', {
      url,
      hasAuditSig: !!(payload?.auditSig || payload?.before?.facts?.auditSig || s?.auditSig || s?.facts?.auditSig),
      hasCoverageNav: !!covNav,
      coverageNav: covNav
    });
  } catch (e) {
    console.log('[TRACE_COVNAV][NODE][payload-ready][ERR]', String(e && (e.stack || e)));
  }

  if (force === 'dummy') payload.scores.real = null;

  try{
    const srcAuditSig =
      s?.facts?.auditSig ||
      s?.facts?.auditSigV2 ||
      s?.auditSig ||
      null;

    const probe = {
      hasS: !!s,
      sKeys: s ? Object.keys(s).slice(0,30) : [],
      hasFacts: !!(s && s.facts),
      factsKeys: (s && s.facts) ? Object.keys(s.facts).slice(0,30) : [],
      hasSrcAuditSig: !!srcAuditSig,
      srcAuditSigKeys: srcAuditSig ? Object.keys(srcAuditSig).slice(0,60) : [],

      // 核心：siteFactsLite がどこに居るか
      hasSiteFactsLiteInSrc: !!(srcAuditSig && srcAuditSig.siteFactsLite),
      hasSiteFactsLiteInFacts: !!(s && s.facts && s.facts.auditSig && s.facts.auditSig.siteFactsLite),
      hasSiteFactsLiteInS: !!(s && s.auditSig && s.auditSig.siteFactsLite),

      // ついでに：payload側に入っているか（マージ後なら true になるはず）
      hasSiteFactsLiteInPayload: !!(payload && payload.auditSig && payload.auditSig.siteFactsLite),
      payloadAuditSigKeys: (payload && payload.auditSig) ? Object.keys(payload.auditSig).slice(0,60) : []
    };

    // ① Nodeログ（従来通り）
    console.log('[AUDITSIG-MERGE][PROBE]', probe);

    // ② レスポンスにも埋め込む（診断結果で見れるようにする）
    payload.debug = payload.debug || {};
    payload.debug.auditSigProbe = probe;

  }catch(e){
    console.log('[AUDITSIG-MERGE][PROBE][ERR]', String(e && (e.stack || e)));
    try{
      payload.debug = payload.debug || {};
      payload.debug.auditSigProbeErr = String(e && (e.stack || e));
    }catch(_){}
  }

  // ===== ADD: compare用に coverageNav / navCount をレスポンスへ載せる（既存キーは壊さない）=====
  try {
    // coverageNav: 置き場所が揺れても拾う（GAS側で想定してる候補に合わせる）
    const c =
      (payload && payload.coverageNav && typeof payload.coverageNav === 'object') ? payload.coverageNav :
      (payload && payload.scoring && payload.scoring.coverageNav && typeof payload.scoring.coverageNav === 'object') ? payload.scoring.coverageNav :
      (payload && payload.snapshot && payload.snapshot.coverageNav && typeof payload.snapshot.coverageNav === 'object') ? payload.snapshot.coverageNav :
      (payload && payload.dom && payload.dom.coverageNav && typeof payload.dom.coverageNav === 'object') ? payload.dom.coverageNav :
      null;

    if (c && typeof c === 'object') {
      payload.coverageNav = {
        hasCompanyNav: (typeof c.hasCompanyNav === 'boolean') ? c.hasCompanyNav : null,
        hasServiceNav: (typeof c.hasServiceNav === 'boolean') ? c.hasServiceNav : null,
        hasContactNav: (typeof c.hasContactNav === 'boolean') ? c.hasContactNav : null,
        hasFaqNav:     (typeof c.hasFaqNav     === 'boolean') ? c.hasFaqNav     : null,
        hasPricingNav: (typeof c.hasPricingNav === 'boolean') ? c.hasPricingNav : null,
        hasCasesNav:   (typeof c.hasCasesNav   === 'boolean') ? c.hasCasesNav   : null,
      };
    } else if (payload.coverageNav == null) {
      payload.coverageNav = null;
    }

    // navCount: 候補を広めに拾う
    let n =
      (payload && typeof payload.navCount === 'number') ? payload.navCount :
      (payload && typeof payload.nav_count === 'number') ? payload.nav_count :
      (payload && payload.scoring && typeof payload.scoring.navCount === 'number') ? payload.scoring.navCount :
      (payload && payload.scoring && typeof payload.scoring.nav_count === 'number') ? payload.scoring.nav_count :
      null;

    if (typeof n === 'number' && Number.isFinite(n)) {
      payload.navCount = n;
    } else if (typeof n === 'string') {
      const nn = Number(String(n).trim());
      payload.navCount = Number.isFinite(nn) ? nn : null;
    } else if (payload.navCount == null) {
      payload.navCount = null;
    }

    // 任意ログ（必要なら）：ここが埋まったか確認
    console.log('[AUDITSIG][COVNAV][FINAL v1] navCount=%s cov=%s',
      String(payload.navCount),
      payload.coverageNav ? JSON.stringify(payload.coverageNav) : 'null'
    );
  } catch (e) {
    console.log('[AUDITSIG][COVNAV][FINAL v1][ERR]', String(e && (e.stack || e)));
  }
  // ===== /ADD =====

  res.json(payload);
});

app.listen(PORT, () => console.log(`[${BUILD_TAG}] running on ${PORT}`));
