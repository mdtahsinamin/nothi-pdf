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
    els.nidJoinModal.hidden = true;
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

export {
  els, state, FONT_LIBRARY, BN_FONT_READY,
  b64ToUint8Array, showToast, saveFileToDisk, downloadDataUrl, openModal, closeModals,
};
