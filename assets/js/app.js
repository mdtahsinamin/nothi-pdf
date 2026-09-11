(function () {
  "use strict";

    
  // Font choices offered in the floating toolbar. Both are self-contained embedded TTFs (no
  // network font dependency at all -- matters for reliability across many viewers on varied
  // connections) with real GSUB/GPOS Bengali shaping tables, verified end-to-end (on-screen AND
  // in the exported PDF) to handle mixed Bangla+English text correctly. Noto Sans Bengali was
  // tried first but dropped: its standalone TTF has no Latin glyphs at all, so any English text
  // in a box would export as tofu boxes.
  const FONT_LIBRARY = {
    hind: { label: "Hind Siliguri", cssFamily: "'Hind Siliguri', 'Nirmala UI', 'Vrinda', system-ui, sans-serif", hasBold: true },
    kalpurush: { label: "Kalpurush", cssFamily: "'Kalpurush', 'Nirmala UI', 'Vrinda', system-ui, sans-serif", hasBold: false },
    // Times New Roman itself is proprietary (Microsoft) and can't legally be embedded/redistributed
    // here -- Tinos is Google's own open, metric-compatible replacement for it (same substitution
    // LibreOffice makes), so English text gets that familiar serif look without a license problem.
    tinos: { label: "Tinos (Times New Roman স্টাইল)", cssFamily: "'Tinos', 'Times New Roman', serif", hasBold: true },
  };

  // Build @font-face rules from the SAME base64 bytes already needed for PDF export, instead of
  // also writing them into <style> as static text -- keeps a ~1MB blob from existing twice in
  // this file. font-display:block (not swap) is safe here specifically because the data is
  // already fully in memory (no network wait), so there is nothing to show a fallback font for.
  function injectFontFace(family, weight, b64) {
    const style = document.createElement("style");
    style.textContent =
      "@font-face { font-family: '" + family + "'; font-weight: " + weight +
      "; font-style: normal; font-display: block; " +
      "src: url(data:font/ttf;base64," + b64 + ") format('truetype'); }";
    document.head.appendChild(style);
  }
  injectFontFace("Hind Siliguri", 400, FONT_REGULAR_B64);
  injectFontFace("Hind Siliguri", 700, FONT_BOLD_B64);
  injectFontFace("Kalpurush", 400, KALPURUSH_B64);
  injectFontFace("Tinos", 400, TINOS_REGULAR_B64);
  injectFontFace("Tinos", 700, TINOS_BOLD_B64);

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // Kick this off immediately (don't wait for a click) so the network fetch has the most possible
  // head start; handleFile() below still awaits it before the editor opens, so typing can never
  // race ahead of the font actually being ready. Wrapped defensively: if document.fonts is
  // unavailable/blocked in this viewer, or the load hangs, the rest of the app must still work.
  function bnFontDelay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  let BN_FONT_READY;
  try {
    BN_FONT_READY = (document.fonts && document.fonts.load)
      ? Promise.race([
          Promise.all([
            document.fonts.load("400 16px 'Hind Siliguri'"),
            document.fonts.load("700 16px 'Hind Siliguri'"),
            document.fonts.load("400 16px 'Kalpurush'"),
            document.fonts.load("400 16px 'Tinos'"),
            document.fonts.load("700 16px 'Tinos'"),
          ]).catch(() => {}),
          bnFontDelay(2500),
        ])
      : Promise.resolve();
  } catch (err) {
    BN_FONT_READY = Promise.resolve();
  }

  const els = {
    btnHome: document.getElementById("btnHome"),
    fileInput: document.getElementById("fileInput"),
    btnUpload: document.getElementById("btnUpload"),
    btnUpload2: document.getElementById("btnUpload2"),
    uploadLabel: document.getElementById("uploadLabel"),
    sidebar: document.getElementById("sidebar"),
    stageWrap: document.getElementById("stageWrap"),
    emptyState: document.getElementById("emptyState"),
    stage: document.getElementById("stage"),
    loadingOverlay: document.getElementById("loadingOverlay"),
    loadingText: document.getElementById("loadingText"),
    canvas: document.getElementById("pdfCanvas"),
    overlay: document.getElementById("overlay"),
    floatingBar: document.getElementById("floatingBar"),
    statusBar: document.getElementById("statusBar"),
    toolSelect: document.getElementById("toolSelect"),
    toolText: document.getElementById("toolText"),
    btnPrev: document.getElementById("btnPrev"),
    btnNext: document.getElementById("btnNext"),
    pageNum: document.getElementById("pageNum"),
    pageCount: document.getElementById("pageCount"),
    btnZoomOut: document.getElementById("btnZoomOut"),
    btnZoomIn: document.getElementById("btnZoomIn"),
    zoomLabel: document.getElementById("zoomLabel"),
    fbFontSize: document.getElementById("fbFontSize"),
    fbFontDown: document.getElementById("fbFontDown"),
    fbFontUp: document.getElementById("fbFontUp"),
    fbFont: document.getElementById("fbFont"),
    fbAutoFont: document.getElementById("fbAutoFont"),
    fbBold: document.getElementById("fbBold"),
    fbColor: document.getElementById("fbColor"),
    fbMove: document.getElementById("fbMove"),
    fbDuplicate: document.getElementById("fbDuplicate"),
    fbDelete: document.getElementById("fbDelete"),
    btnDownload: document.getElementById("btnDownload"),

    modalBackdrop: document.getElementById("modalBackdrop"),
    mergeModal: document.getElementById("mergeModal"),
    mergeAddBtn: document.getElementById("mergeAddBtn"),
    mergeFileInput: document.getElementById("mergeFileInput"),
    mergeFileList: document.getElementById("mergeFileList"),
    mergeCancelBtn: document.getElementById("mergeCancelBtn"),
    mergeRunBtn: document.getElementById("mergeRunBtn"),
    compressModal: document.getElementById("compressModal"),
    compressAddBtn: document.getElementById("compressAddBtn"),
    compressFileInput: document.getElementById("compressFileInput"),
    compressFileName: document.getElementById("compressFileName"),
    compressQuality: document.getElementById("compressQuality"),
    compressQualityLabel: document.getElementById("compressQualityLabel"),
    compressCancelBtn: document.getElementById("compressCancelBtn"),
    compressRunBtn: document.getElementById("compressRunBtn"),
    guideV: document.getElementById("guideV"),
    guideH: document.getElementById("guideH"),

    btnToolsHub: document.getElementById("btnToolsHub"),
    toolsHubModal: document.getElementById("toolsHubModal"),
    hubOpenMerge: document.getElementById("hubOpenMerge"),
    hubOpenCompress: document.getElementById("hubOpenCompress"),
    hubOpenPhoto: document.getElementById("hubOpenPhoto"),
    hubOpenSign: document.getElementById("hubOpenSign"),
    hubOpenImgToPdf: document.getElementById("hubOpenImgToPdf"),
    hubOpenPageMgr: document.getElementById("hubOpenPageMgr"),
    hubOpenStamp: document.getElementById("hubOpenStamp"),
    hubCancelBtn: document.getElementById("hubCancelBtn"),

    photoStudioModal: document.getElementById("photoStudioModal"),
    psAddBtn: document.getElementById("psAddBtn"),
    psFileInput: document.getElementById("psFileInput"),
    psBody: document.getElementById("psBody"),
    psCanvas: document.getElementById("psCanvas"),
    psPreset: document.getElementById("psPreset"),
    psCustomRow: document.getElementById("psCustomRow"),
    psCustomW: document.getElementById("psCustomW"),
    psCustomH: document.getElementById("psCustomH"),
    psZoom: document.getElementById("psZoom"),
    psBg: document.getElementById("psBg"),
    psRemoveBg: document.getElementById("psRemoveBg"),
    psSensRow: document.getElementById("psSensRow"),
    psSensitivity: document.getElementById("psSensitivity"),
    psQuality: document.getElementById("psQuality"),
    psQualityLabel: document.getElementById("psQualityLabel"),
    psRemoveNote: document.getElementById("psRemoveNote"),
    psCancelBtn: document.getElementById("psCancelBtn"),
    psDownloadBtn: document.getElementById("psDownloadBtn"),

    signPadModal: document.getElementById("signPadModal"),
    signCanvas: document.getElementById("signCanvas"),
    signClearBtn: document.getElementById("signClearBtn"),
    signCancelBtn: document.getElementById("signCancelBtn"),
    signDownloadPngBtn: document.getElementById("signDownloadPngBtn"),
    signDownloadJpgBtn: document.getElementById("signDownloadJpgBtn"),

    imgToPdfModal: document.getElementById("imgToPdfModal"),
    i2pAddBtn: document.getElementById("i2pAddBtn"),
    i2pFileInput: document.getElementById("i2pFileInput"),
    i2pFileList: document.getElementById("i2pFileList"),
    i2pCancelBtn: document.getElementById("i2pCancelBtn"),
    i2pRunBtn: document.getElementById("i2pRunBtn"),

    pageMgrModal: document.getElementById("pageMgrModal"),
    pmAddBtn: document.getElementById("pmAddBtn"),
    pmFileInput: document.getElementById("pmFileInput"),
    pmGrid: document.getElementById("pmGrid"),
    pmSplitRow: document.getElementById("pmSplitRow"),
    pmSplitRange: document.getElementById("pmSplitRange"),
    pmSplitBtn: document.getElementById("pmSplitBtn"),
    pmCancelBtn: document.getElementById("pmCancelBtn"),
    pmApplyBtn: document.getElementById("pmApplyBtn"),

    stampModal: document.getElementById("stampModal"),
    stAddBtn: document.getElementById("stAddBtn"),
    stFileInput: document.getElementById("stFileInput"),
    stFileName: document.getElementById("stFileName"),
    stWmEnable: document.getElementById("stWmEnable"),
    stWmSub: document.getElementById("stWmSub"),
    stWmText: document.getElementById("stWmText"),
    stWmOpacity: document.getElementById("stWmOpacity"),
    stPnEnable: document.getElementById("stPnEnable"),
    stPnSub: document.getElementById("stPnSub"),
    stPnPos: document.getElementById("stPnPos"),
    stDtEnable: document.getElementById("stDtEnable"),
    stDtSub: document.getElementById("stDtSub"),
    stDtPos: document.getElementById("stDtPos"),
    stCancelBtn: document.getElementById("stCancelBtn"),
    stRunBtn: document.getElementById("stRunBtn"),
    btnThemeToggle: document.getElementById("btnThemeToggle"),
  };

  // ---------------------------------------------------------------- theme (light/dark, explicit toggle)
  // Absence of data-theme means "follow the OS setting" (the CSS already handles that via
  // prefers-color-scheme) -- only written once the user actually picks a side, so switching OS
  // theme still works for anyone who never touches the toggle.
  const THEME_KEY = "nothi_theme";
  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function isDarkActive() {
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "dark") return true;
    if (explicit === "light") return false;
    return systemPrefersDark();
  }
  function updateThemeToggleIcon() {
    els.btnThemeToggle.textContent = isDarkActive() ? "☀️" : "\u{1F319}";
  }
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    updateThemeToggleIcon();
  }
  (function initTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") applyTheme(saved);
      else updateThemeToggleIcon();
    } catch (err) {
      updateThemeToggleIcon();
    }
  })();
  els.btnThemeToggle.addEventListener("click", () => {
    const next = isDarkActive() ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* private mode etc -- fine, just won't persist */ }
  });

  // ---------------------------------------------------------------- landing: tabbed showcase
  const showcaseImg = document.getElementById("showcaseImg");
  const showcaseDesc = document.getElementById("showcaseDesc");
  document.querySelectorAll(".showcase-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      document.querySelectorAll(".showcase-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      showcaseImg.classList.add("fading");
      setTimeout(() => {
        showcaseImg.src = btn.dataset.img;
        showcaseImg.classList.remove("fading");
      }, 150);
      showcaseDesc.textContent = btn.dataset.desc;
    });
  });

  const state = {
    pdfBytes: null,
    pdfDoc: null,
    numPages: 0,
    currentPage: 1,
    scale: 1.2,
    baseScale: 1.2,
    viewport: null,
    boxes: [],
    selectedId: null,
    nextId: 1,
    pendingFocusId: null,
    dragging: null,
    mode: "text",
    deletedRestoredBoxes: [],   // _orig snapshots of restored boxes the user then removed/emptied
  };

  function b64ToUint8Array(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function hexToRgb01(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#1a1a1a") || [];
    return {
      r: parseInt(m[1] || "1a", 16) / 255,
      g: parseInt(m[2] || "1a", 16) / 255,
      b: parseInt(m[3] || "1a", 16) / 255,
    };
  }

  // ---------------------------------------------------------------- tool mode
  function setMode(mode) {
    state.mode = mode;
    els.toolSelect.classList.toggle("active", mode === "select");
    els.toolText.classList.toggle("active", mode === "text");
    els.overlay.classList.toggle("mode-text", mode === "text");
    els.overlay.classList.toggle("mode-select", mode === "select");
  }
  els.toolSelect.addEventListener("click", () => setMode("select"));
  els.toolText.addEventListener("click", () => setMode("text"));

  // ---------------------------------------------------------------- upload
  function openPicker() { els.fileInput.click(); }
  els.btnUpload.addEventListener("click", openPicker);
  els.btnUpload2.addEventListener("click", openPicker);

  // Clicking the logo returns to the landing page -- standard "click the brand to go home"
  // convention that was simply missing (the brand mark had no click handler at all before this).
  function goHome() {
    if (state.pdfBytes && state.boxes.length) {
      const ok = confirm("হোম পেজে ফিরে গেলে বর্তমান এডিট মুছে যাবে। চালিয়ে যাবেন?");
      if (!ok) return;
    }
    state.pdfBytes = null;
    state.pdfDoc = null;
    state.numPages = 0;
    state.currentPage = 1;
    state.boxes = [];
    state.selectedId = null;
    state.deletedRestoredBoxes = [];
    hideFloatingBar();
    els.stage.style.display = "none";
    els.statusBar.style.display = "none";
    els.sidebar.style.display = "none";
    els.sidebar.innerHTML = "";
    els.btnDownload.disabled = true;
    els.uploadLabel.textContent = "PDF আপলোড";
    els.emptyState.style.display = "";
    setMode("text");
  }
  els.btnHome.addEventListener("click", goHome);
  els.fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    e.target.value = "";
  });
  ["dragover", "dragleave", "drop"].forEach((evt) => {
    els.emptyState.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragover") els.emptyState.classList.add("dragover");
      if (evt === "dragleave") els.emptyState.classList.remove("dragover");
      if (evt === "drop") {
        els.emptyState.classList.remove("dragover");
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && f.type === "application/pdf") handleFile(f);
      }
    });
  });

  function showLoading(text) {
    els.loadingText.textContent = text;
    els.loadingOverlay.classList.add("visible");
  }
  function hideLoading() {
    els.loadingOverlay.classList.remove("visible");
  }

  async function handleFile(file) {
    if (state.pdfBytes && state.boxes.length) {
      const ok = confirm("নতুন PDF লোড করলে বর্তমান এডিট মুছে যাবে। চালিয়ে যাবেন?");
      if (!ok) return;
    }
    // Covers the whole load -- font readiness, pdf.js parsing, and restoring any previously-saved
    // box data -- since a several-hundred-KB scanned PDF can take a real, visible moment here and
    // the page previously gave zero feedback during it (looked hung, not busy).
    showLoading("PDF লোড হচ্ছে...");
    try {
      await BN_FONT_READY;
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let doc;
      try {
        doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      } catch (err) {
        console.error(err);
        showToast("এই PDF ফাইলটি খোলা যায়নি — এটা পাসওয়ার্ড-সুরক্ষিত অথবা ক্ষতিগ্রস্ত হতে পারে।", "error");
        return;
      }
      state.pdfBytes = bytes;
      state.pdfDoc = doc;
      state.numPages = state.pdfDoc.numPages;
      state.currentPage = 1;
      state.scale = state.baseScale;
      state.boxes = [];
      state.selectedId = null;
      state.deletedRestoredBoxes = [];

      // If this PDF was exported by Nothi before, its text boxes are embedded inside it (see the
      // download handler) -- restore them so editing continues exactly where it left off. Any other
      // PDF (never touched by Nothi) simply has no such object, so this quietly does nothing.
      // Two DIFFERENT failure modes are surfaced with a visible alert (not just a silent console
      // log) rather than folded into one generic catch -- "this PDF has no saved data" is normal
      // and expected for a first-ever upload, but "found the data and still failed" is a real bug
      // worth seeing immediately instead of guessing blind.
      try {
        const metaDoc = await PDFLib.PDFDocument.load(bytes.slice());
        const ref = metaDoc.catalog.get(PDFLib.PDFName.of("NothiProjectData"));
        if (ref) {
          try {
            const streamObj = metaDoc.context.lookup(ref);
            const contents = streamObj.getContents ? streamObj.getContents() : streamObj.contents;
            const payload = JSON.parse(new TextDecoder().decode(contents));
            if (payload && Array.isArray(payload.boxes)) {
              state.boxes = payload.boxes.map((b) => {
                const restored = { ...b, id: state.nextId++ };
                restored._orig = { xPdf: b.xPdf, yTopPdf: b.yTopPdf, widthPdf: b.widthPdf,
                                    fontSize: b.fontSize, text: b.text, bold: b.bold,
                                    fontKey: b.fontKey, autoFont: b.autoFont };
                return restored;
              });
              console.log(`[Nothi] restored ${state.boxes.length} text box(es) from this PDF's saved data.`);
            } else {
              showToast("এই PDF-এ Nothi-এর সেভ করা তথ্য পাওয়া গেছে, কিন্তু তার ভেতরে box তালিকা নেই -- ফাঁকা অবস্থা থেকে শুরু করা হচ্ছে।", "info");
            }
          } catch (innerErr) {
            console.error("[Nothi] found saved project data but couldn't read it:", innerErr);
            showToast("এই PDF-এ আগের এডিট করা তথ্য পাওয়া গেছে, কিন্তু পড়া যায়নি: " + innerErr.message, "error");
          }
        } else {
          console.log("[Nothi] this PDF has no saved Nothi data (first upload, or an unrelated PDF) -- starting fresh.");
        }
      } catch (err) {
        console.error("[Nothi] couldn't check this PDF for restorable data:", err);
        showToast("এই PDF থেকে আগের এডিট তথ্য চেক করতে সমস্যা হয়েছে: " + err.message + " -- ফাঁকা অবস্থা থেকে শুরু করা হচ্ছে।", "error");
      }

      els.uploadLabel.textContent = "নতুন PDF";
      els.emptyState.style.display = "none";
      els.stage.style.display = "block";
      els.statusBar.style.display = "flex";
      els.sidebar.style.display = "flex";
      els.btnDownload.disabled = false;
      setMode("text");
      hideFloatingBar();
      // Sized to fit only AFTER the stage/sidebar are visible -- measuring before that reads a
      // stale (empty-state) width and lands on the wrong scale.
      await fitPageToViewport();
      await renderPage();
      await renderThumbnails();
    } finally {
      hideLoading();
    }
  }

  // ---------------------------------------------------------------- render
  // Picks the opening zoom so the whole first page is visible instead of starting at a fixed 1.2x
  // and dumping the user onto a page already running off both the bottom and (on a phone) the
  // sides. Becomes the new 100% reference, so "100%" now means "fits the window".
  async function fitPageToViewport() {
    try {
      const page = await state.pdfDoc.getPage(state.currentPage);
      const vp = page.getViewport({ scale: 1 });
      const cs = getComputedStyle(els.stageWrap);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const availW = els.stageWrap.clientWidth - padX;
      const availH = els.stageWrap.clientHeight - padY;
      if (!(availW > 0 && availH > 0)) return;
      const fit = Math.min(availW / vp.width, availH / vp.height);
      if (!isFinite(fit) || fit <= 0) return;
      state.baseScale = Math.max(0.2, Math.min(fit, 3));
      state.scale = state.baseScale;
    } catch (err) {
      // measuring failed for some reason -- keep whatever scale is already set rather than
      // blocking the document from opening at all
      console.warn("[Nothi] couldn't auto-fit the page, using the default zoom.", err);
    }
  }

  async function renderPage() {
    const page = await state.pdfDoc.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: state.scale });
    state.viewport = viewport;

    const outputScale = window.devicePixelRatio || 1;
    els.canvas.width = Math.floor(viewport.width * outputScale);
    els.canvas.height = Math.floor(viewport.height * outputScale);
    els.canvas.style.width = viewport.width + "px";
    els.canvas.style.height = viewport.height + "px";
    els.stage.style.width = viewport.width + "px";
    els.stage.style.height = viewport.height + "px";

    const ctx = els.canvas.getContext("2d");
    ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

    els.pageNum.textContent = String(state.currentPage);
    els.pageCount.textContent = String(state.numPages);
    els.zoomLabel.textContent = Math.round((state.scale / state.baseScale) * 100) + "%";
    els.btnPrev.disabled = state.currentPage <= 1;
    els.btnNext.disabled = state.currentPage >= state.numPages;

    renderBoxes();
    updateThumbActive();
  }

  async function renderThumbnails() {
    els.sidebar.innerHTML = "";
    for (let i = 1; i <= state.numPages; i++) {
      const wrap = document.createElement("div");
      wrap.className = "thumb" + (i === state.currentPage ? " active" : "");
      wrap.dataset.page = String(i);
      const canvas = document.createElement("canvas");
      const label = document.createElement("div");
      label.className = "thumb-label mono";
      label.textContent = String(i);
      wrap.appendChild(canvas);
      wrap.appendChild(label);
      els.sidebar.appendChild(wrap);
      wrap.addEventListener("click", async () => {
        if (state.currentPage === i) return;
        state.currentPage = i;
        selectBox(null);
        await renderPage();
      });

      const page = await state.pdfDoc.getPage(i);
      const baseVp = page.getViewport({ scale: 1 });
      const thumbScale = 108 / baseVp.width;
      const vp = page.getViewport({ scale: thumbScale });
      const tOutputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * tOutputScale);
      canvas.height = Math.floor(vp.height * tOutputScale);
      canvas.style.width = vp.width + "px";
      canvas.style.height = vp.height + "px";
      const tctx = canvas.getContext("2d");
      tctx.setTransform(tOutputScale, 0, 0, tOutputScale, 0, 0);
      await page.render({ canvasContext: tctx, viewport: vp }).promise;
    }
  }
  function updateThumbActive() {
    els.sidebar.querySelectorAll(".thumb").forEach((t) => {
      t.classList.toggle("active", Number(t.dataset.page) === state.currentPage);
    });
  }

  function pdfToCss(xPdf, yPdf) {
    const p = state.viewport.convertToViewportPoint(xPdf, yPdf);
    return { x: p[0], y: p[1] };
  }
  function cssToPdf(xCss, yCss) {
    const p = state.viewport.convertToPdfPoint(xCss, yCss);
    return { x: p[0], y: p[1] };
  }

  function autoResizeTextarea(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  function renderBoxes() {
    els.overlay.querySelectorAll(".textbox").forEach((n) => n.remove());
    state.boxes
      .filter((b) => b.page === state.currentPage)
      .forEach((box) => {
        const el = buildBoxEl(box);
        els.overlay.appendChild(el);
        const ta = el.querySelector(".tb-content");
        if (ta) autoResizeTextarea(ta);
      });
    if (state.selectedId != null) {
      const box = state.boxes.find((b) => b.id === state.selectedId);
      if (box && box.page === state.currentPage) positionFloatingBar(box);
      else hideFloatingBar();
    }
  }

  function buildBoxEl(box) {
    const pos = pdfToCss(box.xPdf, box.yTopPdf);
    const div = document.createElement("div");
    div.className = "textbox" + (box.id === state.selectedId ? " selected" : "");
    div.dataset.id = String(box.id);
    div.style.left = pos.x + "px";
    div.style.top = pos.y + "px";
    div.style.width = box.widthPdf * state.scale + "px";

    const del = document.createElement("div");
    del.className = "tb-del";
    del.textContent = "×";
    del.title = "মুছুন";

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "tb-resize";
    resizeHandle.title = "টেনে চৌড়া বাড়ান/কমান";

    // A real <textarea> (not a contenteditable div) -- contenteditable has long-standing,
    // browser-inconsistent bugs with IME/composition-based input, which is exactly how complex
    // scripts like Bangla get typed (phonetic layouts such as Avro, or any layout that has to
    // reorder a matra/vowel-sign around the consonant it attaches to). A native form control's
    // composition handling is what every browser actually tests and ships correctly.
    const content = document.createElement("textarea");
    content.className = "tb-content";
    content.rows = 1;
    content.spellcheck = false;
    content.placeholder = "টাইপ করুন...";
    content.style.fontSize = box.fontSize * state.scale + "px";
    content.style.fontWeight = box.bold ? "700" : "400";
    content.style.color = box.color;
    content.style.fontFamily = (FONT_LIBRARY[box.fontKey] || FONT_LIBRARY.hind).cssFamily;
    content.value = box.text || "";

    content.addEventListener("input", () => { box.text = content.value; autoResizeTextarea(content); });
    content.addEventListener("focus", () => selectBox(box.id));
    content.addEventListener("pointerdown", (e) => e.stopPropagation());
    content.addEventListener("blur", (e) => {
      const goingTo = e.relatedTarget;
      if (goingTo && els.floatingBar.contains(goingTo)) return;   // still using this box's own toolbar
      setTimeout(() => {
        const active = document.activeElement;
        if (active === content || els.floatingBar.contains(active)) return;
        if (!box.text || !box.text.trim()) {
          discardIfEmpty(box);
        } else if (state.selectedId === box.id) {
          selectBox(null);
        }
      }, 150);
    });

    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteBox(box.id); });

    resizeHandle.addEventListener("pointerdown", (e) => startResize(e, box, div));

    div.addEventListener("pointerdown", (e) => {
      if (e.target !== div) return;
      e.preventDefault();
      startDrag(e, box, div);
    });

    div.appendChild(del);
    div.appendChild(resizeHandle);
    div.appendChild(content);

    if (box.id === state.pendingFocusId) {
      state.pendingFocusId = null;
      requestAnimationFrame(() => content.focus());
    }
    return div;
  }

  // ---------------------------------------------------------------- select / floating bar
  function selectBox(id) {
    state.selectedId = id;
    els.overlay.querySelectorAll(".textbox").forEach((n) => {
      n.classList.toggle("selected", n.dataset.id === String(id));
    });
    const box = id == null ? null : state.boxes.find((b) => b.id === id);
    if (!box) { hideFloatingBar(); return; }
    els.fbFontSize.value = box.fontSize;
    els.fbBold.classList.toggle("active", !!box.bold);
    els.fbColor.value = box.color;
    els.fbFont.value = box.fontKey || "hind";
    els.fbAutoFont.classList.toggle("active", !!box.autoFont);
    positionFloatingBar(box);
  }
  function hideFloatingBar() { els.floatingBar.style.display = "none"; }
  function positionFloatingBar(box) {
    const pos = pdfToCss(box.xPdf, box.yTopPdf);
    els.floatingBar.style.display = "flex";
    const barH = els.floatingBar.offsetHeight || 36;
    const barW = els.floatingBar.offsetWidth || 190;
    let top = pos.y - barH - 8;
    if (top < 4) top = pos.y + box.fontSize * state.scale + 8;
    let left = Math.max(4, Math.min(pos.x, els.overlay.clientWidth - barW - 4));
    els.floatingBar.style.top = top + "px";
    els.floatingBar.style.left = left + "px";
  }

  function deleteBox(id) {
    const box = state.boxes.find((b) => b.id === id);
    if (box && box._orig) state.deletedRestoredBoxes.push(box._orig);
    state.boxes = state.boxes.filter((b) => b.id !== id);
    if (state.selectedId === id) { state.selectedId = null; hideFloatingBar(); }
    renderBoxes();
  }

  // Sejda-style behavior: a box you clicked into but never typed anything in disappears the
  // moment you click away, instead of leaving an empty box sitting on the page forever (export
  // already silently skips empty boxes -- see the download handler -- so keeping one around in
  // the editor was pure clutter with no upside). Surgical removal only -- see comment above.
  function discardIfEmpty(box) {
    if (box._orig) state.deletedRestoredBoxes.push(box._orig);
    state.boxes = state.boxes.filter((b) => b.id !== box.id);
    if (state.selectedId === box.id) { state.selectedId = null; hideFloatingBar(); }
    const el = els.overlay.querySelector('.textbox[data-id="' + box.id + '"]');
    if (el) el.remove();
  }

  // -------------------------------------------------------- create on click
  els.floatingBar.addEventListener("pointerdown", (e) => {
    // Clicking the bar's own background (not one of its buttons/inputs) -- e.g. because the bar
    // is sitting on top of PDF content the user actually wants to click next, which it often does
    // in a dense form -- previously just did nothing at all (a bubbled-up click never matched the
    // overlay handler's strict e.target check below, so it silently fell through). Deselecting
    // here at least closes the bar out of the way, so a second click in that now-clear spot works.
    if (e.target === els.floatingBar) selectBox(null);
  });

  els.overlay.addEventListener("pointerdown", (e) => {
    if (e.target !== els.overlay) return;
    if (state.mode !== "text") { selectBox(null); return; }
    // Missing here before (every other pointerdown handler in this file already has it) --
    // without it, the browser also synthesizes a compatibility mousedown/click for the SAME
    // physical click, and by the time that fires renderBoxes() below has already torn down and
    // rebuilt the DOM, so the synthesized click can land on the just-created box's textarea
    // instead of being harmlessly ignored -- net effect: the first click didn't seem to "take",
    // and a second click was needed.
    e.preventDefault();
    const rect = els.overlay.getBoundingClientRect();
    const p = cssToPdf(e.clientX - rect.left, e.clientY - rect.top);
    const box = {
      id: state.nextId++,
      page: state.currentPage,
      xPdf: p.x,
      yTopPdf: p.y,
      widthPdf: 240,
      fontSize: parseFloat(els.fbFontSize.value) || 16,
      bold: els.fbBold.classList.contains("active"),
      color: els.fbColor.value || "#1a1a1a",
      fontKey: els.fbFont.value || "hind",
      autoFont: false,
      text: "",
    };
    state.boxes.push(box);
    state.pendingFocusId = box.id;
    state.selectedId = box.id;
    renderBoxes();
  });

  // ---------------------------------------------------------------- resize (width only --
  // height keeps auto-fitting the wrapped text via autoResizeTextarea, same as always)
  function startResize(e, box, el) {
    e.preventDefault();
    e.stopPropagation();
    selectBox(box.id);
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* not supported for this pointer type -- fine */ }
    const startX = e.clientX;
    const startWidthCss = box.widthPdf * state.scale;
    const content = el.querySelector(".tb-content");

    function onMove(ev) {
      const newWidthCss = Math.max(40, startWidthCss + (ev.clientX - startX));
      box.widthPdf = newWidthCss / state.scale;
      el.style.width = newWidthCss + "px";
      if (content) autoResizeTextarea(content);
      positionFloatingBar(box);
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // ---------------------------------------------------------------- drag + smart alignment guides
  // Figma/PowerPoint/Sejda-style: collected once when a drag starts (not recomputed every pointer
  // move, since the OTHER boxes don't move during this box's own drag), then checked against the
  // dragged box's own left/right/center edges on every move.
  const SNAP_PX = 6;   // in CSS px, independent of zoom -- a "6px on screen" feel at any scale
  function collectAlignmentTargets(excludeBoxId) {
    const overlayRect = els.overlay.getBoundingClientRect();
    const xs = [0, overlayRect.width, overlayRect.width / 2];
    const ys = [0, overlayRect.height, overlayRect.height / 2];
    els.overlay.querySelectorAll(".textbox").forEach((el) => {
      if (Number(el.dataset.id) === excludeBoxId) return;
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;
      const w = el.offsetWidth, h = el.offsetHeight;
      xs.push(left, left + w, left + w / 2);
      ys.push(top, top + h, top + h / 2);
    });
    return { xs, ys };
  }
  // Checks the dragged box's left/right/center against every candidate target on one axis; returns
  // the snapped position (already offset back to the box's own left/top) plus where to draw the
  // guide line, or null if nothing is within SNAP_PX.
  function findAxisSnap(pos, size, targets) {
    for (const t of targets) {
      if (Math.abs(pos - t) <= SNAP_PX) return { pos: t, guide: t };
      if (Math.abs(pos + size - t) <= SNAP_PX) return { pos: t - size, guide: t };
      if (Math.abs(pos + size / 2 - t) <= SNAP_PX) return { pos: t - size / 2, guide: t };
    }
    return null;
  }

  function startDrag(e, box, el) {
    selectBox(box.id);
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* not supported for this pointer type -- fine */ }
    const overlayRect = els.overlay.getBoundingClientRect();
    state.dragging = {
      box, el,
      startX: e.clientX, startY: e.clientY,
      startLeft: parseFloat(el.style.left) || 0,
      startTop: parseFloat(el.style.top) || 0,
      overlayRect,
      width: el.offsetWidth, height: el.offsetHeight,
      targets: collectAlignmentTargets(box.id),
    };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
  }
  function onDragMove(e) {
    const d = state.dragging;
    if (!d) return;
    let x = d.startLeft + (e.clientX - d.startX);
    let y = d.startTop + (e.clientY - d.startY);
    x = Math.max(0, Math.min(x, d.overlayRect.width - 10));
    y = Math.max(0, Math.min(y, d.overlayRect.height - 10));

    const snapX = findAxisSnap(x, d.width, d.targets.xs);
    if (snapX) {
      x = snapX.pos;
      els.guideV.style.left = snapX.guide + "px";
      els.guideV.classList.add("visible");
    } else {
      els.guideV.classList.remove("visible");
    }
    const snapY = findAxisSnap(y, d.height, d.targets.ys);
    if (snapY) {
      y = snapY.pos;
      els.guideH.style.top = snapY.guide + "px";
      els.guideH.classList.add("visible");
    } else {
      els.guideH.classList.remove("visible");
    }

    d.el.style.left = x + "px";
    d.el.style.top = y + "px";
    positionFloatingBar({ xPdf: cssToPdf(x, y).x, yTopPdf: cssToPdf(x, y).y, fontSize: d.box.fontSize });
  }
  function onDragEnd() {
    const d = state.dragging;
    if (!d) return;
    const p = cssToPdf(parseFloat(d.el.style.left), parseFloat(d.el.style.top));
    d.box.xPdf = p.x;
    d.box.yTopPdf = p.y;
    state.dragging = null;
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    positionFloatingBar(d.box);
    els.guideV.classList.remove("visible");
    els.guideH.classList.remove("visible");
  }

  // -------------------------------------------------------------- page / zoom
  els.btnPrev.addEventListener("click", async () => {
    if (state.currentPage > 1) { state.currentPage--; selectBox(null); await renderPage(); }
  });
  els.btnNext.addEventListener("click", async () => {
    if (state.currentPage < state.numPages) { state.currentPage++; selectBox(null); await renderPage(); }
  });
  els.btnZoomIn.addEventListener("click", async () => {
    state.scale = Math.min(state.baseScale * 2.5, +(state.scale + 0.18).toFixed(2));
    await renderPage();
  });
  els.btnZoomOut.addEventListener("click", async () => {
    state.scale = Math.max(state.baseScale * 0.4, +(state.scale - 0.18).toFixed(2));
    await renderPage();
  });

  // Ctrl/Cmd + wheel to zoom, keeping the point under the cursor fixed (like Chrome's PDF
  // viewer, Figma, Google Maps) -- plain wheel is left alone so it still scrolls/pans normally.
  els.stageWrap.addEventListener("wheel", async (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.pdfDoc) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    const newScale = Math.max(state.baseScale * 0.4, Math.min(state.baseScale * 2.5, +(state.scale + delta).toFixed(2)));
    if (newScale === state.scale) return;

    const rect = els.stageWrap.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const ratioX = (els.stageWrap.scrollLeft + offsetX) / els.stage.offsetWidth;
    const ratioY = (els.stageWrap.scrollTop + offsetY) / els.stage.offsetHeight;

    state.scale = newScale;
    await renderPage();

    els.stageWrap.scrollLeft = ratioX * els.stage.offsetWidth - offsetX;
    els.stageWrap.scrollTop = ratioY * els.stage.offsetHeight - offsetY;
  }, { passive: false });

  // -------------------------------------------------------------- floating bar controls
  function currentBox() { return state.boxes.find((b) => b.id === state.selectedId); }
  function syncContentEl(box, patch) {
    const c = els.overlay.querySelector('.textbox[data-id="' + box.id + '"] .tb-content');
    if (!c) return;
    if (patch.fontSize != null) { c.style.fontSize = patch.fontSize * state.scale + "px"; autoResizeTextarea(c); }
    if (patch.bold != null) c.style.fontWeight = patch.bold ? "700" : "400";
    if (patch.color != null) c.style.color = patch.color;
    if (patch.fontKey != null) c.style.fontFamily = (FONT_LIBRARY[patch.fontKey] || FONT_LIBRARY.hind).cssFamily;
  }
  els.fbFontSize.addEventListener("input", () => {
    const box = currentBox(); if (!box) return;
    box.fontSize = parseFloat(els.fbFontSize.value) || box.fontSize;
    syncContentEl(box, { fontSize: box.fontSize });
    positionFloatingBar(box);
  });
  els.fbFontDown.addEventListener("click", () => {
    const box = currentBox(); if (!box) return;
    box.fontSize = Math.max(6, box.fontSize - 1);
    els.fbFontSize.value = box.fontSize;
    syncContentEl(box, { fontSize: box.fontSize });
    positionFloatingBar(box);
  });
  els.fbFontUp.addEventListener("click", () => {
    const box = currentBox(); if (!box) return;
    box.fontSize = Math.min(96, box.fontSize + 1);
    els.fbFontSize.value = box.fontSize;
    syncContentEl(box, { fontSize: box.fontSize });
    positionFloatingBar(box);
  });
  els.fbBold.addEventListener("click", () => {
    els.fbBold.classList.toggle("active");
    const box = currentBox(); if (!box) return;
    box.bold = els.fbBold.classList.contains("active");
    syncContentEl(box, { bold: box.bold });
  });
  els.fbColor.addEventListener("input", () => {
    const box = currentBox(); if (!box) return;
    box.color = els.fbColor.value;
    syncContentEl(box, { color: box.color });
  });
  els.fbFont.addEventListener("change", () => {
    const box = currentBox(); if (!box) return;
    box.fontKey = els.fbFont.value;
    syncContentEl(box, { fontKey: box.fontKey });
  });
  els.fbAutoFont.addEventListener("click", () => {
    const box = currentBox(); if (!box) return;
    box.autoFont = !box.autoFont;
    els.fbAutoFont.classList.toggle("active", box.autoFont);
  });
  els.fbMove.addEventListener("pointerdown", (e) => {
    const box = currentBox(); if (!box) return;
    e.preventDefault();
    const el = els.overlay.querySelector('.textbox[data-id="' + box.id + '"]');
    if (el) startDrag(e, box, el);
  });
  els.fbDuplicate.addEventListener("click", () => {
    const box = currentBox(); if (!box) return;
    const copy = Object.assign({}, box, {
      id: state.nextId++,
      xPdf: box.xPdf + 14,
      yTopPdf: box.yTopPdf - 14,
    });
    state.boxes.push(copy);
    state.selectedId = copy.id;
    renderBoxes();
  });
  els.fbDelete.addEventListener("click", () => {
    if (state.selectedId != null) deleteBox(state.selectedId);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Delete" && state.selectedId != null) {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains("tb-content")) return;
      deleteBox(state.selectedId);
    }
    if (e.key === "Escape" && state.selectedId != null) {
      selectBox(null);
    }
  });

  // -------------------------------------------------------------- export
  function splitByScript(text) {
    // Word-level split (not per-character) -- a Bengali sentence's own punctuation/digits/spaces
    // stay attached to their Bengali neighbors instead of spawning a spurious tiny Latin-font run
    // for every comma or space; only an actual run of Latin/other-script words switches font.
    const BENGALI_RE = /[\u0980-\u09FF]/;
    const tokens = text.split(/(\s+)/).filter((t) => t !== "");
    const runs = [];
    for (const tok of tokens) {
      const isSpace = /^\s+$/.test(tok);
      const bengali = isSpace
        ? (runs.length ? runs[runs.length - 1].bengali : true)
        : BENGALI_RE.test(tok);
      if (runs.length && runs[runs.length - 1].bengali === bengali) {
        runs[runs.length - 1].text += tok;
      } else {
        runs.push({ text: tok, bengali });
      }
    }
    return runs;
  }

  function widthOfMixed(text, fontSize, bnFont, enFont) {
    let total = 0;
    for (const run of splitByScript(text)) {
      const f = run.bengali ? bnFont : enFont;
      try { total += f.widthOfTextAtSize(run.text, fontSize); }
      catch (err) { total += run.text.length * fontSize * 0.55; }
    }
    return total;
  }

  function wrapMixedText(text, fontSize, maxWidth, bnFont, enFont) {
    const paragraphs = (text || "").split("\n");
    const lines = [];
    for (const para of paragraphs) {
      if (para.trim() === "") { lines.push(""); continue; }
      const words = para.split(" ");
      let cur = "";
      for (const w of words) {
        const test = cur ? cur + " " + w : w;
        const width = widthOfMixed(test, fontSize, bnFont, enFont);
        if (width > maxWidth && cur) { lines.push(cur); cur = w; }
        else { cur = test; }
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }

  function drawMixedLine(page, lineText, x, y, fontSize, bnFont, enFont, bnFaux, color) {
    let curX = x;
    for (const run of splitByScript(lineText)) {
      if (!run.text) continue;
      const f = run.bengali ? bnFont : enFont;
      page.drawText(run.text, { x: curX, y, size: fontSize, font: f, color });
      if (run.bengali && bnFaux) {
        page.drawText(run.text, { x: curX + fontSize * 0.035, y, size: fontSize, font: f, color });
      }
      curX += f.widthOfTextAtSize(run.text, fontSize);
    }
  }

  function wrapText(text, font, fontSize, maxWidth) {
    const paragraphs = (text || "").split("\n");
    const lines = [];
    for (const para of paragraphs) {
      if (para.trim() === "") { lines.push(""); continue; }
      const words = para.split(" ");
      let cur = "";
      for (const w of words) {
        const test = cur ? cur + " " + w : w;
        let width;
        try { width = font.widthOfTextAtSize(test, fontSize); }
        catch (err) { width = test.length * fontSize * 0.55; }
        if (width > maxWidth && cur) { lines.push(cur); cur = w; }
        else { cur = test; }
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }

  // ---------------------------------------------------------------- toasts (replaces alert())
  // A native alert() halts the whole page and looks jarring against the rest of this redesign, so
  // every alert() call in this file was converted to this instead -- non-blocking, stackable, styled
  // to match the app's own panels/tokens instead of the OS's dialog chrome. Kept deliberately generic
  // (not tied to any one feature) since it's used everywhere: upload errors, tool-modal validation,
  // export failures, and the usage-milestone nudge.
  let toastStackEl = null;
  function getToastStack() {
    if (!toastStackEl) {
      toastStackEl = document.createElement("div");
      toastStackEl.className = "toast-stack";
      toastStackEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastStackEl);
    }
    return toastStackEl;
  }
  const TOAST_ICON = { error: "alert", warn: "alert", info: "shield", success: "check" };
  const TOAST_DURATION = { error: 6500, warn: 4200, info: 4800, success: 4200 };
  function showToast(message, type = "info", duration) {
    const toast = document.createElement("div");
    toast.className = `app-toast app-toast-${type}`;
    const icon = document.createElement("span");
    icon.className = "app-toast-icon";
    icon.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-${TOAST_ICON[type] || "shield"}"/></svg>`;
    const msg = document.createElement("span");
    msg.className = "app-toast-msg";
    msg.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "app-toast-close";
    close.setAttribute("aria-label", "বন্ধ করুন");
    close.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';
    toast.appendChild(icon);
    toast.appendChild(msg);
    toast.appendChild(close);
    getToastStack().appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }
    close.addEventListener("click", dismiss);
    setTimeout(dismiss, duration || TOAST_DURATION[type] || 4500);
  }

  // Standard browser download (Blob + a temporary <a download> link) -- this is a real,
  // standalone site now, not running inside the Claude Artifact sandbox, so there's no
  // window.claude "downloads" capability to lean on. This works in every modern browser.
  function saveFileToDisk(filename, data) {
    const blob = new Blob([data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    bumpUsageCount();
  }

  // ---------------------------------------------------------------- usage milestone (soft, no backend)
  // No accounts/backend exist yet, so this is a per-browser count in localStorage, not a real quota
  // -- anyone can clear site data or use a private window to reset it. That's fine: it's meant as a
  // friendly "you're a real user" nudge, not an enforcement mechanism, so it never blocks anything.
  const USAGE_KEY = "nothi_usage_count";
  const USAGE_MILESTONE = 8;
  function bumpUsageCount() {
    try {
      const count = parseInt(localStorage.getItem(USAGE_KEY) || "0", 10) + 1;
      localStorage.setItem(USAGE_KEY, String(count));
      if (count % USAGE_MILESTONE === 0) showUsageToast(count);
    } catch (err) {
      // localStorage blocked (private mode, disabled site data, etc.) -- never let this break a
      // real export.
    }
  }
  function showUsageToast(count) {
    showToast(`এই ব্রাউজারে আপনি ${count}টা ফাইল বানিয়েছেন! Nothi ভালো লাগলে বন্ধুদের জানান — প্রো ফিচার শীঘ্রই আসছে।`, "success");
  }

  // ---------------------------------------------------------------- Merge / Compress modals
  function openModal(modalEl) {
    els.modalBackdrop.hidden = false;
    modalEl.hidden = false;
  }
  function closeModals() {
    els.modalBackdrop.hidden = true;
    els.mergeModal.hidden = true;
    els.compressModal.hidden = true;
    els.toolsHubModal.hidden = true;
    els.photoStudioModal.hidden = true;
    els.signPadModal.hidden = true;
    els.imgToPdfModal.hidden = true;
    els.pageMgrModal.hidden = true;
    els.stampModal.hidden = true;
  }

  // Generic "save any Blob/dataURL to disk" helper -- Merge/Compress already had saveFileToDisk()
  // for raw PDF bytes; the new image-producing tools need the same download mechanism for
  // image/* MIME types, so this wraps a data URL instead of a typed array.
  function downloadDataUrl(filename, dataUrl) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    bumpUsageCount();
  }
  els.modalBackdrop.addEventListener("mousedown", (e) => {
    if (e.target === els.modalBackdrop) closeModals();
  });

  // ---- Merge ----
  let mergeFiles = [];

  function renderMergeList() {
    els.mergeFileList.innerHTML = "";
    mergeFiles.forEach((file, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = `${i + 1}. ${file.name}`;
      li.appendChild(name);

      const up = document.createElement("button");
      up.type = "button"; up.textContent = "↑"; up.title = "উপরে সরান";
      up.disabled = i === 0;
      up.addEventListener("click", () => {
        [mergeFiles[i - 1], mergeFiles[i]] = [mergeFiles[i], mergeFiles[i - 1]];
        renderMergeList();
      });

      const down = document.createElement("button");
      down.type = "button"; down.textContent = "↓"; down.title = "নিচে সরান";
      down.disabled = i === mergeFiles.length - 1;
      down.addEventListener("click", () => {
        [mergeFiles[i + 1], mergeFiles[i]] = [mergeFiles[i], mergeFiles[i + 1]];
        renderMergeList();
      });

      const del = document.createElement("button");
      del.type = "button"; del.textContent = "×"; del.title = "সরিয়ে ফেলুন";
      del.addEventListener("click", () => {
        mergeFiles.splice(i, 1);
        renderMergeList();
      });

      li.appendChild(up); li.appendChild(down); li.appendChild(del);
      els.mergeFileList.appendChild(li);
    });
  }

  els.hubOpenMerge.addEventListener("click", () => {
    mergeFiles = [];
    renderMergeList();
    closeModals();
    openModal(els.mergeModal);
  });
  els.mergeCancelBtn.addEventListener("click", closeModals);
  els.mergeAddBtn.addEventListener("click", () => els.mergeFileInput.click());
  els.mergeFileInput.addEventListener("change", (e) => {
    mergeFiles.push(...Array.from(e.target.files || []));
    renderMergeList();
    e.target.value = "";
  });

  els.mergeRunBtn.addEventListener("click", async () => {
    if (mergeFiles.length < 2) {
      showToast("অন্তত ২টা PDF ফাইল যোগ করুন।", "warn");
      return;
    }
    const original = els.mergeRunBtn.textContent;
    els.mergeRunBtn.disabled = true;
    els.mergeRunBtn.textContent = "মার্জ হচ্ছে...";
    try {
      const merged = await PDFLib.PDFDocument.create();
      for (const file of mergeFiles) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await PDFLib.PDFDocument.load(bytes);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      }
      const outBytes = await merged.save();
      saveFileToDisk("merged.pdf", outBytes);
      closeModals();
    } catch (err) {
      console.error(err);
      showToast("মার্জ করতে সমস্যা হয়েছে: " + err.message, "error");
    } finally {
      els.mergeRunBtn.disabled = false;
      els.mergeRunBtn.textContent = original;
    }
  });

  // ---- Compress ----
  let compressFile = null;

  els.compressQuality.addEventListener("input", () => {
    els.compressQualityLabel.textContent = els.compressQuality.value + "%";
  });

  els.hubOpenCompress.addEventListener("click", () => {
    compressFile = null;
    els.compressFileName.textContent = "";
    closeModals();
    openModal(els.compressModal);
  });
  els.compressCancelBtn.addEventListener("click", closeModals);
  els.compressAddBtn.addEventListener("click", () => els.compressFileInput.click());
  els.compressFileInput.addEventListener("change", (e) => {
    compressFile = (e.target.files && e.target.files[0]) || null;
    els.compressFileName.textContent = compressFile ? compressFile.name : "";
  });

  els.compressRunBtn.addEventListener("click", async () => {
    if (!compressFile) {
      showToast("একটা PDF ফাইল বেছে নিন।", "warn");
      return;
    }
    const original = els.compressRunBtn.textContent;
    els.compressRunBtn.disabled = true;
    els.compressRunBtn.textContent = "কমপ্রেস হচ্ছে...";
    try {
      const bytes = new Uint8Array(await compressFile.arrayBuffer());
      const srcDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const outDoc = await PDFLib.PDFDocument.create();
      const quality = parseInt(els.compressQuality.value, 10) / 100;
      const RENDER_SCALE = 1.5;   // downsampling this much is where most of the size reduction comes from

      for (let i = 1; i <= srcDoc.numPages; i++) {
        const page = await srcDoc.getPage(i);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

        const jpegDataUrl = canvas.toDataURL("image/jpeg", quality);
        const jpegBytes = Uint8Array.from(atob(jpegDataUrl.split(",")[1]), (c) => c.charCodeAt(0));
        const jpegImage = await outDoc.embedJpg(jpegBytes);

        const origViewport = page.getViewport({ scale: 1 });
        const outPage = outDoc.addPage([origViewport.width, origViewport.height]);
        outPage.drawImage(jpegImage, { x: 0, y: 0, width: origViewport.width, height: origViewport.height });
      }

      const outBytes = await outDoc.save();
      saveFileToDisk("compressed.pdf", outBytes);
      closeModals();
    } catch (err) {
      console.error(err);
      showToast("কমপ্রেস করতে সমস্যা হয়েছে: " + err.message, "error");
    } finally {
      els.compressRunBtn.disabled = false;
      els.compressRunBtn.textContent = original;
    }
  });

  // ---------------------------------------------------------------- Tools Hub
  els.btnToolsHub.addEventListener("click", () => openModal(els.toolsHubModal));
  els.hubCancelBtn.addEventListener("click", closeModals);
  els.hubOpenPhoto.addEventListener("click", () => { closeModals(); openModal(els.photoStudioModal); });
  els.hubOpenSign.addEventListener("click", () => { closeModals(); openModal(els.signPadModal); });
  els.hubOpenImgToPdf.addEventListener("click", () => { closeModals(); openModal(els.imgToPdfModal); });
  els.hubOpenPageMgr.addEventListener("click", () => { closeModals(); openModal(els.pageMgrModal); });
  els.hubOpenStamp.addEventListener("click", () => { closeModals(); openModal(els.stampModal); });

  // ---------------------------------------------------------------- shared: basic background removal
  // A classical (non-ML) chroma-style flood fill: starts from the four edges and grows inward through
  // pixels that are colour-similar to their already-accepted neighbour, so it copes with mild gradients
  // across a plain wall/backdrop while still stopping at a real subject edge if there's enough contrast.
  // No external model/license -- deliberately traded off against a "true" AI cutout for arbitrarily
  // complex backgrounds, which is a separate, bigger feature (see the chat response for the tradeoff).
  function computeBackgroundMask(width, height, data, tolerance) {
    const n = width * height;
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    function seed(x, y) {
      const idx = y * width + x;
      if (visited[idx]) return;
      visited[idx] = 1;
      stack[sp++] = idx;
    }
    function tryAdd(idx, refP) {
      if (visited[idx]) return;
      const p = idx * 4;
      const dr = data[p] - data[refP];
      const dg = data[p + 1] - data[refP + 1];
      const db = data[p + 2] - data[refP + 2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance) {
        visited[idx] = 1;
        stack[sp++] = idx;
      }
    }
    for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
    for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width, y = (idx / width) | 0;
      const refP = idx * 4;
      if (x > 0) tryAdd(idx - 1, refP);
      if (x < width - 1) tryAdd(idx + 1, refP);
      if (y > 0) tryAdd(idx - width, refP);
      if (y < height - 1) tryAdd(idx + width, refP);
    }
    return visited;
  }
  // Separable box blur, used only to feather the foreground/background boundary so the composite
  // doesn't have a jagged 1-bit edge.
  function boxBlur(src, width, height, radius) {
    const tmp = new Float32Array(width * height);
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += src[y * width + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x++) {
        tmp[y * width + x] = sum / (radius * 2 + 1);
        const xOut = Math.min(width - 1, Math.max(0, x - radius));
        const xIn = Math.min(width - 1, Math.max(0, x + radius + 1));
        sum += src[y * width + xIn] - src[y * width + xOut];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y++) {
        out[y * width + x] = sum / (radius * 2 + 1);
        const yOut = Math.min(height - 1, Math.max(0, y - radius));
        const yIn = Math.min(height - 1, Math.max(0, y + radius + 1));
        sum += tmp[Math.min(height - 1, yIn) * width + x] - tmp[yOut * width + x];
      }
    }
    return out;
  }
  function applyBackgroundRemoval(imageData, tolerance, fillRGB) {
    const { width, height, data } = imageData;
    const bgMask = computeBackgroundMask(width, height, data, tolerance);
    const fgScore = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) fgScore[i] = bgMask[i] ? 0 : 255;
    const smoothed = boxBlur(fgScore, width, height, 2);
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < width * height; i++) {
      const fg = smoothed[i] / 255;
      const p = i * 4;
      out[p] = data[p] * fg + fillRGB[0] * (1 - fg);
      out[p + 1] = data[p + 1] * fg + fillRGB[1] * (1 - fg);
      out[p + 2] = data[p + 2] * fg + fillRGB[2] * (1 - fg);
      out[p + 3] = 255;
    }
    return new ImageData(out, width, height);
  }

  // ---------------------------------------------------------------- Photo / Signature Studio
  let psOriginalCanvas = null;
  let psSourceCanvas = null;
  let psPanX = 0, psPanY = 0;
  let psDragging = null;

  function psFillRGB() {
    return els.psBg.value === "blue" ? [0, 61, 165] : [255, 255, 255];
  }

  function rebuildPsSource() {
    if (!psOriginalCanvas) return;
    const w = psOriginalCanvas.width, h = psOriginalCanvas.height;
    if (els.psRemoveBg.checked) {
      const imageData = psOriginalCanvas.getContext("2d").getImageData(0, 0, w, h);
      const tolerance = parseInt(els.psSensitivity.value, 10);
      const result = applyBackgroundRemoval(imageData, tolerance, psFillRGB());
      psSourceCanvas = document.createElement("canvas");
      psSourceCanvas.width = w; psSourceCanvas.height = h;
      psSourceCanvas.getContext("2d").putImageData(result, 0, 0);
    } else if (els.psBg.value !== "none") {
      psSourceCanvas = document.createElement("canvas");
      psSourceCanvas.width = w; psSourceCanvas.height = h;
      const ctx = psSourceCanvas.getContext("2d");
      const [r, g, b] = psFillRGB();
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(psOriginalCanvas, 0, 0);
    } else {
      psSourceCanvas = psOriginalCanvas;
    }
    redrawPsCanvas();
  }

  function redrawPsCanvas() {
    if (!psSourceCanvas) return;
    const targetW = els.psCanvas.width, targetH = els.psCanvas.height;
    const srcW = psSourceCanvas.width, srcH = psSourceCanvas.height;
    const coverScale = Math.max(targetW / srcW, targetH / srcH);
    const zoomPct = parseInt(els.psZoom.value, 10) / 100;
    const scale = coverScale * zoomPct;
    const drawW = srcW * scale, drawH = srcH * scale;
    const maxPanX = Math.max(0, drawW - targetW) / 2;
    const maxPanY = Math.max(0, drawH - targetH) / 2;
    psPanX = Math.max(-maxPanX, Math.min(maxPanX, psPanX));
    psPanY = Math.max(-maxPanY, Math.min(maxPanY, psPanY));
    const drawX = (targetW - drawW) / 2 + psPanX;
    const drawY = (targetH - drawH) / 2 + psPanY;
    const ctx = els.psCanvas.getContext("2d");
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(psSourceCanvas, drawX, drawY, drawW, drawH);
  }

  function applyPsPreset() {
    let w, h;
    if (els.psPreset.value === "photo") { w = 300; h = 300; els.psCustomRow.hidden = true; }
    else if (els.psPreset.value === "signature") { w = 300; h = 80; els.psCustomRow.hidden = true; }
    else {
      els.psCustomRow.hidden = false;
      w = Math.max(20, parseInt(els.psCustomW.value, 10) || 300);
      h = Math.max(20, parseInt(els.psCustomH.value, 10) || 300);
    }
    els.psCanvas.width = w;
    els.psCanvas.height = h;
    psPanX = 0; psPanY = 0;
    redrawPsCanvas();
  }

  async function loadPsFile(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = dataUrl;
    });
    const MAX_SIDE = 1000;   // caps flood-fill cost; plenty of resolution for a 300x300 output
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    psOriginalCanvas = document.createElement("canvas");
    psOriginalCanvas.width = w; psOriginalCanvas.height = h;
    psOriginalCanvas.getContext("2d").drawImage(img, 0, 0, w, h);
    psPanX = 0; psPanY = 0;
    els.psBody.hidden = false;
    els.psDownloadBtn.disabled = false;
    rebuildPsSource();
    applyPsPreset();
  }

  els.psAddBtn.addEventListener("click", () => els.psFileInput.click());
  els.psFileInput.addEventListener("change", async (e) => {
    const file = (e.target.files && e.target.files[0]) || null;
    e.target.value = "";
    if (file) await loadPsFile(file);
  });
  els.psPreset.addEventListener("change", applyPsPreset);
  els.psCustomW.addEventListener("input", () => { if (els.psPreset.value === "custom") applyPsPreset(); });
  els.psCustomH.addEventListener("input", () => { if (els.psPreset.value === "custom") applyPsPreset(); });
  els.psZoom.addEventListener("input", redrawPsCanvas);
  els.psBg.addEventListener("change", rebuildPsSource);
  els.psRemoveBg.addEventListener("change", () => {
    els.psSensRow.hidden = !els.psRemoveBg.checked;
    els.psRemoveNote.hidden = !els.psRemoveBg.checked;
    if (els.psRemoveBg.checked && els.psBg.value === "none") els.psBg.value = "white";
    rebuildPsSource();
  });
  let psSensDebounce = null;
  els.psSensitivity.addEventListener("input", () => {
    clearTimeout(psSensDebounce);
    psSensDebounce = setTimeout(rebuildPsSource, 120);
  });
  els.psQuality.addEventListener("input", () => {
    els.psQualityLabel.textContent = els.psQuality.value + "%";
  });
  els.psCanvas.addEventListener("pointerdown", (e) => {
    if (!psSourceCanvas) return;
    els.psCanvas.setPointerCapture(e.pointerId);
    psDragging = { startX: e.clientX, startY: e.clientY, startPanX: psPanX, startPanY: psPanY };
  });
  els.psCanvas.addEventListener("pointermove", (e) => {
    if (!psDragging) return;
    const rect = els.psCanvas.getBoundingClientRect();
    const ratio = els.psCanvas.width / rect.width;
    psPanX = psDragging.startPanX + (e.clientX - psDragging.startX) * ratio;
    psPanY = psDragging.startPanY + (e.clientY - psDragging.startY) * ratio;
    redrawPsCanvas();
  });
  function endPsDrag() { psDragging = null; }
  els.psCanvas.addEventListener("pointerup", endPsDrag);
  els.psCanvas.addEventListener("pointercancel", endPsDrag);
  els.psCancelBtn.addEventListener("click", () => {
    closeModals();
    psOriginalCanvas = null; psSourceCanvas = null;
    els.psBody.hidden = true; els.psDownloadBtn.disabled = true;
    els.psFileInput.value = "";
  });
  els.psDownloadBtn.addEventListener("click", () => {
    const quality = parseInt(els.psQuality.value, 10) / 100;
    const dataUrl = els.psCanvas.toDataURL("image/jpeg", quality);
    const nameMap = { photo: "nothi-photo-300x300.jpg", signature: "nothi-signature-300x80.jpg", custom: "nothi-image.jpg" };
    downloadDataUrl(nameMap[els.psPreset.value] || "nothi-image.jpg", dataUrl);
  });

  // ---------------------------------------------------------------- Signature Drawing Pad
  let signDrawing = false;
  let signLastX = 0, signLastY = 0;
  let signHasInk = false;
  (function setupSignCanvas() {
    const ctx = els.signCanvas.getContext("2d");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#12213d";
  })();
  function signPointerPos(e) {
    const rect = els.signCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (els.signCanvas.width / rect.width),
      y: (e.clientY - rect.top) * (els.signCanvas.height / rect.height),
    };
  }
  els.signCanvas.addEventListener("pointerdown", (e) => {
    signDrawing = true;
    els.signCanvas.setPointerCapture(e.pointerId);
    const p = signPointerPos(e);
    signLastX = p.x; signLastY = p.y;
  });
  els.signCanvas.addEventListener("pointermove", (e) => {
    if (!signDrawing) return;
    const ctx = els.signCanvas.getContext("2d");
    const p = signPointerPos(e);
    ctx.beginPath();
    ctx.moveTo(signLastX, signLastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    signLastX = p.x; signLastY = p.y;
    signHasInk = true;
  });
  function endSignStroke() { signDrawing = false; }
  els.signCanvas.addEventListener("pointerup", endSignStroke);
  els.signCanvas.addEventListener("pointercancel", endSignStroke);
  els.signClearBtn.addEventListener("click", () => {
    els.signCanvas.getContext("2d").clearRect(0, 0, els.signCanvas.width, els.signCanvas.height);
    signHasInk = false;
  });
  els.signCancelBtn.addEventListener("click", closeModals);
  els.signDownloadPngBtn.addEventListener("click", () => {
    if (!signHasInk) { showToast("আগে সই আঁকুন।", "warn"); return; }
    downloadDataUrl("nothi-signature.png", els.signCanvas.toDataURL("image/png"));
  });
  els.signDownloadJpgBtn.addEventListener("click", () => {
    if (!signHasInk) { showToast("আগে সই আঁকুন।", "warn"); return; }
    const out = document.createElement("canvas");
    out.width = 300; out.height = 80;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 300, 80);
    ctx.drawImage(els.signCanvas, 0, 0, 300, 80);
    downloadDataUrl("nothi-signature-300x80.jpg", out.toDataURL("image/jpeg", 0.92));
  });

  // ---------------------------------------------------------------- Images -> PDF (also covers NID front+back)
  let i2pFiles = [];
  function renderI2pList() {
    els.i2pFileList.innerHTML = "";
    i2pFiles.forEach((file, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = `${i + 1}. ${file.name}`;
      li.appendChild(name);
      const up = document.createElement("button");
      up.type = "button"; up.textContent = "↑"; up.title = "উপরে সরান"; up.disabled = i === 0;
      up.addEventListener("click", () => { [i2pFiles[i - 1], i2pFiles[i]] = [i2pFiles[i], i2pFiles[i - 1]]; renderI2pList(); });
      const down = document.createElement("button");
      down.type = "button"; down.textContent = "↓"; down.title = "নিচে সরান"; down.disabled = i === i2pFiles.length - 1;
      down.addEventListener("click", () => { [i2pFiles[i + 1], i2pFiles[i]] = [i2pFiles[i], i2pFiles[i + 1]]; renderI2pList(); });
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "×"; del.title = "সরিয়ে ফেলুন";
      del.addEventListener("click", () => { i2pFiles.splice(i, 1); renderI2pList(); });
      li.appendChild(up); li.appendChild(down); li.appendChild(del);
      els.i2pFileList.appendChild(li);
    });
  }
  els.i2pAddBtn.addEventListener("click", () => els.i2pFileInput.click());
  els.i2pFileInput.addEventListener("change", (e) => {
    i2pFiles.push(...Array.from(e.target.files || []));
    renderI2pList();
    e.target.value = "";
  });
  els.i2pCancelBtn.addEventListener("click", closeModals);
  async function loadImageForPdfDoc(outDoc, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPng = file.type ? file.type === "image/png" : /\.png$/i.test(file.name);
    return isPng ? outDoc.embedPng(bytes) : outDoc.embedJpg(bytes);
  }
  els.i2pRunBtn.addEventListener("click", async () => {
    if (i2pFiles.length < 1) { showToast("অন্তত ১টা ছবি যোগ করুন।", "warn"); return; }
    const modeInput = document.querySelector('input[name="i2pMode"]:checked');
    const mode = modeInput ? modeInput.value : "separate";
    const original = els.i2pRunBtn.textContent;
    els.i2pRunBtn.disabled = true;
    els.i2pRunBtn.textContent = "তৈরি হচ্ছে...";
    try {
      const outDoc = await PDFLib.PDFDocument.create();
      const A4 = [595.28, 841.89];
      const embedded = [];
      for (const file of i2pFiles) embedded.push(await loadImageForPdfDoc(outDoc, file));

      if (mode === "separate") {
        for (const img of embedded) {
          const scale = Math.min(A4[0] / img.width, A4[1] / img.height, 1);
          const w = img.width * scale, h = img.height * scale;
          const page = outDoc.addPage(A4);
          page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
        }
      } else {
        const page = outDoc.addPage(A4);
        const margin = 24;
        const slotH = (A4[1] - margin * (embedded.length + 1)) / embedded.length;
        let y = A4[1] - margin;
        for (const img of embedded) {
          const scale = Math.min((A4[0] - margin * 2) / img.width, slotH / img.height, 1);
          const w = img.width * scale, h = img.height * scale;
          y -= h;
          page.drawImage(img, { x: (A4[0] - w) / 2, y, width: w, height: h });
          y -= margin;
        }
      }

      const outBytes = await outDoc.save();
      saveFileToDisk("images.pdf", outBytes);
      closeModals();
      i2pFiles = [];
    } catch (err) {
      console.error(err);
      showToast("PDF বানাতে সমস্যা হয়েছে (শুধু JPG/PNG ছবি সমর্থিত): " + err.message, "error");
    } finally {
      els.i2pRunBtn.disabled = false;
      els.i2pRunBtn.textContent = original;
    }
  });

  // ---------------------------------------------------------------- Page Manager (reorder / delete / rotate / split)
  let pmFile = null;
  let pmSrcDoc = null;
  let pmPages = [];

  function parsePageRange(str, numPages) {
    const indices = [];
    for (const rawPart of str.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) throw new Error(`"${part}" বোঝা যায়নি -- যেমন লিখুন: 1-3,5`);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      if (start < 1 || end > numPages || start > end) {
        throw new Error(`"${part}" এই PDF-এর পাতা সংখ্যার (১-${numPages}) মধ্যে নেই`);
      }
      for (let i = start; i <= end; i++) indices.push(i - 1);
    }
    if (indices.length === 0) throw new Error("অন্তত ১টা পাতা উল্লেখ করুন");
    return indices;
  }

  async function loadPageMgrFile(file) {
    pmFile = file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    pmSrcDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    pmPages = [];
    for (let i = 0; i < pmSrcDoc.numPages; i++) pmPages.push({ originalIndex: i, rotation: 0, deleted: false });
    els.pmSplitRow.hidden = false;
    els.pmApplyBtn.disabled = false;
    await renderPmGrid();
  }

  async function renderPmGrid() {
    els.pmGrid.innerHTML = "";
    for (let slot = 0; slot < pmPages.length; slot++) {
      const entry = pmPages[slot];
      const card = document.createElement("div");
      card.className = "pm-card" + (entry.deleted ? " marked-delete" : "");
      card.draggable = true;
      card.dataset.slot = String(slot);

      const canvas = document.createElement("canvas");
      const page = await pmSrcDoc.getPage(entry.originalIndex + 1);
      const baseViewport = page.getViewport({ scale: 1 });
      const thumbScale = 120 / Math.max(baseViewport.width, baseViewport.height);
      const totalRotation = ((page.rotate || 0) + entry.rotation) % 360;
      const viewport = page.getViewport({ scale: thumbScale, rotation: totalRotation });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      card.appendChild(canvas);

      const label = document.createElement("div");
      label.className = "pm-label";
      label.textContent = `পাতা ${entry.originalIndex + 1}`;
      card.appendChild(label);

      const actions = document.createElement("div");
      actions.className = "pm-actions";
      const rotateBtn = document.createElement("button");
      rotateBtn.type = "button"; rotateBtn.textContent = "⟳"; rotateBtn.title = "৯০° ঘুরান";
      rotateBtn.addEventListener("click", async () => { entry.rotation = (entry.rotation + 90) % 360; await renderPmGrid(); });
      const delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.textContent = entry.deleted ? "↺" : "🗑"; delBtn.title = entry.deleted ? "ফিরিয়ে আনুন" : "মুছুন";
      delBtn.addEventListener("click", async () => { entry.deleted = !entry.deleted; await renderPmGrid(); });
      actions.appendChild(rotateBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);

      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", String(slot));
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drop-target"); });
      card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
      card.addEventListener("drop", async (e) => {
        e.preventDefault();
        card.classList.remove("drop-target");
        const fromSlot = parseInt(e.dataTransfer.getData("text/plain"), 10);
        const toSlot = parseInt(card.dataset.slot, 10);
        if (Number.isNaN(fromSlot) || fromSlot === toSlot) return;
        const [moved] = pmPages.splice(fromSlot, 1);
        pmPages.splice(toSlot, 0, moved);
        await renderPmGrid();
      });

      els.pmGrid.appendChild(card);
    }
  }

  els.pmAddBtn.addEventListener("click", () => els.pmFileInput.click());
  els.pmFileInput.addEventListener("change", async (e) => {
    const file = (e.target.files && e.target.files[0]) || null;
    e.target.value = "";
    if (file) await loadPageMgrFile(file);
  });
  els.pmCancelBtn.addEventListener("click", () => {
    closeModals();
    pmFile = null; pmSrcDoc = null; pmPages = [];
    els.pmGrid.innerHTML = "";
    els.pmSplitRow.hidden = true;
    els.pmApplyBtn.disabled = true;
  });
  els.pmApplyBtn.addEventListener("click", async () => {
    if (!pmFile) return;
    const kept = pmPages.filter((p) => !p.deleted);
    if (kept.length === 0) { showToast("সব পাতা মুছে ফেলা যাবে না, অন্তত ১টা রাখুন।", "warn"); return; }
    const original = els.pmApplyBtn.textContent;
    els.pmApplyBtn.disabled = true;
    els.pmApplyBtn.textContent = "তৈরি হচ্ছে...";
    try {
      const bytes = new Uint8Array(await pmFile.arrayBuffer());
      const srcDoc = await PDFLib.PDFDocument.load(bytes);
      const outDoc = await PDFLib.PDFDocument.create();
      const copied = await outDoc.copyPages(srcDoc, kept.map((p) => p.originalIndex));
      copied.forEach((page, i) => {
        const entry = kept[i];
        if (entry.rotation) {
          const base = page.getRotation().angle || 0;
          page.setRotation(PDFLib.degrees((base + entry.rotation) % 360));
        }
        outDoc.addPage(page);
      });
      const outBytes = await outDoc.save();
      saveFileToDisk("edited-pages.pdf", outBytes);
      closeModals();
    } catch (err) {
      console.error(err);
      showToast("প্রয়োগ করতে সমস্যা হয়েছে: " + err.message, "error");
    } finally {
      els.pmApplyBtn.disabled = false;
      els.pmApplyBtn.textContent = original;
    }
  });
  els.pmSplitBtn.addEventListener("click", async () => {
    if (!pmFile || !pmSrcDoc) return;
    const rangeStr = els.pmSplitRange.value.trim();
    if (!rangeStr) { showToast("কোন পাতা বের করবেন লিখুন, যেমন 1-3", "warn"); return; }
    let indices;
    try {
      indices = parsePageRange(rangeStr, pmSrcDoc.numPages);
    } catch (err) {
      showToast(err.message, "warn");
      return;
    }
    const original = els.pmSplitBtn.textContent;
    els.pmSplitBtn.disabled = true;
    els.pmSplitBtn.textContent = "বের করা হচ্ছে...";
    try {
      const bytes = new Uint8Array(await pmFile.arrayBuffer());
      const srcDoc = await PDFLib.PDFDocument.load(bytes);
      const outDoc = await PDFLib.PDFDocument.create();
      const copied = await outDoc.copyPages(srcDoc, indices);
      copied.forEach((p) => outDoc.addPage(p));
      const outBytes = await outDoc.save();
      saveFileToDisk("split.pdf", outBytes);
    } catch (err) {
      console.error(err);
      showToast("Split করতে সমস্যা হয়েছে: " + err.message, "error");
    } finally {
      els.pmSplitBtn.disabled = false;
      els.pmSplitBtn.textContent = original;
    }
  });

  // ---------------------------------------------------------------- Stamp Tools (watermark / page numbers / date)
  let stFile = null;
  function updateStSubVisibility() {
    els.stWmSub.hidden = !els.stWmEnable.checked;
    els.stPnSub.hidden = !els.stPnEnable.checked;
    els.stDtSub.hidden = !els.stDtEnable.checked;
  }
  els.stWmEnable.addEventListener("change", updateStSubVisibility);
  els.stPnEnable.addEventListener("change", updateStSubVisibility);
  els.stDtEnable.addEventListener("change", updateStSubVisibility);
  els.stAddBtn.addEventListener("click", () => els.stFileInput.click());
  els.stFileInput.addEventListener("change", (e) => {
    stFile = (e.target.files && e.target.files[0]) || null;
    els.stFileName.textContent = stFile ? stFile.name : "";
  });
  els.stCancelBtn.addEventListener("click", closeModals);
  function stPositionXY(pos, pageW, pageH, textW, margin) {
    const map = {
      "bottom-center": { x: (pageW - textW) / 2, y: margin },
      "bottom-right": { x: pageW - textW - margin, y: margin },
      "bottom-left": { x: margin, y: margin },
      "top-right": { x: pageW - textW - margin, y: pageH - margin },
      "top-left": { x: margin, y: pageH - margin },
    };
    return map[pos] || map["bottom-center"];
  }
  els.stRunBtn.addEventListener("click", async () => {
    if (!stFile) { showToast("একটা PDF ফাইল বেছে নিন।", "warn"); return; }
    if (!els.stWmEnable.checked && !els.stPnEnable.checked && !els.stDtEnable.checked) {
      showToast("অন্তত একটা অপশন চালু করুন।", "warn");
      return;
    }
    const original = els.stRunBtn.textContent;
    els.stRunBtn.disabled = true;
    els.stRunBtn.textContent = "প্রয়োগ হচ্ছে...";
    try {
      const bytes = new Uint8Array(await stFile.arrayBuffer());
      const outDoc = await PDFLib.PDFDocument.load(bytes);
      outDoc.registerFontkit(window.fontkit);
      const font = await outDoc.embedFont(b64ToUint8Array(FONT_REGULAR_B64), { subset: true });
      const pages = outDoc.getPages();
      const dateStr = new Date().toLocaleDateString("en-GB");
      const margin = 24;

      pages.forEach((page, i) => {
        const { width, height } = page.getSize();

        if (els.stWmEnable.checked && els.stWmText.value.trim()) {
          const text = els.stWmText.value.trim();
          const size = (Math.min(width, height) / (text.length * 0.6 + 2)) * 2.2;
          const opacity = parseInt(els.stWmOpacity.value, 10) / 100;
          const textWidth = font.widthOfTextAtSize(text, size);
          page.drawText(text, {
            x: (width - textWidth) / 2, y: (height - size) / 2,
            size, font, color: PDFLib.rgb(0.5, 0.5, 0.5), opacity, rotate: PDFLib.degrees(45),
          });
        }
        if (els.stPnEnable.checked) {
          const text = `${i + 1} / ${pages.length}`;
          const size = 10;
          const textWidth = font.widthOfTextAtSize(text, size);
          const { x, y } = stPositionXY(els.stPnPos.value, width, height, textWidth, margin);
          page.drawText(text, { x, y, size, font, color: PDFLib.rgb(0.2, 0.2, 0.2) });
        }
        if (els.stDtEnable.checked) {
          const size = 9;
          const textWidth = font.widthOfTextAtSize(dateStr, size);
          const { x, y } = stPositionXY(els.stDtPos.value, width, height, textWidth, margin);
          page.drawText(dateStr, { x, y, size, font, color: PDFLib.rgb(0.35, 0.35, 0.35) });
        }
      });

      const outBytes = await outDoc.save();
      saveFileToDisk("stamped.pdf", outBytes);
      closeModals();
    } catch (err) {
      console.error(err);
      showToast("প্রয়োগ করতে সমস্যা হয়েছে: " + err.message, "error");
    } finally {
      els.stRunBtn.disabled = false;
      els.stRunBtn.textContent = original;
    }
  });

  els.btnDownload.addEventListener("click", async () => {
    if (!state.pdfBytes) return;
    const original = els.btnDownload.textContent;
    els.btnDownload.disabled = true;
    els.btnDownload.textContent = "তৈরি হচ্ছে...";
    try {
      const outDoc = await PDFLib.PDFDocument.load(state.pdfBytes.slice());
      outDoc.registerFontkit(window.fontkit);
      // Embed every font in the library once, up front -- each box picks its own at draw time.
      // Kalpurush ships only one weight (real Bangla practice for it: no dedicated bold face), so a
      // box asking for bold on it gets a "faux bold" double-strike instead of silently rendering as
      // plain regular weight.
      const embeds = {
        hind: {
          regular: await outDoc.embedFont(b64ToUint8Array(FONT_REGULAR_B64), { subset: true }),
          bold: await outDoc.embedFont(b64ToUint8Array(FONT_BOLD_B64), { subset: true }),
        },
        kalpurush: {
          regular: await outDoc.embedFont(b64ToUint8Array(KALPURUSH_B64), { subset: true }),
          bold: null,
        },
        tinos: {
          regular: await outDoc.embedFont(b64ToUint8Array(TINOS_REGULAR_B64), { subset: true }),
          bold: await outDoc.embedFont(b64ToUint8Array(TINOS_BOLD_B64), { subset: true }),
        },
      };
      const pages = outDoc.getPages();

      // Covers up a PREVIOUS export's baked-in text for one box, so "rewriting" text added in an
      // earlier session doesn't just draw new text on top of/next to the old -- PDFs have no way
      // to un-draw something already in the page's content stream, so the practical fix is to
      // paint over its exact old footprint before drawing the current text. The footprint is
      // sized from `orig`'s OWN font/width/text (exactly what's actually on the page right now),
      // not the box's current (possibly since-edited) values.
      function origLineCount(orig) {
        const fontDef = FONT_LIBRARY[orig.fontKey] || FONT_LIBRARY.hind;
        const fontSet = embeds[orig.fontKey] || embeds.hind;
        const font = (orig.bold && fontDef.hasBold) ? fontSet.bold : fontSet.regular;
        try {
          const lines = orig.autoFont
            ? wrapMixedText(orig.text, orig.fontSize, orig.widthPdf, font, orig.bold ? embeds.tinos.bold : embeds.tinos.regular)
            : wrapText(orig.text, font, orig.fontSize, orig.widthPdf);
          return Math.max(1, lines.length);
        } catch (err) {
          return 6;   // generous fallback if measuring the old text fails for any reason
        }
      }
      function whiteoutOrig(page, orig) {
        const lineHeight = orig.fontSize * 1.35;
        const pad = 3;
        const height = origLineCount(orig) * lineHeight + pad * 2;
        page.drawRectangle({
          x: orig.xPdf - pad, y: orig.yTopPdf - height + pad,
          width: orig.widthPdf + pad * 2, height,
          color: PDFLib.rgb(1, 1, 1),
        });
      }

      // Boxes restored from a previous export, then deleted/emptied in this session -- their old
      // text must disappear even though there's no current box left to draw over it.
      for (const orig of state.deletedRestoredBoxes) {
        const page = pages[orig.page - 1];
        if (page) whiteoutOrig(page, orig);
      }

      for (const box of state.boxes) {
        if (!box.text || !box.text.trim()) continue;
        const page = pages[box.page - 1];
        if (!page) continue;
        const fontDef = FONT_LIBRARY[box.fontKey] || FONT_LIBRARY.hind;
        const fontSet = embeds[box.fontKey] || embeds.hind;
        const useTrueBold = box.bold && fontDef.hasBold;
        const faux = box.bold && !fontDef.hasBold;
        const font = useTrueBold ? fontSet.bold : fontSet.regular;
        const { r, g, b } = hexToRgb01(box.color);
        const color = PDFLib.rgb(r, g, b);
        const lineHeight = box.fontSize * 1.35;
        const baseline = box.yTopPdf - box.fontSize * 0.82;
        const fauxOffset = box.fontSize * 0.035;

        if (box._orig) whiteoutOrig(page, box._orig);

        if (box.autoFont) {
          // Bengali-script runs use this box's chosen Bangla font; everything else (Latin
          // letters, digits, stray punctuation) uses Tinos -- so "প্রার্থীর নাম: Md. Tahsin Amin"
          // gets both scripts in their own proper font instead of one font awkwardly covering
          // both. The on-screen textarea still shows a single font while typing (it can't mix
          // fonts per character) -- this only changes the exported PDF.
          const enFont = box.bold ? embeds.tinos.bold : embeds.tinos.regular;
          const mixedLines = wrapMixedText(box.text, box.fontSize, box.widthPdf, font, enFont);
          mixedLines.forEach((line, i) => {
            if (!line) return;
            drawMixedLine(page, line, box.xPdf, baseline - i * lineHeight, box.fontSize, font, enFont, faux, color);
          });
        } else {
          const lines = wrapText(box.text, font, box.fontSize, box.widthPdf);
          lines.forEach((line, i) => {
            if (!line) return;
            const ly = baseline - i * lineHeight;
            page.drawText(line, { x: box.xPdf, y: ly, size: box.fontSize, font, color });
            if (faux) {
              page.drawText(line, { x: box.xPdf + fauxOffset, y: ly, size: box.fontSize, font, color });
            }
          });
        }
      }

      // Embed every text box (position, font, size, color, autoFont, the actual text) as
      // private data inside the PDF itself -- re-uploading THIS exact downloaded file back into
      // Nothi later restores every box for further editing, instead of starting from a blank
      // page. Wrapped in try/catch: this is a bonus on top of the real export, never a reason to
      // block the download if something about it fails.
      try {
        const projectPayload = JSON.stringify({ nothiVersion: 1, boxes: state.boxes });
        const projectBytes = new TextEncoder().encode(projectPayload);
        const streamDict = outDoc.context.obj({ Length: projectBytes.length });
        const stream = PDFLib.PDFRawStream.of(streamDict, projectBytes);
        const ref = outDoc.context.register(stream);
        outDoc.catalog.set(PDFLib.PDFName.of("NothiProjectData"), ref);
      } catch (err) {
        console.error("Could not embed project data for later re-editing (download still proceeds):", err);
        showToast("সতর্কতা: এই PDF-টা পরে আবার আপলোড করে এডিট চালিয়ে যাওয়ার তথ্য সেভ করা যায়নি (" + err.message + ")। PDF ডাউনলোড তবুও স্বাভাবিকভাবেই হবে।", "info");
      }

      const outBytes = await outDoc.save();
      saveFileToDisk("nothi-edited.pdf", outBytes);
    } catch (err) {
      console.error(err);
      showToast("এক্সপোর্ট করতে সমস্যা হয়েছে। PDF ফাইলটি সমর্থিত কিনা দেখুন।", "error");
    } finally {
      els.btnDownload.disabled = false;
      els.btnDownload.textContent = original;
    }
  });
})();
