<!-- =========================
  pdf.html (NEW)
  - PDF export v1 skeleton
  - Public API: window.runPdfExportV1()
  ========================= -->
<script>
(function(){
  'use strict';

  // Prevent double-install
  if (window.__PDF_EXPORT_V1_INSTALLED__) return;
  window.__PDF_EXPORT_V1_INSTALLED__ = true;

  // -------------------------
  // Config (adjust if needed)
  // -------------------------
  const SEL = {
    // Root pages
    dashboardRoot: '#page-dashboard-v2',
    diagnosisRoot:  '#page-diagnosis-v2',
    compareRoot:    '#page-compare',        // if exists

    // Diagnosis subroots (order fixed)
    diagCharts:     '#dv2-diagnosis-charts',
    diagSummary:    '#dv2-diagnosis-summary',
    diagScoreTable: '#dv2-score-table',
    diagCards:      '#dv2-improve-cards',

    // AI recognition log (on dashboard)
    aiRecognition:  '#dv2-ai-recognition'
  };

  const PRINT_ROOT_ID = 'pdf-print-root';
  const MODAL_ID = 'pdf-export-modal-v1';

  // -------------------------
  // Public entry
  // -------------------------
  window.runPdfExportV1 = async function runPdfExportV1(){
    window.__PDF_EXPORT_INFLIGHT__ = true;

    try{
      // 1) Open modal and get user inputs
      const job = await openPdfModal_();
      if (!job) return; // cancelled
      attachVisibleCompareSummaryToJob_(job);

      // 2) Show global loader if available (or no-op)
      loaderOn_('PDFを生成しています…');

      // 3) Build print root (cover/conditions/sections/notes)
      const ctx = buildContext_(job);

      // ★ 追加：表紙用の「レポート作成日（納品日）」
      // モーダルで指定があればそれを優先、なければ従来どおり診断日へフォールバック
      ctx.reportDateText = (job && job.reportDateText) ? job.reportDateText : '';

      // ★ 追加：非表示ページも“PDF収集時だけ”見えるようにする
      try { if (typeof window.markAllPagesForPrint === 'function') window.markAllPagesForPrint(true); } catch(_){}

      let sections = null;
      try{
        sections = collectDomSections_(job);
      }catch(e){
        console.error('[PDF][SECTIONS][EXC]', e);
        throw e;
      }

      // ★ Chart.js / レイアウト安定待ち（診断直後PDFが白紙になる対策）
      await new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });

      let printRoot = null;

      // === [PDF][DASH-FORCE-VIS v1] 診断直後のdashboard非可視/未resizeで白紙になるのを防ぐ（必ず復元） ===
      let __pdfDash = null;
      let __pdfDashUndo = null;

      function __raf2(){
        return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }

      try{
        // 0) dashboard を“PDF中だけ”強制可視化
        try{
          __pdfDash = document.querySelector('#page-dashboard-v2');
          if (__pdfDash){
            const prev = {
              className: __pdfDash.className,
              hidden: __pdfDash.hasAttribute('hidden'),
              ariaHidden: __pdfDash.getAttribute('aria-hidden'),
              styleText: __pdfDash.getAttribute('style') || ''
            };

            __pdfDashUndo = function(){
              try{
                __pdfDash.className = prev.className;
                if (prev.hidden) __pdfDash.setAttribute('hidden','');
                else __pdfDash.removeAttribute('hidden');

                if (prev.ariaHidden === null) __pdfDash.removeAttribute('aria-hidden');
                else __pdfDash.setAttribute('aria-hidden', prev.ariaHidden);

                if (prev.styleText) __pdfDash.setAttribute('style', prev.styleText);
                else __pdfDash.removeAttribute('style');
              }catch(_){}
            };

            __pdfDash.classList.add('active');
            __pdfDash.removeAttribute('hidden');
            __pdfDash.removeAttribute('aria-hidden');

            __pdfDash.style.setProperty('display','block','important');
            __pdfDash.style.setProperty('visibility','visible','important');
            __pdfDash.style.setProperty('opacity','1','important');
            __pdfDash.style.setProperty('pointer-events','none','important');

            // ★ ここ（ダッシュボード側で確実に出る）
            console.warn('[PDF][DASH-SNAP][AFTER-STYLE]', {
              found: true,
              w: __pdfDash.getBoundingClientRect ? Math.round(__pdfDash.getBoundingClientRect().width) : null,
              display: getComputedStyle(__pdfDash).display,
              vis: getComputedStyle(__pdfDash).visibility,
              op: getComputedStyle(__pdfDash).opacity
            });
          } else {
            console.warn('[PDF][DASH-SNAP][AFTER-STYLE]', { found: false });
          }
        }catch(_){}

        // ★ PDF中だけ：ダッシュボードの KPI/チャート見た目を固定（画面全体には漏らさない：__pdfDash直下だけ触る）
        try{
          if (__pdfDash){

            // 1) KPIは常に3列横並び（縦積み禁止）
            const kpi = __pdfDash.querySelector('section.kpi-row');
            if (kpi){
              kpi.style.setProperty('display','grid','important');
              kpi.style.setProperty('grid-template-columns','repeat(3, minmax(0, 1fr))','important');
              kpi.style.setProperty('gap','12px','important');
              kpi.style.setProperty('width','100%','important');
              kpi.style.setProperty('max-width','100%','important');
              kpi.style.setProperty('box-sizing','border-box','important');

              // 子の最小幅だけ止血（折り返し事故防止）
              Array.from(kpi.children || []).forEach(ch=>{
                try{ ch.style.setProperty('min-width','0','important'); }catch(_){}
              });
            }

            // 2) チャート枠は高さ固定（PC幅PDFでも高さが変わるのを止める）
            __pdfDash.querySelectorAll('.chart-wrap').forEach(w=>{
              w.style.setProperty('height','320px','important');
              w.style.setProperty('max-height','320px','important');
              w.style.setProperty('overflow','hidden','important');
              w.style.setProperty('box-sizing','border-box','important');
            });

            // 3) canvas が display:none だと Chart.js が計算崩すので、PDF中だけ必ず表示
            ['#dv2-chart-score', '#dv2-chart-clicks'].forEach(sel=>{
              const cv = __pdfDash.querySelector(sel);
              if (!cv) return;
              cv.style.setProperty('display','block','important');
              cv.style.setProperty('visibility','visible','important');
              cv.style.setProperty('opacity','1','important');
              cv.style.setProperty('max-width','100%','important');

              // 画面DOMに合わせた “CSS高さ” の止血（必要なら値はあなたの正に合わせる）
              cv.style.setProperty('height','294px','important');
            });

            console.warn('[PDF][DASH-SNAP][FIXSTYLE-APPLIED]', {
              kpi: !!__pdfDash.querySelector('section.kpi-row'),
              scoreCv: !!__pdfDash.querySelector('#dv2-chart-score'),
              clicksCv: !!__pdfDash.querySelector('#dv2-chart-clicks')
            });
          }
        }catch(_){}

        // 1) 可視化が layout に反映されるのを待つ
        await __raf2();

        // 2) Chart.js を “可視状態” で一度だけ resize/update（canvasが0x0のままを防ぐ）
        try{
          if (__pdfDash && window.Chart){
            const cvs = Array.from(__pdfDash.querySelectorAll('canvas[id]')) || [];
            cvs.forEach(cv=>{
              try{
                const ch = (Chart.getChart ? Chart.getChart(cv) : (cv.__chart || cv.chart || null));
                if (!ch) return;
                try{ ch.resize && ch.resize(); }catch(_){}
                try{
                  if (ch.options) { ch.options.animation = false; ch.options.animations = false; }
                }catch(_){}
                try{ ch.update && ch.update('none'); }catch(_){}

                // === [PDF][DASH-SNAP][PNG-CAPTURE v2] “画面canvas”ではなく offscreen で描き直してPNG化（サイズ固定） ===
                try{
                  const id = String(cv && cv.id || '');
                  if (id === 'dv2-chart-score' || id === 'dv2-chart-clicks'){
                    window.__PDF_DASH_PNG__ = window.__PDF_DASH_PNG__ || {};

                    // ✅ 固定サイズ（あなたのDOM: canvas style height 294px / width 628px に合わせる）
                    const Wcss = 628;
                    const Hcss = 294;
                    const DPR  = window.devicePixelRatio || 1;

                    // offscreen canvas
                    const off = document.createElement('canvas');
                    off.width  = Math.round(Wcss * DPR);
                    off.height = Math.round(Hcss * DPR);

                    const ctx2 = off.getContext('2d');

                    // --- データ/オプションを“壊れない範囲で”クローン（関数が混ざるので structuredClone 優先） ---
                    function cloneObj_(o){
                      try{
                        if (typeof structuredClone === 'function') return structuredClone(o);
                      }catch(_){}
                      try{
                        return JSON.parse(JSON.stringify(o));
                      }catch(_){
                        // 最後の逃げ（浅い）
                        const x = {};
                        try{ for (const k in (o||{})) x[k] = o[k]; }catch(_){}
                        return x;
                      }
                    }

                    const type = (ch && ch.config && ch.config.type) ? ch.config.type : 'line';
                    const data = cloneObj_(ch.data || {});
                    const opt  = cloneObj_(ch.options || {});

                    // ✅ PDF用：必ず固定描画
                    opt.responsive = false;
                    opt.maintainAspectRatio = false;
                    opt.animation = false;
                    opt.animations = false;
                    opt.devicePixelRatio = DPR;

                    // ✅ 一時Chartを生成 → PNG化 → destroy
                    const tmp = new Chart(ctx2, { type, data, options: opt });
                    try{ tmp.resize(Wcss, Hcss); }catch(_){}
                    try{ tmp.update('none'); }catch(_){}
                    try{ tmp.draw(); }catch(_){}

                    window.__PDF_DASH_PNG__[id] = off.toDataURL('image/png');

                    try{ tmp.destroy(); }catch(_){}

                    console.warn('[PDF][DASH-PNG][CAPTURED]', { id, Wcss, Hcss, DPR });
                  }
                }catch(_){}
              }catch(_){}
            });
          }
        }catch(_){}

        // 3) 念のためもう1フレ
        await __raf2();

        // 4) build
        console.warn('[PDF][PRINT_ROOT][CALL] about to build');
        printRoot = buildPrintRoot_C_(job, ctx, sections);
        console.warn('[PDF][PRINT_ROOT][OK]', {
          id: printRoot && printRoot.id,
          children: (printRoot && printRoot.children) ? printRoot.children.length : null
        });

        // === [PDF][PRI][COPY-UI-LABEL v1] 画面の「優先度：中（…）」をPDFバッジに反映 ===
        try{
          const ui = Array.from(document.querySelectorAll('.priority-badge'))
            .map(el => String(el.textContent || '').trim())
            .filter(t => /^優先度：/.test(t));

          const pdf = printRoot ? Array.from(printRoot.querySelectorAll('.pdf-pri')) : [];

          // 件数が合う前提（いまのログでは 22枚で揃っている）
          const n = Math.min(ui.length, pdf.length);

          for (let i = 0; i < n; i++){
            const t = ui[i];               // 例: "優先度：中（品質向上）"
            const m = t.match(/^優先度：\s*([高中低])/);
            const jp = m ? m[1] : '';

            // 表示をそのままコピー
            pdf[i].textContent = t;

            // 色は jp(高/中/低) で確実に当てる（middle 等の混入を潰す）
            if (jp){
              pdf[i].className = pdf[i].className
                .split(/\s+/).filter(c => c && !/^pdf-pri-/.test(c))
                .concat(['pdf-pri', 'pdf-pri-' + jp])
                .join(' ')
                .trim();
            }
          }

          console.warn('[PDF][PRI][COPY-UI-LABEL][OK]', { ui: ui.length, pdf: pdf.length, applied: n });
        }catch(e){
          console.warn('[PDF][PRI][COPY-UI-LABEL][SKIP]', e);
        }
        // === [/PDF][PRI][COPY-UI-LABEL v1] ===

      }catch(e){
        console.error('[PDF][PRINT_ROOT][EXC]', e);
        throw e;

      } finally {
        // === [PDF][DASH-SNAP][UNDO v1] KPI/Chart 固定スタイルを元に戻す ===
        try{ __pdfDashStyleUndo && __pdfDashStyleUndo(); }catch(_){}

        // 5) 必ず復元（画面状態は壊さない）
        try{ __pdfDashUndo && __pdfDashUndo(); }catch(_){}
      }

      // 4) Render to PDF + download
      console.warn('[PDF][RENDER][ROOT-CHECK]', {
        printRootId: printRoot && printRoot.id,
        priCount: printRoot ? printRoot.querySelectorAll('.pdf-pri').length : -1,
        priHigh: printRoot ? printRoot.querySelectorAll('.pdf-pri-高').length : -1,
        priMid:  printRoot ? printRoot.querySelectorAll('.pdf-pri-中').length : -1,
        priLow:  printRoot ? printRoot.querySelectorAll('.pdf-pri-低').length : -1,
      });

      await renderPdfAndDownload_(job, printRoot);

      // 5) Done
      toast_('PDFを生成しました');
    }catch(err){
      console.error('[PDF][v1] FAILED', err);
      toast_('PDF生成に失敗しました');
    } finally {
      window.__PDF_EXPORT_INFLIGHT__ = false;
      cleanup_();
      loaderOff_();
    }
  };

  // =========================================================
  // 0) Minimal CSS injection (no pdf_styles.html)
  // =========================================================
  injectCssOnce_();

  function injectCssOnce_(){
    if (document.getElementById('pdf-v1-style')) return;
    const style = document.createElement('style');
    style.id = 'pdf-v1-style';
    style.textContent = `
      /* --- PDF print root (offscreen) --- */
      #${PRINT_ROOT_ID}{
        position: fixed;
        left: -99999px;
        top: 0;
        width: 794px; /* A4 portrait @ 96dpi-ish */
        background: #fff;
        color: #111;
        z-index: -1;
      }
      #${PRINT_ROOT_ID} .pdf-page{
        box-sizing: border-box;
        padding: 32px;
        page-break-after: always;
      }
      #${PRINT_ROOT_ID} .pdf-page:last-child{
        page-break-after: auto;
      }
      #${PRINT_ROOT_ID} h1{
        margin: 0 0 12px 0;
        font-size: 22px;
      }
      #${PRINT_ROOT_ID} h2{
        margin: 0 0 10px 0;
        font-size: 16px;
      }
      #${PRINT_ROOT_ID} .pdf-kv{
        margin-top: 14px;
        font-size: 13px;
        line-height: 1.6;
      }
      #${PRINT_ROOT_ID} .pdf-kv dt{ font-weight: 700; }
      #${PRINT_ROOT_ID} .pdf-kv dd{ margin: 0 0 10px 0; }
      #${PRINT_ROOT_ID} .pdf-divider{
        height: 1px; background: #ddd; margin: 18px 0;
      }
      /* Avoid modals/toasts etc inside cloned DOM */
      #${PRINT_ROOT_ID} .no-print,
      #${PRINT_ROOT_ID} [data-no-print="1"]{
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function attachVisibleCompareSummaryToJob_(job){
    try{
      if (!job || !job.includeCompare) return;

      const cmpSummaryEl = document.getElementById('cmp-summary');
      const visibleCompareSummaryText = cmpSummaryEl
        ? String(cmpSummaryEl.innerText || cmpSummaryEl.textContent || '').trim()
        : '';
      const visibleCompareSummaryHtml = cmpSummaryEl
        ? String(cmpSummaryEl.innerHTML || '').trim()
        : '';

      let compareRes = null;
      try{
        compareRes = JSON.parse(Storage.prototype.getItem.call(localStorage, 'aio:lastCompare') || 'null');
      }catch(_){
        compareRes = null;
      }
      if (!compareRes || typeof compareRes !== 'object') compareRes = {};

      if (visibleCompareSummaryText) {
        compareRes.summaryText = visibleCompareSummaryText;
      }
      if (visibleCompareSummaryHtml) {
        compareRes.summaryHtml = visibleCompareSummaryHtml;
      }

      try{
        const tbl = document.querySelector('#compareScores');
        if (tbl) {
          const rows = Array.from(tbl.querySelectorAll('tbody tr'));
          const parsed = rows.map(tr => {
            const tds = Array.from(tr.querySelectorAll('td')).map(td => String(td.innerText || td.textContent || '').trim());
            const label = tds[0] || '';
            const nums = tds.slice(1).map(n => Number(String(n || '').replace(/[^\d.-]/g, '')) || 0);

            return {
              label: label,
              values: nums.slice(0, 5),
              axes: {
                data: nums[0],
                doc: nums[1],
                clarity: nums[2],
                coverage: nums[3],
                trust: nums[4]
              },
              avg: nums[5],
              sum: nums[5]
            };
          }).filter(r => r.label);

          if (parsed.length === 4) {
            compareRes.table = parsed;
            console.warn('[PDF][COMPARE][TABLE_FROM_DOM]', { rows: parsed.length });
          }
        }
      }catch(e){
        console.warn('[PDF][COMPARE][TABLE_FROM_DOM][ERR]', e);
      }

      if (!Array.isArray(compareRes.table) || !compareRes.table.length) {
        try{
          const rawTable = Storage.prototype.getItem.call(localStorage, 'aio:lastCompareTable');
          const parsedTable = rawTable ? JSON.parse(rawTable) : null;
          if (Array.isArray(parsedTable) && parsedTable.length) compareRes.table = parsedTable;
        }catch(_){}
      }

      try{
        const a = String(Storage.prototype.getItem.call(localStorage, 'aio:lastCompareTargetA') || '').trim();
        const b = String(Storage.prototype.getItem.call(localStorage, 'aio:lastCompareTargetB') || '').trim();
        if (a && !compareRes.aUrl) compareRes.aUrl = a;
        if (b && !compareRes.bUrl) compareRes.bUrl = b;
      }catch(_){}

      job.compareRes = compareRes;
      console.warn('[PDF][COMPARE][SUMMARY_FROM_DOM]', {
        textLen: visibleCompareSummaryText.length,
        htmlLen: visibleCompareSummaryHtml.length
      });
    }catch(e){
      console.warn('[PDF][COMPARE][SUMMARY_FROM_DOM][ERR]', e);
    }
  }

  // =========================================================
  // 1) UI modal (clientName + includeCompare)
  // =========================================================
  function openPdfModal_(){
    return new Promise((resolve) => {
      // If already open, close first
      const prev = document.getElementById(MODAL_ID);
      if (prev) prev.remove();

      const overlay = document.createElement('div');
      overlay.id = MODAL_ID;
      overlay.style.cssText = [
        'position:fixed','inset:0','background:rgba(0,0,0,.35)',
        'z-index:99999','display:flex','align-items:center','justify-content:center',
        'padding:16px'
      ].join(';');

      const dialog = document.createElement('div');
      dialog.style.cssText = [
        'width:min(560px, 100%)','background:#fff','border-radius:12px',
        'box-shadow:0 10px 30px rgba(0,0,0,.25)','padding:16px 16px 12px 16px',
        'text-align:left','display:block','box-sizing:border-box','overflow:hidden'
      ].join(';');

      const hasCompare = !!document.querySelector(SEL.compareRoot);

      dialog.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="font-weight:700;font-size:16px;">PDF生成</div>
          <button type="button" data-act="close" style="border:none;background:transparent;font-size:18px;cursor:pointer;">×</button>
        </div>
        <div style="margin-top:12px;font-size:13px;opacity:.85;">
          表紙・検査条件・診断結果等を出力します。<br>競合比較もレポートに含める場合はPDF生成前に実施してください。
        </div>

        <div style="margin-top:14px;">
          <label style="display:block;font-size:13px;font-weight:700;margin-bottom:6px;">クライアント名</label>
          <input type="text" data-k="clientName" placeholder="例）株式会社〇〇"
                 style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ddd;border-radius:10px;font-size:14px;">
        </div>

        <div style="margin-top:14px;">
          <label style="display:block;font-size:13px;font-weight:700;margin-bottom:6px;">レポート作成日（納品日）</label>
          <input type="date" data-k="reportDate"
                 style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ddd;border-radius:10px;font-size:14px;">
          <div style="margin-top:6px;font-size:12px;opacity:.75;">
            ※ 表紙の「作成日」に反映されます（診断日とは別）
          </div>
        </div>

        <div style="margin-top:14px;text-align:left;">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">生成対象</div>

          <div style="display:grid;grid-template-columns:18px 1fr;column-gap:8px;row-gap:8px;align-items:start;width:100%;">

            <!-- ダッシュボード（固定） -->
            <input type="checkbox" checked disabled style="margin:2px 0 0 0;" />
            <div style="min-width:0;max-width:100%;overflow-wrap:anywhere;white-space:normal;font-size:13px;">
              ダッシュボード（固定）
            </div>

            <!-- GEO診断（固定） -->
            <input type="checkbox" checked disabled style="margin:2px 0 0 0;" />
            <div style="min-width:0;max-width:100%;overflow-wrap:anywhere;white-space:normal;font-size:13px;">
              GEO診断（固定）
            </div>

            <!-- 競合比較（任意） -->
            <input type="checkbox" data-k="includeCompare" ${hasCompare ? '' : 'disabled'}
              style="margin:2px 0 0 0;${hasCompare ? '' : 'opacity:.6;'}" />
            <div style="min-width:0;max-width:100%;overflow-wrap:anywhere;white-space:normal;font-size:13px;${hasCompare ? '' : 'opacity:.6;'}">
              競合比較（任意） ${hasCompare ? '' : '（比較ページがないため無効）'}
            </div>

          </div>
        </div>

        <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" data-act="cancel"
            style="padding:10px 14px;border:1px solid #ddd;border-radius:10px;background:#fff;color:#111;cursor:pointer;">
            キャンセル
          </button>
          <button type="button" data-act="run"
            style="padding:10px 14px;border:1px solid #111;border-radius:10px;background:#111;color:#fff;cursor:pointer;">
            PDFを生成
          </button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      // default: today (yyyy-mm-dd)
      try{
        const el = dialog.querySelector('[data-k="reportDate"]');
        if (el && !el.value){
          const d = new Date();
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2,'0');
          const day = String(d.getDate()).padStart(2,'0');
          el.value = `${y}-${m}-${day}`;
        }
      }catch(_){}

      function close(result){
        overlay.remove();
        resolve(result);
      }

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      dialog.querySelector('[data-act="close"]').addEventListener('click', () => close(null));
      dialog.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));

      dialog.querySelector('[data-act="run"]').addEventListener('click', () => {
        const clientName = String(dialog.querySelector('[data-k="clientName"]').value || '').trim();
        const includeCompare = !!(dialog.querySelector('[data-k="includeCompare"]').checked);

        // report date (yyyy-mm-dd -> yyyy/mm/dd)
        let reportDateText = '';
        try{
          const v = String((dialog.querySelector('[data-k="reportDate"]')||{}).value || '').trim();
          if (v) reportDateText = v.replace(/-/g,'/');
        }catch(_){}

        close({
          clientName: clientName || '(未入力)',
          includeCompare: includeCompare && hasCompare,
          reportDateText: reportDateText // 表紙用（未入力なら空）
        });
      });
    });
  }

  // =========================================================
  // 2) Context builder for "検査条件" (v1 fixed text + runtime values)
  // =========================================================
  function buildContext_(job){
    const origin = getActiveOrigin_();
    const siteTypeLabel = (function(){
      function map(v){
        switch(String(v||'').trim()){
          case 'corporate': return 'コーポレート';
          case 'saas':      return 'サービス';
          case 'ec':        return 'EC';
          case 'media':     return 'メディア';
          default:          return '';
        }
      }

      try{
        // 1) まず既存関数
        const v0 = (typeof getSiteTypeLabel_ === 'function') ? String(getSiteTypeLabel_()||'').trim() : '';
        const v0Label = map(v0);
        if (v0Label) return v0Label;

        // 2) 診断ページの radio から直取り（最優先の確実ルート）
        const checked =
          document.querySelector('input[name="siteType"]:checked') ||
          document.querySelector('#page-diagnose input[name="siteType"]:checked') ||
          document.querySelector('#page-diagnosis-v2 input[name="siteType"]:checked');

        const v1 = map(checked && checked.value);
        if (v1) return v1;

        return '未判定';
      }catch(_){
        return '未判定';
      }
    })();

    // v1 fixed / agreed texts
    const scopeLines = [
      'トップページ（HTML構造・主要コンテンツ）',
      '主要ナビゲーション／フッターに表示されているリンク情報',
      '構造化データ（JSON-LD：Organization / WebSite / WebPage 等）',
      'サイト構造・宣言に関する補助情報（robots.txt / sitemap.xml 等）',
      'AI可視性に関する参考情報（AI向け宣言・外部参照点 等）'
    ];

    const modelLines = [
      'Gemini 2.5 Pro（テキスト生成・要約・評価）',
      'Gemini 1.5 Pro（構造化出力・JSON生成）'
    ];

    // v1 assumption (you can later wire real used list)
    const aiOverviewLines = [
      'Google（AI Overviews）',
      'ChatGPT（Web）',
      'Perplexity',
      'Copilot'
    ];

    // Diagnosis date: best-effort (v1)
    const diagnosisDateText = getDiagnosisDateText_() || formatDateYmd_(new Date());

    // Author (your company): optional in v1 (leave blank if you want)
    const authorName = getAuthorName_() || '';

    return {
      origin,
      siteTypeLabel,
      scopeLines,
      modelLines,
      aiOverviewLines,
      diagnosisDateText,
      authorName,
      clientName: String(job && job.clientName || '').trim() || '(未入力)',
      reportDateText: String(job && job.reportDateText || '').trim()
    };
  }

  // =========================================================
  // 3) DOM collection (clone sources)
  // =========================================================
  function collectDomSections_(job){
    const sections = {
      dashboard: null,
      diagnosisBlocks: [],
      compare: null
    };

    const dash = document.querySelector(SEL.dashboardRoot);
    if (dash) sections.dashboard = dash;

    // Diagnosis: v1はサブブロック積み上げをやめて、ページ全体を1つで取る（白紙対策）
    const diagRoot =
      document.querySelector('#page-diagnosis-v2') ||
      document.querySelector('#page-diagnose');
    sections.diagnosisRoot = diagRoot || null;

    // 互換のため diagnosisBlocks は空にしておく
    sections.diagnosisBlocks = [];

    if (job.includeCompare){
      const cmp = document.querySelector(SEL.compareRoot);
      if (cmp) sections.compare = cmp;
    }

    return sections;
  }

  // =========================================================
  // 4) Build #pdf-print-root with fixed page order
  // =========================================================
  function buildPrintRoot_C_(job, ctx, sections){
    document.getElementById(PRINT_ROOT_ID)?.remove();

    const root = document.createElement('div');
    root.id = PRINT_ROOT_ID;

    // PDF専用スタイル（改ページ・table・カード途中分割抑制）
    const st = document.createElement('style');
    st.textContent = `
      #${PRINT_ROOT_ID}{ font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color:#111; }

      /* ★ 表紙だけ：absolute配置の基準を与える */
      #${PRINT_ROOT_ID} .pdf-page.pdf-cover{
        position: relative;
      }

      /* pages */
      #${PRINT_ROOT_ID} .pdf-page{
        page-break-after: always;
        break-after: page;
        padding: 22px 36px 26px;
      }

      /* screen-only: page boundary visibility */
      @media screen{
        #${PRINT_ROOT_ID} .pdf-page{
          outline: 1px solid rgba(0,0,0,.08);
          outline-offset: 6px;
          background: #fff;
        }
      }

      /* typography */
      #${PRINT_ROOT_ID} .pdf-text{ font-size:13px; line-height:1.7; }
      #${PRINT_ROOT_ID} .pdf-h1{ margin:0 0 10px; font-size:20px; font-weight:800; }
      #${PRINT_ROOT_ID} .pdf-h2{ margin:12px 0 6px; font-size:16px; font-weight:800; }
      #${PRINT_ROOT_ID} .pdf-sub{
        margin:12px 0 6px;
        font-size:14px;
        font-weight:800;
        color:#111;
      }
      #${PRINT_ROOT_ID} .pdf-note{ font-size:12px; color:#444; margin-top:8px; }

      /* tables */
      #${PRINT_ROOT_ID} .pdf-table{
        width:100%;
        border-collapse:collapse;
        font-size:12px;
        border:1px solid #e5e7eb;
      }
      #${PRINT_ROOT_ID} .pdf-table th{
        text-align:left;
        border-bottom:1px solid #d1d5db;
        padding:7px 8px;
        background:#f3f4f6;
        font-weight:800;
        vertical-align:bottom;
      }
      #${PRINT_ROOT_ID} .pdf-table td{
        border-bottom:1px solid #e5e7eb;
        padding:7px 8px;
        vertical-align:top;
      }
      #${PRINT_ROOT_ID} .r{ text-align:right; }

      /* cards (共通) */
      #${PRINT_ROOT_ID} .pdf-card{
        border:1px solid #d1d5db;
        border-radius:0;              /* ★角丸やめる（共通でOKならここで） */
        padding:12px;
        margin:12px 0;
        break-inside: avoid;
        page-break-inside: avoid;
        background:#fff;
        box-sizing:border-box;
      }

      /* ★ 2枚目以降も「区切り線」が見えるように、カード間に1本線を追加 */
      #${PRINT_ROOT_ID} .pdf-card + .pdf-card{
        margin-top:14px;
        border-top:1px solid #d1d5db; /* 連続して見える問題の止血 */
      }

      #${PRINT_ROOT_ID} .compare-section{
        page-break-before:auto;
        break-before:auto;
        page-break-inside:avoid;
        break-inside:avoid;
        margin-top:0 !important;
      }
      #${PRINT_ROOT_ID} .compare-section .pdf-h2{
        margin-top:0;
        page-break-before:avoid;
        break-before:avoid;
      }
      #${PRINT_ROOT_ID} .compare-section#card-compare-targets-text{
        margin-top:0;
        margin-bottom:8px;
        padding-top:10px;
        padding-bottom:10px;
        page-break-inside:avoid;
        break-inside:avoid;
      }
      #${PRINT_ROOT_ID} .compare-targets-title{
        margin:0 0 6px 0 !important;
        padding:0 !important;
        line-height:1.2 !important;
        page-break-before:avoid;
        break-before:avoid;
      }
      #${PRINT_ROOT_ID} .compare-targets-body{
        margin:0 !important;
        padding:0 !important;
        line-height:1.35 !important;
      }
      #${PRINT_ROOT_ID} .compare-target-line{
        margin:0 !important;
        padding:0 !important;
        line-height:1.35 !important;
      }

      /* helpers */
      #${PRINT_ROOT_ID} .pdf-muted{ color:#6b7280; font-size:12px; }

      #${PRINT_ROOT_ID} .pdf-panel{
        border:1px solid #e5e7eb;
        background:#f9fafb;
        border-radius:0;   /* ★サマリー側も角丸不要なら */
        padding:12px;
      }

      #${PRINT_ROOT_ID} .pdf-axis-cover-frame{
        border:1px solid #d1d5db;
        background:#fff;
        padding:12px;
        box-sizing:border-box;
      }
      #${PRINT_ROOT_ID} .pdf-axis-cover-field + .pdf-axis-cover-field{
        margin-top:12px;
        padding-top:12px;
        border-top:1px solid #e5e7eb;
      }
      #${PRINT_ROOT_ID} .pdf-axis-cover-label{
        font-size:14px;
        font-weight:800;
        color:#111;
        margin:12px 0 6px;
      }
      #${PRINT_ROOT_ID} .pdf-axis-cover-value{
        font-size:13px;
        line-height:1.7;
        color:#111;
      }
      #${PRINT_ROOT_ID} .pdf-axis-cover-list{
        margin:0;
        padding-left:18px;
      }
      #${PRINT_ROOT_ID} .pdf-axis-cover-list li{
        margin:0 0 4px;
        font-size:13px;
        line-height:1.7;
      }

      #${PRINT_ROOT_ID} .pdf-grid-2{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
      #${PRINT_ROOT_ID} .pdf-grid-3{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; }

      #${PRINT_ROOT_ID} .pdf-kpi-label{ font-size:11px; color:#6b7280; margin:0 0 4px; }
      #${PRINT_ROOT_ID} .pdf-kpi-value{ font-size:28px; font-weight:900; margin:0; }
      #${PRINT_ROOT_ID} .pdf-kpi-sub{ font-size:12px; color:#6b7280; margin-top:4px; }

      /* bars */
      #${PRINT_ROOT_ID} .pdf-bar-fill.before{ background: rgba(54, 162, 235, 1); }
      #${PRINT_ROOT_ID} .pdf-bar-fill.after { background: rgba(255, 99, 132, 1); }
      #${PRINT_ROOT_ID} .pdf-bar-fill{ -webkit-print-color-adjust: exact; print-color-adjust: exact; display:block; }

      /* priority badge */
      #${PRINT_ROOT_ID} .pdf-pri{
        display:inline-block;
        padding:2px 8px;
        border-radius:999px;
        font-size:12px;
        font-weight:800;
        line-height:1.2;
        border:1px solid #ddd;
      }
      #${PRINT_ROOT_ID} .pdf-pri-高{ background:#fee2e2; color:#991b1b; border-color:#fecaca; }
      #${PRINT_ROOT_ID} .pdf-pri-中{ background:#fef3c7; color:#92400e; border-color:#fde68a; }
      #${PRINT_ROOT_ID} .pdf-pri-低{ background:#e0f2fe; color:#075985; border-color:#bae6fd; }

      /* === Improve（画像版でも見た目を揃える） === */

      /* Improveカード：サマリーと同じ “薄グレー背景＋四角枠” */
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve .pdf-card{
        background:#f9fafb !important;
        border-color:#e5e7eb !important;
      }

      /* Improve本文：改行を生かす（Markdownを段落っぽく） */
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve .pdf-text{
        white-space: pre-wrap;
      }

      /* ===== サマリー本文：色指定をすべて黒に上書き ===== */
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-rank,
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-rank *{
        color:#111 !important;
      }

      /* インライン `code`（最低限の見分け） */
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve .pdf-text code{
        background:#ffffff;
        border:1px solid #e5e7eb;
        padding:0 4px;
        border-radius:0;
      }

      /* コードブロック：カードがグレーなので “中は白” にする + 変な細い箱を防ぐ */
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve pre{
        display:block;
        width:100%;
        box-sizing:border-box;
        margin:10px 0 12px;
        padding:12px;
        background:#ffffff;
        border:1px solid #e5e7eb;
        border-radius:0;
        white-space:pre-wrap;
        word-break:break-word;
        overflow-wrap:anywhere;
      }
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve pre code{
        background:transparent;
        border:none;
        padding:0;
      }

      /* ===== Improve: code block force-white (inline style に勝つ) ===== */
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve pre{
        background: #ffffff !important;
        background-color: #ffffff !important;
        border: 1px solid #e5e7eb !important;
        border-radius: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
        display: block !important;
        padding: 12px !important;
        margin: 10px 0 12px !important;
        white-space: pre-wrap !important;
        word-break: break-word !important;
        overflow-wrap: anywhere !important;
      }
      #${PRINT_ROOT_ID} .pdf-page.pdf-report-improve pre code{
        background: transparent !important;
        border: none !important;
        padding: 0 !important;
      }

      /* continue note */
      .pdf-continue-note{ display:none; }
      .pdf-page[data-has-next="1"] .pdf-continue-note{ display:block; }

      #${PRINT_ROOT_ID} .pdf-continue-note{
        margin-top: 8px;
        font-size: 12px;
        color: #6b7280;
        opacity: .9;
        text-align: left;
      }

      /* PDF: 根拠の見出しは出さないが、見出し相当の間隔だけは残す */
      #${PRINT_ROOT_ID} .pdf-sub-spacer{
        height: 14px;
      }

      /* ※ “Improveカード継ぎ目の線を消す” ルールは一旦入れない（あなたの要望：線が欲しいため） */
    `;
    root.appendChild(st);

    // 1) Cover
    root.appendChild(makePage_('pdf-cover', buildCoverHtml_(ctx)));

    // 2) Conditions
    root.appendChild(makePage_('pdf-conditions', buildConditionsHtml_(ctx)));

    function bakeStyles_(src, dst){
      try{
        const cs = getComputedStyle(src);
        const PROPS = [
          'display','position','boxSizing',
          'width','height','minWidth','maxWidth','minHeight','maxHeight',
          'marginTop','marginRight','marginBottom','marginLeft',
          'paddingTop','paddingRight','paddingBottom','paddingLeft',
          'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
          'borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle',
          'borderTopColor','borderRightColor','borderBottomColor','borderLeftColor',
          'borderTopLeftRadius','borderTopRightRadius',
          'borderBottomRightRadius','borderBottomLeftRadius',
          'backgroundColor',
          'color','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
          'textAlign','whiteSpace',
          'alignItems','justifyContent','gap',
          'boxShadow'
        ];
        PROPS.forEach(p=>{
          try{ dst.style[p] = cs[p]; }catch(_){}
        });
      }catch(_){}
    }

    function bakeTree_(srcRoot, dstRoot){
      bakeStyles_(srcRoot, dstRoot);
      const s = srcRoot.children ? Array.from(srcRoot.children) : [];
      const d = dstRoot.children ? Array.from(dstRoot.children) : [];
      const n = Math.min(s.length, d.length);
      for (let i=0;i<n;i++){
        bakeTree_(s[i], d[i]);
      }
    }

    function appendAiRecognitionLogPages_(){
    // AI recognition log（AIごと改ページ／UIは除去／重複させない／AI名はPDFに出さない）
    try{
      const aiSrc =
        (sections?.dashboard && sections.dashboard.querySelector('#ai-rec-section')) ||
        (sections?.diagnosisRoot && sections.diagnosisRoot.querySelector('#ai-rec-section')) ||
        document.querySelector('#ai-rec-section');

      if (!aiSrc){
        root.appendChild(makePage_('pdf-report-ai', [
          '<h1 class="pdf-h1">AI認識ログ</h1>',
          '<div class="pdf-note">※ #ai-rec-section が見つかりませんでした</div>'
        ].join('\n')));
      } else {
        // ★details（=AIごとのアコーディオン）を確実に拾う
        const detailsList = Array.from(aiSrc.querySelectorAll('details[id^="ai-rec-"]'));

        // 末尾の注意書き（1回だけ）を取る
        let footerNote = '';
        try{
          const muted = aiSrc.querySelector(':scope > div.muted');
          if (muted) footerNote = (muted.textContent || '').trim();
        }catch(_){}

        if (!detailsList.length){
          // detailsが無い場合のフォールバック：見えるテキストだけ（UI除去は最小限）
          const clean = aiSrc.cloneNode(true);
          try{
            clean.querySelectorAll('form, textarea, input, select, button, summary, a').forEach(n => n.remove());
            clean.querySelectorAll('[role="button"], [tabindex]').forEach(n => n.remove());
          }catch(_){}
          const raw = (clean.textContent || '').trim();

          root.appendChild(makePage_('pdf-report-ai', [
            '<h1 class="pdf-h1">AI認識ログ</h1>',
            raw
              ? `<div style="white-space:pre-wrap;line-height:1.55;">${esc_(raw)}</div>`
              : '<div class="pdf-note">※ AI認識ログの内容が空でした</div>',
            footerNote ? `<div class="pdf-note" style="margin-top:10px;">${esc_(footerNote)}</div>` : ''
          ].join('\n')));
        } else {
          // detailsごとにページ化（AI名は一切出さない）
          // ★ 高さで分割して「table行のまま」複数ページ化する（切れ防止）
          const A4_H_PX = 1123; // stage.width=794px 前提のA4高さ(約)
          const PAD_T = 22;     // .pdf-page padding top（あなたのCSSと一致させる）
          const PAD_B = 26;     // .pdf-page padding bottom
          const SAFE_EXTRA = 30; // 余裕（ヘッダ/フッタ相当の安全分）
          const MAX_PAGE_H = A4_H_PX - PAD_T - PAD_B - SAFE_EXTRA;

          // 計測用ステージ（1回だけ作って使い回す）
          const __measureStage = (function(){
            try{
              const d = document.createElement('div');
              d.style.position = 'fixed';
              d.style.left = '-100000px';
              d.style.top  = '0';
              d.style.width = '794px';
              d.style.background = '#fff';
              d.style.pointerEvents = 'none';
              d.style.zIndex = '-1';
              document.body.appendChild(d);
              return d;
            }catch(_){ return null; }
          })();

          function measureHtmlHeight_(html){
            if (!__measureStage) return 999999;
            __measureStage.innerHTML = '';
            const page = document.createElement('section');
            page.className = 'pdf-page pdf-report-ai';
            // paddingはCSSが当たるのでここでは入れない
            page.appendChild(htmlToEl_(html));
            __measureStage.appendChild(page);
            // scrollHeight の方が確実
            const h = page.scrollHeight || page.getBoundingClientRect().height || 999999;
            return Math.ceil(h);
          }

          // payload（全文）を「行」単位で分割し、A4に収まる最大量でページを切る
          function splitPayloadByHeight_(baseHtmlBuilder, payloadText){
            const src = String(payloadText || '').replace(/\r\n/g, '\n');
            if (!src.trim()) return ['—'];

            // まず改行で行配列
            let lines = src.split('\n');

            // 長すぎる1行（URL/コード等）は先に適当に折る（高さ測定の安定化）
            const HARD_WRAP = 220; // 1行がこれ以上なら文字で折る
            const fixed = [];
            lines.forEach(l=>{
              l = String(l || '');
              if (l.length <= HARD_WRAP) { fixed.push(l); return; }
              let s = l;
              while (s.length){
                fixed.push(s.slice(0, HARD_WRAP));
                s = s.slice(HARD_WRAP);
              }
            });
            lines = fixed;

            const parts = [];
            let idx = 0;

            while (idx < lines.length){
              // 二分探索で「収まる最大行数」を探す
              let lo = 1;
              let hi = Math.min(lines.length - idx, 600); // 念のため上限
              let best = 1;

              while (lo <= hi){
                const mid = (lo + hi) >> 1;
                const chunk = lines.slice(idx, idx + mid).join('\n') || '—';
                const html = baseHtmlBuilder(chunk);
                const h = measureHtmlHeight_(html);

                if (h <= MAX_PAGE_H){
                  best = mid;
                  lo = mid + 1;
                }else{
                  hi = mid - 1;
                }
              }

              const out = lines.slice(idx, idx + best).join('\n') || '—';
              parts.push(out);
              idx += best;

              // それでも全然進まない（=1行でも溢れる）場合の保険：文字で強制切り
              if (best === 1){
                const one = String(lines[idx - 1] || '');
                if (one.length > 80){
                  const head = one.slice(0, 80);
                  const tail = one.slice(80);
                  parts[parts.length - 1] = head;
                  lines.splice(idx, 0, tail);
                }
              }
            }

            return parts.length ? parts : ['—'];
          }

          detailsList.forEach((det, idx) => {
            const aiTitle = (det.querySelector('summary')?.textContent || '').trim();
            const metaEl    = det.querySelector('.muted[id$="Meta"]');
            const queryEl   = det.querySelector('[id$="ViewQuery"]');
            const payloadEl = det.querySelector('[id$="ViewPayload"]');

            const meta    = (metaEl?.textContent || '').trim();
            const query   = (queryEl?.textContent || '').trim();
            const payload = (payloadEl?.textContent || '').trim();

            // 1ページ目：従来の見た目（AI名/保存日時/検索語句/観測結果）
            function buildAiHtml_First_(payloadChunk){
              const hasMore = !!(payloadChunk && String(payloadChunk).trim()) && !!(payload && String(payload).trim()) && (String(payloadChunk).length < String(payload).length);
              // ↑ hasMore は「続きページがあるときだけ出したい」なら使う（雑でもOK）

              return [
                '<h1 class="pdf-h1">AI認識ログ</h1>',
                aiTitle ? `<h2 class="pdf-h2">${esc_(aiTitle)}</h2>` : '',

                '<table class="pdf-table">',
                  '<tr><th style="width:26%;">項目</th><th>内容</th></tr>',
                  `<tr><td>検索語句</td><td style="white-space:pre-wrap;word-break:break-word;">${esc_(query || '—')}</td></tr>`,
                  `<tr><td>観測結果（全文）</td><td style="white-space:pre-wrap;word-break:break-word;">${esc_(payloadChunk || '—')}</td></tr>`,

                  // ★ 追加：表の末尾に「次ページへ続く…」を入れる（見た目はほぼ変えず、表の一部として出す）
                  // (hasMore ? [
                  //   '<tr>',
                  //     '<td colspan="2" style="text-align:right;font-size:12px;color:#6b7280;padding-top:6px;">',
                  //       '（次ページへ続く…）',
                  //     '</td>',
                  //   '</tr>',
                  // ].join('') : ''),

                '</table>',
              ].filter(Boolean).join('\n');
            }

            // 2ページ目以降：続きだけ（AI名/検索語句は出さない）
            // ※ 見た目を変えないため、table自体は維持するが行は「続き」だけにする
            function buildAiHtml_Cont_(payloadChunk, partLabel){
              return [
                '<h1 class="pdf-h1">AI認識ログ</h1>',

                // ★ 続きページは見出し（観測結果（続き）（2/2））を出さない
                // 代わりに table の行ラベルだけで “続き” を表現する
                '<table class="pdf-table">',
                  '<tr><th style="width:26%;">項目</th><th>内容</th></tr>',
                  `<tr><td>観測結果（続き）</td><td style="white-space:pre-wrap;word-break:break-word;">${esc_(payloadChunk || '—')}</td></tr>`,
                '</table>',
              ].join('\n');
            }

            // まず「高さで」payloadを分割
            const parts = splitPayloadByHeight_(
              (chunk) => buildAiHtml_First_(chunk), // 計測は1ページ目の骨格でOK（より厳しめ）
              payload
            );

            const total = parts.length;

            for (let pi=0; pi<total; pi++){
              const label = (total > 1) ? `（${pi+1}/${total}）` : '';

              if (pi === 0){
                root.appendChild(makePage_('pdf-report-ai', buildAiHtml_First_(parts[pi])));
              }else{
                root.appendChild(makePage_('pdf-report-ai', buildAiHtml_Cont_(parts[pi], label)));
              }
            }

            // 最後の注記は「最後のAIの最後の分割ページ」だけに付ける（仕様維持）
            if (footerNote && idx === detailsList.length - 1 && total > 0){
              // 最後に追加したページの末尾に注記を追記（簡単に：別ブロックとして追記）
              // ※ここは“見た目を変えない”なら、注記は従来通り最終ページに出すだけでOK
              // 既に上で抑制しているので、ここで1回だけ出す
              const html = [
                '<h1 class="pdf-h1">AI認識ログ</h1>',
                '<div class="pdf-note">※</div>',
                `<div class="pdf-note" style="margin-top:10px;">${esc_(footerNote)}</div>`
              ].join('\n');
              // 注記専用ページが嫌なら、この3行はコメントアウトしてOK
              // root.appendChild(makePage_('pdf-report-ai', html));
            }
          });

          try{ __measureStage && __measureStage.remove(); }catch(_){}
        }
      }
    }catch(e){
      root.appendChild(makePage_('pdf-report-ai', [
        '<h1 class="pdf-h1">AI認識ログ</h1>',
        '<div class="pdf-note">※ AI認識ログの取り込みで例外が発生しました</div>'
      ].join('\n')));
    }
    }

    // 5) AIO check（AI可視性に関する対応状況：1ページだけ・まずは枠だけ）
    try{
	      function buildAioCheckHtml_(rows, summary){
	        rows = Array.isArray(rows) ? rows : [];
	        summary = (summary && typeof summary === 'object') ? summary : {};
	        // rows: [{label, statusText}]  statusText は「✔ 確認されました / ✖ 現時点では確認されていません / － このサイト種別では必須ではありません / —」など
	        const trs = rows.map(r=>{
          const label = esc_(String(r && r.label || '—'));

	          // statusText は旧表記も受け取り、PDFでは色付きの丸印表示へ寄せる。
	          const st = detailStatusMark_(r && r.statusText);

	          // statusNote: ▲ のときだけ入れる「確認できた内容 / 推奨対応」（任意）
	          const noteRaw = (r && r.statusNote) ? String(r.statusNote) : '';
	          const note = noteRaw.trim()
	            ? `<div class="pdf-text" style="margin-top:4px;font-size:12px;line-height:1.55;color:#333;">${hangingLinesHtml_(noteRaw)}</div>`
	            : '';

			          return `<tr><td>${label}</td><td>${st}${note}</td></tr>`;
			        }).join('\n');

	        function hangingLinesHtml_(text){
	          return String(text || '').split(/\n/).map(line => {
	            const raw = String(line || '');
	            const isBullet = raw.trim().indexOf('・') === 0;
	            const style = isBullet
	              ? 'padding-left:1.15em;text-indent:-1.15em;'
	              : '';
	            return '<div style="' + style + '">' + esc_(raw) + '</div>';
	          }).join('');
	        }

	        function bulletListHtml_(items){
	          const bullets = Array.isArray(items) ? items.filter(Boolean).slice(0, 4) : [];
	          if (!bullets.length) return '';
	          return '<div style="margin-top:8px;font-size:11.5px;line-height:1.5;color:#333;">' +
	            bullets.map(b => '<div style="padding-left:1.15em;text-indent:-1.15em;">・' + esc_(String(b)) + '</div>').join('') +
	          '</div>';
	        }

		        function detailStatusLabel_(raw){
		          const s = String(raw || '').trim();
		          if (s.indexOf('一部') >= 0 || s.indexOf('△') >= 0 || s.indexOf('必須ではありません') >= 0) return '一部確認';
		          if (s.indexOf('確認されました') >= 0 || s.indexOf('✔') >= 0 || s === '良好') return '確認されました';
		          if (s.indexOf('未配置') >= 0) return '未配置';
		          if (!s || s === '—' || s === 'ー') return '現時点では確認されていません';
		          if (s.indexOf('確認できません') >= 0 || s.indexOf('未観測') >= 0 || s.indexOf('未確認') >= 0 || s.indexOf('✖') >= 0) return '現時点では確認されていません';
		          return '現時点では確認されていません';
		        }

		        function detailStatusMark_(raw){
		          const label = detailStatusLabel_(raw);
		          const color = label === '確認されました'
		            ? '#16934a'
		            : label === '一部確認'
		              ? '#c78500'
		              : '#d12f2f';
			          return '<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.45;color:#1f2937;white-space:nowrap;">' +
		            '<span style="font-size:11px;color:' + color + ';">●</span>' +
		            '<span>' + esc_(label) + '</span>' +
		          '</span>';
		        }

	        function statusPill_(card){
	          const bg = String(card && card.statusBg || '#eef2f7');
	          const color = String(card && card.statusColor || '#333');
	          const border = String(card && card.statusBorder || '#cbd5e1');
	          return '<span style="display:inline-block;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;background:' + bg + ';color:' + color + ';border:1px solid ' + border + ';white-space:nowrap;">' +
	            esc_(String(card && card.status || '—')) +
	          '</span>';
	        }

		        function summaryCard_(card){
		          card = (card && typeof card === 'object') ? card : {};
		          const bulletHtml = bulletListHtml_(card.bullets);
		          return [
	            '<div style="flex:1;min-width:0;border:1px solid #d8dee8;border-radius:12px;padding:13px 12px 12px;background:#ffffff;box-shadow:0 1px 3px rgba(15,23,42,0.04);">',
	              '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">',
	                '<div style="font-size:13.5px;font-weight:800;color:#111827;line-height:1.35;">' + esc_(String(card.title || '—')) + '</div>',
	                statusPill_(card),
	              '</div>',
	              '<div class="pdf-text" style="margin-top:9px;font-size:12px;line-height:1.62;color:#1f2937;">' + esc_(String(card.body || '')).replace(/\n/g, '<br>') + '</div>',
	              bulletHtml,
	            '</div>'
	          ].join('');
	        }

	        const cardsHtml = [
	          summaryCard_(summary.policy),
	          summaryCard_(summary.multimodal),
	          summaryCard_(summary.structure)
	        ].join('\n');

	        return [
	          // 章タイトル
	          '<h1 class="pdf-h1">GEO診断</h1>',
	          '<h2 class="pdf-h2">AI可視性に関する対応状況</h2>',

	          '<div class="pdf-text" style="font-size:12.5px;line-height:1.6;margin-top:4px;color:#1f2937;">',
	            'AIから見た公開設計を、方針・マルチモーダル情報・サイト構造の3つに分けて整理します。',
	          '</div>',

	          '<div style="display:flex;gap:10px;margin-top:12px;align-items:stretch;">',
	            cardsHtml,
	          '</div>',

	          '<div style="margin-top:12px;font-size:12.5px;font-weight:800;color:#1f2937;">詳細チェック</div>',
	          '<table class="pdf-table" style="margin-top:6px;font-size:11.5px;line-height:1.45;">',
	            '<tr><th style="width:42%;">項目</th><th>状況</th></tr>',
	            trs,
	          '</table>',
	        ].join('\n');
	      }

      // --- AIOチェック：実データが取れれば✔/✖/－にする（取れなければ — のまま） ---
      function pickFactsForAioCheck_(){
        // SSOT: 直近診断の結果（PDF生成時に参照できる）
        try{
          const r = (typeof window !== 'undefined' && window.__AIO_LAST_RES__) ? window.__AIO_LAST_RES__ : null;
          if (r && typeof r === 'object'){
            if (r.aioCheck && typeof r.aioCheck === 'object') return r.aioCheck;
            if (r.facts && typeof r.facts === 'object') return r.facts;
            // 念のため救済：facts が直置きされている形式
            if (r.auditSig || r.trust || r.data) return r;
          }
        }catch(_){}
        return null;
      }

	      function statusText_(v){
	        // v: true/false/null/undefined
	        if (v === true)  return '確認されました';
	        if (v === null)  return '一部確認';
	        if (v === false) return '現時点では確認されていません';
	        // undefined は未判定
	        return '現時点では確認されていません';
	      }

      // === [AIOCHECK][POLICY-TRI-STATE v1] AI向け利用方針だけ △ 表示を許可 ===
      function statusTextPolicy_(aiPolicyBool, hasDecl){
	        if (aiPolicyBool === true)  return '確認されました';
	        if (aiPolicyBool === false) return '現時点では確認されていません';

        // aiPolicy が未判定でも「宣言の示唆」が取れていれば △
	        if (hasDecl === true) return '一部確認';

	        return '現時点では確認されていません';
	      }

      function normalizeSiteTypeCode_(siteType){
        // 4種だけ：corp / ec / media / saas
        try{
          if (!siteType) return '';

          // 文字列ならそのまま正規化
          if (typeof siteType === 'string'){
            const s = siteType.trim().toLowerCase();
            if (s === 'corp' || s === 'corporate') return 'corp';
            if (s === 'ec'   || s === 'ecommerce') return 'ec';
            if (s === 'media' || s === 'news') return 'media';
            if (s === 'saas' || s === 'service') return 'saas'; // もし過去混在が残っててもsaasへ寄せる
            return '';
          }

          // オブジェクト（snapshotJSON.siteType）を想定
          if (typeof siteType === 'object'){
            if (siteType.isSaaSOrService) return 'saas';
            if (siteType.isEC)           return 'ec';
            if (siteType.isMedia)        return 'media';
            if (siteType.isCorporate)    return 'corp';
            return '';
          }
        }catch(_){}
        return '';
      }

      function statusTextMcp_(v, siteType){
        // v: true/false/null/undefined
        if (v === true)  return '✔ 確認されました';

        if (v === false){
          const st = normalizeSiteTypeCode_(siteType);

          // siteType 不明でも「一般サイト寄り」扱い（あなたの方針維持）
          if (!st) return '－ このサイト種別では必須ではありません';

          // 「MCPが必須じゃない」＝ corp/ec/media
          const isNotRequired = (st === 'corp' || st === 'ec' || st === 'media');

          return isNotRequired ? '－ このサイト種別では必須ではありません'
                              : '✖ 現時点では確認されていません'; // saas はここに落ちる
        }

        // null/undefined は未判定
        return '—';
      }

      function boolFromFacts_(f, path){
        // path: 'auditSig.hasSitemapXml' のようなドットパス
        try{
          const ps = String(path||'').split('.');
          let cur = f;
          for (let i=0;i<ps.length;i++){
            if (!cur || typeof cur !== 'object') return undefined;
            cur = cur[ps[i]];
          }
          return (typeof cur === 'boolean') ? cur : undefined;
        }catch(_){ return undefined; }
      }

      function anyHrefIncludes_(needle){
        try{
          const n = String(needle||'').toLowerCase();
          const as = Array.from(document.querySelectorAll('a[href]'));
          for (const a of as){
            const href = String(a.getAttribute('href')||'').toLowerCase();
            if (href.includes(n)) return true;
          }
        }catch(_){}
        return undefined; // 断定しない（リンクが無い＝存在しない、ではないので）
      }

      function hasExternalRefHint_(f){
        // “外部評価情報への参照点”は、GBP/Maps などの「入口」があれば✔
        // facts があれば sameAs / placeId 系から拾う。無ければ DOM の maps リンクだけ軽く拾う。
        try{
          // JSON-LD解析結果が facts に入っている想定の救済（ある場合だけ）
          const sig = (f && typeof f.auditSig === 'object') ? f.auditSig : {};
          // 例：sig.hasGoogleMapsLink / sig.hasPlaceId 等があるならそれを使う
          const b1 = (typeof sig.hasGoogleMapsLink === 'boolean') ? sig.hasGoogleMapsLink : undefined;
          if (b1 !== undefined) return b1;

          const b2 = (typeof sig.hasPlaceId === 'boolean') ? sig.hasPlaceId : undefined;
          if (b2 !== undefined) return b2;
        }catch(_){}

        // DOMベース（弱いが“入口がある”の事実としては十分）
        try{
          const as = Array.from(document.querySelectorAll('a[href]'));
          for (const a of as){
            const href = String(a.getAttribute('href')||'');
            if (!href) continue;
            const h = href.toLowerCase();
            if (h.includes('google.com/maps') || h.includes('goo.gl/maps') || h.includes('maps.app.goo.gl')) return true;
            if (h.includes('g.page/')) return true; // Googleビジネスプロフィール短縮
          }
        }catch(_){}
        return null; // 見つからなければ「未判定」
      }

      // === [PDF][AIOCHECK][FACTS-SOURCE v1] pickFactsForAioCheck_ に依存せず、直近resから読む ===
	      const f0 = (function(){
	        try{
	          // 1) いま実際に入っている場所（あなたの確認結果）
	          if (window.__AIO_LAST_RES__ && typeof window.__AIO_LAST_RES__ === 'object') return window.__AIO_LAST_RES__;
	          if (window.__AIO_LAST_SS_RES__ && typeof window.__AIO_LAST_SS_RES__ === 'object') return window.__AIO_LAST_SS_RES__;
	          if (window.__AIO_DEBUG_LAST_SS_RESULT && typeof window.__AIO_DEBUG_LAST_SS_RESULT === 'object') return window.__AIO_DEBUG_LAST_SS_RESULT;
	        }catch(_){}
	        return null;
	      })();

	      const snapshot0 = (function(){
	        try{
	          return (f0 && f0.snapshot   && typeof f0.snapshot   === 'object') ? f0.snapshot :
	            (f0 && f0.snapshotJSON && typeof f0.snapshotJSON === 'object') ? f0.snapshotJSON :
	            (f0 && f0.snap       && typeof f0.snap       === 'object') ? f0.snap :
	            null;
	        }catch(_){}
	        return null;
	      })();

	      // === [PDF][AIOCHECK-READ v1] snapshotJSON.aioCheck（永続）を最優先で読む ===
	      const aioCheck0 = (function(){
	        try{
	          // 1) facts 直下に aioCheck がある（将来用）
	          if (f0 && f0.aioCheck && typeof f0.aioCheck === 'object') return f0.aioCheck;

	          // 2) SSから復元した snapshotJSON が facts にぶら下がっている場合（よくある）
	          //    ここは実装揺れがあるので "snapshot" / "snapshotJSON" / "snap" を順に見る
	          if (snapshot0 && snapshot0.aioCheck && typeof snapshot0.aioCheck === 'object') return snapshot0.aioCheck;
	        }catch(_){}
	        return null;
	      })();

	      const multimodal0 = (function(){
	        try{
	          const candidates = [
	            f0 && f0.multimodalSignals,
	            f0 && f0.auditSig && f0.auditSig.multimodalSignals,
	            f0 && f0.enrichedObservations && f0.enrichedObservations.multimodalSignals,
	            snapshot0 && snapshot0.multimodalSignals,
	            snapshot0 && snapshot0.auditSig && snapshot0.auditSig.multimodalSignals,
	            snapshot0 && snapshot0.enrichedObservations && snapshot0.enrichedObservations.multimodalSignals,
	            snapshot0 && snapshot0.observations && snapshot0.observations.multimodalSignals
	          ];
	          for (let i = 0; i < candidates.length; i++) {
	            const v = candidates[i];
	            if (v && typeof v === 'object' && !Array.isArray(v)) return v;
	          }
	        }catch(_){}
	        return null;
	      })();

      const siteType0 =
        (aioCheck0 && (aioCheck0.siteType || aioCheck0.siteMode)) ||
        (f0 && (
          f0.siteType ||
          f0.siteMode ||
          (f0.meta && (f0.meta.siteType || f0.meta.siteMode))
        )) ||
        undefined;

      function findBoolDeep_(obj, key){
        // obj のどこかに { [key]: true/false } があればそれを返す
        try{
          const seen = new Set();
          function walk(o, depth){
            if (!o || typeof o !== 'object') return undefined;
            if (seen.has(o)) return undefined;
            seen.add(o);
            if (depth > 12) return undefined; // 深掘りしすぎ防止

            if (Object.prototype.hasOwnProperty.call(o, key)){
              const v = o[key];
              if (typeof v === 'boolean') return v;
            }
            for (const k in o){
              if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
              const v = o[k];
              if (v && typeof v === 'object'){
                const hit = walk(v, depth + 1);
                if (hit !== undefined) return hit;
              }
            }
            return undefined;
          }
          return walk(obj, 0);
        }catch(_){
          return undefined;
        }
      }

      // 1) AI向け利用方針（まず永続 aioCheck を最優先）
      let hasAiPolicy =
        (aioCheck0 && typeof aioCheck0.aiPolicy === 'boolean') ? aioCheck0.aiPolicy :
        boolFromFacts_(f0, 'aiPolicy') ??
        undefined;

      // 2) robots.txt（aioCheck を最優先）
      let hasRobots =
        (aioCheck0 && typeof aioCheck0.hasRobotsTxt === 'boolean') ? aioCheck0.hasRobotsTxt :
        boolFromFacts_(f0, 'hasRobotsTxt') ??
        undefined;

      // 3) sitemap.xml（aioCheck を最優先）
      let hasSitemap =
        (aioCheck0 && typeof (aioCheck0.hasSitemapXml ?? aioCheck0.sitemap) === 'boolean')
          ? (aioCheck0.hasSitemapXml ?? aioCheck0.sitemap)
          : (boolFromFacts_(f0, 'hasSitemapXml') ?? boolFromFacts_(f0, 'sitemap') ?? findBoolDeep_(f0, 'hasSitemapXml'));

      // 4) 構造化宣言（aioCheck を最優先…ただし false は auditSig で救済）
      const sig = (f0 && typeof f0.auditSig === 'object') ? f0.auditSig : {};

      let hasStructuredDecl =
        (aioCheck0 && typeof aioCheck0.hasStructuredDecl === 'boolean') ? aioCheck0.hasStructuredDecl :
        (boolFromFacts_(f0, 'hasStructuredDecl') ?? undefined);

      // ★救済：×(false) でも JSON-LD検出があるなら △(null) に引き上げ
      try{
        const hasAnyJsonld =
          (sig.hasOrgJsonLd === true) ||
          (sig.hasWebsiteJsonLd === true) ||
          (sig.jsonldDetected === true) ||
          (typeof sig.jsonldCount === 'number' && sig.jsonldCount > 0);

        if (hasStructuredDecl === false && hasAnyJsonld) {
          // 「自社宣言として確定はできないが、構造化データ自体はある」扱い
          hasStructuredDecl = null;
        }
      }catch(_){}

      // 5) MCP（aioCheck を最優先）
      let hasMcp = (function(){
        try{
          // 1) SS保存済み aioCheck を最優先
          if (aioCheck0 && typeof aioCheck0.hasMcpEndpoint === 'boolean') {
            return aioCheck0.hasMcpEndpoint;
          }
          // 2) 次に facts（復元揺れ用）
          const b = boolFromFacts_(f0, 'hasMcpEndpoint');
          if (typeof b === 'boolean') return b;

          // 3) それ以外は未判定
          return undefined;
        }catch(_){
          return undefined;
        }
      })();

      // 6) 外部評価情報への参照点（aioCheck を最優先）
	      let hasExternalRef =
	        (aioCheck0 && typeof aioCheck0.hasExternalRefHint === 'boolean') ? aioCheck0.hasExternalRefHint :
	        boolFromFacts_(f0, 'hasExternalRefHint') ??
	        boolFromFacts_(f0, 'externalRef') ??
	        hasExternalRefHint_(f0);

	      const mmImage0 = (multimodal0 && multimodal0.image && typeof multimodal0.image === 'object') ? multimodal0.image : {};
	      const mmStructured0 = (multimodal0 && multimodal0.structured && typeof multimodal0.structured === 'object') ? multimodal0.structured : {};
	      const mmVideo0 = (multimodal0 && multimodal0.video && typeof multimodal0.video === 'object') ? multimodal0.video : {};
	      const mmAudio0 = (multimodal0 && multimodal0.audio && typeof multimodal0.audio === 'object') ? multimodal0.audio : {};
	      const hasMultimodalChecked0 = !!(multimodal0 && multimodal0.checked === true);
	      const hasOgImage0 = !!(mmImage0.hasOgImage === true || String(mmImage0.ogImageUrl || '').trim());
	      const hasTwitterImage0 = !!(mmImage0.hasTwitterImage === true || String(mmImage0.twitterImageUrl || '').trim());
	      const hasFavicon0 = !!(mmImage0.hasFavicon === true || String(mmImage0.faviconUrl || '').trim());
	      const hasAppleTouchIcon0 = !!(mmImage0.hasAppleTouchIcon === true || String(mmImage0.appleTouchIconUrl || '').trim());
	      const hasAnyBasicMediaMeta0 = hasOgImage0 || hasTwitterImage0 || hasFavicon0 || hasAppleTouchIcon0;
	      const hasStructuredLogo0 = !!(mmStructured0.hasStructuredLogo === true || String(mmStructured0.structuredLogoUrl || '').trim());
	      const hasImageObject0 = Number(mmStructured0.imageObjectCount || 0) > 0;
	      const hasStructuredImage0 = Number(mmStructured0.structuredImageCount || 0) > 0;
	      const hasPrimaryImage0 = !!String(mmStructured0.primaryImageOfPage || '').trim();
	      const hasVideoObject0 = !!(mmVideo0.hasVideoObject === true || Number(mmVideo0.videoObjectCount || 0) > 0);
		      const hasAudioObject0 = !!(mmAudio0.hasAudioObject === true || Number(mmAudio0.audioObjectCount || 0) > 0);
		      const hasAnyStructuredMedia0 = hasStructuredLogo0 || hasImageObject0 || hasStructuredImage0 || hasPrimaryImage0 || hasVideoObject0 || hasAudioObject0;
		      const structuredMediaStrong0 = hasStructuredLogo0 && (hasImageObject0 || hasStructuredImage0 || hasPrimaryImage0);

		      const aioSummary0 = (function(){
		        const okStyle = {
		          statusBg: '#e8f7ee',
		          statusColor: '#166534',
		          statusBorder: '#9bd8ae'
		        };
		        const warnStyle = {
		          statusBg: '#fff7db',
		          statusColor: '#92400e',
		          statusBorder: '#e6c36a'
		        };
		        const badStyle = {
		          statusBg: '#fee2e2',
		          statusColor: '#991b1b',
		          statusBorder: '#f1a5a5'
		        };

		        const hasLlmsTxt0 = !!(aioCheck0 && (aioCheck0.hasLlmsTxt === true || String(aioCheck0.llmsTxtUrl || '').trim()));
		        const hasLlmsFullTxt0 = !!(aioCheck0 && (aioCheck0.hasLlmsFullTxt === true || String(aioCheck0.llmsFullTxtUrl || '').trim()));
		        const hasRobotsAiPolicy0 = !!(aioCheck0 && aioCheck0.robotsAiBotHints === true);
		        const policyStrong0 = hasLlmsFullTxt0 || hasLlmsTxt0;
		        const policyPartial0 = !policyStrong0 && hasRobotsAiPolicy0;
			        const policyStatus0 = policyStrong0
			          ? Object.assign({ status: '良好' }, okStyle)
			          : policyPartial0
			            ? Object.assign({ status: '一部対応' }, warnStyle)
			            : Object.assign({ status: '要整備' }, badStyle);

			        const multimodalStatus0 = (hasAnyBasicMediaMeta0 && structuredMediaStrong0)
			          ? Object.assign({ status: '良好' }, okStyle)
			          : hasAnyBasicMediaMeta0
			            ? Object.assign({ status: '一部対応' }, warnStyle)
			            : Object.assign({ status: '要整備' }, badStyle);

		        const sameAsCnt0 = (typeof sig.sameAsCount === 'number' && sig.sameAsCount > 0) ? sig.sameAsCount : 0;
		        const hasStructureBase0 = (hasSitemap === true) || (hasStructuredDecl === true) || (hasStructuredDecl === null) || sameAsCnt0 > 0;
			        const structureStatus0 = hasStructureBase0
			          ? Object.assign({ status: '良好' }, okStyle)
			          : Object.assign({ status: '要整備' }, badStyle);

		        return {
		          policy: Object.assign({
		            title: 'AI向け公開方針',
		            body: policyStrong0
		              ? 'AI向け公開情報ファイルを確認できます。robots.txt の方針と合わせて、AIが参照しやすい公開設計になっています。'
		              : policyPartial0
		                ? 'AIクローラー方針は robots.txt で確認できます。一方で、AI向け公開情報ファイル（llms.txt / llms-full.txt）は確認対象URLでは未配置です。'
		                : 'AIクローラー向けの方針や、AI向け公開情報ファイルは観測範囲では確認できていません。',
		            bullets: [
		              'robots.txt AIクローラー方針: ' + (hasRobotsAiPolicy0 ? '確認' : '確認できず'),
		              'llms.txt: ' + (hasLlmsTxt0 ? '確認' : '未配置'),
		              'llms-full.txt: ' + (hasLlmsFullTxt0 ? '確認' : '未配置')
		            ]
		          }, policyStatus0),

		          multimodal: Object.assign({
		            title: 'AI向けマルチモーダル情報',
		            body: hasAnyBasicMediaMeta0
		              ? 'OGP画像やアイコン情報は確認できます。一方で、AIが画像やメディア情報を機械的に理解しやすくする構造化情報は限定的です。'
		              : '画像やアイコンの基本メタ情報、構造化メディア情報ともに観測範囲では限定的です。',
		            bullets: [
		              'OGP / twitter:image: ' + ((hasOgImage0 || hasTwitterImage0) ? '確認' : '確認できず'),
		              'favicon / apple-touch-icon: ' + ((hasFavicon0 || hasAppleTouchIcon0) ? '確認' : '確認できず'),
		              '実装ヒント: structured logo / ImageObject',
		              'VideoObject / AudioObject: ' + ((hasVideoObject0 || hasAudioObject0) ? '一部確認' : '必要時に整備')
		            ]
		          }, multimodalStatus0),

			          structure: Object.assign({
			            title: 'AI可読なサイト構造',
			            body: hasStructureBase0
			              ? 'サイト構造や運営主体に関する基本入口は成立しています。良好は改善余地ゼロではなく、AIにとって読めない状態ではないという意味です。'
			              : 'サイト構造や運営主体に関する機械可読な情報は、観測範囲では限定的です。',
		            bullets: [
		              'sitemap.xml: ' + (hasSitemap === true ? '確認' : '確認できず'),
		              'WebSite / Organization: ' + (hasStructuredDecl === true ? '確認' : hasStructuredDecl === null ? '一部確認' : '確認できず'),
		              'sameAs: ' + (sameAsCnt0 > 0 ? String(sameAsCnt0) + '件' : '確認できず')
		            ]
		          }, structureStatus0),

		        };
		      })();

		      const rows0 = [
	        {
		          label: 'AIクローラー方針（robots.txt）',
          statusText: (function(){
            try{
              // decl は「宣言を確認できた時だけ true」それ以外は null 扱い（= 断定しない）
              const decl =
                (aioCheck0 && aioCheck0.hasAiPolicyDeclaration === true) ? true :
                (boolFromFacts_(f0, 'hasAiPolicyDeclaration') === true) ? true :
                null;

              const v = hasAiPolicy; // true / false / null / undefined

	              // 表示ルール（仕様は変えず、見せ方だけ明確化）
	              if (decl === true) return '確認されました';
	              if (v === true)    return '一部確認'; // 示唆はあるが「宣言」は確認できない
	              return '現時点では確認されていません';
	            }catch(_){
	              return '現時点では確認されていません';
	            }
          })(),
          statusNote: (function(){
            try{
              const decl =
                (aioCheck0 && aioCheck0.hasAiPolicyDeclaration === true) ? true :
                (boolFromFacts_(f0, 'hasAiPolicyDeclaration') === true) ? true :
                false;

              const v = hasAiPolicy; // true / false / null / undefined

              // ○：明示宣言あり → 注記なし
              if (decl === true) return '';

	              // △：示唆あり（robots 等）
	              if (v === true) {
	                return 'robots.txt でAIクローラー方針を確認できます。一方で、AI向け公開情報ファイル（llms.txt / llms-full.txt）は確認対象URLでは未配置です';
	              }

	              // ×：取得できたが宣言なし
	              if (v === false) {
	                return 'AIクローラー方針やAI向け公開情報ファイルは、観測範囲では確認できませんでした';
	              }

              // ー：未観測・判定不能
              return 'AI利用に関する方針や意図を示す記述は未観測、または判定できませんでした';

            }catch(_){
              return 'AI利用に関する方針や意図を示す記述は未観測、または判定できませんでした';
            }
          })()
        },
	        {
	          label: 'llms.txt',
	          statusText: aioCheck0 && typeof aioCheck0.hasLlmsTxt === 'boolean'
	            ? (aioCheck0.llmsTxtUrl ? '確認されました' : '未配置')
	            : '現時点では確認されていません',
	          statusNote: aioCheck0 && aioCheck0.llmsTxtUrl ? '・検出URL: ' + String(aioCheck0.llmsTxtUrl) : ''
	        },
	        {
	          label: 'llms-full.txt',
	          statusText: aioCheck0 && typeof aioCheck0.hasLlmsFullTxt === 'boolean'
	            ? (aioCheck0.llmsFullTxtUrl ? '確認されました' : '未配置')
	            : '現時点では確認されていません',
	          statusNote: aioCheck0 && aioCheck0.llmsFullTxtUrl ? '・検出URL: ' + String(aioCheck0.llmsFullTxtUrl) : ''
	        },
	        {
	          label: 'AIクローラー対象トークン',
	          statusText: statusText_(aioCheck0 && typeof aioCheck0.robotsAiBotHints === 'boolean' ? aioCheck0.robotsAiBotHints : undefined),
	          statusNote: (function(){
	            try{
              const tokens = (aioCheck0 && Array.isArray(aioCheck0.robotsAiBotHintTokens))
                ? aioCheck0.robotsAiBotHintTokens.filter(Boolean)
                : [];
              const source = aioCheck0 && aioCheck0.aiPolicyEvidenceSource
                ? String(aioCheck0.aiPolicyEvidenceSource)
	                : '';
	              const lines = [];
	              if (tokens.length) lines.push('・AIクローラー方針の対象: ' + tokens.slice(0, 12).join(', '));
	              if (source) lines.push('・根拠: ' + source);
	              return lines.join('\n');
	            }catch(_){
	              return '';
	            }
	          })()
	        },
	        {
	          label: 'AI向けマルチモーダル情報（基本メタ）',
	          statusText: hasMultimodalChecked0
	            ? (hasAnyBasicMediaMeta0 ? '確認されました' : '現時点では確認されていません')
	            : '現時点では確認されていません',
	          statusNote: (function(){
	            try{
	              if (!hasMultimodalChecked0) return '';
	              const bits = [];
	              if (hasOgImage0) bits.push('og:image');
	              if (hasTwitterImage0) bits.push('twitter:image');
	              if (hasFavicon0) bits.push('favicon');
	              if (hasAppleTouchIcon0) bits.push('apple-touch-icon');
	              return bits.length ? '・確認項目: ' + bits.join(', ') : '';
	            }catch(_){ return ''; }
	          })()
	        },
	        {
	          label: '構造化メディア情報（JSON-LD）',
	          statusText: hasMultimodalChecked0
	            ? (structuredMediaStrong0 ? '確認されました' : '一部確認')
	            : '現時点では確認されていません',
	          statusNote: (function(){
	            try{
	              if (!hasMultimodalChecked0) return '';
	              const present = [];
	              const missing = [];
	              if (hasStructuredLogo0) present.push('structured logo'); else missing.push('structured logo');
	              if (hasImageObject0) present.push('ImageObject'); else missing.push('ImageObject');
	              if (hasPrimaryImage0) present.push('primaryImageOfPage'); else missing.push('primaryImageOfPage');
	              if (hasVideoObject0) present.push('VideoObject');
	              if (hasAudioObject0) present.push('AudioObject');
		              const lines = [];
		              if (present.length) lines.push('・確認項目: ' + present.join(', '));
		              if (missing.length) lines.push('・AIが画像やメディア情報を機械的に理解しやすくする余地があります');
		              if (missing.length) lines.push('・改善余地: ' + missing.join(', '));
	              if (!hasVideoObject0 && !hasAudioObject0) lines.push('・動画・音声の未検出自体は不足扱いしません');
	              return lines.join('\n');
	            }catch(_){ return ''; }
	          })()
	        },
	        { label: 'サイトマップ公開（sitemap.xml）',   statusText: statusText_(hasSitemap) },
        {
          label: 'サイト全体・運営主体の構造化データ（自社宣言）',
          statusText: (function(){
            try{
	              // hasStructuredDecl: true=✔ / false=✖ / null=△ / undefined=—
	              if (hasStructuredDecl === true)  return '確認されました';
	              if (hasStructuredDecl === null)  return '一部確認';
	              if (hasStructuredDecl === false) return '現時点では確認されていません';
	              return '現時点では確認されていません';
	            }catch(_){ return '現時点では確認されていません'; }
          })(),
          statusNote: (function(){
            try{
              const sig = (f0 && typeof f0.auditSig === 'object') ? f0.auditSig : {};

              // ✔：強い根拠（Org / WebSite を確認）
              if (hasStructuredDecl === true) {
                const bits = [];
                if (sig.hasOrgJsonLd === true)     bits.push('Organization');
                if (sig.hasWebsiteJsonLd === true) bits.push('WebSite');
                const types = bits.length ? bits.join(', ') : '（種別は未特定）';
                return `・構造化データ（${types}）を確認`;
              }

              // △：弱い根拠（jsonldDetected/jsonldCount はある）
              if (hasStructuredDecl === null) {
                const cnt = (typeof sig.jsonldCount === 'number') ? sig.jsonldCount : 0;
                if (cnt > 0) return `・構造化データは検出（件数: ${cnt}）しましたが、自社宣言（運営主体/サイト全体）として確定できません`;
                if (sig.jsonldDetected === true) return '・構造化データは検出しましたが、自社宣言（運営主体/サイト全体）として確定できません';
                return '・構造化データは一部確認できますが、自社宣言として確定できません';
              }

              // ✖：未検出
              if (hasStructuredDecl === false) {
                return '・サイト全体/運営主体を示す構造化データは確認できませんでした';
              }

              return '';
            }catch(_){ return ''; }
          })()
        },
        {
          label: '外部プロフィール連携（sameAs）',
          statusText: (function(){
            try{
              // 1) 構造化データの sameAs 件数（あれば ✔）
              const sig = (f0 && typeof f0.auditSig === 'object') ? f0.auditSig : {};
              const sameAsCnt = (typeof sig.sameAsCount === 'number' && sig.sameAsCount > 0) ? sig.sameAsCount : 0;

	              if (sameAsCnt > 0) return '確認されました';

              // 2) DOM上の外部参照（あれば △）
              // ※ hasExternalRefHint_(f0) は “外部へつながる入口がある” の弱い証拠
              const hasDomExternal = (hasExternalRefHint_(f0) === true);
	              if (hasDomExternal) return '一部確認';

	              // 3) 無ければ未検出
	              return '現時点では確認されていません';
	            }catch(_){ return '現時点では確認されていません'; }
          })(),
          statusNote: (function(){
            try{
              const sig = (f0 && typeof f0.auditSig === 'object') ? f0.auditSig : {};
              const sameAsCnt = (typeof sig.sameAsCount === 'number' && sig.sameAsCount > 0)
                ? sig.sameAsCount
                : 0;

              // 構造化データ sameAs がある場合
              if (sameAsCnt > 0 && sig.hasJsonLd === true) {
                return `・構造化データの sameAs を ${sameAsCnt} 件確認`;
              }

              // 構造化データとしては確定できないが、外部参照候補がある場合
              if (sameAsCnt > 0 && sig.hasJsonLd !== true) {
                return `・外部プロフィール候補: ${sameAsCnt} 件`;
              }

              // 何も無い
              return '';
            }catch(_){
              return '';
            }
          })()
        },
	      ];

	      root.appendChild(makePage_('pdf-report-aio', buildAioCheckHtml_(rows0, aioSummary0)));
    }catch(e){
      try{
        console.error('[PDF][AIOCHECK][BUILD][ERR]', e && (e.stack || e));
        window.__AIO_LAST_AIOCHECK_BUILD_ERR__ = String(e && (e.stack || e));
      }catch(_){}

      root.appendChild(makePage_('pdf-report-aio', [
        '<h1 class="pdf-h1">GEO診断</h1>',
        '<h2 class="pdf-h2">AI可視性に関する対応状況</h2>',
        '<div class="pdf-note">※ AI可視性チェックページの生成で例外が発生しました</div>'
      ].join('\n')));
    }

    // 3) Summary page（sections=画面DOMからKPIを抽出して埋める）
    const kpi = extractKpiFromSections_(sections);
    console.warn('[PDF][C][KPI]', kpi);

    // 3.1) Summary page DOM（KPIは画面DOMをクローン→computed style焼き付けで“再現”）
    {
      const page = document.createElement('section');
      page.className = 'pdf-page pdf-report-summary';

      page.appendChild(htmlToEl_('<h1 class="pdf-h1">GEO診断</h1>'));
      // page.appendChild(htmlToEl_('<h2 class="pdf-h2">ランク・総合スコア</h2>'));

      try{
        const kpiSrc =
          (sections?.dashboard && sections.dashboard.querySelector('.kpi-row')) ||
          document.querySelector('.kpi-row') ||
          null;

        if (kpiSrc){
          const kpiClone = kpiSrc.cloneNode(true);
          bakeTree_(kpiSrc, kpiClone);

          // === [PDF][KPI][FILL+WIDTH-FIX v1] 値を“抽出結果”で確実に差し込み + 右詰まり/固定幅を止血 ===
          try{
            // 0) まず「どのIDが居るか」確認（次の切り分け用）
            const ids = Array.from(kpiClone.querySelectorAll('[id]')).map(n=>n.id).filter(Boolean);
            console.warn('[PDF][KPI][IDS]', ids);

            // 1) 値を差し込む（dv2系IDが居ればそこへ。無ければ旧IDへフォールバック）
            const scoreText = (kpi && (kpi.score != null)) ? String(kpi.score) : '';
            const rankText  = (kpi && kpi.rank) ? String(kpi.rank) : '';
            const diffText  = (kpi && kpi.diffText) ? String(kpi.diffText) : '';

            function setTextByIds_(idList, text){
              if (!text) return false;
              for (const id of idList){
                const el = kpiClone.querySelector('#' + id);
                if (el){
                  el.textContent = text;
                  return true;
                }
              }
              return false;
            }

            // rank
            setTextByIds_(['dv2-kpi-rank','dv2-kpiRank','resultRank','dv2-kpi-rank'], rankText);

            // score
            setTextByIds_(['dv2-kpi-score','dv2-kpiScore','badgeAvg','resultScore','sumBefore'], scoreText);

            // diff（文字列のまま： "+3" 等を維持）
            setTextByIds_(['dv2-kpi-gap','dv2-kpiDiff','prevDiff','kpiDiff'], diffText);

            // 2) “右端まで伸びる/右詰まり”の主因だけ止血（kpiClone配下限定）
            //    - 固定px幅/transform/auto margin を最小限に解除
            kpiClone.style.setProperty('width','100%','important');
            kpiClone.style.setProperty('max-width','100%','important');
            kpiClone.style.setProperty('box-sizing','border-box','important');

            // gridの見た目は維持（縦積み禁止）
            kpiClone.style.setProperty('display','grid','important');
            kpiClone.style.setProperty('grid-template-columns','repeat(3, minmax(0, 1fr))','important');
            kpiClone.style.setProperty('gap','12px','important');

            // 子（カード）だけ“幅/位置”を正規化
            Array.from(kpiClone.querySelectorAll(':scope .card')).forEach(card=>{
              try{
                card.style.setProperty('width','100%','important');
                card.style.setProperty('max-width','100%','important');
                card.style.setProperty('box-sizing','border-box','important');
                card.style.setProperty('transform','none','important');
                card.style.setProperty('left','0','important');
                card.style.setProperty('right','0','important');
                card.style.setProperty('margin-left','0','important');
                card.style.setProperty('margin-right','0','important');
                card.style.setProperty('min-width','0','important');
              }catch(_){}
            });

            console.warn('[PDF][KPI][FILLED]', {rankText, scoreText, diffText});
          }catch(e){
            console.warn('[PDF][KPI][FILL+WIDTH-FIX][ERR]', e);
          }

          // ✅ KPIだけ：下の“余白（margin-bottom）”だけ潰す（paddingは触らない）
          try{
            // kpiClone 自体の下余白
            kpiClone.style.marginBottom = '0';

            // KPI内の最後のカードが下余白を持ってるケースを潰す
            const cards = kpiClone.querySelectorAll('.card');
            const last  = cards && cards.length ? cards[cards.length - 1] : null;
            if (last) last.style.marginBottom = '0';

            // 念のため：kpi-row直下の要素にも下余白が焼けてたら潰す（paddingは維持）
            Array.from(kpiClone.children || []).forEach(ch=>{
              try{ ch.style.marginBottom = '0'; }catch(_){}
            });
          }catch(_){}

          // ★PDF用：KPIだけ「レイアウト系」を上書きして、見切れ/重なりを止める
          try{
            // 親（kpi-row）をPDF用の3カラムグリッドに固定
            kpiClone.style.display = 'grid';
            kpiClone.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
            kpiClone.style.gap = '12px';
            kpiClone.style.alignItems = 'stretch';
            kpiClone.style.width = '100%';
            kpiClone.style.maxWidth = '100%';
            kpiClone.style.boxSizing = 'border-box';

            kpiClone.querySelectorAll('.title-wrap').forEach(tw=>{
              try{
                tw.style.display = 'block';      // 横並びflexを殺す
                tw.style.width = '100%';
              }catch(_){}
            });
            kpiClone.querySelectorAll('.title-wrap > *').forEach(ch=>{
              try{
                ch.style.display = 'block';      // 「項目名」「Before」を縦に
              }catch(_){}
            });

            // 子孫の “固定幅” を解除（タイポは維持）
            // ★ width:auto は「内容幅に縮む」原因になるので、px幅は 100% に寄せる
            kpiClone.querySelectorAll('*').forEach(el=>{
              try{
                el.style.boxSizing = 'border-box';

                const w  = String(el.style.width || '');
                const mw = String(el.style.maxWidth || '');

                // px固定幅が焼けているなら、原則 100% に寄せる（縮み防止）
                if (/^\d+px$/.test(w))  el.style.width = '100%';

                // maxWidth のpx固定も 100% に寄せる
                if (/^\d+px$/.test(mw)) el.style.maxWidth = '100%';

                // min/max系の安全化
                if (el.style.minWidth)  el.style.minWidth = '0';
                if (!el.style.maxWidth) el.style.maxWidth = '100%';

                // transform/位置ズレの保険（右だけ崩れる系）
                if (el.style.transform) el.style.transform = 'none';
                if (el.style.left)  el.style.left  = '0';
                if (el.style.right) el.style.right = '0';

                // 長い文字/数字が重なりやすいので折返しを許可
                if (el.style.whiteSpace) el.style.whiteSpace = 'normal';
                // 行間が詰まりすぎると重なるので最低限だけ確保
                if (!el.style.lineHeight) el.style.lineHeight = '1.25';
              }catch(_){}
            });
          }catch(_){}

          // ★PDF用：KPIブロックの「過剰な高さ」を締める（焼き付いたheight/min-height対策）
          try{
            // 親（kpi-row）自体が変に高いケース
            kpiClone.style.height = 'auto';
            kpiClone.style.minHeight = '0';

            // KPIカード（.card）に焼き付いた min-height / height / padding が暴れてるケースが多い
            kpiClone.querySelectorAll('.card').forEach(card=>{
              try{
                card.style.height = 'auto';
                card.style.minHeight = '0';
                // “上下paddingが過剰” で背が伸びるケース用（タイポは維持）
                if (!card.style.paddingTop)    card.style.paddingTop = '12px';
                if (!card.style.paddingBottom) card.style.paddingBottom = '12px';
              }catch(_){}
            });

            // 子孫に焼き付いた height/min-height を解除（幅はもうやってるので高さだけ）
            kpiClone.querySelectorAll('*').forEach(el=>{
              try{
                if (el.style.height)    el.style.height = 'auto';
                if (el.style.minHeight) el.style.minHeight = '0';
                // もしline-heightが異常にデカく焼けてたら最低限に戻す（未指定の時だけ）
                if (!el.style.lineHeight) el.style.lineHeight = '1.25';
              }catch(_){}
            });
          }catch(_){}

          // === [PDF][KPI-VAL-JC-CENTER v1] dv2-kpi-{rank,score,gap} は justify-content を強制center（値要素だけ） ===
          try{
            ['dv2-kpi-rank','dv2-kpi-score','dv2-kpi-gap'].forEach(id=>{
              const el = kpiClone.querySelector('#' + id);
              if (!el || !el.style || !el.style.setProperty) return;

              // 「normal」(=start扱い) を潰して、値だけ確実に中央へ
              el.style.setProperty('display', 'flex', 'important');
              el.style.setProperty('justify-content', 'center', 'important');
              el.style.setProperty('align-items', 'center', 'important');
              el.style.setProperty('text-align', 'center', 'important');
              el.style.setProperty('width', '100%', 'important');
              el.style.setProperty('box-sizing', 'border-box', 'important');
            });
          }catch(_){}

          page.appendChild(kpiClone);

          // ✅ KPIと下のチャートの間だけ空ける（KPIの高さ・レイアウトは触らない）
          page.appendChild(htmlToEl_('<div style="height:12px"></div>'));

          // ★ KPI直後：推移・件数チャート（同一ページ：KPIの下に出す）
          try{
            function buildChartBlock(canvasSel, title){
              // 1) まず「PDF用に保存したPNG」を最優先で使う（画面幅/表示状態の影響を避ける）
              try{
                const id = String(canvasSel || '').replace(/^#/, '');
                const stash = window.__PDF_DASH_PNG__ || {};
                const png1 = stash[id];
                if (png1){
                  return [
                    '<div class="card" style="margin:0 0 12px;">',
                      `<h2 class="pdf-h2" style="margin:0 0 6px;">${esc_(title)}</h2>`,
                      '<div style="background:#ffffff;padding:8px;">',
                        `<img src="${png1}" style="width:100%;height:auto;display:block;">`,
                      '</div>',
                    '</div>'
                  ].join('');
                }
              }catch(_){}

              // 2) フォールバック：その場のDOM canvasから（従来どおり）
              try{
                const cv = document.querySelector(canvasSel);
                if (!cv || !cv.toDataURL) return '';

                const png2 = cv.toDataURL('image/png');
                return [
                  '<div class="card" style="margin:0 0 12px;">',
                    `<h2 class="pdf-h2" style="margin:0 0 6px;">${esc_(title)}</h2>`,
                    '<div style="background:#ffffff;padding:8px;">',
                      `<img src="${png2}" style="width:100%;height:auto;display:block;">`,
                    '</div>',
                  '</div>'
                ].join('');
              }catch(_){}

              return '';
            }

            const html = [
              '<section style="break-inside:avoid;page-break-inside:avoid;">',
                buildChartBlock('#dv2-chart-score',  '総合スコア推移'),
                buildChartBlock('#dv2-chart-clicks', '改善ポイント件数'),
              '</section>'
            ].join('\n');

            // ✅ 同一ページ：KPIページ（page）の末尾に追加
            page.appendChild(htmlToEl_(html));

          }catch(e){
            // ✅ KPIページは壊さない（注記だけ出す）
            page.appendChild(htmlToEl_('<div class="pdf-note">※ チャート生成失敗</div>'));
          }

        } else {
          page.appendChild(htmlToEl_('<div class="pdf-note">※ KPI（.kpi-row）が見つかりませんでした</div>'));
        }
      }catch(e){
        page.appendChild(htmlToEl_('<div class="pdf-note">※ KPIの取得に失敗しました</div>'));
      }

      page.appendChild(htmlToEl_([
        '<div style="height:12px"></div>',
        (kpi && kpi._note) ? `<div class="pdf-note" style="margin-top:10px;">${esc_(kpi._note)}</div>` : ''
      ].join('\n')));

      // === [PDF][SUMMARY-WIDTH-NORMALIZE v1] Summary内の“直下だけ”固定px幅を剥がす ===
      try{
        page.style.width = '794px';
        page.style.maxWidth = '794px';
        page.style.boxSizing = 'border-box';

        Array.from(page.children || []).forEach(ch=>{
          try{
            if (!ch || !ch.style) return;

            const w = String(ch.style.width || '');
            if (/^\d+px$/.test(w)) ch.style.width = '100%';

            const mw = String(ch.style.maxWidth || '');
            if (/^\d+px$/.test(mw)) ch.style.maxWidth = '100%';

            ch.style.boxSizing = 'border-box';
            ch.style.transform = 'none';
            ch.style.left = '0';
            ch.style.right = '0';
          }catch(_){}
        });
      }catch(_){}

      root.appendChild(page);
    }

    // 6) Diagnosis radar + Axis scores（同一ページに収める）
    try{
      const radarCard =
        (sections?.diagnosisRoot && sections.diagnosisRoot.querySelector('#dv2-card-result-radar')) ||
        document.querySelector('#dv2-card-result-radar');

      // ✅ レーダーは「canvas直取りでPNG化」し、見た目（グレー背景＋タイトル）は wrapper で作る
      // （= await不要。ここで壊れない）
      let png = '';
      try{
        if (radarCard){
          const c = radarCard.querySelector('canvas');
          if (c && c.toDataURL) png = c.toDataURL('image/png');
        }
      }catch(_){
        png = '';
      }

      // ★ 画面のスコア詳細（これを“置換元”として使う）※ID両対応
      const scoreSrc =
        (sections?.diagnosisRoot &&
          sections.diagnosisRoot.querySelector('#v2-card-score-table, #card-score-table')) ||
        document.querySelector('#v2-card-score-table, #card-score-table');

      // ===== ここから：makePage_ じゃなく “sectionを組む” =====
      const page = document.createElement('section');
      page.className = 'pdf-page pdf-report-radar-axis';

      page.appendChild(htmlToEl_('<h1 class="pdf-h1">GEO診断</h1>'));

      if (png){
        try{
          const radarSrc =
            (sections?.diagnosisRoot && sections.diagnosisRoot.querySelector('#dv2-card-result-radar')) ||
            document.querySelector('#dv2-card-result-radar') ||
            null;

          if (radarSrc){
            // 1) 画面DOMを丸ごと clone
            const radarClone = radarSrc.cloneNode(true);

            // 2) computed style 焼き付け
            bakeTree_(radarSrc, radarClone);

            // 3) canvas → PNG 差し替え
            const srcCanvas = radarSrc.querySelector('canvas');
            const dstCanvas = radarClone.querySelector('canvas');

            if (srcCanvas && dstCanvas && srcCanvas.toDataURL){
              const img = document.createElement('img');
              img.src = srcCanvas.toDataURL('image/png');
              img.style.display = 'block';
              img.style.maxWidth = '100%';
              img.style.height = 'auto';
              dstCanvas.replaceWith(img);
            }

            // 4) DOMとして追加（★ htmlToEl_ を使わない）
            page.appendChild(radarClone);

            // ✅ 余白（レーダー → スコア詳細の間隔を復元）
            page.appendChild(htmlToEl_('<div style="height:12px"></div>'));

          } else {
            page.appendChild(htmlToEl_(
              '<div class="pdf-note">※ レーダーが見つかりませんでした</div>'
            ));
          }

        } catch(e){
          page.appendChild(htmlToEl_(
            '<div class="pdf-note">※ レーダーチャートの再現に失敗しました</div>'
          ));
        }

      } else {
        page.appendChild(htmlToEl_(
          '<div class="pdf-note">※ レーダーが見つからないか、画像化できませんでした</div>'
        ));
      }

      // スコア詳細：画面DOMをクローンしてそのまま載せる（=ここで“置換”完了）
      if (scoreSrc){
        const clone = scoreSrc.cloneNode(true);

        // computed style 焼き付け（画面再現の肝）
        try{ bakeTree_(scoreSrc, clone); }catch(_){}

        // 指標の説明は常に非表示
        try{
          clone.querySelectorAll('#kpiHelpBlock, details').forEach(n => n.remove());
        }catch(_){}

        // はみ出し事故だけ止血
        try{
          clone.style.maxWidth = '100%';
          clone.style.boxSizing = 'border-box';
          clone.querySelectorAll('*').forEach(el=>{
            try{
              el.style.boxSizing = 'border-box';
              if (el.style.maxWidth) el.style.maxWidth = '100%';
            }catch(_){}
          });
        }catch(_){}

        page.appendChild(clone);
      }else{
        page.appendChild(htmlToEl_('<div class="pdf-note">※ #v2-card-score-table が見つかりませんでした</div>'));
      }

      root.appendChild(page);

    }catch(e){
      root.appendChild(makePage_('pdf-report-radar-axis', [
        '<h1 class="pdf-h1">レーダーチャート・スコア詳細</h1>',
        '<div class="pdf-note">※ レーダー/スコア詳細の生成で例外が発生しました</div>'
      ].join('\n')));
    }

    // 8) Summary card page（総合ランク：DOMクローン→computed style焼き付けで“再現”）
    try{
      const sumSrc =
        (sections?.diagnosisRoot && sections.diagnosisRoot.querySelector('#v2-card-result-summary')) ||
        document.querySelector('#v2-card-result-summary');

      const page = document.createElement('section');
      page.className = 'pdf-page pdf-report-rank';

      // 章/節のフォーマット
      page.appendChild(htmlToEl_('<h1 class="pdf-h1">GEO診断</h1>'));
      page.appendChild(htmlToEl_('<h2 class="pdf-h2">概要</h2>'));

      if (!sumSrc){
        page.appendChild(htmlToEl_('<div class="pdf-note">※ #v2-card-result-summary が見つかりませんでした</div>'));
      } else {
        // ★ PDF専用クローンを作る（画面DOMは触らない）
        const clone = sumSrc.cloneNode(true);

        // ★ 最重要：画面の computed style をすべて焼き付ける
        try{ bakeTree_(sumSrc, clone); }catch(_){}

        // 1) 指標の説明はPDFでは不要（＋スコア詳細が紛れたら消す）
        try{
          clone.querySelectorAll('#kpiHelpBlock, details, #v2-card-score-table').forEach(n => n.remove());
        }catch(_){}

        // 2) はみ出し防止（事故防止・見た目は維持）
        try{
          clone.style.maxWidth = '100%';
          clone.style.boxSizing = 'border-box';
          clone.querySelectorAll('*').forEach(el=>{
            el.style.boxSizing = 'border-box';
            if (el.style.maxWidth) el.style.maxWidth = '100%';
          });
        }catch(_){}

        // 3) pdf-page にそのまま載せる
        page.appendChild(clone);
      }

      // === [PDF][RANK-WIDTH-NORMALIZE v1] GEO診断サマリー(pfd-report-rank)だけ “右詰まり” を止血 ===
      try{
        // ページ自体は固定幅（他と同条件に揃える）
        page.style.width = '794px';
        page.style.maxWidth = '794px';
        page.style.boxSizing = 'border-box';

        // 「直下の card だけ」安全に正規化（深い子孫は触らない）
        const cards = Array.from(page.querySelectorAll(':scope .card'));
        cards.forEach(card=>{
          try{
            if (!card || !card.style) return;

            // 幅/位置/変形の焼き付きを無効化（右詰まりの主因）
            card.style.boxSizing = 'border-box';
            card.style.width = '100%';
            card.style.maxWidth = '100%';

            // left/right/transform が焼けてるケースがあるので潰す
            card.style.left = '0';
            card.style.right = '0';
            card.style.transform = 'none';

            // 余計な auto margin があると幅が詰まって見えるので固定
            card.style.marginLeft = '0';
            card.style.marginRight = '0';
          }catch(_){}
        });
      }catch(_){}

      // === [PDF][RANK-INNER-WIDTH-UNLOCK v2] rankページの「card配下」だけ px固定幅を解除 ===
      try{
        // ★ 絶対に rank ページ以外へ漏らさない
        const isRankPage = !!(page && page.classList && page.classList.contains('pdf-report-rank'));
        if (isRankPage) {
          const MAX_PX = 760; // 794pxページの内側での上限目安

          // ★ rankページ内の card の「中だけ」対象（kpi-row など他ページへの漏れを防ぐ）
          const cards = Array.from(page.querySelectorAll('.card'));
          cards.forEach(card=>{
            const nodes = Array.from(card.querySelectorAll('[style]'));
            nodes.forEach(el=>{
              try{
                const st = el.style;
                if (!st) return;

                const w  = String(st.width || '');
                const mw = String(st.maxWidth || '');

                if (/^\d+px$/.test(mw)) {
                  const n = parseInt(mw, 10);
                  if (!isNaN(n) && n > 0 && n < MAX_PX) st.maxWidth = '100%';
                }
                if (/^\d+px$/.test(w)) {
                  const n = parseInt(w, 10);
                  if (!isNaN(n) && n > 0 && n < MAX_PX) st.width = '100%';
                }

                // 位置ズレ要因だけ最小限に無効化（rank内だけ）
                if (st.transform) st.transform = 'none';
                if (st.left)      st.left = '0';
                if (st.right)     st.right = '0';
              }catch(_){}
            });

            // card自体は常に100%
            try{
              card.style.width = '100%';
              card.style.maxWidth = '100%';
              card.style.boxSizing = 'border-box';
            }catch(_){}
          });
        }
      }catch(_){}

      root.appendChild(page);

    }catch(e){
      root.appendChild(makePage_('pdf-report-rank', [
        '<h1 class="pdf-h1">GEO診断</h1>',
        '<h2 class="pdf-h2">概要</h2>',
        '<div>—</div>'
      ].join('\n')));
    }

    // 9) Improve page（改善カード：カードごと改ページ / DOM再現）
    try{
      const rootDoc = sections?.diagnosisRoot || document;
      const host =
        (rootDoc && rootDoc.querySelector && rootDoc.querySelector('#v2-card-inline-improve')) ||
        document.querySelector('#v2-card-inline-improve');

      const cards = host ? Array.from(host.querySelectorAll('section.improve-card')) : [];
      console.warn('[PDF][C][IMPROVE][DOM]', {hasHost: !!host, cards: cards.length});

      if (!host || !cards.length){
        root.appendChild(makePage_('pdf-report-improve', [
          '<h1 class="pdf-h1">GEO診断</h1>',
          '<h2 class="pdf-h2">改善ポイント</h2>',
          '<div class="pdf-note">※ 改善カードが見つかりませんでした</div>'
        ].join('\n')));
      } else {
        function pickText_(el, sel){
          try{
            const n = el.querySelector(sel);
            return n ? (n.textContent || '').trim() : '';
          }catch(_){ return ''; }
        }
        function pickAllText_(el, sel){
          try{
            return Array.from(el.querySelectorAll(sel)).map(n => (n.textContent||'').trim()).filter(Boolean);
          }catch(_){ return []; }
        }

        const __domTitlesByAxis = { data:[], doc:[], clarity:[], coverage:[], trust:[] };
        cards.forEach((srcCard) => {
          const __title =
            pickText_(srcCard, 'h3') ||
            pickText_(srcCard, '.card-title') ||
            pickText_(srcCard, '.improve-title') ||
            '';
          const __axisKey =
            axisKeyFromTitleForPdf_(__title) ||
            axisKeyOf_(
              pickText_(srcCard, '.axis') ||
              pickText_(srcCard, '.axis-badge') ||
              ''
            );
          if (!__axisKey || !__title) return;
          if (__domTitlesByAxis[__axisKey].indexOf(__title) < 0) {
            __domTitlesByAxis[__axisKey].push(__title);
          }
        });

        const __axisReportData = buildAxisReportData_(sections, __domTitlesByAxis);
        const __seenAxisCover = {};
        const __axisOrder = ['data', 'doc', 'clarity', 'coverage', 'trust'];

        // ★カードごとにページ化（仕様：カード毎に改ページ）
        // DOM再現をやめて「テキストをそのままPDF用HTMLにする」= 白紙を確実に潰す
        cards.forEach((srcCard, i) => {
          const __titleForCover =
            pickText_(srcCard, 'h3') ||
            pickText_(srcCard, '.card-title') ||
            pickText_(srcCard, '.improve-title') ||
            '';
          const __axisKeyForCover =
            axisKeyFromTitleForPdf_(__titleForCover) ||
            axisKeyOf_(
              pickText_(srcCard, '.axis') ||
              pickText_(srcCard, '.axis-badge') ||
              ''
            );
          console.log('[PDF][AXIS]', __axisKeyForCover);
          if (__axisKeyForCover) {
            const __targetIdx = __axisOrder.indexOf(__axisKeyForCover);
            __axisOrder.forEach((ax, axIdx) => {
              if (axIdx > __targetIdx) return;
              if (__seenAxisCover[ax]) return;
              if (!__axisReportData[ax]) return;
              const __coverPage = buildAxisCoverPage_(ax, __axisReportData[ax]);
              if (__coverPage) root.appendChild(__coverPage);
              __seenAxisCover[ax] = true;
            });
          }

          const page = document.createElement('section');
          page.className = 'pdf-page pdf-report-improve';

          const pri = (srcCard.getAttribute('data-priority') || '').trim(); // 高 / 中 / 低

          page.appendChild(htmlToEl_('<h1 class="pdf-h1">GEO診断</h1>'));
          page.appendChild(htmlToEl_('<h2 class="pdf-h2">改善ポイント</h2>'));

          const title =
            pickText_(srcCard, 'h3') ||
            pickText_(srcCard, '.card-title') ||
            pickText_(srcCard, '.improve-title') ||
            '';

          const axis =
            pickText_(srcCard, '.axis') ||
            pickText_(srcCard, '.axis-badge') ||
            '';

          // セクション見出し+本文を “見出しごと” 抜く（全文・Markdown保持）
          let blocks = [];
          try{
            const heads = Array.from(srcCard.querySelectorAll('h4,h5'));
            if (heads.length){
              heads.forEach(h=>{
                const key = (h.textContent || '').trim();

                let bodyParts = [];
                let cur = h.nextElementSibling;

                while (cur){
                  // 次の見出しに到達したら終了
                  if (cur.matches && cur.matches('h4,h5')) break;

                  try{
                    // 1) まず「コードブロック」を優先的に拾う（UI側で ``` が消えて <pre><code> になっている想定）
                    const pre = (cur.matches && cur.matches('pre')) ? cur : (cur.querySelector ? cur.querySelector('pre') : null);
                    if (pre){
                      const codeEl = (pre.querySelector && pre.querySelector('code')) ? pre.querySelector('code') : pre;

                      // lang 推定（よくあるパターンを拾う）
                      let lang = '';
                      try{
                        lang = String(
                          pre.getAttribute('data-lang') ||
                          codeEl.getAttribute('data-lang') ||
                          pre.getAttribute('lang') ||
                          codeEl.getAttribute('lang') ||
                          ''
                        ).trim();
                      }catch(_){}

                      if (!lang){
                        try{
                          const cls = String(pre.className || '') + ' ' + String(codeEl.className || '');
                          const m1 = cls.match(/\blanguage-([a-zA-Z0-9_-]+)\b/);
                          const m2 = cls.match(/\blang-([a-zA-Z0-9_-]+)\b/);
                          lang = (m1 && m1[1]) ? m1[1] : (m2 && m2[1]) ? m2[1] : '';
                        }catch(_){}
                      }

                      const codeText = String(codeEl.textContent || '').replace(/\s+$/,'');
                      const fence = '```' + (lang ? lang : '') + '\n' + codeText + '\n```';
                      if (codeText.trim()) bodyParts.push(fence);

                      cur = cur.nextElementSibling;
                      continue;
                    }

                    // 2) 通常テキスト（DOM構造を “改行つき/強調つき” に寄せる）
                    let text = '';

                    try{
                      // ★ br/strong を含む “1つの<p>に全部入ってる型” を救う（今回の崩れ原因）
                      const rawHtml = String(cur.innerHTML || '');
                      const looksRich = /<br\s*\/?>/i.test(rawHtml) || /<(strong|b)\b/i.test(rawHtml);

                      if (looksRich){
                        // HTML → 最低限Markdown寄せ（renderBodyHtml_ に渡して整形させる）
                        let md = rawHtml;

                        // br は改行へ
                        md = md.replace(/<br\s*\/?>/gi, '\n');

                        // strong/b は ** ** へ（中のタグは落としてテキスト化）
                        md = md.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, function(_m,_t,inner){
                          const t = String(inner || '').replace(/<[^>]+>/g,'').trim();
                          return t ? ('**' + t + '**') : '';
                        });

                        // 残りタグは落とす（p/span 等）
                        md = md.replace(/<[^>]+>/g, '');

                        // 連続改行を詰める（段落境界は残す）
                        md = md.replace(/\n{3,}/g, '\n\n').trim();

                        if (md) {
                          bodyParts.push(md);
                          // ★ ここで終わり（下のinnerText経路に落ちない）
                          //    → br/strong が “確実に” 残る
                        } else {
                          // 空なら従来経路へ落とす
                          const fallback = (cur.innerText || cur.textContent || '').trim();
                          if (fallback) bodyParts.push(fallback);
                        }

                      } else {
                        // --- 従来経路（li優先→innerText） ---
                        const lis = cur.querySelectorAll ? Array.from(cur.querySelectorAll('li')) : [];
                        if (lis.length){
                          text = lis.map(li => (li.innerText || li.textContent || '').trim()).filter(Boolean).join('\n');
                        } else {
                          text = (cur.innerText || '').trim();
                          if (!text) text = (cur.textContent || '').trim();
                        }
                        if (text) bodyParts.push(text);
                      }

                    }catch(_){
                      text = (cur.innerText || cur.textContent || '').trim();
                      if (text) bodyParts.push(text);
                    }

                  }catch(_){
                    // 例外時でも “改行/強調” をできるだけ潰さないため、innerHTML優先で拾う
                    try{
                      const html = String(cur.innerHTML || '').trim();
                      if (html){
                        const text = html
                          .replace(/<br\s*\/?>/gi, '\n')
                          .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, function(_m,_t,inner){
                            const t = String(inner || '').replace(/<[^>]+>/g,'').trim();
                            return t ? ('**' + t + '**') : '';
                          })
                          .replace(/<[^>]+>/g, '')
                          .trim();

                        if (text) bodyParts.push(text);
                      }else{
                        const text = (cur.innerText || cur.textContent || '').trim();
                        if (text) bodyParts.push(text);
                      }
                    }catch(__){
                      const text = (cur.innerText || cur.textContent || '').trim();
                      if (text) bodyParts.push(text);
                    }
                  }

                  cur = cur.nextElementSibling;
                }

                // ✅ 連結は “1改行” に寄せる（bodyParts側に既に改行が含まれるため、\n\n だと空きすぎる）
                let body = bodyParts.join('\n').trim();

                if (body.length > 4000) body = body.slice(0, 4000);
                if (key || body) blocks.push({ key, body });
              });
            }
          }catch(_){}

          // fallback：h4/h5 が取れないカードは全文を入れる（ただし上限）
          if (!blocks.length){
            const raw = (srcCard.innerText || srcCard.textContent || '').trim();
            if (raw) blocks = [{key:'', body: raw.slice(0, 4000)}];
          }

          // blocks本文に紛れた「優先度：高/中/低」等の行を除去（重複表示対策）
          blocks = blocks.map(b => {
            const body = String(b.body || '')
              .replace(/^[ \t　]*(優先度|Priority)\s*[:：]?\s*(高|中|低)\s*[\r\n]+/m, '')
              .replace(/[\r\n]+[ \t　]*(優先度|Priority)\s*[:：]?\s*(高|中|低)\s*$/m, '');
            return { key: b.key, body };
          });

          const html = [
            '<div class="pdf-card" style="break-inside:avoid;page-break-inside:avoid;">',

              (axis || pri)
                ? `<div class="pdf-note" style="margin:0 0 6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    ${axis ? `<span>${esc_(axis)}</span>` : ''}
                    ${pri ? pdfPriBadge_(pri) : ''}
                  </div>`
                : '',

              title ? `<div class="pdf-h2" style="margin:0 0 6px;">${esc_(title)}</div>` : '',

              ...blocks.map(b=>{
                const __k = String(b.key || '').replace(/[\s\u3000]+/g,'').trim();
                const h = __k
                  ? (__k === '根拠'
                      ? `<div class="pdf-sub-spacer" style="height:14px;"></div>`
                      : `<div class="pdf-sub">${esc_(b.key)}</div>`)
                  : '';

                // --- PDF用：Markdownのコードフェンス ```lang ... ``` と **bold** を最低限整形して出す ---
                function decodeEntitiesForDisplay_(s){
                  return String(s || '')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&#x27;/g, "'");
                }

                function formatInlineMd_(escapedText){
                  return String(escapedText || '')
                    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<strong>$1</strong>');
                }

                // ★ 表示用：HTMLエンティティを “最大2回” 戻す（&amp;lt; → &lt; → <）
                function decodeEntitiesTwice_(s){
                  s = String(s || '');
                  function once(x){
                    try{
                      const ta = document.createElement('textarea');
                      ta.innerHTML = String(x || '');
                      return ta.value;
                    }catch(_){
                      // DOMが使えない場合の最低限フォールバック
                      return String(x || '')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'");
                    }
                  }
                  const a = once(s);
                  const b = once(a);
                  return b;
                }

                // フェンスをプレースホルダに退避 → 本文全体を esc_ → 戻して ** も処理
                function renderBodyHtml_(raw){
                  raw = decodeEntitiesTwice_(String(raw || '')); // ★ &amp;lt; / &lt; を “表示用に” いったん戻す

                  // reference は reference section 側だけで表示する。
                  // evidence に旧形式の「参考情報」ブロックが混ざっていてもPDFでは根拠として出さない。
                  try{
                    const __isEvidenceBlock =
                      __k === '根拠' ||
                      String(b.key || '').trim().toLowerCase() === 'evidence' ||
                      /観測事実（AI可視性ログ）/.test(String(raw || ''));
                    if (__isEvidenceBlock) {
                      raw = String(raw || '').replace(
                        /(^|\n)[ \t　]*(?:\*\*)?参考情報(?:\*\*)?[ \t　]*[\s\S]*$/m,
                        ''
                      ).trim();
                    }
                  }catch(_){}

                  // ★ evidence内ラベル行を「ブロック見出し」に固定（改行が潰れるのを防ぐ）
                  try{
                    raw = String(raw || '').replace(
                      /(^|\n)[ \t　]*(観測事実（AI可視性ログ）|参考情報)[ \t　]*(?=\n|$)/g,
                      function(_m, bol, t){
                        // 後段でHTMLに差し替えるためのトークン
                        return (bol || '\n') + '@@@PDF_EVID_TITLE:' + String(t || '').trim() + '@@@';
                      }
                    );
                  }catch(_){}

                  const blocks = [];
                  let tokenized = raw.replace(
                    /(^|\n)```([a-zA-Z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n```(?=\n|$)/g,
                    function(_m, bol, lang, code){
                      const i = blocks.length;
                      blocks.push({ lang: (lang || ''), code });
                      return (bol || '') + `@@@PDF_CODE_BLOCK_${i}@@@`;
                    }
                  );

                  // ★ コードブロック直前/直後の “余計な空行” を1つに圧縮（これが「コード前だけ改行が入る」原因）
                  try{
                    // 直前の空行を詰める：\n\n@@@... → \n@@@...
                    tokenized = tokenized.replace(/\n{2,}(@@@PDF_CODE_BLOCK_\d+@@@)/g, '\n$1');
                    // 直後の空行を詰める：@@@...\n\n → @@@...\n
                    tokenized = tokenized.replace(/(@@@PDF_CODE_BLOCK_\d+@@@)\n{2,}/g, '$1\n');
                  }catch(_){}

                  // 1) リスト記号が “段落途中に混ざって改行が消える” 系を、先に改行正規化する
                  function normalizeListNewlines_(s){
                    s = String(s || '');

                    // 「…です。1. xxx」みたいに “行頭じゃない 1.” を段落扱いに寄せる
                    // ※ 直前が改行でない 1. を見つけたら、前に \n\n を挿入
                    s = s.replace(/([^\n])\s*(\d+)\.\s+/g, function(_m, pre, n){
                      return pre + '\n' + n + '. ';
                    });

                    // 同様に “行頭じゃない * / - ” を改行扱いに寄せる
                    s = s.replace(/([^\n])\s*([*-])\s+/g, function(_m, pre, m){
                      return pre + '\n' + m + ' ';
                    });

                    return s;
                  }

                  // 2) 本文は esc_ して安全化 → 最低限のMarkdown整形
                  let out = formatInlineMd_(esc_(normalizeListNewlines_(tokenized)));

                  // ★ evidenceタイトルトークンをHTMLへ差し替え（divなので必ず改行される）
                  try{
                    out = String(out || '').replace(
                      /@@@PDF_EVID_TITLE:([^@]+)@@@/g,
                      function(_m, t){
                        return `<div class="pdf-evidence-title" style="margin:16px 0 4px;font-weight:600;">${esc_(String(t||'').trim())}</div>`;
                      }
                    );
                  }catch(_){}

                  // 2.1) インラインコード `...`
                  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

                  // 2.2) 行頭の番号リスト / 箇条書きを “行” として整形（見た目と改行を安定させる）
                  out = out
                    // 1. xxx
                    .replace(/(^|\n)[ \t]*(\d+)\.\s+([^\n]+)/g, function(_m, bol, n, body){
                      body = String(body || '');

                      // タイトル＝先頭〜最初の「:」or「：」まで（なければ先頭の塊）
                      let head = body;
                      let tail = '';
                      const m = body.match(/^(.{1,120}?)([:：]\s*)([\s\S]*)$/); // 120は暴走防止
                      if (m){
                        head = m[1];
                        tail = (m[2] || '') + (m[3] || '');
                      }

                      // 番号ではなく “項目タイトル” を太字に
                      return bol + `<div style="margin:0 0 6px;">${n}. <strong>${head}</strong>${tail}</div>`;
                    })
                    // * xxx / - xxx
                    .replace(/(^|\n)[ \t]*([*-])\s+([^\n]+)/g, function(_m, bol, _mk, body){
                      return bol + `<div style="margin:2px 0 0;">• ${body}</div>`;
                    });

                  // 2.3) 「本文 → 1. ...」の境目だけ、改行ではなく余白にする（連続項目間は増やさない）
                  try{
                    // いったん「番号divの直前の改行」を全部 “スペーサーdiv” に変える
                    out = String(out || '').replace(
                      /\n(?=<div style="margin:0 0 6px;">\d+\.\s)/g,
                      '<div style="height:6px"></div>'
                    );
                    // ただし、項目同士の間（</div>の直後）はスペーサーを消す＝余白が二重にならない
                    out = out.replace(/<\/div><div style="height:6px"><\/div>/g, '</div>');
                  }catch(_){}

                  // 3) 退避したコードブロックを HTML として差し戻し（中身は esc_ 済み）
                  blocks.forEach((b, i) => {
                    const codeDecoded = decodeEntitiesForDisplay_(b.code);
                    const codeSafe    = esc_(codeDecoded);

                    const label = b.lang
                      ? `<div style="
                          font-size:11px;
                          font-weight:700;
                          color:#9ca3af;
                          background:#111827;
                          display:inline-block;
                          padding:2px 8px;
                          border-radius:6px;
                          margin:0 0 6px;
                          letter-spacing:0.04em;
                        ">${esc_(b.lang)}</div>`
                      : '';

                    const html = [
                      '<div style="margin:6px 0 14px;">',
                        label,
                        '<pre style="margin:0;',
                          'padding:12px 14px;',
                          'border:1px solid #1f2937 !important;',
                          'border-radius:10px;',
                          'background:#0f172a !important;',
                          'color:#e5e7eb !important;',
                          'font-size:12.5px;',
                          'line-height:1.6;',
                          'white-space:pre-wrap;',
                          'word-break:break-word;',
                          'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
                        '">',
                          '<code style="color:inherit !important;">',
                            codeSafe,
                          '</code>',
                        '</pre>',
                      '</div>'
                    ].join('');

                    out = out.split(`@@@PDF_CODE_BLOCK_${i}@@@`).join(html);
                  });

                  // ★ 追加：コードブロック直前の「余計な改行/空白」を潰す
                  try{
                    out = String(out || '').replace(
                      /<\/div>\s*(?:<br\s*\/?>\s*)*\s*(<div style="margin:4px 0 12px;">)/g,
                      '</div>$1'
                    );
                  }catch(_){}

                  // ★ 最終サニタイズ：自前で生成するタグ以外の "<" を全部殺す
                  //   これで "<nav&gt;" のような表示崩れを根絶
                  try{
                    out = String(out || '')
                      .replace(/<(?!\/?(div|pre|code|span|br|strong|em)\b)/g, '&lt;');
                  }catch(_){}

                  return out;
                }

                const safeBodyHtml = renderBodyHtml_(
                  String(b.body || '').replace(/\*\*/g, '')
                );

                // ★ safeBodyHtml が “HTMLを含む” 場合、pre-wrap だと改行文字がそのまま空行として可視化されてレイアウトが崩れる
                //   → HTML時は pre-wrap を外す（これで「コードブロック直前だけ余計な空行」が消える）
                let __hasHtml = false;
                try{
                  __hasHtml = /<(div|pre|br|strong|em|code|span)\b/i.test(String(safeBodyHtml || ''));
                }catch(_){ __hasHtml = false; }

                const t = safeBodyHtml
                  ? (__hasHtml
                      ? `<div style="line-height:1.55;word-break:break-word;">${safeBodyHtml}</div>`
                      : `<div style="white-space:pre-wrap;line-height:1.55;word-break:break-word;">${safeBodyHtml}</div>`
                    )
                  : '';

                return `<div class="pdf-block" style="margin:0 0 10px;">${h}${t}</div>`;
              }),

            '</div>'
          ].filter(Boolean).join('\n');

          page.appendChild(htmlToEl_(html));

          root.appendChild(page);
        });

        __axisOrder.forEach((ax) => {
          if (!__seenAxisCover[ax] && __axisReportData[ax]) {
            const __coverPage = buildAxisCoverPage_(ax, __axisReportData[ax]);
            if (__coverPage) root.appendChild(__coverPage);
            __seenAxisCover[ax] = true;
          }
        });
      }
    }catch(e){
      console.warn('[PDF][C][IMPROVE][EX]', e);
      root.appendChild(makePage_('pdf-report-improve', [
        '<h1 class="pdf-h1">GEO診断</h1>',
        '<h2 class="pdf-h2">改善ポイント</h2>',
        '<div class="pdf-note">※ 改善ポイントの取り込みで例外が発生しました</div>'
      ].join('\n')));
    }

    // 10) Compare page（任意：includeCompare のときだけ）
    try{
      console.warn('[PDF][C][COMPARE][GATE v1]', {hasJob: !!job, includeCompare: !!(job && job.includeCompare), jobKeys: job ? Object.keys(job) : null});

      if (job?.includeCompare){

        // ✅ まず「描画用の一時ページ」を作る（ここに3カード全部を描かせる）
        const pageTmp = document.createElement('section');
        pageTmp.className = 'pdf-page pdf-report-compare';

        // ✅ タイトル画像っぽい見出し（＝このまま html2canvas されるので見栄えが安定する）
        pageTmp.appendChild(htmlToEl_('<h1 class="pdf-h1">競合比較</h1>'));

        // 1) PDF用の「器」
        pageTmp.appendChild(htmlToEl_(
          '<section class="card hide" id="compareRadarCard">' +
            '<h2 class="pdf-h2">比較レーダーチャート</h2>' +
            '<div class="chart-wrap" style="height:418px; max-height:418px; overflow:hidden;">' +
              '<canvas id="compareRadar"></canvas>' +
            '</div>' +
          '</section>' +

          '<section class="card" id="compareTableCard">' +
            '<h2 class="pdf-h2">比較スコア</h2>' +
            '<table id="compareScores" class="table">' +
              '<thead><tr>' +
                '<th>対象</th>' +
                '<th>データ構造</th><th>文書構造</th><th>表現の明確さ</th><th>情報網羅性</th><th>信頼性</th>' +
                '<th>合計</th>' +
              '</tr></thead>' +
              '<tbody></tbody>' +
            '</table>' +
          '</section>' +

          '<section class="card hide" id="compareOutputs">' +
            '<h2 class="pdf-h2">自社（Before）との比較</h2>' +
            '<div id="cmp-summary" class="cmp-summary"></div>' +
          '</section>'
        ));

        // 2) 「描画に渡す res」
        const cmpRes =
          (job && (job.compareRes || job.compare || job.cmp || null)) ||
          (sections && (sections.compareRes || sections.compare || null)) ||
          {};

          function __pdfCmpDisplayLabel_(label){
            const s = String(label || '').trim();
            if (s === '競合A') return '比較対象1';
            if (s === '競合B') return '比較対象2';
            return s;
          }
          function __pdfCmpOrigin_(raw, fallback){
            try{
              let s = String(raw || '').trim();
              if (!s) return fallback || '';
              if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
              return new URL(s).origin || fallback || '';
            }catch(_){
              return fallback || String(raw || '').trim();
            }
          }
          function __pdfCmpSummaryForDisplay_(summaryText, res){
            const originA = __pdfCmpOrigin_(res && (res.aUrl || res.targetA || res.competitorA), '比較対象1');
            const originB = __pdfCmpOrigin_(res && (res.bUrl || res.targetB || res.competitorB), '比較対象2');
            return String(summaryText || '')
              .replace(/競合A/g, originA)
              .replace(/競合B/g, originB)
              .replace(/比較対象1/g, originA)
              .replace(/比較対象2/g, originB);
          }

          // === [PDF][C][COMPARE][TARGETS-RESOLVE v3] 画面側が保存したA/Bを最優先で拾う ===
          let __tA = '';
          let __tB = '';
          try{
            // 1) job 由来（あれば最優先）
            __tA = String(job?.compareTargetA || job?.targetA || job?.competitorA || '').trim();
            __tB = String(job?.compareTargetB || job?.targetB || job?.competitorB || '').trim();

            // 2) cmpRes 由来（あれば次）
            if (!__tA) __tA = String(cmpRes?.aUrl || cmpRes?.targetA || cmpRes?.competitorA || cmpRes?.compA || '').trim();
            if (!__tB) __tB = String(cmpRes?.bUrl || cmpRes?.targetB || cmpRes?.competitorB || cmpRes?.compB || '').trim();

            // 3) 最後に localStorage（★今回ここが効く）
            if (!__tA) __tA = String(Storage.prototype.getItem.call(localStorage,'aio:lastCompareTargetA') || '').trim();
            if (!__tB) __tB = String(Storage.prototype.getItem.call(localStorage,'aio:lastCompareTargetB') || '').trim();

            // 軽い正規化（末尾/だけ）
            __tA = __tA.replace(/\/+$/,'');
            __tB = __tB.replace(/\/+$/,'');
          }catch(_){}

          // cmpRes にも載せておく（後段の表示/デバッグが楽）
          try{
            if (__tA) cmpRes.targetA = __tA;
            if (__tB) cmpRes.targetB = __tB;
            if (__tA && !cmpRes.aUrl) cmpRes.aUrl = __tA;
            if (__tB && !cmpRes.bUrl) cmpRes.bUrl = __tB;
          }catch(_){}

          try{
            console.warn('[PDF][C][COMPARE][TARGETS-RESOLVE v3]', {hasA: !!__tA, hasB: !!__tB, a: __tA, b: __tB});
          }catch(_){}
          // === [/PDF][C][COMPARE][TARGETS-RESOLVE v3] ===

        // ★ [PDF][C][COMPARE][INJECT_TABLE v1] cmpRes.table が無いときだけ LS から注入
        try{
          if (!Array.isArray(cmpRes.table) || !cmpRes.table.length) {
            const raw = Storage.prototype.getItem.call(localStorage, 'aio:lastCompareTable');
            if (raw) {
              const arr = JSON.parse(raw);
              if (Array.isArray(arr) && arr.length) {
                cmpRes.table = arr;
                console.warn('[PDF][C][COMPARE][INJECT_TABLE v1]', { rows: arr.length });
              } else {
                console.warn('[PDF][C][COMPARE][INJECT_TABLE v1] skip (parsed empty)');
              }
            } else {
              console.warn('[PDF][C][COMPARE][INJECT_TABLE v1] skip (no storage)');
            }
          }
        }catch(e){
          console.warn('[PDF][C][COMPARE][INJECT_TABLE v1][ERR]', e);
        }

        // ★ [PDF][C][COMPARE][INJECT_SUMMARY v1] cmpRes.summaryText が無いときだけ LS から注入
        try{
          if (!cmpRes.summaryText) {
            const s = String(
              Storage.prototype.getItem.call(localStorage,'aio:lastCompareSummaryLLM') ||
              Storage.prototype.getItem.call(localStorage,'aio:lastCompareSummary') ||
              ''
            ).trim();
            if (s) {
              cmpRes.summaryText = s;
              console.warn('[PDF][C][COMPARE][INJECT_SUMMARY v1]', { len: s.length });
            } else {
              console.warn('[PDF][C][COMPARE][INJECT_SUMMARY v1] skip (no storage)');
            }
          }
        }catch(e){
          console.warn('[PDF][C][COMPARE][INJECT_SUMMARY v1][ERR]', e);
        }

        try{
          if (Array.isArray(cmpRes.table)) {
            cmpRes.table = cmpRes.table.map(function(r){
              if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
              return Object.assign({}, r, { label: __pdfCmpDisplayLabel_(r.label) });
            });
          }
          cmpRes.summaryText = __pdfCmpSummaryForDisplay_(cmpRes.summaryText || '', cmpRes);
        }catch(e){
          console.warn('[PDF][C][COMPARE][DISPLAY_LABELS][ERR]', e);
        }

        // 3) 画面と同じ処理で描画（✅ root にはまだ append しない）
        const isFn = (typeof window.renderCompareDispatch === 'function');
        console.warn('[PDF][C][COMPARE][CHARTJS v1]', {hasChart: !!window.Chart});

        if (isFn){
          // ✅ 先に「非表示ステージ」に刺してから描画（Chart.jsの白紙防止）
          const stage = document.createElement('div');
          stage.style.position = 'fixed';
          stage.style.left = '-100000px';
          stage.style.top  = '0';
          stage.style.width = '794px';
          stage.style.background = '#ffffff';
          document.body.appendChild(stage);

          try{
            const fn = window.__CMP_CORE__ || window.renderCompareDispatch;

            stage.appendChild(pageTmp);
            try {
              const t = Array.isArray(cmpRes.table) ? cmpRes.table : [];
              const selfBefore = t.find(r => {
                const label = String(r && r.label || '');
                return label.indexOf('自社') >= 0 && label.indexOf('After') < 0;
              });
              const selfAfter = t.find(r => {
                const label = String(r && r.label || '');
                return label.indexOf('自社') >= 0 && label.indexOf('After') >= 0;
              });

              function toVec(r){
                if (!r) return null;
                if (Array.isArray(r.values)) return r.values.slice(0, 5).map(n => Number(n) || 0);
                if (r.axes) return ['data','doc','clarity','coverage','trust'].map(k => Number(r.axes[k]) || 0);
                return null;
              }

              const bVec = toVec(selfBefore);
              const aVec = toVec(selfAfter);

              if (bVec && aVec && bVec.length >= 5 && aVec.length >= 5) {
                window.__diagAch = {
                  keys: ['data','doc','clarity','coverage','trust'],
                  before: bVec.slice(0, 5),
                  after: aVec.slice(0, 5)
                };
                cmpRes.result = Object.assign({}, cmpRes.result || {}, {
                  avgBefore: bVec.slice(0, 5).reduce((s,n) => s + (Number(n) || 0), 0),
                  avgAfter: aVec.slice(0, 5).reduce((s,n) => s + (Number(n) || 0), 0),
                  achPairs: ['data','doc','clarity','coverage','trust'].map((k, i) => ({
                    axis: k,
                    bAch: bVec[i],
                    aAch: aVec[i]
                  }))
                });
                console.warn('[PDF][COMPARE][SELF_SYNC_FROM_TABLE]', { before: bVec, after: aVec });
              }
            } catch(e) {
              console.warn('[PDF][COMPARE][SELF_SYNC_ERR]', e);
            }

            fn(cmpRes, pageTmp);

            try {
              const summaryEl = pageTmp.querySelector('#cmp-summary');
              if (summaryEl && cmpRes) {
                if (cmpRes.summaryHtml) {
                  summaryEl.innerHTML = String(cmpRes.summaryHtml || '');
                } else if (cmpRes.summaryText) {
                  summaryEl.textContent = String(cmpRes.summaryText || '');
                }
              }
            } catch(e) {
              console.warn('[PDF][COMPARE][SUMMARY_SYNC_ERROR]', e);
            }

            // === [PDF][C][COMPARE][SUMMARY-ONECOL v2] PDF内の比較サマリーだけ「2カラム化」を根絶 ===
            try{
              const wrap = pageTmp && pageTmp.querySelector ? pageTmp : null;
              const out  = wrap ? wrap.querySelector('#compareOutputs') : null;

              if (out){
                const st = document.createElement('style');
                st.setAttribute('data-pdf-compare', 'summary-onecol-v2');
                st.textContent = `
                  /* compare outputs 内だけに限定（画面へ漏れない） */
                  #compareOutputs #compareSummaryBox,
                  #compareOutputs #cmp-summary{
                    box-sizing: border-box !important;
                    width: 100% !important;
                    max-width: 100% !important;

                    /* ★ columns 起因の2カラムを根絶 */
                    column-count: 1 !important;
                    -webkit-column-count: 1 !important;
                    -moz-column-count: 1 !important;
                    columns: auto !important;
                    -webkit-columns: auto !important;
                    -moz-columns: auto !important;
                    column-gap: 0 !important;
                    -webkit-column-gap: 0 !important;
                    -moz-column-gap: 0 !important;
                  }

                  /* 子孫に columns が付いてても全部殺す */
                  #compareOutputs #cmp-summary *{
                    box-sizing: border-box !important;
                    max-width: 100% !important;
                    column-count: 1 !important;
                    -webkit-column-count: 1 !important;
                    -moz-column-count: 1 !important;
                    columns: auto !important;
                    -webkit-columns: auto !important;
                    -moz-columns: auto !important;
                    column-gap: 0 !important;
                    -webkit-column-gap: 0 !important;
                    -moz-column-gap: 0 !important;
                  }

                  /* flex/grid の残骸があれば block に倒す（保険） */
                  #compareOutputs #cmp-summary [style*="display:flex"],
                  #compareOutputs #cmp-summary [style*="display: flex"],
                  #compareOutputs #cmp-summary [style*="display:grid"],
                  #compareOutputs #cmp-summary [style*="display: grid"]{
                    display: block !important;
                  }

                  /* 直下の子が横並び指定されてても縦積みにする（保険） */
                  #compareOutputs #cmp-summary > *{
                    display: block !important;
                    width: 100% !important;
                    float: none !important;
                    clear: both !important;
                  }
                `;

                out.insertBefore(st, out.firstChild);
              }
            }catch(e){
              console.warn('[PDF][C][COMPARE][SUMMARY-ONECOL v2][ERR]', e);
            }
            // === [/PDF][C][COMPARE][SUMMARY-ONECOL v2] ===

            // ✅ Radar card / Outputs card を PDFでは表示させる（hide を外す）
            try{
              const r = pageTmp.querySelector('#compareRadarCard');
              const o = pageTmp.querySelector('#compareOutputs');
              if (r) r.classList.remove('hide');
              if (o) o.classList.remove('hide');
            }catch(_){}

            // ★ PDF用：レーダーPNG固定化（既存処理を pageTmp 基準で動かす）
            try{
              if (!window.Chart) throw new Error('Chart.js not found');

              const DPR = window.devicePixelRatio || 1;

              const Wcss = 418;
              const Hcss = 418;

              const off = document.createElement('canvas');
              off.style.width  = Wcss + 'px';
              off.style.height = Hcss + 'px';
              off.width  = Math.round(Wcss * DPR);
              off.height = Math.round(Hcss * DPR);

              // ★ 参照元（renderCompareDispatch が作った chart）
              const srcCv = pageTmp.querySelector('#compareRadar');
              if (!srcCv || !srcCv.__chart) throw new Error('src compareRadar chart not found (need cv.__chart)');

              const srcChart = srcCv.__chart;
              const srcType  = (srcChart.config && srcChart.config.type) ? srcChart.config.type : 'radar';
              const srcData  = srcChart.data || {};

              const RADAR_COLORS = [
                { border:'rgba(54,162,235,1)',  bg:'rgba(54,162,235,0.08)',  point:'rgba(54,162,235,1)'  }, // 自社 Before
                { border:'rgba(255,99,132,1)',  bg:'rgba(255,99,132,0.08)',  point:'rgba(255,99,132,1)'  }, // 自社 After
                { border:'rgba(255,159,64,1)',  bg:'rgba(255,159,64,0.08)',  point:'rgba(255,159,64,1)'  }, // 比較対象1
                { border:'rgba(255,205,86,1)',  bg:'rgba(255,205,86,0.08)',  point:'rgba(255,205,86,1)'  }  // 比較対象2
              ];

              const clonedData = {
                labels: Array.isArray(srcData.labels) ? srcData.labels.slice() : [],
                datasets: Array.isArray(srcData.datasets) ? srcData.datasets.map((ds, idx) => {
                  const c = RADAR_COLORS[idx] || RADAR_COLORS[RADAR_COLORS.length - 1];
                  return {
                    label: String(ds && ds.label || ''),
                    data: Array.isArray(ds && ds.data) ? ds.data.slice() : [],
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 3,
                    pointHitRadius: 6,
                    borderColor: c.border,
                    backgroundColor: c.bg,
                    pointBackgroundColor: c.point
                  };
                }) : []
              };

              const clonedOpt = {
                responsive: false,
                maintainAspectRatio: false,
                animation: false,
                devicePixelRatio: DPR,
                scales: {
                  r: {
                    min: 0,
                    max: 100,
                    beginAtZero: true,
                    ticks: { stepSize: 20 },
                    pointLabels: { padding: 6, font: { size: 11 } }
                  }
                },
                plugins: {
                  legend: { position: 'top', labels: { font: { size: 11 } } },
                  tooltip: {
                    enabled: true,
                    mode: 'nearest',
                    intersect: false,
                    titleFont:  { size: 11 },
                    bodyFont:   { size: 11 },
                    footerFont: { size: 11 }
                  }
                },
                elements: {
                  line:  { tension: 0.15, borderWidth: 2 },
                  point: { radius: 3, hoverRadius: 3, hitRadius: 6 }
                },
                interaction: { mode: 'nearest', intersect: false }
              };

              const ctx = off.getContext('2d');
              const tmp = new Chart(ctx, { type: srcType, data: clonedData, options: clonedOpt });

              try{ tmp.resize(Wcss, Hcss); }catch(_){}
              try{ tmp.update('none'); }catch(_){}
              try{ tmp.draw(); }catch(_){}

              const png = off.toDataURL('image/png');
              try{ tmp.destroy(); }catch(_){}

              // ✅ compareRadar(canvas) を img に置換（白紙根絶）
              const cv = pageTmp.querySelector('#compareRadar');
              if (!cv) throw new Error('compareRadar not found in pageTmp');

              const img = document.createElement('img');
              img.alt = 'レーダーチャート';
              img.style.display = 'block';
              img.style.margin = '0 auto';
              img.style.width = '418px';
              img.style.height = 'auto';
              img.style.maxHeight = '418px';
              img.style.objectFit = 'contain';
              img.src = png;

              cv.replaceWith(img);

            }catch(e){
              console.warn('[PDF][C][COMPARE][RADAR_OFFSCREEN][ERR]', e);
            }

            // =========================
            // ✅ ここからが本題：2ページに分割して root に append
            //   1枚目：レーダー + 比較スコア
            //   2枚目：自社（Before）との比較
            // =========================

            const radarCard   = pageTmp.querySelector('#compareRadarCard');
            const tableCard   = pageTmp.querySelector('#compareTableCard');
            const outputsCard = pageTmp.querySelector('#compareOutputs');

            // 1ページ目
            const page1 = document.createElement('section');
            page1.className = 'pdf-page pdf-report-compare';
            page1.appendChild(htmlToEl_('<h1 class="pdf-h1">競合比較</h1>'));

            // === [PDF][C][COMPARE][TARGETS-TEXT v4] 比較対象をテキストで表示（tableからも復元して確実化） ===
            try{
              // 1) まずは明示フィールド（入っていればそれを優先）
              let a = String(cmpRes?.targetA || cmpRes?.competitorA || '').trim();
              let b = String(cmpRes?.targetB || cmpRes?.competitorB || '').trim();

              // 2) 空なら compare table から復元（ここで “skipの種” を潰す）
              //    table行の1列目に「比較対象1/2」または URL が入っている前提で拾う
              if (!a || !b){
                try{
                  const rows = Array.isArray(cmpRes?.table) ? cmpRes.table : [];

                  // 競合行っぽいものを抽出（最小：先頭セルが文字列なら拾う）
                  const names = [];
                  for (let i=0; i<rows.length; i++){
                    const r = rows[i];
                    if (!Array.isArray(r) || !r.length) continue;
                    const cell0 = String(r[0] ?? '').trim();
                    if (!cell0) continue;

                    // よくあるパターン：'比較対象1', '比較対象2', URLそのもの
                    names.push(cell0);
                  }

                  // a/b が空のときだけ埋める（上書きしない）
                  // - names 内に URL があればそれを優先
                  // - 無ければ「比較対象1/2」等でもとにかく入れる（PDFで空にしない）
                  function pickUrlFirst(list){
                    for (let i=0; i<list.length; i++){
                      const s = String(list[i] || '').trim();
                      if (/^https?:\/\//i.test(s)) return s;
                    }
                    return '';
                  }

                  const url1 = pickUrlFirst(names);
                  // URLが1個しかないケースもあるので、2個目は別探索
                  let url2 = '';
                  if (url1){
                    for (let i=0; i<names.length; i++){
                      const s = String(names[i] || '').trim();
                      if (/^https?:\/\//i.test(s) && s !== url1){ url2 = s; break; }
                    }
                  }

                  if (!a){
                    a = url1 || names.find(s=>String(s).includes('比較対象1')) || names.find(s=>String(s).includes('競合A')) || '';
                    a = String(a || '').trim();
                  }
                  if (!b){
                    b = url2 || names.find(s=>String(s).includes('比較対象2')) || names.find(s=>String(s).includes('競合B')) || '';
                    b = String(b || '').trim();
                  }

                  console.warn('[PDF][C][COMPARE][TARGETS-RESOLVE v4]', {hasA:!!a, hasB:!!b, a, b, via:'table'});
                }catch(e2){
                  console.warn('[PDF][C][COMPARE][TARGETS-RESOLVE v4][ERR_TABLE]', e2);
                }
              } else {
                console.warn('[PDF][C][COMPARE][TARGETS-RESOLVE v4]', {hasA:!!a, hasB:!!b, a, b, via:'fields'});
              }

              // 3) 描画（空なら出さない、ただしここまで来れば空になる確率を潰している）
              if (a || b){
                const box = document.createElement('section');
                box.className = 'card compare-section';
                box.id = 'card-compare-targets-text';

                box.appendChild(htmlToEl_('<h2 class="pdf-h2 compare-targets-title">比較対象</h2>'));

                const lines = [
                  a ? `<div class="compare-target-line">比較対象1：${esc_(a)}</div>` : '',
                  b ? `<div class="compare-target-line">比較対象2：${esc_(b)}</div>` : ''
                ].filter(Boolean).join('');

                box.appendChild(htmlToEl_(`<div class="compare-targets-body">${lines}</div>`));
                page1.appendChild(box);

                console.warn('[PDF][C][COMPARE][TARGETS-TEXT v4] ok', {hasA:!!a, hasB:!!b});
              }else{
                console.warn('[PDF][C][COMPARE][TARGETS-TEXT v4] skip (empty)');
              }
            }catch(e){
              console.warn('[PDF][C][COMPARE][TARGETS-TEXT v4][ERR]', e);
            }
            // === [/PDF][C][COMPARE][TARGETS-TEXT v4] ===

            if (radarCard) page1.appendChild(radarCard);
            if (tableCard) page1.appendChild(tableCard);

            // 2ページ目
            const page2 = document.createElement('section');
            page2.className = 'pdf-page pdf-report-compare';
            page2.appendChild(htmlToEl_('<h1 class="pdf-h1">競合比較</h1>'));
            if (outputsCard) page2.appendChild(outputsCard);

            root.appendChild(page1);
            root.appendChild(page2);

          }catch(e){
            console.warn('[PDF][C][COMPARE][CALL_ERR v2]', e);
            root.appendChild(makePage_('pdf-report-compare', [
              '<div style="margin:0 0 10px;padding:10px 12px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:12px;">',
                '<div style="font-size:18px;font-weight:900;line-height:1.2;">競合比較</div>',
              '</div>',
              '<div class="pdf-note">※ 競合比較の描画中にエラーが発生しました</div>'
            ].join('\n')));
          }finally{
            try{ stage.remove(); }catch(_){}
          }

        } else {
          root.appendChild(makePage_('pdf-report-compare', [
            '<div style="margin:0 0 10px;padding:10px 12px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:12px;">',
              '<div style="font-size:18px;font-weight:900;line-height:1.2;">競合比較</div>',
            '</div>',
            '<div class="pdf-note">※ renderCompareDispatch が見つからないため、競合比較を描画できませんでした</div>'
          ].join('\n')));
          console.warn('[PDF][C][COMPARE][MISSING_RENDERER]');
        }
      }

    }catch(e){
      console.warn('[PDF][C][COMPARE] failed', e);
    }

    // AI認識ログは競合比較の後ろに配置する（生成内容は変更しない）。
    appendAiRecognitionLogPages_();

    // 11) Notes
    root.appendChild(makePage_('pdf-notes', buildNotesHtml_()));

    // 12) Notes (評価差分)
    root.appendChild(makePage_('pdf-notes-diff', buildNotesDiffHtml_()));

    document.body.appendChild(root);
    return root;

    function extractKpiFromSections_(sections){
      const roots = [];
      try{
        if (sections?.dashboard) roots.push(sections.dashboard);
        if (sections?.diagnosisRoot) roots.push(sections.diagnosisRoot);
      }catch(_){}

      const SELS = {
        score: [
          '#badgeAvg', '#resultScore', '#sumBefore', '[data-kpi="score"]',
          '#kpiScore', '.kpi-score'
        ],
        rank: [
          '#resultRank', '#dv2-kpi-rank', '[data-kpi="rank"]',
          '#kpiRank', '.kpi-rank'
        ],
        diff: [
          '#dv2-kpi-gap',          // ★これを追加（確定）
          '#kpiDiff', '#prevDiff', '[data-kpi="diff"]',
          '.kpi-diff', '.kpi-prev-diff'
        ]
      };

      function getText_(root, sel){
        try{
          const el = root && root.querySelector ? root.querySelector(sel) : null;
          if (!el) return '';
          return (el.textContent || '').trim();
        }catch(_){ return ''; }
      }

      function pickTextAny_(cands){
        for (const r of roots){
          for (const sel of cands){
            const t = getText_(r, sel);
            if (t) return t;
          }
        }
        for (const sel of cands){
          const t = getText_(document, sel);
          if (t) return t;
        }
        return '';
      }

      function pickNumber_(s){
        try{
          const m = String(s||'').replace(/,/g,'').match(/(\d+(?:\.\d+)?)/);
          if (!m) return null;
          const n = Number(m[1]);
          return Number.isFinite(n) ? n : null;
        }catch(_){ return null; }
      }

      const rawScore = pickTextAny_(SELS.score);
      const rawRank  = pickTextAny_(SELS.rank);
      const rawDiff  = pickTextAny_(SELS.diff);

      const score = pickNumber_(rawScore);

      const out = {
        score: (score == null ? null : score),
        rank: rawRank || '',
        diffText: rawDiff || ''
      };

      const miss = [];
      if (out.score == null) miss.push('Score');
      if (!out.rank)        miss.push('Rank');
      if (!out.diffText)    miss.push('Diff');
      if (miss.length){
        out._note = '※ 画面DOMからKPIを取得できませんでした: ' + miss.join(', ');
      }
      return out;
    }

    function extractAxisScoresFromSections_(sections){
      const root = sections?.diagnosisRoot || sections?.dashboard || document;
      const card = root.querySelector ? root.querySelector('#v2-card-score-table') : null;
      const table = card ? card.querySelector('table#resultScores') : (root.querySelector ? root.querySelector('table#resultScores') : null);

      const out = {
        rows: [], // {label, beforeText, afterText}
        totalBefore: null,
        totalAfter: null
      };

      if (!table) return out;

      const trs = Array.from(table.querySelectorAll('tbody tr'));
      trs.forEach(tr => {
        const th = tr.querySelector('th');
        const tds = Array.from(tr.querySelectorAll('td'));

        // 合計行（<th>合計</th><th>68</th><th>86</th>）
        if (th && th.textContent.trim() === '合計'){
          const ths = Array.from(tr.querySelectorAll('th'));
          if (ths[1]) out.totalBefore = ths[1].textContent.trim();
          if (ths[2]) out.totalAfter  = ths[2].textContent.trim();
          return;
        }

        // 通常行：<td>指標</td><td>Beforeセル</td><td>Afterセル</td>
        if (tds.length >= 3){
          const label = (tds[0].textContent || '').trim();
          const beforeText = pickScoreText_(tds[1]);
          const afterText  = pickScoreText_(tds[2]);
          if (label){
            out.rows.push({ label, beforeText, afterText });
          }
        }
      });

      return out;

      function pickScoreText_(cell){
        // "17/30" などは span.small.muted の中にある
        const span = cell.querySelector('span.small.muted');
        const t = (span ? span.textContent : cell.textContent) || '';
        return t.trim();
      }
    }

    function esc_(s){
      return String(s)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#39;");
    }

    function normalizePriJP_(p){
      const s = String(p || '').trim().toLowerCase();
      if (!s) return '';
      if (s === 'high' || s === '高') return '高';
      // ★ ここに middle を追加
      if (s === 'medium' || s === 'mid' || s === 'middle' || s === '中') return '中';
      if (s === 'low' || s === '低') return '低';
      return String(p || '').trim();
    }

    function pdfPriBadge_(pri){
      try{
        let priJP = normalizePriJP_(pri);

        // ★ priority が空のカードでも、画面と同様に "中" を表示する（表示上の下駄）
        if (!priJP) priJP = '中';

        // ★ 括弧は“まず付ける”だけ（中身は次段で決める）
        const suffix = '（品質向上）'; // ←いったん仮。次にスコア影響へ分岐させる

        return `<span class="pdf-pri pdf-pri-${esc_(priJP)}">優先度：${esc_(priJP + suffix)}</span>`;
      }catch(_){
        return '';
      }
    }

    function parseFrac_(txt){
      const m = String(txt||'').match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) return { ok:false, pct:0 };
      const x = Number(m[1]), y = Number(m[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || y<=0) return { ok:false, pct:0 };
      return { ok:true, pct: Math.max(0, Math.min(100, (x/y)*100)) };
    }

    function barHtml_(o, type){
      const pct = (o && o.ok) ? Math.round(o.pct) : 0;
      const cls = (type === 'after') ? 'after' : 'before';
      // DOM通り: 高さ8px / 角丸4px / 背景#eee
      return `<div class="pdf-bar" style="height:8px;background:#eee;border-radius:4px;overflow:hidden">
        <div class="pdf-bar-fill ${cls}" style="height:100%;width:${pct}%;"></div>
      </div>`;
    }

    function axisKeyOf_(s){
      const t = String(s || '').trim().toLowerCase();
      if (!t) return '';
      if (t === 'data' || t.includes('データ')) return 'data';
      if (t === 'doc' || t.includes('文書')) return 'doc';
      if (t === 'clarity' || t.includes('明確')) return 'clarity';
      if (t === 'coverage' || t.includes('網羅')) return 'coverage';
      if (t === 'trust' || t.includes('信頼')) return 'trust';
      return '';
    }

    function axisKeyFromTitleForPdf_(title){
      const t = String(title || '').trim();
      if (!t) return '';

      if (
        t === 'WebSite 構造化データの整備' ||
        t === 'Breadcrumb 構造化データの整備' ||
        t === '構造化データにおけるエンティティ間の関連付け'
      ) return 'data';

      if (
        t === '見出し構造（H1等）の整備' ||
        t === 'ナビゲーション領域のセマンティック明示'
      ) return 'doc';

      if (
        t === 'お問い合わせ導線の明確化' ||
        t === '主要情報導線の不足' ||
        t === '主要導線とナビゲーション構造の整合' ||
        t === '主要導線（ナビ/回遊）の薄さ改善' ||
        t === 'HTMLサイトマップの整備'
      ) return 'coverage';

      if (t === '連絡先情報の信頼性・明示性の強化') return 'trust';

      if (t.indexOf('【データ構造】') === 0) return 'data';
      if (t.indexOf('【文書構造】') === 0) return 'doc';
      if (t.indexOf('【表現の明確さ】') === 0) return 'clarity';
      if (t.indexOf('【情報網羅性】') === 0) return 'coverage';
      if (t.indexOf('【信頼性】') === 0) return 'trust';

      return '';
    }

    function axisMeta_(){
      return {
        data:     { label:'データ構造', max:30 },
        doc:      { label:'文書構造', max:20 },
        clarity:  { label:'表現の明確さ', max:10 },
        coverage: { label:'情報網羅性', max:15 },
        trust:    { label:'信頼性', max:25 }
      };
    }

    function pickLatestDiagRes_(){
      const cands = [
        window.__AIO_DETAIL__,
        window.__AIO_DETAIL,
        window.__AIO_LATEST_RES__,
        window.__LATEST_DIAG_RES__,
        window.__AIO_LAST_RES__,
        window.__AIO_LAST_SS_RES__,
        window.__AIO_DEBUG_LAST_SS_RESULT,
        window.__AIO_LATEST_RESULT__
      ];
      for (const c of cands){
        if (c && typeof c === 'object') return c;
      }
      return null;
    }

    function pickFirstArray_(){
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (Array.isArray(v)) return v;
      }
      return [];
    }

    function pickFirstNonEmptyArray_(){
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (Array.isArray(v) && v.length) return v;
      }
      return [];
    }

    function pickFirstObject_(){
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      }
      return null;
    }

    function parseJsonObject_(v){
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      if (typeof v !== 'string' || !v.trim()) return null;
      try {
        const parsed = JSON.parse(v);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
      } catch (_) {
        return null;
      }
    }

    function cardRuleIdOf_(card){
      return String((card && (card.sourceRuleId || card.ruleId || card.id)) || '').trim();
    }

    function axisOfRuleId_(ruleId){
      const s = String(ruleId || '').toUpperCase();
      if (s.indexOf('DATA_') === 0) return 'data';
      if (s.indexOf('DOC_') === 0) return 'doc';
      if (s.indexOf('CLAR_') === 0) return 'clarity';
      if (s.indexOf('COV_') === 0) return 'coverage';
      if (s.indexOf('TRUST_') === 0) return 'trust';
      return '';
    }

    function normalizeMinorRuleId_(rawId, penaltyItems, cards){
      const raw = String(rawId || '').trim();
      const upper = raw.toUpperCase();
      if (axisOfRuleId_(upper)) return upper;

      const pis = Array.isArray(penaltyItems) ? penaltyItems : [];
      for (let i = 0; i < pis.length; i++) {
        const it = pis[i] || {};
        const rid = String((it.ruleId || it.id) || '').trim().toUpperCase();
        if (!rid) continue;
        if (
          raw === String(it.cardKey || '').trim() ||
          raw === String(it.ruleId || '').trim() ||
          raw === String(it.id || '').trim()
        ) {
          return rid;
        }
      }

      const cs = Array.isArray(cards) ? cards : [];
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i] || {};
        const rid = cardRuleIdOf_(c).toUpperCase();
        if (!rid) continue;
        if (
          raw === String(c.cardKey || '').trim() ||
          raw === String(c.templateCardKey || '').trim() ||
          raw === String(c.effectiveCardKey || '').trim() ||
          raw === String(c.themeKey || '').trim() ||
          raw === String(c.id || '').trim()
        ) {
          return rid;
        }
      }

      const map = {
        trust_copyright: 'TRUST_FRESHNESS_WEAK_V1',
        trust_sameas: 'TRUST_SAMEAS_WEAK',
        trust_nap_thin: 'TRUST_NAP_THIN_WEAK',
        trust_sameas_absent: 'TRUST_SAMEAS_ABSENT_WEAK',
        trust_address_missing_minor: 'TRUST_ADDRESS_MISSING_MINOR',
        clar_meta_core: 'CLAR_META_DESCRIPTION_SHORT',
        coverage_nav_thin: 'COV_NAVCOUNT_THIN_WEAK',
        cov_recruit_minor: 'COV_RECRUIT_LINK_MISSING_MINOR',
        doc_main_minor: 'DOC_MAIN_LANDMARK_MISSING_MINOR',
        data_structured_core: 'DATA_JSONLD_VARIANTS_FEW'
      };
      return map[raw] || upper;
    }

    function minorReasonText_(ruleId){
      const map = {
        CLAR_ABSTRACT_LINKTEXT: '冒頭要約内のリンク文言は確認できるものの、遷移先や内容が文言だけで読み分けられるかまでは判定できていません。リンク文言の具体性を確認してください。',
        CLAR_EVIDENCE_SIGNAL_MISSING: '説明候補となる本文や見出しは確認できるものの、主張を支える具体例や根拠文が添えられているかまでは判定できていません。根拠となる説明文や具体例の有無を確認してください。',
        CLAR_HEADING_GENERIC_MIX: '見出しの存在は確認できるものの、抽象語が混在せず内容ごとに区別できる表現になっているかまでは判定できていません。見出し文言の言い分けを確認してください。',
        CLAR_HEADING_THIN: '見出しの存在は確認できるものの、各セクションの要点が見出しだけで伝わる情報量になっているかまでは判定できていません。見出しの具体性を確認してください。',
        CLAR_META_DESCRIPTION_TOO_SHORT: 'meta description の存在は確認できるものの、ページ主題と価値を要約できる長さが確保されているかまでは判定できていません。要約文の情報量を確認してください。',
        CLAR_META_DESCRIPTION_TOO_SHORT_MINOR: 'meta description の存在は確認できるものの、ページ主題と価値を要約できる長さが確保されているかまでは判定できていません。要約文の情報量を確認してください。',
        CLAR_META_DESCRIPTION_SHORT: 'meta description の存在は確認できるものの、主題と価値を十分に伝える説明量になっているかまでは判定できていません。説明文の長さと内容を確認してください。',
        CLAR_META_DESCRIPTION_LONG: 'meta description の存在は確認できるものの、主題が一読で伝わる長さと焦点に収まっているかまでは判定できていません。要約文の長さと焦点を確認してください。',
        CLAR_NAV_ABSTRACT_RATIO: '主要導線のリンク文言は確認できるものの、遷移先ごとの差が文言だけで読み分けられるかまでは判定できていません。リンク文言の具体性を確認してください。',
        CLAR_NAV_GENERIC_MIX: 'ナビゲーションのリンク文言は確認できるものの、汎用語が混在せず役割ごとに区別できる表現になっているかまでは判定できていません。導線ラベルの言い分けを確認してください。',
        CLAR_PRIMARY_MESSAGE_SPECIFICITY_WEAK: '主題説明の具体性・利用者視点の補強',
        CLAR_SPEC_COMPARISON_WEAK: '仕様・比較情報の明確化',
        CLAR_TITLE_LENGTH_WEAK: 'title の存在は確認できるものの、主題を過不足なく伝える長さに収まっているかまでは判定できていません。title の長さと主題の一致を確認してください。',
        DATA_BREADCRUMB_SCHEMA_MISSING: 'BreadcrumbList に相当する構造化データの一部は確認できるものの、親ページから現在ページまでの階層情報が機械可読に整理されているかまでは判定できていません。BreadcrumbList の項目構造を確認してください。',
        DATA_BREADCRUMB_SCHEMA_UNVERIFIED_WEAK: 'パンくずに相当する情報は確認できるものの、BreadcrumbList として階層順・名称・URL が整っているかまでは判定できていません。構造化データの階層定義を確認してください。',
        DATA_JSONLD_VARIANTS_FEW: '構造化データの存在は確認できるものの、WebSite や Organization など必要な型が十分にそろっているかまでは判定できていません。JSON-LD の型構成を確認してください。',
        DATA_ORG_PROFILE_THIN: 'Organization 構造化データの存在は確認できるものの、名称・URL・連絡先・所在地などの基本プロフィールが整理されているかまでは判定できていません。Organization の基本プロパティを確認してください。',
        DOC_MAIN_LANDMARK_MISSING_MINOR: '本文に相当するコンテンツの存在は確認できるものの、main 要素や main ランドマークで主要領域が明示されているかまでは判定できていません。main の配置と範囲を確認してください。',
        TRUST_FRESHNESS_WEAK_V1: '更新に関する表記は一部確認できるものの、最新性を継続的に示す日時や更新情報が整理されているかまでは判定できていません。更新日や更新導線の表示を確認してください。',
        TRUST_NAP_THIN_WEAK: '事業者情報に相当する記載は確認できるものの、名称・住所・連絡先がそろって一貫表示されているかまでは判定できていません。基本事業者情報の掲載内容を確認してください。',
        TRUST_SAMEAS_WEAK: '外部参照先の存在は確認できるものの、公式SNSや外部プロフィールへ主体情報を十分につなげられているかまでは判定できていません。sameAs の接続先を確認してください。',
        TRUST_NAP_THIN: '事業者情報に相当する記載は確認できるものの、名称・住所・連絡先が基本情報としてそろっているかまでは判定できていません。事業者情報の掲載項目を確認してください。',
        TRUST_ADDRESS_MISSING_MINOR: '事業者情報の掲載箇所は確認できるものの、所在地まで明示されているかまでは判定できていません。所在地表記の有無を確認してください。',
        TRUST_SAMEAS_ABSENT_WEAK: '主体情報に相当する記載は確認できるものの、公式SNSや外部プロフィールとの接続まで整理されているかまでは判定できていません。外部プロフィールへの接続を確認してください。',
        TRUST_PRIVACY_LABEL_WEAK: 'プライバシー関連ページへのリンクは確認できるものの、リンク名だけで役割が分かる表現になっているかまでは判定できていません。プライバシー導線のラベルを確認してください。',
        TRUST_CONTACT_INFO_SEMANTICS: '連絡先情報の意味づけ・信頼性の補強',
        TRUST_FRESHNESS_OPERATION_WEAK: '更新運用シグナルの明確化',
        TRUST_COPYRIGHT_STALE: '著作権表記の存在は確認できるものの、現在の運営年と整合した年表記になっているかまでは判定できていません。著作権年の最新性を確認してください。',
        COV_NAVCOUNT_THIN_WEAK: '主要導線の存在は確認できるものの、会社情報・サービス・問い合わせなどへ十分な本数で到達できる構成かまでは判定できていません。主要導線の配置数を確認してください。',
        COV_NAV_UNKNOWN_MINOR: '主要導線に相当する要素は確認できるものの、会社情報・サービス・問い合わせなどのカテゴリごとに到達性を判定できる状態かまでは確認できていません。主要導線のカテゴリ分けを確認してください。',
        COV_FOOTER_NAV_THIN: 'フッター導線や主要ナビゲーションの情報量が限定的です。会社情報・プライバシー情報・利用規約など、補助導線の配置と見つけやすさを確認してください。',
        COV_RECRUIT_LINK_MISSING_MINOR: '企業情報に相当する導線は確認できるものの、採用情報ページへ継続的に到達できる構成かまでは判定できていません。採用導線の有無と配置を確認してください。',
        COV_HTML_SITEMAP_STRUCTURE: 'HTMLサイトマップの存在は確認できるものの、見出しやリストによる階層構造が整理されているかまでは判定できていません。構造と一覧性を確認してください。',
        COV_STRUCTURE_THIN: '主要カテゴリへの導線は一部確認できるものの、会社情報・問い合わせ・FAQ などへ偏りなく到達できる構成かまでは判定できていません。主要カテゴリの露出バランスを確認してください。'
      };
      return map[String(ruleId || '').trim()] || String(ruleId || '').trim();
    }

    function stripAxisPrefixForPdf_(title){
      return String(title || '')
        .replace(/^【データ構造】\s*/, '')
        .replace(/^【文書構造】\s*/, '')
        .replace(/^【表現の明確さ】\s*/, '')
        .replace(/^【情報網羅性】\s*/, '')
        .replace(/^【信頼性】\s*/, '')
        .trim();
    }

    function axisEvalText_(before, after, max, proposalTitles, minorReasons){
      const proposalList = Array.isArray(proposalTitles) ? proposalTitles.filter(Boolean) : [];
      const minorCount = Array.isArray(minorReasons) ? minorReasons.length : 0;
      const topThemes = proposalList.slice(0, 2).map(stripAxisPrefixForPdf_).filter(Boolean);
      const hasThemes = topThemes.length > 0;
      const themeText = topThemes.length >= 2
        ? '「' + topThemes[0] + '」と「' + topThemes[1] + '」'
        : topThemes.length === 1
          ? '「' + topThemes[0] + '」'
          : '';

      if (!(Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(max) && max > 0)) {
        return [
          '現状スコアと改善後（想定）スコアの数値を十分に取得できていないため、この軸の改善幅を定量的には説明できません。',
          (hasThemes
            ? (themeText + ' が主な改善テーマです。')
            : 'この軸では現時点で対応すべき主要な改善提案は確認されていません。'),
          'これらの対応により、生成AIや検索システムがこの軸に関わる重要情報を理解しやすくなることが期待されます。',
          (minorCount > 0
            ? 'あわせて、補足改善ポイントも確認されています。'
            : '補足改善ポイントは現時点では確認されていません。')
        ].join('\n');
      }
      if (!hasThemes) {
        return [
          '現状は ' + before + ' / ' + max + ' 点で、改善後（想定）スコアも同水準です。',
          'この軸では現時点で対応すべき主要な改善提案は確認されていません。',
          '現行の構造・状態は、生成AIや検索システムにとって十分に理解しやすい状態にあります。',
          (minorCount > 0
            ? 'あわせて、補足改善ポイントも確認されています。'
            : '補足改善ポイントは現時点では確認されていません。')
        ].join('\n');
      }
      return [
        '現状は ' + before + ' / ' + max + ' 点で、改善後（想定）スコアは ' + after + ' / ' + max + ' 点を見込んでいます。',
        themeText + ' が主な改善テーマです。',
        'これらの対応により、生成AIや検索システムがページ構造や重要情報を理解しやすくなることが期待されます。',
        (minorCount > 0
          ? 'あわせて、補足改善ポイントも確認されています。'
          : '補足改善ポイントは現時点では確認されていません。')
      ].join('\n');
    }

    function buildAxisReportData_(sections, domTitlesByAxis){
      const meta = axisMeta_();
      const res = pickLatestDiagRes_() || {};
      const snap =
        pickFirstObject_(
          parseJsonObject_(res && res.snapshotJSON),
          parseJsonObject_(res && res.snapshotJSONText),
          parseJsonObject_(res && res.snapshot),
          parseJsonObject_(res && res.detailPayload && res.detailPayload.snapshotJSON),
          parseJsonObject_(res && res.detailPayload && res.detailPayload.snapshotJSONText),
          parseJsonObject_(res && res.diagnosis && res.diagnosis.snapshotJSON),
          parseJsonObject_(res && res.diagnosis && res.diagnosis.snapshotJSONText)
        ) || {};
      const scoreAxis =
        pickFirstObject_(
          res && res.score && res.score.axis,
          res && res.axis,
          res && res.diagnosis && res.diagnosis.axis,
          res && res.meta && res.meta.axis
        ) || {};

      const cards =
        pickFirstArray_(
          res && res.cards,
          res && res.detailPayload && res.detailPayload.cards,
          res && res.diagnosis && res.diagnosis.cards,
          res && res.improveItems
        );

      const penaltyItems =
        pickFirstArray_(
          res && res.penaltyItems,
          res && res.detailPayload && res.detailPayload.penaltyItems,
          res && res.diagnosis && res.diagnosis.penaltyItems,
          res && res.meta && res.meta.penaltyItems,
          res && res.score && res.score.details && res.score.details.penaltyItems,
          snap && snap.penaltyItems,
          snap && snap.diagnosis && snap.diagnosis.penaltyItems,
          snap && snap.meta && snap.meta.penaltyItems
        );

      const minorItems =
        pickFirstNonEmptyArray_(
          res && res.minorPenaltyItems,
          res && res.detailPayload && res.detailPayload.minorPenaltyItems,
          res && res.diagnosis && res.diagnosis.minorPenaltyItems,
          res && res.meta && res.meta.minorPenaltyItems,
          res && res.score && res.score.details && res.score.details.minorPenaltyItems,
          snap && snap.minorPenaltyItems,
          snap && snap.diagnosis && snap.diagnosis.minorPenaltyItems,
          snap && snap.meta && snap.meta.minorPenaltyItems
        );

      const minorByAxis =
        pickFirstObject_(
          res && res.minorByAxis,
          res && res.detailPayload && res.detailPayload.minorByAxis,
          res && res.diagnosis && res.diagnosis.minorByAxis,
          res && res.meta && res.meta.minorByAxis,
          res && res.meta && res.meta.penalty && res.meta.penalty.minor && res.meta.penalty.minor.byAxis,
          snap && snap.minorByAxis,
          snap && snap.diagnosis && snap.diagnosis.minorByAxis,
          snap && snap.meta && snap.meta.minorByAxis,
          snap && snap.meta && snap.meta.penalty && snap.meta.penalty.minor && snap.meta.penalty.minor.byAxis
        ) || {};
      const minorAxisSources = [
        res && res.minorByAxis,
        res && res.detailPayload && res.detailPayload.minorByAxis,
        res && res.diagnosis && res.diagnosis.minorByAxis,
        res && res.meta && res.meta.minorByAxis,
        res && res.meta && res.meta.penalty && res.meta.penalty.minor && res.meta.penalty.minor.byAxis,
        snap && snap.minorByAxis,
        snap && snap.diagnosis && snap.diagnosis.minorByAxis,
        snap && snap.meta && snap.meta.minorByAxis,
        snap && snap.meta && snap.meta.penalty && snap.meta.penalty.minor && snap.meta.penalty.minor.byAxis
      ].filter(v => v && typeof v === 'object');

      let minorIds =
        pickFirstNonEmptyArray_(
          res && res.minorPenaltyIds,
          res && res.detailPayload && res.detailPayload.minorPenaltyIds,
          res && res.diagnosis && res.diagnosis.minorPenaltyIds,
          res && res.meta && res.meta.minorPenaltyIds,
          res && res.meta && res.meta.penalty && res.meta.penalty.minor && res.meta.penalty.minor.lowIds,
          snap && snap.minorPenaltyIds,
          snap && snap.diagnosis && snap.diagnosis.minorPenaltyIds,
          snap && snap.meta && snap.meta.minorPenaltyIds,
          snap && snap.meta && snap.meta.penalty && snap.meta.penalty.minor && snap.meta.penalty.minor.lowIds
        ).slice();

      const rawMinorIds = minorIds.slice();

      if (!minorIds.length) {
        minorIds = (minorItems.length ? minorItems : penaltyItems)
          .filter(it => String((it && it.group) || '') === 'minor')
          .map(it => String((it && (it.ruleId || it.id)) || ''))
          .filter(Boolean);
      }

      function appendMinorId_(rid){
        const s = String(rid || '').trim();
        if (s && minorIds.indexOf(s) < 0) minorIds.push(s);
      }
      function appendMinorIdsFromValue_(v){
        if (!v) return;
        if (typeof v === 'string') {
          appendMinorId_(v);
          return;
        }
        if (Array.isArray(v)) {
          v.forEach(appendMinorIdsFromValue_);
          return;
        }
        if (typeof v === 'object') {
          appendMinorId_(v.ruleId || v.id);
          appendMinorIdsFromValue_(v.ruleIds || v.ids || v.minorPenaltyIds || v.items || v.penaltyItems);
        }
      }
      minorAxisSources.forEach(src => {
        ['data','doc','clarity','coverage','trust'].forEach(ax => {
          appendMinorIdsFromValue_(src && src[ax]);
        });
      });

      const axisScores = {};
      Object.keys(meta).forEach(ax => {
        const before = scoreAxis && scoreAxis.before ? scoreAxis.before[ax] : null;
        const after  = scoreAxis && scoreAxis.after  ? scoreAxis.after[ax]  : null;
        axisScores[ax] = {
          before: Number.isFinite(before) ? before : null,
          after: Number.isFinite(after) ? after : null
        };
      });

      const domAxis = extractAxisScoresFromSections_(sections);
      (domAxis.rows || []).forEach(row => {
        const ax = axisKeyOf_(row && row.label);
        if (!ax) return;
        const b = parseFrac_(row.beforeText || '');
        const a = parseFrac_(row.afterText || '');
        if (axisScores[ax].before == null && b.ok) axisScores[ax].before = Math.round((b.pct / 100) * meta[ax].max);
        if (axisScores[ax].after  == null && a.ok) axisScores[ax].after  = Math.round((a.pct / 100) * meta[ax].max);
      });

      const proposalTitlesByAxis = { data:[], doc:[], clarity:[], coverage:[], trust:[] };
      const proposalTraceByAxis = { data:[], doc:[], clarity:[], coverage:[], trust:[] };
      cards.forEach(card => {
        const rid = cardRuleIdOf_(card);
        const ax = axisKeyOf_(card && card.axis) || axisOfRuleId_(rid);
        const ttl = String((card && card.title) || '').trim();
        if (!ax || !ttl) return;
        if (proposalTitlesByAxis[ax].indexOf(ttl) < 0) {
          proposalTitlesByAxis[ax].push(ttl);
        }
        if (proposalTraceByAxis[ax]) {
          proposalTraceByAxis[ax].push({
            ruleId: rid,
            cardKey: String((card && card.cardKey) || ''),
            templateCardKey: String((card && card.templateCardKey) || ''),
            effectiveCardKey: String((card && card.effectiveCardKey) || ''),
            title: ttl
          });
        }
      });

      Object.keys(meta).forEach(ax => {
        if (!proposalTitlesByAxis[ax].length && domTitlesByAxis && Array.isArray(domTitlesByAxis[ax])) {
          proposalTitlesByAxis[ax] = domTitlesByAxis[ax].slice();
        }
      });

      const minorReasonsByAxis = { data:[], doc:[], clarity:[], coverage:[], trust:[] };
      const finalRenderedMinorItems = [];
      const minorRenderIds = minorIds.slice();
      minorItems.forEach(it => {
        if (!it || String(it.group || '') !== 'minor') return;
        const rid = String((it.ruleId || it.id) || '').trim();
        const ax = axisKeyOf_(it.axis) || axisOfRuleId_(rid);
        if (rid && ax && minorRenderIds.indexOf(rid) < 0) minorRenderIds.push(rid);
      });
      minorRenderIds.forEach(rid => {
        const ruleId = normalizeMinorRuleId_(rid, penaltyItems, cards);
        const ax = axisOfRuleId_(ruleId);
        if (!ax) return;
        const text = minorReasonText_(ruleId);
        if (text && minorReasonsByAxis[ax].indexOf(text) < 0) {
          minorReasonsByAxis[ax].push(text);
          finalRenderedMinorItems.push({ ruleId: ruleId, axis: ax, reason: text });
        }
      });

      try {
        console.log('[PDF_MINOR_SOURCE_TRACE]', JSON.stringify({
          minorIds: minorIds,
          minorItems: minorItems.map(it => ({
            ruleId: String((it && (it.ruleId || it.id)) || ''),
            axis: String((it && it.axis) || ''),
            group: String((it && it.group) || ''),
            title: String((it && it.title) || '')
          })),
          minorByAxis: minorByAxis,
          dataReasons: minorReasonsByAxis.data
        }));
      } catch (_) {}
      try {
        console.log('[PDF_MINOR_RENDER_TRACE]', JSON.stringify({
          rawMinorIds: rawMinorIds,
          rawMinorItems: minorItems.map(it => ({
            ruleId: String((it && (it.ruleId || it.id)) || ''),
            axis: String((it && it.axis) || ''),
            group: String((it && it.group) || ''),
            surfaced: it && it.surfaced,
            title: String((it && it.title) || '')
          })),
          dataMinorItems: finalRenderedMinorItems.filter(it => it.axis === 'data'),
          filteredMinorItems: minorRenderIds.map(rid => normalizeMinorRuleId_(rid, penaltyItems, cards)),
          finalRenderedMinorItems: finalRenderedMinorItems,
          hasDataBreadcrumbMinor: finalRenderedMinorItems.some(it => it.ruleId === 'DATA_BREADCRUMB_SCHEMA_MISSING')
        }));
      } catch (_) {}
      try {
        console.log('[PDF_AXIS_PROPOSAL_TRACE]', JSON.stringify({
          counts: Object.keys(proposalTitlesByAxis).reduce((acc, ax) => {
            acc[ax] = proposalTitlesByAxis[ax].length;
            return acc;
          }, {}),
          data: proposalTraceByAxis.data
        }));
      } catch (_) {}

      const out = {};
      Object.keys(meta).forEach(ax => {
        const before = axisScores[ax].before;
        const after = axisScores[ax].after;
        const max = meta[ax].max;
        out[ax] = {
          axis: ax,
          label: meta[ax].label,
          max: max,
          before: before,
          after: after,
          beforeText: Number.isFinite(before) ? `${before}/${max}` : '—',
          afterText: Number.isFinite(after) ? `${after}/${max}` : '—',
          proposalTitles: proposalTitlesByAxis[ax],
          minorReasons: minorReasonsByAxis[ax]
        };
        out[ax].evaluation = axisEvalText_(
          before,
          after,
          max,
          out[ax].proposalTitles,
          out[ax].minorReasons
        );
      });
      return out;
    }

    function buildAxisCoverPage_(axisKey, axisData){
      if (!axisData) return null;
      const proposals = (axisData.proposalTitles && axisData.proposalTitles.length)
        ? axisData.proposalTitles.map(t => stripAxisPrefixForPdf_(t)).filter(Boolean)
        : [];
      const hasProposals = proposals.length > 0;
      const minorReasons = (axisData.minorReasons && axisData.minorReasons.length)
        ? axisData.minorReasons.map(t => String(t || '').trim()).filter(Boolean)
        : [];
      const hasMinorReasons = minorReasons.length > 0;

      const html = [
        '<h1 class="pdf-h1">GEO診断</h1>',
        `<h2 class="pdf-h2">${esc_(axisData.label)}</h2>`,
        '<div class="pdf-card pdf-axis-cover-frame">',
          '<div class="pdf-axis-cover-field">',
            '<div class="pdf-axis-cover-label">現状スコア</div>',
            `<div class="pdf-axis-cover-value">${esc_(axisData.beforeText)}</div>`,
          '</div>',
          '<div class="pdf-axis-cover-field">',
            '<div class="pdf-axis-cover-label">改善後（想定）スコア</div>',
            `<div class="pdf-axis-cover-value">${esc_(axisData.afterText)}</div>`,
          '</div>',
          '<div class="pdf-axis-cover-field">',
            '<div class="pdf-axis-cover-label">評価</div>',
            `<div class="pdf-axis-cover-value" style="white-space:pre-line;">${esc_(axisData.evaluation)}</div>`,
          '</div>',
          '<div class="pdf-axis-cover-field">',
            '<div class="pdf-axis-cover-label">この指標の改善提案</div>',
            (hasProposals
              ? [
                  '<ul class="pdf-axis-cover-list">',
                    proposals.map(t => `<li>${esc_(t)}</li>`).join(''),
                  '</ul>'
                ].join('\n')
              : '<div class="pdf-axis-cover-value">該当なし</div>'),
          '</div>',
          [
            '<div class="pdf-axis-cover-field">',
              '<div class="pdf-axis-cover-label">補足改善ポイント</div>',
              (hasMinorReasons
                ? [
                    '<div class="pdf-axis-cover-value">GEOへの影響は軽微のため改善施策としては提示していませんが、<br>以下の理由により減点されています。</div>',
                    '<ul class="pdf-axis-cover-list" style="margin-top:8px;">',
                      minorReasons.map(t => `<li>${esc_(t)}</li>`).join(''),
                    '</ul>'
                  ].join('\n')
                : '<div class="pdf-axis-cover-value">該当なし</div>'),
            '</div>'
          ].join('\n'),
        '</div>'
      ].join('\n');

      return makePage_('pdf-report-axis-cover', html);
    }

    function safeCanvasPng_(sel){
      try{
        const c = document.querySelector(sel);
        if (c && c.toDataURL) return c.toDataURL('image/png');
      }catch(_){}
      return '';
    }
  }

  function makePage_(cls, innerHtml){
    const page = document.createElement('section');
    page.className = `pdf-page ${cls}`;

    // ★ ヘッダー/フッター直描き（y=8 / pageH-6）と本文の衝突を避けるための安全余白
    //  - jsPDF の header/footer を動かさず、HTML側に上下の“物理的な空白”を確保する
    const SAFE_TOP_H = 0;
    const SAFE_BOT_H = 0;

    const wrap = document.createElement('div');
    wrap.innerHTML = [
      (SAFE_TOP_H ? `<div style="height:${SAFE_TOP_H}px;"></div>` : ''),
      innerHtml,
      (SAFE_BOT_H ? `<div style="height:${SAFE_BOT_H}px;"></div>` : '')
    ].join('\n');

    page.appendChild(wrap);

    // ★ 表紙だけ：縦センター寄せ（上半分に偏るのを防ぐ）
    if (String(cls).includes('pdf-cover')) {
      page.style.minHeight = '1040px';
      page.style.display = 'flex';
      page.style.flexDirection = 'column';
      page.style.justifyContent = 'center';
    }

    return page;
  }

  function forceVisibleTree_(root){
    try{
      root.querySelectorAll('[hidden]').forEach(n => n.removeAttribute('hidden'));
      root.querySelectorAll('[aria-hidden="true"]').forEach(n => n.setAttribute('aria-hidden','false'));
      root.querySelectorAll('*').forEach(n => {
        if (!n || !n.style) return;
        if (n.style.display === 'none') n.style.display = 'block';
        if (n.style.visibility === 'hidden') n.style.visibility = 'visible';
        if (n.style.opacity === '0') n.style.opacity = '1';
      });
    }catch(_){}
  }

  // =========================================================
  // 5) HTML templates (cover / conditions / notes)
  // =========================================================
  function buildCoverHtml_(ctx){
    const authorLine = ctx.authorName
      ? `<div style="margin-top:10px;font-size:13px;">作成：${escapeHtml_(ctx.authorName)}</div>`
      : '';

    return `
      <div style="text-align:center;margin-top:120px;">
        <div style="
          position:absolute;
          top:32px;
          left:32px;
          font-size:14px;
          text-align:left;
        ">
          ${escapeHtml_(ctx.clientName || '(未入力)')} 御中
        </div>

        <div style="font-size:36px;font-weight:800;letter-spacing:.02em;">
          GEO診断レポート
        </div>
        <div style="margin-top:14px;font-size:15px;opacity:.9;">
          AI可視性（AI Visibility）に基づくWebサイト評価
        </div>

        <div style="margin-top:56px;font-size:16px;font-weight:400;">
          株式会社フォーク
        </div>

        <div style="position:absolute; right:48px; bottom:0px; font-size:14px; display:flex; gap:16px; align-items:flex-end;">
          <div>${authorLine}</div>
          <div>作成日：${escapeHtml_(ctx.reportDateText || ctx.diagnosisDateText || '—')}</div>
        </div>
      </div>
    `;
  }

  function buildConditionsHtml_(ctx){
    return `
      <h1 class="pdf-h1">検査条件</h1>

      <div class="pdf-text" style="font-size:13px;line-height:1.7;">
        <h2 style="margin-top:14px;">診断日</h2>
        <div>${escapeHtml_(ctx.diagnosisDateText || ctx.dateJST || '—')}</div>

        <h2 style="margin-top:14px;">対象URL</h2>
        <div>${escapeHtml_(ctx.origin || '—')}</div>

        <h2 style="margin-top:14px;">診断対象</h2>
        ${ul_(ctx.scopeLines)}

        <!-- ★ 指標の説明：ここに移動＋ ul_() で統一 -->
        <h2 style="margin-top:14px;">評価指標</h2>
        <div>
          本診断では、Webサイトを以下の5つの観点から評価しています。
        </div>
        ${ul_([
          '【データ構造】AIが情報を正確に理解できるよう、構造化データやHTML構造が適切に設計されているか',
          '【文書構造】ページ内の見出し構成や情報の並びが論理的で、内容の把握がしやすい構成になっているか',
          '【表現の明確さ】サービス内容や提供価値が、AIにとって把握しやすい形で提示されているか',
          '【情報網羅性】ページ内外の主要情報・補助導線が、利用者とAIにとって辿りやすく整理されているか',
          '【信頼性】運営主体や実績、方針など、信頼につながる情報が明示されているか'
        ])}

        <h2 style="margin-top:14px;">使用したAIモデル</h2>
        ${ul_(ctx.modelLines)}

        <h2 style="margin-top:14px;">観測したAIの種類</h2>
        ${ul_(ctx.aiOverviewLines)}

      </div>
    `;
  }

  function buildNotesHtml_(){
    // Use your already agreed notes copy; this is a compact v1 placeholder.
    return `
      <h1 class="pdf-h1">注記</h1>
      <div style="font-size:13px;line-height:1.7;">
        <h2 style="margin-top:14px;">本レポートについて</h2>
        <div>本レポートは、対象URLおよび構造化データ等をもとに、生成AI時代におけるWebサイトの可読性・評価傾向を多角的に分析したものです。診断結果および改善提案は、診断実施時点の情報に基づくスナップショットです。</div>

        <h2 style="margin-top:14px;">診断範囲と前提条件</h2>
        <ul>
          <li>本診断はトップページを主対象とし、構造化データ（JSON-LD等）の有無・内容を解析対象に含みます。</li>
          <li>下層ページ全体の網羅的なクロールや内容評価は行っていません。</li>
          <li>サイト構成やページ種別により、評価の重みづけや注視点が異なる場合があります。</li>
        </ul>

        <h2 style="margin-top:14px;">指標およびスコアについて</h2>
        <ul>
          <li>各スコアおよびランクは、複数の評価軸をもとに算出されています。</li>
          <li>Afterスコアは、改善カードに記載した対策を実施した場合に、GEO/AI可視性上で観測済みの改善余地がどこまで補えるかを示す想定値です。</li>
          <li>時間・コストに対して効果が限定的、または運用継続が前提となる項目（例：情報設計の厚み、表記ゆれ・保守性、継続的な更新運用など）は、Afterスコアにも減点が残る場合があります。</li>
          <li>数値は相対評価を目的とした指標であり、検索順位や成果を直接保証するものではありません。</li>
          <li>評価スコアは明確な欠落の有無だけでなく、情報の網羅性や内容の厚みを含めた相対的な水準をもとに算出されます。改善カードが表示されない場合でも、評価が最大値に達しないケースがあります。</li>
          <li>評価ロジック上、「評価差分」として扱われる代表的な観点については、次ページにて補足しています。</li>
        </ul>

        <h2 style="margin-top:14px;">改善提案について</h2>
        <ul>
          <li>改善ポイントとは、診断実施時点の情報をもとに自動生成された提案です。</li>
          <li>実装にあたっては、サイトの目的・優先度・運用体制に応じた検討が必要です。</li>
          <li>AI流入や検索順位などの効果測定を保証するものではなく、構造面における改善余地を示す診断結果です。</li>
          <li>特定のページや要素に対して、明確な欠落や不備が確認できる場合にのみ、改善カードが表示されます。</li>
        </ul>

        <h2 style="margin-top:14px;">AI認識ログについて</h2>
        <ul>
          <li>AI認識ログは特定モデルに対して対象URLの情報を入力し、その時点での認識傾向を記録したものです。</li>
          <li>出力はモデル仕様や時間経過により変動する可能性があります。</li>
          <li>本レポートではAI認識ログを定点観測の参考情報として位置づけています。</li>
        </ul>

        <h2 style="margin-top:14px;">AI可視性に関する対応状況について</h2>
        <ul>
          <li>各項目は、AIが参照しやすい構造・宣言・情報設計の有無を確認しています。</li>
          <li>特定の検索順位や生成AIでの表示結果を保証するものではありません。</li>
        </ul>
      </div>
    `;
  }

  function buildNotesDiffHtml_(){
    return `
      <h1 class="pdf-h1">評価差分について</h1>
      <div style="font-size:13px;line-height:1.7;">

        <!-- ><h2 style="margin-top:14px;">評価差分について</h2> -->
        <p>
          以下は、改善カードとして表示される場合もありますが、
          AIによる構造理解や確信度評価の過程で、スコア差分や残差要因としても扱われる代表的な補足観点です。
          これらは不具合や欠陥を示すものではなく、機械的な解釈精度や情報の集約度の違いによって生じる評価調整要因であり、
          本診断では改善カードとあわせて、スコア算出上の補足要素として位置づけています。
        </p>

        <h2 style="margin-top:14px;">データ構造</h2>
        <ul>
          <li>JSON-LDは存在するが、ページ種別や主要情報の構造化範囲が限定的で、本文上の情報との対応関係に確認余地がある</li>
          <li>取得タイミングやJavaScript依存により、機械的解釈の確実性が低下する可能性がある（例：タイムアウト・遅延描画・動的挿入）</li>
          <li>ページ上の主題は読めるが、構造化データ上で「主役」が固定されず、確信度が最大化されない（例：mainEntity/author/providerが未定義）</li>
        </ul>

        <h2 style="margin-top:14px;">文書構造</h2>
        <ul>
          <li>見出し階層は成立しているが、情報ブロックの論理粒度が均一でない（例：同じ階層に目的の異なるセクションが混在）</li>
          <li>セマンティック構造は有効だが、AIが全体像を把握するまでに追加解釈を要する（例：nav/main/header/footerの役割が複数パターン）</li>
          <li>リンク群・注釈・補足が本文と近接し、主要情報の抽出でノイズになり得る（例：共通パーツが本文に混ざって見える）</li>
        </ul>

        <h2 style="margin-top:14px;">表現の明確さ</h2>
        <ul>
          <li>意味は成立するが、主語・条件・前提が暗黙的な表現が含まれる（例：「〜できます」だけで対象・条件が省略される）</li>
          <li>略語や専門用語の定義がページ内で完結していない（例：初出での補足がなく、他ページ前提になる）</li>
          <li>ページ単体での要約は可能だが、用語・表記ゆれにより同一概念の統合精度が下がる（例：名称揺れ、表記の混在）</li>
        </ul>

        <h2 style="margin-top:14px;">情報網羅性</h2>
        <ul>
          <li>情報欠落はないが、内部リンク設計や情報集約性に改善余地がある（例：重要情報が分散し、ハブが弱い）</li>
          <li>AIが構造を把握するために複数ページの横断を要する構成（例：導線はあるが、階層・役割が明示されない）</li>
          <li>一覧性はあるが、分類軸が曖昧で「どこに何があるか」の確信度が上がりにくい（例：フッター/サイトマップの情報設計）</li>
        </ul>

        <h2 style="margin-top:14px;">信頼性</h2>
        <ul>
          <li>運営・法的・技術的な信頼シグナルは存在するが、強度や即時性にばらつきがある（例：確認できるが目立たない／到達が遠い）</li>
          <li>信頼情報が分散配置されており、確信度が最大化されていない（例：運営者情報・規約・連絡先が別ページに散る）</li>
          <li>技術的には問題がなくても、第三者的な裏取りや更新運用の継続性を示すシグナルが弱い場合がある</li>
        </ul>

      </div>
    `;
  }

  function siteTypeDescription_(siteTypeLabel){
    // Keep short (2–3 sentences). Avoid implying "we read/understand the prose".
    const t = String(siteTypeLabel || '');

    if (t.includes('コーポレート')){
      return '企業・組織（※公共施設・団体サイトを含む）の運営主体情報をAIが正しく把握できるよう、情報が構造的に整理・提示されているかを重視します。運営主体の概要、役割・提供内容、所在地や連絡先（NAP）の明示性、主要ページ（概要・お問い合わせ・ポリシー等）への導線、ならびに構造化データ（Organization／WebSite 等）を評価対象とします。';
    }

    if (t.includes('サービス') || t.includes('LP')){
      return 'サービス内容を判断するために必要な情報が、過不足なく整理・提示されているかを重視します。サービス概要・料金・対象ユーザー・提供価値の明示と、事例・FAQ・問い合わせ等の主要導線、ならびに構造化データ（Service／Offer／Organization 等）を評価対象とします。';
    }

    if (t.includes('EC')){
      return '商品の購入判断に必要な情報が、適切な粒度で整理され、購入までの導線が明確かを重視します。商品情報（価格・在庫・SKU・画像・レビュー等）の明示、送料・返品ポリシーへの導線、ならびに構造化データ（Product／Offer 等）を評価対象とします。';
    }

    if (t.includes('メディア') || t.includes('オウンド')){
      return '記事内容の信頼性を判断するための手がかりが明示され、記事群が整理されているかを重視します。著者・更新日・出典等の明示、カテゴリ・タグ・パンくず等の整理に加え、運営主体情報の明確さ、ならびに構造化データ（Article／BlogPosting／Organization 等）を評価対象とします。';
    }

    return '';
  }

  function ul_(items){
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return '—';
    return `<ul style="margin:0;padding-left:18px;">${
      arr.map(s => `<li>${escapeHtml_(String(s))}</li>`).join('')
    }</ul>`;
  }

  // =========================================================
  // 6) PDF render (TODO integrate your current pipeline)
  // =========================================================
  async function renderPdfAndDownload_(job, printRoot){
    // --- dependency checks ---
    const h2c = window.html2canvas;
    const jsPDFCtor =
      (window.jspdf && window.jspdf.jsPDF) ||
      window.jsPDF ||
      null;

    if (typeof h2c !== 'function') {
      throw new Error('html2canvas が未ロードです（window.html2canvas がありません）');
    }
    if (!jsPDFCtor) {
      throw new Error('jsPDF が未ロードです（window.jspdf.jsPDF / window.jsPDF がありません）');
    }

    // --- mount printRoot clone to offscreen stage (layout fix) ---
    const stage = document.createElement('div');
    stage.style.position = 'fixed';
    stage.style.left = '-100000px';
    stage.style.top  = '0';
    stage.style.width = '794px'; // A4相当
    stage.style.background = '#ffffff';
    stage.style.pointerEvents = 'none';
    stage.style.zIndex = '-1';
    document.body.appendChild(stage);

    // ★ 本体は動かさず、クローンだけ使う
    const printClone = printRoot.cloneNode(true);
    stage.appendChild(printClone);

    // === [PDF][WIDTH-NORMALIZE v1] radar/summary だけ「固定幅焼き付け」を解除して100%に戻す（cloneのみ） ===
    try{
      const pageSels = [
        '.pdf-page.pdf-report-radar-axis',
        '.pdf-page.pdf-report-summary'
      ];

      pageSels.forEach(sel=>{
        const p = printClone.querySelector(sel);
        if (!p) return;

        Array.from(p.children || []).forEach(ch=>{
          // 見出しはそのまま
          if (ch && ch.classList && ch.classList.contains('pdf-h1')) return;
          if (!ch || !ch.style) return;

          // “焼き付いた固定幅” を殺して、ページ有効幅(722px)いっぱいに揃える
          ch.style.width = '100%';
          ch.style.maxWidth = '100%';
          ch.style.boxSizing = 'border-box';

          // 左右ズレの温床になりやすいので明示的にゼロ（paddingは触らない）
          ch.style.marginLeft  = '0';
          ch.style.marginRight = '0';

          // transform が焼けてたら右欠け/左寄りに見えるので念のため無効化
          if (ch.style.transform && ch.style.transform !== 'none'){
            ch.style.transform = 'none';
          }
        });
      });

      console.warn('[PDF][WIDTH-NORMALIZE][DONE]');
    }catch(e){
      console.warn('[PDF][WIDTH-NORMALIZE][EXC]', e);
    }

    // === [PDF][RADAR-CENTER-SAFE v1] 診断レーダーを“幅を変えずに”中央寄せ（printCloneだけ） ===
    try{
      const card = printClone.querySelector('#dv2-card-result-radar');
      if (card){
        const wrap =
          card.querySelector('.chart-wrap') ||
          (card.querySelector('#dv2-radar-canvas') && card.querySelector('#dv2-radar-canvas').parentElement) ||
          null;

        if (wrap){
          // いまの見た目幅を保持して中央寄せ（width:100% は絶対に触らない）
          const r = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
          const w = r && r.width ? Math.round(r.width) : 0;

          wrap.style.marginLeft  = 'auto';
          wrap.style.marginRight = 'auto';

          if (w > 0){
            wrap.style.width    = w + 'px';
            wrap.style.maxWidth = w + 'px';
          }

          // 念のため “左寄せの原因が親flex” でも中央に来るように
          const parent = wrap.parentElement;
          if (parent && parent.style){
            parent.style.justifyContent = 'center';
          }
        }
      }
    }catch(_){}

    // === [PDF][CLONE-ID-PROBE v1] printClone内に実在する dv2/compare 系IDを列挙 ===
    try{
      const ids = Array.from(printClone.querySelectorAll('[id]'))
        .map(n => String(n.id || ''))
        .filter(id => id && (id.startsWith('dv2-') || id.startsWith('compare') || id.includes('chart')))
        .slice(0, 200);

      console.warn('[PDF][CLONE-ID-PROBE]', {count: ids.length, ids});
    }catch(e){
      console.warn('[PDF][CLONE-ID-PROBE][EXC]', e);
    }

    // === [PDF][CHART-INJECT v1] printClone側にcanvasが無い場合、画面側canvasをPNG化して枠へ流し込む ===
    try{
      function injectChartByContainerId_(containerId){
        try{
          // 1) 画面側：container配下のcanvasを探してPNG化
          const liveBox = document.getElementById(containerId);
          if (!liveBox) return {ok:false, why:'no_live_box'};

          const liveCanvas =
            (liveBox.tagName === 'CANVAS') ? liveBox : liveBox.querySelector('canvas');
          if (!liveCanvas) return {ok:false, why:'no_live_canvas'};

          let dataUrl = '';
          try{ dataUrl = liveCanvas.toDataURL('image/png'); }catch(_){ dataUrl = ''; }
          if (!dataUrl || !dataUrl.startsWith('data:image/')) return {ok:false, why:'no_dataurl'};

          // 2) printClone側：同じidの枠を探して中身をIMGに置換
          const cloneBox = printClone.querySelector('#' + containerId);
          if (!cloneBox) return {ok:false, why:'no_clone_box'};

          // 枠の高さが潰れるのを防ぐ（最低限）
          try{
            if (cloneBox.style && cloneBox.style.setProperty){
              cloneBox.style.setProperty('display', 'block', 'important');
              cloneBox.style.setProperty('min-height', '220px', 'important'); // 必要なら後で調整
            }
          }catch(_){}

          // 既存の中身をクリアして画像を入れる
          cloneBox.innerHTML = '';
          const img = document.createElement('img');
          img.src = dataUrl;
          img.alt = 'chart';
          img.style.display = 'block';
          img.style.width = '100%';
          img.style.height = 'auto';
          img.style.margin = '0';
          cloneBox.appendChild(img);

          return {ok:true};
        }catch(e){
          return {ok:false, why:'exc'};
        }
      }

      const targets = [
        'dv2-chart-score',   // 総合スコア推移（あなたのKILL_SELECTORSにも出てる）
        'dv2-chart-clicks',  // 改善ポイント件数/クリック等（同上）
        'dv2-chart-state'    // 状態チャートがあるなら
      ];

      const rep = {};
      let okCount = 0;
      targets.forEach(id=>{
        const r = injectChartByContainerId_(id);
        rep[id] = r;
        if (r && r.ok) okCount++;
      });

      console.warn('[PDF][CHART-INJECT][DONE]', {okCount, rep});
    }catch(e){
      console.warn('[PDF][CHART-INJECT][SKIP]', e);
    }

    // --- collect pages ---
    let pages = [];
    try{
      pages = Array.from(printClone.querySelectorAll('.pdf-page')) || [];
      const head = (pages[0] && (pages[0].innerText || pages[0].textContent || '')) || '';
    }catch(e){
      console.error('[PDF][PAGES][EXC]', e);
      // ★ ここまで来て落ちるなら DOM か selector 周り
      pages = [];
    }

    if (!pages.length) {
      throw new Error('.pdf-page が見つかりません（printRoot 組み立てに失敗している可能性）');
    }

    // --- filename ---
    const safeClient = sanitizeFilePart_(job.clientName || '');
    const ymd = formatDateFileYmd_(new Date());
    const fname = safeClient
      ? `GEO診断レポート_${safeClient}_${ymd}.pdf`
      : `GEO診断レポート_${ymd}.pdf`;

    // --- create pdf (A4 portrait, mm) ---
    const pdf = new jsPDFCtor({
      orientation: 'p',
      unit: 'mm',
      format: 'a4'
    });

    // A4 size in mm
    const pageW = 210;
    const pageH = 297;

    // --- render each .pdf-page as an image, one-by-one ---
    for (let i = 0; i < pages.length; i++){
      const el = pages[i];

      // ★ Step4: 強制表示を「ここ1箇所」に集約（Improveページだけ）
      // - 目的：.hide / [hidden] / aria-hidden / display:none !important を “最小限” で解除
      function forceShowForPdfImprove_(pageEl){
        try{
          if (!pageEl) return;

          // Improveページかどうか（“GEO診断改善ポイント”を含むページだけ）
          const t = String(pageEl.textContent || '');
          const isImprove = t.includes('GEO診断改善ポイント') || t.includes('改善ポイント');
          if (!isImprove) return;

          // 1) まずページ自身を確実に表示（これだけで直るケースが多い）
          try{
            pageEl.classList && pageEl.classList.remove('hide');
            pageEl.removeAttribute('hidden');
            pageEl.removeAttribute('aria-hidden');

            if (pageEl.style && pageEl.style.setProperty) {
              pageEl.style.setProperty('display', 'block', 'important');
              pageEl.style.setProperty('visibility', 'visible', 'important');
              pageEl.style.setProperty('opacity', '1', 'important');
              pageEl.style.setProperty('transform', 'none', 'important');
            }
          }catch(_){}

          // 2) Improveブロック配下だけ最小限で解除（子孫全部は触らない）
          //    ※ “改善ポイントブロック”のルートを絞る（id/classが無くてもテキスト近傍で拾う）
          let root = null;
          try{
            // 可能なら既知のid/classがあれば優先（存在しないならスキップされる）
            root =
              pageEl.querySelector('#improveSummary') ||
              pageEl.querySelector('#improveSummaryText') ||
              pageEl.querySelector('[data-improve]') ||
              null;
          }catch(_){}

          // 見つからない場合は「見出しを含む要素の近いコンテナ」を拾う
          if (!root) {
            try{
              const head = Array.from(pageEl.querySelectorAll('*')).find(n => {
                const s = (n.textContent || '').trim();
                return s === 'GEO診断改善ポイント' || s === '改善ポイント';
              });
              root = head ? (head.closest('.card, section, div') || head) : null;
            }catch(_){}
          }
          if (!root) return;

          // root と “直下少数” だけ解除（深い全探索はしない）
          const targets = [root].concat(Array.from(root.children || []));
          targets.forEach(node => {
            try{
              node.classList && node.classList.remove('hide');
              node.removeAttribute && node.removeAttribute('hidden');
              node.removeAttribute && node.removeAttribute('aria-hidden');

              if (node.style && node.style.setProperty) {
                node.style.setProperty('display', 'block', 'important');
                node.style.setProperty('visibility', 'visible', 'important');
                node.style.setProperty('opacity', '1', 'important');
                node.style.setProperty('transform', 'none', 'important');
              }
            }catch(_){}
          });
        }catch(_){}
      }

      // Ensure layout is stable
      await nextFrame_();

      // ★ 診断ページだけ：レーダー枠を一時的に正方形固定（html2canvasの縦長化対策）
      let __radarFix = null;
      try{
        const radarCard = el.querySelector && el.querySelector('#dv2-card-result-radar');
        if (radarCard) {
          const box =
            radarCard.querySelector('.chart-wrap') ||
            radarCard.querySelector('canvas')?.parentElement ||
            radarCard;

          const prev = {
            height: box.style.height,
            maxHeight: box.style.maxHeight,
            aspectRatio: box.style.aspectRatio,
            display: box.style.display,
            paddingTop: box.style.paddingTop
          };

          // 正方形fix
          const w = Math.max(320, Math.round(box.getBoundingClientRect().width || 0));
          box.style.display = 'block';
          box.style.aspectRatio = '1 / 1';
          box.style.height = w + 'px';
          box.style.maxHeight = w + 'px';

          // “確定で入ってる上余白” をゼロへ（これが効いた）
          box.style.paddingTop = '0px';

          __radarFix = { box, prev };
        }
      }catch(e){
        console.warn('[PDF][v1] radar square fix failed', e);
      }

      // レイアウト反映待ち
      if (__radarFix) await nextFrame_();

      // ★ html2canvas直前：診断レーダーだけ “見えている実体” を必要ならPNG化し、必要なら上に詰める
      let __radarImgSwap = null;
      try{
        const radarCard = el.querySelector && el.querySelector('#dv2-card-result-radar');

        const target = radarCard && radarCard.querySelector && (
          radarCard.querySelector('#dv2-radar-canvas') ||
          radarCard.querySelector('canvas') ||
          radarCard.querySelector('img[alt="radar"], img[alt="chart"], img[src^="data:image/"]')
        );

        if (radarCard && target) {
          const wrap =
            (target.closest && target.closest('.chart-wrap')) ||
            (radarCard.querySelector && radarCard.querySelector('.chart-wrap')) ||
            radarCard;

          // ★ 統一フォーマット（ここだけ覚えればOK）
          __radarImgSwap = {
            wrap,
            prevWrap: {
              paddingTop: wrap && wrap.style ? wrap.style.paddingTop : '',
              marginTop:  wrap && wrap.style ? wrap.style.marginTop  : '',
              overflow:   wrap && wrap.style ? wrap.style.overflow   : ''
            },
            // “元の実体” と “置換後の実体” を分けて持つ
            originalEl: target,
            replacedEl: null,
            prevReplacedStyle: null
          };

          // 1) まずwrapの上余白を潰して、枠外描画は止める
          if (wrap && wrap.style) {
            wrap.style.paddingTop = '0';
            wrap.style.marginTop  = '0';
            wrap.style.overflow   = 'hidden';
          }

          // 2) CANVASなら PNG化して差し替え、IMGならそのまま使う
          let visibleEl = target;

          if (target.tagName === 'CANVAS' && window.Chart) {
            const cv = target;
            const ch = (Chart.getChart ? Chart.getChart(cv) : (cv.__chart || cv.chart || null));
            if (ch) {
              try { if (ch.options) { ch.options.animation = false; ch.options.animations = false; } } catch(_){}
              try { ch.update('none'); } catch(_){}

              let dataUrl = '';
              try { dataUrl = (typeof ch.toBase64Image === 'function') ? ch.toBase64Image() : cv.toDataURL('image/png'); } catch(_){}

              if (dataUrl && dataUrl.startsWith('data:image/')) {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = 'radar';
                img.style.display = 'block';
                img.style.width  = '100%';
                img.style.height = 'auto';
                img.style.margin = '0';

                cv.replaceWith(img);
                __radarImgSwap.replacedEl = img;
                visibleEl = img;
              }
            }
          }

          // 3) “見えている実体(IMG)” を gap 分だけ上に詰める（本命）
          if (wrap && visibleEl && wrap.getBoundingClientRect && visibleEl.getBoundingClientRect) {
            const br = wrap.getBoundingClientRect();
            const vr = visibleEl.getBoundingClientRect();
            const gap = Math.round(vr.top - br.top);

            // style退避（置換してない場合も、IMGを動かすので退避する）
            __radarImgSwap.prevReplacedStyle = {
              position: visibleEl.style ? visibleEl.style.position : '',
              top:      visibleEl.style ? visibleEl.style.top      : '',
              marginTop:visibleEl.style ? visibleEl.style.marginTop: ''
            };

            if (gap > 0 && visibleEl.style) {
              visibleEl.style.position = 'relative';
              visibleEl.style.marginTop = '0';

              const maxUp = Math.max(80, Math.round(br.height - 20));
              const up = Math.min(gap, maxUp);

              // ★ 調整量（px）：正の値ほど「下がる」
              const OFFSET_PX = 25;

              visibleEl.style.top = (-(up - OFFSET_PX)) + 'px';
            }

            // “動かした実体”を必ず記録（復元で使う）
            if (!__radarImgSwap.replacedEl) __radarImgSwap.replacedEl = visibleEl;
            __radarImgSwap.movedEl = visibleEl; // ★ styleを動かした実体
          }
        }
      }catch(e){
        console.warn('[PDF][v1] radar img swap failed', e);
      }

      // === 追加：競合比較レーダー（compareRadar）も同じ“沈み/凡例チラ見え”対策を適用 ===
      try{
        const cmpCard =
          (el.querySelector && el.querySelector('#compareRadarCard')) ||
          null;

        const target2 = cmpCard && cmpCard.querySelector && (
          cmpCard.querySelector('#compareRadar') ||
          cmpCard.querySelector('canvas') ||
          cmpCard.querySelector('img[alt="radar"], img[alt="chart"], img[src^="data:image/"]')
        );

        if (cmpCard && target2) {
          const wrap2 =
            (target2.closest && target2.closest('.chart-wrap')) ||
            (cmpCard.querySelector && cmpCard.querySelector('.chart-wrap')) ||
            cmpCard;

          // 診断と同じフォーマットで退避（復元は既存の __radarImgSwap 復元で“共用”したいので、配列にする）
          // 既存が単体なら、配列化して両方突っ込む
          const pushSwap = (sw) => {
            if (!sw) return;
            if (!__radarImgSwap) { __radarImgSwap = [sw]; return; }
            if (Array.isArray(__radarImgSwap)) { __radarImgSwap.push(sw); return; }
            __radarImgSwap = [__radarImgSwap, sw];
          };

          const sw2 = {
            wrap: wrap2,
            prevWrap: {
              paddingTop: wrap2 && wrap2.style ? wrap2.style.paddingTop : '',
              marginTop:  wrap2 && wrap2.style ? wrap2.style.marginTop  : '',
              overflow:   wrap2 && wrap2.style ? wrap2.style.overflow   : ''
            },
            originalEl: target2,
            replacedEl: null,
            movedEl: null,
            prevReplacedStyle: null
          };

          // 1) wrapの上余白/クリップを潰す
          if (wrap2 && wrap2.style) {
            wrap2.style.paddingTop = '0';
            wrap2.style.marginTop  = '0';
            wrap2.style.overflow   = 'hidden';
          }

          // 2) CANVASならPNG化して差し替え（競合比較もChart.jsなので効く）
          let visible2 = target2;
          if (target2.tagName === 'CANVAS' && window.Chart) {
            const cv2 = target2;
            const ch2 = (Chart.getChart ? Chart.getChart(cv2) : (cv2.__chart || cv2.chart || null));
            if (ch2) {
              try { if (ch2.options) { ch2.options.animation = false; ch2.options.animations = false; } } catch(_){}
              try { ch2.update('none'); } catch(_){}

              let dataUrl2 = '';
              try { dataUrl2 = (typeof ch2.toBase64Image === 'function') ? ch2.toBase64Image() : cv2.toDataURL('image/png'); } catch(_){}

              if (dataUrl2 && dataUrl2.startsWith('data:image/')) {
                const img2 = document.createElement('img');
                img2.src = dataUrl2;
                img2.alt = 'radar';
                img2.style.display = 'block';
                img2.style.width  = '100%';
                img2.style.height = 'auto';
                img2.style.margin = '0';

                cv2.replaceWith(img2);
                sw2.replacedEl = img2;
                visible2 = img2;
              }
            }
          }

          // 3) “見えている実体” の gap を測って上に詰める（あなたの 25px 調整込み）
          if (wrap2 && visible2 && wrap2.getBoundingClientRect && visible2.getBoundingClientRect) {
            const br2 = wrap2.getBoundingClientRect();
            const vr2 = visible2.getBoundingClientRect();
            const gap2 = Math.round(vr2.top - br2.top);

            sw2.prevReplacedStyle = {
              position: visible2.style ? visible2.style.position : '',
              top:      visible2.style ? visible2.style.top      : '',
              marginTop:visible2.style ? visible2.style.marginTop: ''
            };

            if (gap2 > 0 && visible2.style) {
              visible2.style.position = 'relative';
              visible2.style.marginTop = '0';
              const maxUp2 = Math.max(80, Math.round(br2.height - 20));
              const up2 = Math.min(gap2, maxUp2);
              visible2.style.top = (-(up2 - 25)) + 'px'; // ★ あなたの“ちょうど良かった”調整
            }

            sw2.movedEl = visible2;
            if (!sw2.replacedEl) sw2.replacedEl = visible2;
          }

          pushSwap(sw2);
        }
      }catch(_){}

      // 1フレ待ってレイアウト安定
      await nextFrame_();

      // html2canvas（★wrap方式は撤廃：このページ要素 el をそのままキャプチャ）
      const canvas = await h2c(el, {
        backgroundColor: '#ffffff',
        useCORS: true,
        allowTaint: true,
        scale: Math.min(2, (window.devicePixelRatio || 1)),
        logging: false
      });

      // cleanup（wrapは使っていない）

      // ★ 復元（clone内だけだが念のため）
      try{
        // 0) radarFix を戻す
        try{
          if (__radarFix && __radarFix.box && __radarFix.prev) {
            const b = __radarFix.box;
            const p = __radarFix.prev;
            b.style.height      = p.height;
            b.style.maxHeight   = p.maxHeight;
            b.style.aspectRatio = p.aspectRatio;
            b.style.display     = p.display;
            b.style.paddingTop  = p.paddingTop;
          }
        }catch(_){}

        // 1)〜3) の復元は “単体/配列どっちでも” 戻せるようにする
        try{
          const list = !__radarImgSwap ? [] : (Array.isArray(__radarImgSwap) ? __radarImgSwap : [__radarImgSwap]);

          list.forEach(sw => {
            if (!sw) return;

            // (1) CANVAS→IMG を戻す（CANVASだった時だけ）
            try{
              if (sw.originalEl && sw.replacedEl &&
                  sw.originalEl.tagName === 'CANVAS' && sw.replacedEl.tagName === 'IMG') {
                sw.replacedEl.replaceWith(sw.originalEl);
              }
            }catch(_){}

            // (2) wrap を戻す
            try{
              if (sw.wrap && sw.prevWrap && sw.wrap.style) {
                sw.wrap.style.paddingTop = sw.prevWrap.paddingTop;
                sw.wrap.style.marginTop  = sw.prevWrap.marginTop;
                sw.wrap.style.overflow   = sw.prevWrap.overflow;
              }
            }catch(_){}

            // (3) 動かした実体のstyleを戻す
            try{
              const v = sw.movedEl || sw.replacedEl;
              const p = sw.prevReplacedStyle;
              if (v && p && v.style) {
                v.style.position = p.position;
                v.style.top      = p.top;
                v.style.marginTop= p.marginTop;
              }
            }catch(_){}
          });
        }catch(_){}
      }catch(_){}

      // Convert to image
      const imgData = canvas.toDataURL('image/jpeg', 0.95);

      // Fit image to A4 width
      const imgPxW = canvas.width;
      const imgPxH = canvas.height;

      // Convert px aspect -> mm fit
      const imgMmW = pageW;
      const imgMmH = (imgPxH * imgMmW) / imgPxW;

      // --- header/footer reserved space (mm) ---
      // ★ 表紙(i===0)はヘッダ/フッタを出さない
      const HEADER_MM = (i === 0) ? 0 : 14;
      const FOOTER_MM = (i === 0) ? 0 : 12;
      const CONTENT_H = pageH - HEADER_MM - FOOTER_MM;

      // ★ ここで必ず宣言する（while より前）
      let remainingH = imgMmH;
      let offsetY = 0;

      // ★ 追加：スライスの重なり（mm）
      // まずは 3〜5mm で試すのが安全。文字がまだ切れるなら 7〜9mm に上げる。
      const OVERLAP_MM = 3; // ← 2 か 3。おすすめは 3

      // ★ 追加：次へ進む量（mm）= 1ページ分 - 重なり
      const STEP_MM = Math.max(1, CONTENT_H - OVERLAP_MM);

      while (remainingH > 0) {

        // ★ 中身（画像）自体をヘッダー分だけ下げる
        pdf.addImage(imgData, 'JPEG', 0, HEADER_MM - offsetY, imgMmW, imgMmH);

        // ★ 白帯：ヘッダ/フッタの領域は必ず白で確保（ヘッダ文字と画像の重なり防止）
        try{
          if (HEADER_MM || FOOTER_MM){
            pdf.setFillColor(255, 255, 255);

            // 上（ヘッダ余白）
            if (HEADER_MM) {
              pdf.rect(0, 0, pageW, HEADER_MM, 'F');
            }

            // 下（フッタ余白）
            if (FOOTER_MM) {
              pdf.rect(0, pageH - FOOTER_MM, pageW, FOOTER_MM, 'F');
            }
          }
        }catch(_){}

        // Header / Footer（英字固定）※表紙(i===0)では出さない
        if (i !== 0) {
          try{
            const pageNo = pdf.getNumberOfPages();

            pdf.setFontSize(9);
            pdf.text('AI Connect', 10, 8);

            pdf.setFontSize(9);
            pdf.text('FORK CORPORATION', 10, pageH - 6);

            pdf.setFontSize(9);
            pdf.text(String(pageNo), pageW - 10, pageH - 6, { align: 'right' });
          }catch(_){}
        }

        // // ★ 次のスライスへ
        // remainingH -= CONTENT_H;
        // offsetY += CONTENT_H;

        // ★ 次のスライスへ（OVERLAPあり：進みを少し小さくして、前ページ末尾を次ページ先頭に重ねる）
        const STEP_H = Math.max(1, CONTENT_H - (OVERLAP_MM || 0));
        remainingH -= STEP_H;
        offsetY    += STEP_H;

        // ✅ slice内の改ページ（これは必要）
        if (remainingH > 2) {
          pdf.addPage();

          // ===== Improve（画像）：2ページ目以降もタイトルを同位置に描く =====
          try{
            pdf.setFontSize(18);
            pdf.text('GEO診断', LEFT_MM, HEADER_MM + 12);

            pdf.setFontSize(14);
            pdf.text('改善ポイント', LEFT_MM, HEADER_MM + 20);
          }catch(_){}
        }
      }
      // ★ 次の .pdf-page に進むときだけ改ページ（空白ページ防止）
      if (i < pages.length - 1) pdf.addPage();
    }

    pdf.save(fname);
    try { if (!window.__PDF_DEBUG_KEEP_STAGE__) stage.remove(); } catch(_){}
  }

  // -------- helpers for renderPdfAndDownload_ --------
  function sanitizeFilePart_(s){
    return String(s || '')
      .trim()
      .replace(/[\\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 40);
  }

  function formatDateFileYmd_(d){
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}${mm}${dd}`;
  }

  function nextFrame_(){
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  // =========================================================
  // 7) Loader / Toast helpers (safe no-op)
  // =========================================================
  function loaderOn_(message){
    try{
      const TITLE = String(message || 'PDFを生成しています');
      const DESC  = 'この処理は数十秒で終わります\n画面を閉じずにお待ちください';

      // ✅ AIO共通の全画面ローダー（最優先）
      try{
        if (typeof window.__AIO_GLOBAL_LOADER_SHOW__ === 'function'){
          window.__AIO_GLOBAL_LOADER_SHOW__('pdf', TITLE, DESC);
          return;
        }
      }catch(_){}

      // 既存互換（環境によってはある）
      if (typeof window.showGlobalLoader === 'function') return window.showGlobalLoader(message);
      if (typeof window.globalLoaderOn === 'function') return window.globalLoaderOn(message);

      // no-op fallback（UIは増やさない）
    }catch(e){
      console.warn('[PDF][v1] loaderOn_ failed', e);
    }
  }

  function loaderOff_(){
    try{
      // ✅ AIO共通の全画面ローダー（最優先）
      try{
        if (typeof window.__AIO_GLOBAL_LOADER_HIDE__ === 'function'){
          // key指定が必要な実装・不要な実装どちらも吸収
          try { window.__AIO_GLOBAL_LOADER_HIDE__('pdf'); } catch(_) { window.__AIO_GLOBAL_LOADER_HIDE__(); }
          return;
        }
      }catch(_){}

      // 既存互換
      if (typeof window.hideGlobalLoader === 'function') return window.hideGlobalLoader();
      if (typeof window.globalLoaderOff === 'function') return window.globalLoaderOff();

      // no-op fallback（UIは増やさない）
    }catch(e){
      console.warn('[PDF][v1] loaderOff_ failed', e);
    }
  }

  function toast_(msg){
    try{
      if (typeof window.toast === 'function') return window.toast(msg);
      // Minimal fallback
      console.log('[PDF][toast]', msg);
    }catch(_){}
  }

  // =========================================================
  // 8) Cleanup
  // =========================================================
  function cleanup_(){
    document.getElementById(PRINT_ROOT_ID)?.remove();
    document.getElementById(MODAL_ID)?.remove();
  }

  // =========================================================
  // 9) Getters (v1 best-effort)
  // =========================================================
  function getActiveOrigin_(){
    // Priority order: active variables -> storage -> res/snapshot -> location
    let o = '';

    // 1) 明示変数（最強）
    try{
      o = String(window.__AIO_ACTIVE_ORIGIN__ || '').trim();
      if (o) return normalizeOrigin_(o);
    }catch(_){}

    // 2) storage（ピッカー復元がここに入る想定）
    const keys = ['aio:activeOrigin','aio:lastOrigin'];
    for (const k of keys){
      try{
        const v = String(localStorage.getItem(k) || '').trim();
        if (v) return normalizeOrigin_(v);
      }catch(_){}
    }
    try{
      const v = String(sessionStorage.getItem('aio:lastOrigin') || '').trim();
      if (v) return normalizeOrigin_(v);
    }catch(_){}

    // 3) 直近res（揺れ救済：あなたの実装で実際に使われてる名前も拾う）
    try{
      const r =
        window.__AIO_LAST_RES__ ||
        window.__AIO_LAST_SS_RES__ ||
        window.__AIO_DEBUG_LAST_SS_RESULT ||
        window.__AIO_LATEST_RES__ ||
        window.__LATEST_DIAG_RES__ ||
        null;

      if (r && (r.siteOrigin || r.origin)) return normalizeOrigin_(r.siteOrigin || r.origin);
    }catch(_){}

    // 4) snapshot（PDF時に一番取りやすい：SS保存の単一情報源）
    try{
      const snapRaw = localStorage.getItem('aio:snapshot:v1');
      if (snapRaw){
        const snap = JSON.parse(snapRaw);
        const so = snap && (snap.siteOrigin || snap.origin);
        if (so) return normalizeOrigin_(so);
      }
    }catch(_){}

    // 5) 最後：画面自身のorigin（GASのオリジンは normalizeOrigin_ で弾かれる可能性がある）
    try{
      const lo = String(location.origin || '').trim();
      const n  = normalizeOrigin_(lo);
      return n || ''; // ← normalize が弾いたら空のまま（誤って googleusercontent を採用しない）
    }catch(_){
      return '';
    }
  }

  function getSiteTypeLabel_(){
    function normalizeCode_(siteType){
      try{
        if (typeof normalizeSiteTypeCode_ === 'function'){
          const code = String(normalizeSiteTypeCode_(siteType) || '').trim().toLowerCase();
          if (code === 'corp') return 'corporate';
          if (code === 'ec' || code === 'media' || code === 'saas') return code;
        }
      }catch(_){}

      try{
        if (!siteType) return '';
        if (typeof siteType === 'string'){
          const s = siteType.trim().toLowerCase();
          if (s === 'corp' || s === 'corporate') return 'corporate';
          if (s === 'ec' || s === 'ecommerce') return 'ec';
          if (s === 'media' || s === 'news') return 'media';
          if (s === 'saas' || s === 'service') return 'saas';
          return '';
        }
        if (typeof siteType === 'object'){
          if (siteType.isSaaSOrService) return 'saas';
          if (siteType.isEC) return 'ec';
          if (siteType.isMedia) return 'media';
          if (siteType.isCorporate) return 'corporate';
        }
      }catch(_){}
      return '';
    }

    function pickFromContainer_(obj){
      try{
        if (!obj || typeof obj !== 'object') return '';
        const code =
          normalizeCode_(obj.siteType) ||
          normalizeCode_(obj.rawSiteType) ||
          normalizeCode_(obj.siteMode) ||
          normalizeCode_(obj.meta && obj.meta.siteType) ||
          normalizeCode_(obj.meta && obj.meta.rawSiteType) ||
          normalizeCode_(obj.meta && obj.meta.siteMode);
        if (code) return code;

        const snap =
          (obj.snapshot && typeof obj.snapshot === 'object') ? obj.snapshot :
          (obj.snapshotJSON && typeof obj.snapshotJSON === 'object') ? obj.snapshotJSON :
          (obj.snap && typeof obj.snap === 'object') ? obj.snap :
          null;
        if (!snap) return '';
        return (
          normalizeCode_(snap.siteType) ||
          normalizeCode_(snap.rawSiteType) ||
          normalizeCode_(snap.siteMode) ||
          normalizeCode_(snap.diagnosis && snap.diagnosis.siteType) ||
          normalizeCode_(snap.diagnosis && snap.diagnosis.rawSiteType) ||
          normalizeCode_(snap.diagnosis && snap.diagnosis.siteMode)
        );
      }catch(_){}
      return '';
    }

    try{
      const detailCandidates = [
        window.__AIO_LAST_RES__,
        window.__AIO_LAST_SS_RES__,
        window.__AIO_DEBUG_LAST_SS_RESULT
      ];
      for (const r of detailCandidates){
        const code = pickFromContainer_(r);
        if (code) return code;
      }
    }catch(_){}

    try{
      const snapRaw = localStorage.getItem('aio:snapshot:v1');
      if (snapRaw){
        const snap = JSON.parse(snapRaw);
        const code = pickFromContainer_(snap);
        if (code) return code;
      }
    }catch(_){}

    try{
      const latestCandidates = [
        window.__AIO_LATEST_RES__,
        window.__LATEST_DIAG_RES__,
        window.__AIO_LATEST_RESULT__
      ];
      for (const r of latestCandidates){
        const code = pickFromContainer_(r);
        if (code) return code;
      }
    }catch(_){}

    return '';
  }

  function getDiagnosisDateText_(){
    try{
      const r = window.__AIO_LATEST_RES__ || window.__LATEST_DIAG_RES__ || null;
      const d = (r && (r.dateJST || (r.meta && r.meta.dateJST))) || '';
      if (d) return String(d);
    }catch(_){}
    return '';
  }

  function getAuthorName_(){
    // Optional. If you already have a constant somewhere, return it.
    // v1: empty is OK.
    return '';
  }

  function normalizeOrigin_(s){
    let t = String(s||'').trim();
    t = t.replace(/\/+$/,''); // drop trailing slash
    return t;
  }

  function formatDateYmd_(d){
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}年${mm}月${dd}日`;
  }

  // =========================================================
  // 10) Utilities
  // =========================================================
  function htmlToEl_(html){
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '').trim();

    // 1要素ならその要素を返す（従来互換）
    const els = Array.from(tpl.content.children || []);
    if (els.length === 1) return els[0];

    // 複数要素ならラッパーDIVにまとめて返す（ここが修正点）
    const wrap = document.createElement('div');
    wrap.style.display = 'block';
    while (tpl.content.firstChild) wrap.appendChild(tpl.content.firstChild);
    return wrap;
  }

  function escapeHtml_(s){
    return String(s ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'","&#39;");
  }

  (function bindPdfButtonOnce(){
    if (window.__PDF_EXPORT_V1_BOUND__) return;
    window.__PDF_EXPORT_V1_BOUND__ = true;

    const btn = document.getElementById('btnShare');
    if (!btn) {
      console.warn('[PDF][v1] #btnShare not found');
      return;
    }

    btn.addEventListener('click', function(ev){
      ev.preventDefault();
      if (typeof window.runPdfExportV1 === 'function') {
        window.runPdfExportV1();
      } else {
        console.warn('[PDF][v1] runPdfExportV1 is not ready');
      }
    }, { passive: false });
  })();

})();
</script>
