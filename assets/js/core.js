// Shared foundation: font loading, DOM refs, theme toggle, landing showcase tabs, shared state,
// toasts, modal open/close, and the two download helpers every tool/feature routes through.
// Everything here is either self-executing on load (fonts, theme, showcase) or exported for the
// other 3 modules (editor.js, tools-pdf.js, tools-image.js) to import.
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
    toolImage: document.getElementById("toolImage"),
    imageBoxInput: document.getElementById("imageBoxInput"),
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
    hubOpenNidJoin: document.getElementById("hubOpenNidJoin"),
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

    nidJoinModal: document.getElementById("nidJoinModal"),
    nidFrontCanvas: document.getElementById("nidFrontCanvas"),
    nidFrontAddBtn: document.getElementById("nidFrontAddBtn"),
    nidFrontInput: document.getElementById("nidFrontInput"),
    nidFrontZoomRow: document.getElementById("nidFrontZoomRow"),
    nidFrontZoom: document.getElementById("nidFrontZoom"),
    nidFrontBtnLabel: document.getElementById("nidFrontBtnLabel"),
    nidBackCanvas: document.getElementById("nidBackCanvas"),
    nidBackAddBtn: document.getElementById("nidBackAddBtn"),
    nidBackInput: document.getElementById("nidBackInput"),
    nidBackZoomRow: document.getElementById("nidBackZoomRow"),
    nidBackZoom: document.getElementById("nidBackZoom"),
    nidBackBtnLabel: document.getElementById("nidBackBtnLabel"),
    nidBorder: document.getElementById("nidBorder"),
    nidCancelBtn: document.getElementById("nidCancelBtn"),
    nidSaveJpgBtn: document.getElementById("nidSaveJpgBtn"),
    nidSavePdfBtn: document.getElementById("nidSavePdfBtn"),

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

    // editor: edit-existing-text, shapes, undo/redo, mode hint, autosave restore
    toolEdit: document.getElementById("toolEdit"),
    toolShape: document.getElementById("toolShape"),
    toolShapeIcon: document.getElementById("toolShapeIcon"),
    shapeMenu: document.getElementById("shapeMenu"),
    btnUndo: document.getElementById("btnUndo"),
    btnRedo: document.getElementById("btnRedo"),
    modeHint: document.getElementById("modeHint"),
    modeHintText: document.getElementById("modeHintText"),
    modeHintAction: document.getElementById("modeHintAction"),
    fbStroke: document.getElementById("fbStroke"),
    fbFill: document.getElementById("fbFill"),
    fbLineHeight: document.getElementById("fbLineHeight"),
    btnPageNumbers: document.getElementById("btnPageNumbers"),
    pageNumModal: document.getElementById("pageNumModal"),
    pnFormat: document.getElementById("pnFormat"),
    pnPosition: document.getElementById("pnPosition"),
    pnDigits: document.getElementById("pnDigits"),
    pnStart: document.getElementById("pnStart"),
    pnSize: document.getElementById("pnSize"),
    pnRange: document.getElementById("pnRange"),
    pnCancelBtn: document.getElementById("pnCancelBtn"),
    pnApplyBtn: document.getElementById("pnApplyBtn"),
    insertPdfInput: document.getElementById("insertPdfInput"),
    restoreCard: document.getElementById("restoreCard"),
    restoreName: document.getElementById("restoreName"),
    restoreTime: document.getElementById("restoreTime"),
    restoreBtn: document.getElementById("restoreBtn"),
    restoreDiscardBtn: document.getElementById("restoreDiscardBtn"),

    // tools: password protect/unlock, OCR
    hubOpenSecure: document.getElementById("hubOpenSecure"),
    hubOpenOcr: document.getElementById("hubOpenOcr"),
    secureModal: document.getElementById("secureModal"),
    secAddBtn: document.getElementById("secAddBtn"),
    secFileInput: document.getElementById("secFileInput"),
    secFileName: document.getElementById("secFileName"),
    secStatus: document.getElementById("secStatus"),
    secProtectBox: document.getElementById("secProtectBox"),
    secPassword: document.getElementById("secPassword"),
    secPassword2: document.getElementById("secPassword2"),
    secNoPrint: document.getElementById("secNoPrint"),
    secNoCopy: document.getElementById("secNoCopy"),
    secCancelBtn: document.getElementById("secCancelBtn"),
    secRunBtn: document.getElementById("secRunBtn"),
    secRunLabel: document.getElementById("secRunLabel"),
    ocrModal: document.getElementById("ocrModal"),
    ocrAddBtn: document.getElementById("ocrAddBtn"),
    ocrFileInput: document.getElementById("ocrFileInput"),
    ocrFileName: document.getElementById("ocrFileName"),
    ocrProgress: document.getElementById("ocrProgress"),
    ocrProgressBar: document.getElementById("ocrProgressBar"),
    ocrProgressText: document.getElementById("ocrProgressText"),
    ocrResult: document.getElementById("ocrResult"),
    ocrCopyBtn: document.getElementById("ocrCopyBtn"),
    ocrTxtBtn: document.getElementById("ocrTxtBtn"),
    ocrCancelBtn: document.getElementById("ocrCancelBtn"),
    ocrRunBtn: document.getElementById("ocrRunBtn"),
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
    els.btnThemeToggle.innerHTML = '<svg class="ic theme-ic" aria-hidden="true"><use href="#i-' + (isDarkActive() ? "sun" : "moon") + '"/></svg>';
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

  // ---------------------------------------------------------------- landing: tool tiles
  // Each tile just presses the matching (already wired) Tools Hub / upload button, so a tool
  // opens straight from the landing page in one click instead of hub -> tool.
  document.querySelectorAll("[data-open]").forEach((tile) => {
    tile.addEventListener("click", () => {
      const target = document.getElementById(tile.dataset.open);
      if (target) target.click();
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

  // ---------------------------------------------------------------- "name your file" dialog
  // Every download in the app goes through saveFileToDisk()/downloadDataUrl(), so the rename step
  // lives here once instead of in each tool. It's its own overlay (not inside #modalBackdrop) on
  // purpose: tools call closeModals() right after starting a download, and that must not also
  // close this dialog. The real <a download> click happens inside the dialog's submit handler, so
  // it still counts as a user gesture and browsers don't block it.
  const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
  function splitExt(name) {
    const m = /^(.*?)(\.[a-z0-9]{1,5})$/i.exec(name);
    return m ? { base: m[1], ext: m[2] } : { base: name, ext: "" };
  }
  // Turns whatever the user typed into a safe file name that still ends in the right extension
  // (typing "my form" for a PDF gives "my form.pdf", never an extension-less file).
  function cleanFileName(typed, defaultName) {
    const { ext } = splitExt(defaultName);
    let name = String(typed || "").replace(ILLEGAL_FILENAME_CHARS, "").replace(/\s+/g, " ").trim();
    name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
    if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) name = name.slice(0, -ext.length).trim();
    if (!name) return defaultName;
    return name.slice(0, 150) + ext;
  }
  // Base name of an uploaded file, for building defaults like "invoice-edited.pdf".
  function fileBaseName(file, fallback) {
    if (!file || !file.name) return fallback;
    const base = splitExt(file.name).base.replace(ILLEGAL_FILENAME_CHARS, "").trim();
    return base || fallback;
  }

  // One reusable "type a value" dialog (file name, password, ...). Its own overlay, not inside
  // #modalBackdrop, so a tool calling closeModals() right after starting a download never closes it.
  let promptDialogEls = null;
  function buildPromptDialog() {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop filename-backdrop";
    overlay.hidden = true;
    overlay.innerHTML =
      '<form class="modal filename-modal" role="dialog" aria-modal="true" aria-labelledby="pdTitle">' +
        '<h2 id="pdTitle"></h2>' +
        '<p class="modal-note pd-note"></p>' +
        '<div class="fn-row"><input class="fn-input" spellcheck="false" autocomplete="off"><span class="fn-ext"></span></div>' +
        '<p class="pd-error" hidden></p>' +
        '<div class="modal-actions">' +
          '<button class="ghost-btn fn-cancel" type="button">বাতিল</button>' +
          '<button class="primary-btn fn-ok" type="submit"><svg class="ic" aria-hidden="true"><use href="#i-download"/></svg><span></span></button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(overlay);
    return {
      overlay,
      form: overlay.querySelector("form"),
      title: overlay.querySelector("h2"),
      note: overlay.querySelector(".pd-note"),
      input: overlay.querySelector(".fn-input"),
      ext: overlay.querySelector(".fn-ext"),
      error: overlay.querySelector(".pd-error"),
      okIcon: overlay.querySelector(".fn-ok use"),
      okLabel: overlay.querySelector(".fn-ok span"),
      cancel: overlay.querySelector(".fn-cancel"),
    };
  }

  // Resolves the typed value, or null if cancelled. `validate(value)` may return an error string
  // (shown inline, dialog stays open) or a Promise of one -- used by the password prompt so a wrong
  // password can be retried without the dialog closing and reopening.
  function promptDialog(opts) {
    if (!promptDialogEls) promptDialogEls = buildPromptDialog();
    const d = promptDialogEls;
    d.title.textContent = opts.title || "";
    d.note.textContent = opts.note || "";
    d.note.hidden = !opts.note;
    d.input.type = opts.type || "text";
    d.input.value = opts.value || "";
    d.input.placeholder = opts.placeholder || "";
    d.input.setAttribute("aria-label", opts.title || "");
    d.ext.textContent = opts.suffix || "";
    d.ext.hidden = !opts.suffix;
    d.error.hidden = true;
    d.okLabel.textContent = opts.okLabel || "ঠিক আছে";
    d.okIcon.setAttribute("href", "#i-" + (opts.okIcon || "check"));
    const previousFocus = document.activeElement;
    d.overlay.hidden = false;
    setTimeout(() => { d.input.focus(); d.input.select(); }, 0);

    return new Promise((resolve) => {
      let busy = false;
      function finish(value) {
        d.overlay.hidden = true;
        d.form.removeEventListener("submit", onSubmit);
        d.cancel.removeEventListener("click", onCancel);
        d.overlay.removeEventListener("mousedown", onBackdrop);
        document.removeEventListener("keydown", onKey, true);
        if (previousFocus && document.contains(previousFocus) && previousFocus.focus) previousFocus.focus();
        resolve(value);
      }
      async function onSubmit(e) {
        e.preventDefault();
        if (busy) return;
        const value = d.input.value;
        if (opts.validate) {
          busy = true;
          let err = null;
          try { err = await opts.validate(value); } catch (ex) { err = ex.message || String(ex); }
          busy = false;
          if (err) {
            d.error.textContent = err;
            d.error.hidden = false;
            d.input.focus(); d.input.select();
            return;
          }
        }
        finish(value);
      }
      function onCancel() { finish(null); }
      function onBackdrop(e) { if (e.target === d.overlay) finish(null); }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      }
      d.form.addEventListener("submit", onSubmit);
      d.cancel.addEventListener("click", onCancel);
      d.overlay.addEventListener("mousedown", onBackdrop);
      document.addEventListener("keydown", onKey, true);
    });
  }

  // Asks for the download's file name (pre-filled, extension locked) and calls onSave(finalName).
  // Resolves true (saved) / false (cancelled).
  async function askFileName(defaultName, onSave) {
    const { base, ext } = splitExt(defaultName);
    const typed = await promptDialog({
      title: "ফাইলের নাম দিন",
      note: "যে নামে ডাউনলোড হবে সেটা লিখুন — এক্সটেনশন নিজে থেকেই যোগ হবে।",
      value: base, suffix: ext, okLabel: "ডাউনলোড", okIcon: "download",
    });
    if (typed == null) return false;
    onSave(cleanFileName(typed, defaultName));
    return true;
  }

  function triggerDownload(href, filename) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    bumpUsageCount();
  }

  // Standard browser download (Blob + a temporary <a download> link) -- this is a real,
  // standalone site now, not running inside the Claude Artifact sandbox, so there's no
  // window.claude "downloads" capability to lean on. This works in every modern browser.
  // The user names the file first (askFileName above).
  function saveFileToDisk(filename, data, mime) {
    const blob = new Blob([data], { type: mime || "application/pdf" });
    return askFileName(filename, (finalName) => {
      const url = URL.createObjectURL(blob);
      triggerDownload(url, finalName);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
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
    els.nidJoinModal.hidden = true;
    els.pageMgrModal.hidden = true;
    els.stampModal.hidden = true;
    els.secureModal.hidden = true;
    els.ocrModal.hidden = true;
    els.pageNumModal.hidden = true;
  }

  // Generic "save any Blob/dataURL to disk" helper -- Merge/Compress already had saveFileToDisk()
  // for raw PDF bytes; the new image-producing tools need the same download mechanism for
  // image/* MIME types, so this wraps a data URL instead of a typed array.
  function downloadDataUrl(filename, dataUrl) {
    return askFileName(filename, (finalName) => triggerDownload(dataUrl, finalName));
  }
  // ---------------------------------------------------------------- lazy-loaded heavy libraries
  // Only fetched the first time a feature needs them, so the normal page load stays light.
  // @cantoo/pdf-lib is a maintained pdf-lib fork that can encrypt/decrypt; its ESM build is
  // self-contained, so importing it never collides with the regular global PDFLib (v1.17.1).
  const CRYPTO_PDFLIB_URL = "https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.11.1/dist/pdf-lib.esm.min.js";
  let cryptoPdfLibPromise = null;
  function loadCryptoPdfLib() {
    if (!cryptoPdfLibPromise) {
      cryptoPdfLibPromise = import(CRYPTO_PDFLIB_URL).catch((err) => {
        cryptoPdfLibPromise = null;
        throw new Error("পাসওয়ার্ড লাইব্রেরি লোড হয়নি — ইন্টারনেট সংযোগ দেখুন। (" + err.message + ")");
      });
    }
    return cryptoPdfLibPromise;
  }

  // Removes the password from an encrypted PDF and returns plain bytes the rest of the app
  // (pdf.js + regular pdf-lib) can work with. Throws a Bangla message on a wrong password.
  async function decryptPdfBytes(bytes, password) {
    const C = await loadCryptoPdfLib();
    let doc;
    try {
      doc = await C.PDFDocument.load(bytes, { password });
    } catch (err) {
      if (/password/i.test(err.message || "")) throw new Error("পাসওয়ার্ড ভুল হয়েছে।");
      throw err;
    }
    // Verified against the app's regular pdf-lib: the object-stream save comes out clean, while
    // the classic-xref save still looks encrypted to pdf-lib 1.17 -- so try that order and keep
    // the first output the rest of the app can actually open.
    for (const opts of [{}, { useObjectStreams: false }]) {
      const out = await doc.save(opts);
      try { await PDFLib.PDFDocument.load(out); return out; } catch (err) { /* try next */ }
    }
    throw new Error("পাসওয়ার্ড সরানো গেলেও ফাইলটা খোলা যাচ্ছে না।");
  }

  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  let tesseractPromise = null;
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("লোড হয়নি: " + src));
      document.head.appendChild(s);
    });
  }
  // One shared OCR worker for the whole session (Bangla + English) -- creating it downloads
  // ~15MB of language data the first time (then the browser caches it), so it's never recreated.
  let ocrWorkerPromise = null;
  function getOcrWorker(onProgress) {
    if (!tesseractPromise) {
      tesseractPromise = loadScriptOnce(TESSERACT_URL).catch((err) => { tesseractPromise = null; throw err; });
    }
    ocrProgressHandler = onProgress || null;
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = tesseractPromise.then(() =>
        window.Tesseract.createWorker("ben+eng", 1, {
          logger: (m) => { if (ocrProgressHandler) ocrProgressHandler(m); },
        })
      ).catch((err) => {
        ocrWorkerPromise = null;
        throw new Error("OCR চালু করা যায়নি — ইন্টারনেট সংযোগ দেখুন। (" + err.message + ")");
      });
    }
    return ocrWorkerPromise;
  }
  let ocrProgressHandler = null;
  function setOcrProgressHandler(fn) { ocrProgressHandler = fn || null; }

  // ---------------------------------------------------------------- tiny IndexedDB key-value store
  // Used for autosave (the PDF bytes can be several MB -- far beyond localStorage's limit). Every
  // call fails soft (resolves undefined / false) when IndexedDB is unavailable, e.g. private mode.
  const IDB_NAME = "nothi", IDB_STORE = "kv";
  let idbPromise = null;
  function idbOpen() {
    if (!idbPromise) {
      idbPromise = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open(IDB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } catch (err) { reject(err); }
      });
      idbPromise.catch(() => { idbPromise = null; });
    }
    return idbPromise;
  }
  function idbRun(mode, fn) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }
  function idbGet(key) { return idbRun("readonly", (st) => st.get(key)).catch(() => undefined); }
  function idbSet(key, value) { return idbRun("readwrite", (st) => st.put(value, key)).then(() => true).catch(() => false); }
  function idbDel(key) { return idbRun("readwrite", (st) => st.delete(key)).then(() => true).catch(() => false); }

  // ---------------------------------------------------------------- offline support (PWA)
  // Only over http(s) -- service workers can't register from file://, and that's fine.
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("[Nothi] offline mode unavailable:", err));
    });
  }

  els.modalBackdrop.addEventListener("mousedown", (e) => {
    if (e.target === els.modalBackdrop) closeModals();
  });

export {
  els, state, FONT_LIBRARY, BN_FONT_READY,
  b64ToUint8Array, showToast, saveFileToDisk, downloadDataUrl, openModal, closeModals, fileBaseName,
  promptDialog, loadCryptoPdfLib, decryptPdfBytes, getOcrWorker, setOcrProgressHandler,
  idbGet, idbSet, idbDel,
};
