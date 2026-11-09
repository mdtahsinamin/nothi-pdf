// The core PDF viewing/editing engine: upload (incl. password-protected PDFs), render, every kind
// of box on the page (new text, edited original text, images, shapes), multi-select, drag/resize
// with smart guides, undo/redo, autosave, fillable forms, per-page OCR, and the export pipeline.
"use strict";
import {
  els, state, FONT_LIBRARY, BN_FONT_READY, b64ToUint8Array, showToast, saveFileToDisk, fileBaseName,
  promptDialog, decryptPdfBytes, getOcrWorker, setOcrProgressHandler, idbGet, idbSet, idbDel,
} from "./core.js";
import { removeTextInRects, removeImagesInRects, makeStandardWidthLookup } from "./pdf-text-remove.js";

  state.selection = new Set();
  state.shapeKind = "whiteout";
  state.formValues = {};
  state.hasForm = false;
  state.sourceFileName = "nothi";

  function hexToRgb01(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#1a1a1a") || [];
    return {
      r: parseInt(m[1] || "1a", 16) / 255,
      g: parseInt(m[2] || "1a", 16) / 255,
      b: parseInt(m[3] || "1a", 16) / 255,
    };
  }
  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  }
  const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
  function bnNum(n) { return String(n).replace(/\d/g, (d) => BN_DIGITS[d]); }
  function round1(v) { return Math.round(v * 10) / 10; }

  // ---------------------------------------------------------------- tool modes
  // select: pick/move boxes (rubber-band too) · edit: click the PDF's own text to change it ·
  // text: click anywhere to add new text · shape: drag to draw the chosen shape.
  const SHAPE_LABELS = {
    whiteout: "সাদা করে মুছুন", highlight: "হাইলাইট", rect: "আয়তক্ষেত্র", ellipse: "বৃত্ত",
    line: "লাইন", check: "টিক ✓", cross: "ক্রস ✗",
  };
  const SHAPE_DEFAULT_COLOR = {
    whiteout: "#ffffff", highlight: "#ffe14d", rect: "#d92d20", ellipse: "#d92d20",
    line: "#1a1a1a", check: "#0a7a3d", cross: "#d92d20",
  };
  function setMode(mode) {
    state.mode = mode;
    els.toolSelect.classList.toggle("active", mode === "select");
    els.toolEdit.classList.toggle("active", mode === "edit");
    els.toolText.classList.toggle("active", mode === "text");
    els.toolShape.classList.toggle("active", mode === "shape");
    ["text", "select", "edit", "shape"].forEach((m) => els.overlay.classList.toggle("mode-" + m, mode === m));
    closeShapeMenu();
    renderTextLayer();
  }
  els.toolSelect.addEventListener("click", () => setMode("select"));
  els.toolEdit.addEventListener("click", () => setMode("edit"));
  els.toolText.addEventListener("click", () => setMode("text"));

  function closeShapeMenu() { els.shapeMenu.hidden = true; els.toolShape.setAttribute("aria-expanded", "false"); }
  els.toolShape.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = els.shapeMenu.hidden;
    els.shapeMenu.hidden = !open;
    els.toolShape.setAttribute("aria-expanded", String(open));
  });
  els.shapeMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-shape]");
    if (!btn) return;
    state.shapeKind = btn.dataset.shape;
    els.shapeMenu.querySelectorAll("[data-shape]").forEach((b) => b.classList.toggle("active", b === btn));
    els.toolShapeIcon.setAttribute("href", "#i-shape-" + state.shapeKind);
    setMode("shape");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!els.shapeMenu.hidden && !els.shapeMenu.contains(e.target) && !els.toolShape.contains(e.target)) closeShapeMenu();
  });

  // A short line under the toolbar saying what a click does right now -- the #1 confusion in any
  // multi-mode editor is "why did clicking do nothing / the wrong thing".
  let hintTimer = null;
  function updateModeHint(textInfo) {
    clearTimeout(hintTimer);
    if (!state.pdfDoc) { els.modeHint.hidden = true; return; }
    els.modeHint.hidden = false;
    els.modeHint.classList.remove("quiet");
    els.modeHintAction.hidden = true;
    // the hint steps out of the way after a few seconds (it floats over the page top), unless it
    // carries an action such as "run OCR"
    hintTimer = setTimeout(() => { if (els.modeHintAction.hidden) els.modeHint.classList.add("quiet"); }, 5000);
    let msg = "";
    if (state.mode === "edit") {
      if (!textInfo) msg = "লেখা খোঁজা হচ্ছে...";
      else if (!textInfo.blocks.length) {
        msg = "এই পাতায় এডিটযোগ্য লেখা পাওয়া যায়নি — সম্ভবত স্ক্যান করা পাতা।";
        els.modeHintAction.hidden = false;
        els.modeHintAction.textContent = "OCR করে লেখা খুঁজুন";
      } else if (textInfo.source === "ocr") msg = "OCR করা লেখা — যেকোনো লাইনে ক্লিক করে বদলান।";
      else msg = "যেকোনো লেখায় ক্লিক করে সরাসরি বদলান — ফন্ট, সাইজ, রং নিজে থেকেই মিলিয়ে নেবে।";
    } else if (state.mode === "text") msg = "যেখানে লিখতে চান সেখানে ক্লিক করুন।";
    else if (state.mode === "select") msg = "বক্স বাছুন — Shift+ক্লিক বা ফাঁকা জায়গায় টেনে একসাথে অনেকগুলো।";
    else if (state.mode === "shape") msg = SHAPE_LABELS[state.shapeKind] + ": পাতায় টেনে আঁকুন (বা একবার ক্লিক করুন)।";
    els.modeHintText.textContent = msg;
  }
  els.modeHintAction.addEventListener("click", () => ocrCurrentPage());

  // ---------------------------------------------------------------- image / signature boxes
  // Not a persistent "mode" -- clicking it immediately opens a file picker, and the picked image is
  // dropped onto the current page pre-centered, ready to drag/resize like any other box.
  els.toolImage.addEventListener("click", () => {
    if (!state.pdfDoc) { showToast("প্রথমে একটা PDF আপলোড করুন।", "warn"); return; }
    els.imageBoxInput.click();
  });
  els.imageBoxInput.addEventListener("change", async (e) => {
    const file = (e.target.files && e.target.files[0]) || null;
    e.target.value = "";
    const target = replaceTarget;
    replaceTarget = null;
    if (file) await addImageBox(file, target);
  });

  function dataUrlMime(dataUrl) {
    const m = /^data:([^;]+);base64,/.exec(dataUrl || "");
    return m ? m[1] : "";
  }

  async function addImageBox(file, replaceId) {
    const rawDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = rawDataUrl;
    });

    // pdf-lib can only embed PNG/JPEG -- anything else (webp, gif, bmp, svg) is normalized to PNG
    // here, once, so the export step never has to guess or fail on an unsupported format later.
    let mime = dataUrlMime(rawDataUrl);
    let imageDataUrl = rawDataUrl;
    if (mime !== "image/png" && mime !== "image/jpeg") {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      imageDataUrl = canvas.toDataURL("image/png");
      mime = "image/png";
    }

    const aspect = img.naturalHeight / img.naturalWidth || 1;
    const existing = replaceId != null ? state.boxes.find((b) => b.id === replaceId) : null;
    if (existing) {
      // keep the old box's width and vertical center, adopt the new picture's proportions
      const cy = existing.yTopPdf - existing.heightPdf / 2;
      existing.imageDataUrl = imageDataUrl;
      existing.mime = mime;
      existing.heightPdf = existing.widthPdf * aspect;
      existing.yTopPdf = cy + existing.heightPdf / 2;
      renderBoxes();
      commit();
      showToast("ছবি বদলানো হয়েছে।", "success");
      return;
    }
    const { w: pageWidthPdf, h: pageHeightPdf } = pageSizePdf();
    const widthPdf = Math.min(180, pageWidthPdf * 0.4);
    const heightPdf = widthPdf * aspect;
    const cx = pageWidthPdf / 2, cy = pageHeightPdf / 2;

    const box = {
      id: state.nextId++,
      page: state.currentPage,
      type: "image",
      xPdf: cx - widthPdf / 2,
      yTopPdf: cy + heightPdf / 2,
      widthPdf, heightPdf,
      imageDataUrl, mime,
    };
    state.boxes.push(box);
    setSelection([box.id]);
    renderBoxes();
    commit();
    showToast("ছবি বসানো হয়েছে — টেনে সরান, কোণা ধরে সাইজ বদলান।", "info");
  }

  function pageSizePdf() {
    return state.viewport
      ? { w: state.viewport.width / state.scale, h: state.viewport.height / state.scale }
      : { w: 595, h: 842 };
  }

  // ---------------------------------------------------------------- upload / open
  function openPicker() { els.fileInput.click(); }
  els.btnUpload.addEventListener("click", openPicker);
  els.btnUpload2.addEventListener("click", openPicker);

  function hasUnsavedWork() {
    return !!state.pdfBytes && (state.boxes.length > 0 || Object.keys(state.formValues).length > 0);
  }

  // Clicking the logo returns to the landing page.
  function goHome() {
    if (hasUnsavedWork()) {
      const ok = confirm("হোম পেজে ফিরে গেলে বর্তমান এডিট মুছে যাবে। চালিয়ে যাবেন?");
      if (!ok) return;
    }
    clearAutosave();
    state.pdfBytes = null;
    state.pdfDoc = null;
    state.numPages = 0;
    state.currentPage = 1;
    state.boxes = [];
    state.formValues = {};
    state.hasForm = false;
    setSelection([]);
    state.deletedRestoredBoxes = [];
    textBlockCache.clear();
    imageBlockCache.clear();
    formAnnotCache.clear();
    resetHistory();
    els.stage.style.display = "none";
    els.statusBar.style.display = "none";
    els.sidebar.style.display = "none";
    els.sidebar.innerHTML = "";
    els.btnDownload.disabled = true;
    els.uploadLabel.textContent = "PDF আপলোড";
    els.emptyState.style.display = "";
    document.body.classList.remove("editing");
    els.modeHint.hidden = true;
    setMode("edit");
    checkAutosave();
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
        if (f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name))) handleFile(f);
        else if (f) showToast("শুধু PDF ফাইল দিন।", "warn");
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
    if (hasUnsavedWork()) {
      const ok = confirm("নতুন PDF লোড করলে বর্তমান এডিট মুছে যাবে। চালিয়ে যাবেন?");
      if (!ok) return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openDocument(bytes, fileBaseName(file, "nothi"));
  }

  // Password prompt that retries in place on a wrong password; resolves decrypted bytes or null.
  async function askPasswordAndDecrypt(bytes, note) {
    let decrypted = null;
    const value = await promptDialog({
      title: "এই PDF পাসওয়ার্ড দিয়ে সুরক্ষিত",
      note: note || "খুলতে পাসওয়ার্ড দিন। (পাসওয়ার্ড শুধু আপনার ব্রাউজারেই ব্যবহার হয়, কোথাও পাঠানো হয় না।)",
      type: "password", okLabel: "খুলুন", okIcon: "unlock",
      validate: async (pw) => {
        try { decrypted = await decryptPdfBytes(bytes, pw); return null; }
        catch (err) { return err.message; }
      },
    });
    return value == null ? null : decrypted;
  }

  // opts.restore: an autosave record to apply after loading (boxes, form values, page).
  async function openDocument(bytes, name, opts = {}) {
    showLoading("PDF লোড হচ্ছে...");
    try {
      await BN_FONT_READY;
      let doc;
      try {
        doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      } catch (err) {
        if (err && err.name === "PasswordException") {
          hideLoading();
          const dec = await askPasswordAndDecrypt(bytes);
          if (!dec) return false;
          bytes = dec;
          showLoading("PDF লোড হচ্ছে...");
          doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        } else {
          console.error(err);
          showToast("এই PDF ফাইলটি খোলা যায়নি — ফাইলটি ক্ষতিগ্রস্ত হতে পারে।", "error");
          return false;
        }
      }

      // pdf.js opens "owner-password" PDFs (no password needed to view) fine, but pdf-lib refuses
      // to modify them -- strip that restriction now so export can't fail later.
      let metaDoc = null;
      try {
        metaDoc = await PDFLib.PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
        if (metaDoc.isEncrypted) {
          try {
            bytes = await decryptPdfBytes(bytes, "");
            metaDoc = await PDFLib.PDFDocument.load(bytes.slice());
          } catch (err) {
            console.warn("[Nothi] couldn't lift owner restrictions:", err);
          }
        }
      } catch (err) {
        console.error("[Nothi] pdf-lib couldn't parse this PDF:", err);
      }

      if (state.pdfDoc && state.pdfDoc !== doc) { try { state.pdfDoc.destroy(); } catch (err) { /* ignore */ } }
      state.pdfBytes = bytes;
      state.sourceFileName = name || "nothi";
      state.pdfDoc = doc;
      state.numPages = doc.numPages;
      state.currentPage = 1;
      state.scale = state.baseScale;
      state.boxes = [];
      state.formValues = {};
      state.deletedRestoredBoxes = [];
      setSelection([]);
      textBlockCache.clear();
      imageBlockCache.clear();
      formAnnotCache.clear();

      // Boxes from an earlier Nothi export live inside the PDF itself -- restore them so editing
      // continues exactly where it left off.
      state.hasForm = false;
      if (metaDoc) {
        try {
          state.hasForm = metaDoc.getForm().getFields().length > 0;
        } catch (err) { state.hasForm = false; }
        try {
          const ref = metaDoc.catalog.get(PDFLib.PDFName.of("NothiProjectData"));
          if (ref) {
            const streamObj = metaDoc.context.lookup(ref);
            const contents = streamObj.getContents ? streamObj.getContents() : streamObj.contents;
            const payload = JSON.parse(new TextDecoder().decode(contents));
            if (payload && Array.isArray(payload.boxes)) {
              state.boxes = payload.boxes.map((b) => {
                const { id: _oldId, _orig: _oldOrig, ...rest } = b;
                const restored = { ...rest, id: state.nextId++ };
                restored._orig = { ...rest };
                return restored;
              });
              console.log(`[Nothi] restored ${state.boxes.length} box(es) from this PDF's saved data.`);
            }
          }
        } catch (err) {
          console.error("[Nothi] found saved project data but couldn't read it:", err);
          showToast("এই PDF-এ আগের এডিট করা তথ্য পাওয়া গেছে, কিন্তু পড়া যায়নি: " + err.message, "error");
        }
      }

      if (opts.restore) {
        const r = opts.restore;
        if (r.scale) state.scale = r.scale;
        state.boxes = (r.boxes || []).map((b) => ({ ...b }));
        state.nextId = Math.max(state.nextId, ...state.boxes.map((b) => b.id + 1));
        state.deletedRestoredBoxes = (r.deleted || []).slice();
        state.formValues = { ...(r.formValues || {}) };
        if (r.page >= 1 && r.page <= state.numPages) state.currentPage = r.page;
      }

      els.uploadLabel.textContent = "নতুন PDF";
      els.emptyState.style.display = "none";
      els.stage.style.display = "block";
      els.statusBar.style.display = "flex";
      els.sidebar.style.display = "flex";
      els.btnDownload.disabled = false;
      document.body.classList.add("editing");
      resetHistory();
      if (!(opts.restore && opts.restore.scale)) await fitPageToViewport();
      setMode(opts.restore && opts.restore.mode ? opts.restore.mode : "edit");
      await renderPage();
      renderThumbnails();
      saveAutosavePdf();
      if (opts.silent) { /* page operation -- the caller shows its own message */ }
      else if (opts.restore) showToast("আগের কাজ ফিরিয়ে আনা হয়েছে।", "success");
      else if (state.hasForm) showToast("এই PDF-এ পূরণযোগ্য ফর্ম আছে — সরাসরি ঘরগুলোতে লিখুন।", "info");
      return true;
    } catch (err) {
      console.error(err);
      showToast("PDF খুলতে সমস্যা হয়েছে: " + err.message, "error");
      return false;
    } finally {
      hideLoading();
    }
  }

  // ---------------------------------------------------------------- render
  // Picks the opening zoom so the whole first page is visible ("100%" = fits the window).
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
      // Whole page visible, but never narrower than ~62% of the workspace -- on a wide screen a
      // full-height A4 is too small to edit comfortably. Taller pages simply scroll (and the
      // wheel continues onto the next page at the bottom edge).
      const fitWidth = availW / vp.width;
      const fit = Math.min(fitWidth, Math.max(availH / vp.height, (availW * 0.62) / vp.width));
      if (!isFinite(fit) || fit <= 0) return;
      state.baseScale = Math.max(0.2, Math.min(fit, 3));
      state.scale = state.baseScale;
    } catch (err) {
      console.warn("[Nothi] couldn't auto-fit the page, using the default zoom.", err);
    }
  }

  // Rapid zoom/page clicks used to start overlapping pdf.js renders into the same canvas
  // ("Cannot use the same canvas during multiple render operations"). Each render now cancels
  // the previous one, and a stale render never touches the DOM.
  let renderSeq = 0;
  let currentRenderTask = null;
  async function renderPage() {
    const seq = ++renderSeq;
    const page = await state.pdfDoc.getPage(state.currentPage);
    if (seq !== renderSeq) return;
    if (currentRenderTask) {
      currentRenderTask.cancel();
      try { await currentRenderTask.promise; } catch (err) { /* cancelled */ }
      if (seq !== renderSeq) return;
    }
    const viewport = page.getViewport({ scale: state.scale });
    state.viewport = viewport;

    const outputScale = window.devicePixelRatio || 1;
    els.canvas.width = Math.floor(viewport.width * outputScale);
    els.canvas.height = Math.floor(viewport.height * outputScale);
    els.canvas.style.width = viewport.width + "px";
    els.canvas.style.height = viewport.height + "px";
    els.stage.style.width = viewport.width + "px";
    els.stage.style.height = viewport.height + "px";

    els.pageNum.value = String(state.currentPage);
    els.pageNum.max = String(state.numPages);
    els.pageCount.textContent = String(state.numPages);
    els.zoomLabel.textContent = Math.round((state.scale / state.baseScale) * 100) + "%";
    els.btnPrev.disabled = state.currentPage <= 1;
    els.btnNext.disabled = state.currentPage >= state.numPages;
    renderBoxes();
    updateThumbActive();

    const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
    ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);
    const task = page.render({
      canvasContext: ctx, viewport,
      // with a fillable form, pdf.js leaves the fields off the canvas and our own inputs take
      // their place (otherwise the old value would show through behind the new one)
      annotationMode: state.hasForm ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE,
    });
    currentRenderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === "RenderingCancelledException") return;
      throw err;
    } finally {
      if (currentRenderTask === task) currentRenderTask = null;
    }
    if (seq !== renderSeq) return;
    renderTextLayer();
    renderFormLayer();
  }

  // Thumbnails render lazily as they scroll into view -- a 200-page PDF used to render all 200
  // up front, freezing the tab for seconds before the first page was even usable.
  let thumbObserver = null;
  function renderThumbnails() {
    els.sidebar.innerHTML = "";
    if (thumbObserver) thumbObserver.disconnect();
    const doc = state.pdfDoc;
    thumbObserver = "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          entries.forEach((en) => {
            if (!en.isIntersecting) return;
            thumbObserver.unobserve(en.target);
            drawThumb(en.target, doc);
          });
        }, { root: els.sidebar, rootMargin: "300px 0px" })
      : null;
    for (let i = 1; i <= state.numPages; i++) {
      const wrap = document.createElement("button");
      wrap.type = "button";
      wrap.className = "thumb" + (i === state.currentPage ? " active" : "");
      wrap.dataset.page = String(i);
      wrap.setAttribute("aria-label", "পাতা " + i);
      const canvas = document.createElement("canvas");
      canvas.style.width = "108px";
      canvas.style.height = "140px";
      const label = document.createElement("div");
      label.className = "thumb-label mono";
      label.textContent = String(i);
      const actions = document.createElement("div");
      actions.className = "thumb-actions";
      [["rotate", "ঘোরান", () => pageRotateOp(i)], ["copy", "পাতার কপি", () => pageDuplicateOp(i)],
       ["plus", "এর পরে ফাঁকা পাতা", () => pageInsertBlankOp(i)], ["trash", "পাতা মুছুন", () => pageDeleteOp(i)]]
        .forEach(([icon, title, fn]) => {
          const b = document.createElement("span");
          b.className = "thumb-act" + (icon === "trash" ? " danger" : "");
          b.setAttribute("role", "button");
          b.title = title;
          b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-' + icon + '"/></svg>';
          b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
          actions.appendChild(b);
        });
      wrap.appendChild(canvas);
      wrap.appendChild(label);
      wrap.appendChild(actions);
      els.sidebar.appendChild(wrap);
      wrap.addEventListener("click", () => goToPage(i, "top"));
      wrap.draggable = true;
      wrap.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-nothi-page", String(i)); wrap.classList.add("dragging"); });
      wrap.addEventListener("dragend", () => wrap.classList.remove("dragging"));
      wrap.addEventListener("dragover", (e) => {
        if (![...e.dataTransfer.types].includes("text/x-nothi-page")) return;
        e.preventDefault();
        wrap.classList.add("drop-target");
      });
      wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-target"));
      wrap.addEventListener("drop", (e) => {
        wrap.classList.remove("drop-target");
        const from = parseInt(e.dataTransfer.getData("text/x-nothi-page"), 10);
        if (from) { e.preventDefault(); pageMoveOp(from, i); }
      });
      if (thumbObserver) thumbObserver.observe(wrap); else drawThumb(wrap, doc);
    }
    const add = document.createElement("div");
    add.className = "thumb-add";
    add.innerHTML =
      '<button type="button" class="thumb-add-btn" data-act="blank"><svg class="ic" aria-hidden="true"><use href="#i-plus"/></svg><span>ফাঁকা পাতা</span></button>' +
      '<button type="button" class="thumb-add-btn" data-act="pdf"><svg class="ic" aria-hidden="true"><use href="#i-file-plus"/></svg><span>PDF জুড়ুন</span></button>';
    add.querySelector('[data-act="blank"]').addEventListener("click", () => pageInsertBlankOp(state.numPages));
    add.querySelector('[data-act="pdf"]').addEventListener("click", () => { insertPdfAfter = state.numPages; els.insertPdfInput.click(); });
    els.sidebar.appendChild(add);
  }
  async function drawThumb(wrap, doc) {
    if (doc !== state.pdfDoc) return;
    const i = Number(wrap.dataset.page);
    const canvas = wrap.querySelector("canvas");
    try {
      const page = await doc.getPage(i);
      const baseVp = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 108 / baseVp.width });
      const s = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * s);
      canvas.height = Math.floor(vp.height * s);
      canvas.style.width = vp.width + "px";
      canvas.style.height = vp.height + "px";
      const tctx = canvas.getContext("2d");
      tctx.setTransform(s, 0, 0, s, 0, 0);
      await page.render({ canvasContext: tctx, viewport: vp }).promise;
    } catch (err) {
      console.warn("[Nothi] thumbnail failed for page " + i, err);
    }
  }
  function updateThumbActive() {
    els.sidebar.querySelectorAll(".thumb").forEach((t) => {
      const on = Number(t.dataset.page) === state.currentPage;
      t.classList.toggle("active", on);
      if (on && t.scrollIntoView && document.body.classList.contains("editing")) {
        t.scrollIntoView({ block: "nearest" });
      }
    });
  }
  // scrollTo: "top" | "bottom" | undefined -- where to land on the new page (wheel/arrow paging
  // lands at the edge you came from, like a continuous document).
  async function goToPage(n, scrollTo) {
    if (n < 1 || n > state.numPages || n === state.currentPage) return;
    state.currentPage = n;
    setSelection([]);
    await renderPage();
    if (scrollTo === "top") els.stageWrap.scrollTop = 0;
    else if (scrollTo === "bottom") els.stageWrap.scrollTop = els.stageWrap.scrollHeight;
    scheduleAutosave();
  }
  els.pageNum.addEventListener("change", () => {
    const n = parseInt(els.pageNum.value, 10);
    if (n >= 1 && n <= state.numPages) goToPage(n, "top");
    else els.pageNum.value = String(state.currentPage);
  });
  els.pageNum.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); els.pageNum.blur(); }
  });
  els.pageNum.addEventListener("focus", () => els.pageNum.select());

  // Mouse wheel / touchpad: scrolling past the bottom of a page continues onto the next one (and
  // up past the top onto the previous one). A little extra push at the edge is needed first, so a
  // touchpad's momentum doesn't fly through several pages.
  let edgePush = 0, edgeDir = 0, pageFlipLock = 0;
  els.stageWrap.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey || !state.pdfDoc || state.numPages < 2) return;
    const sw = els.stageWrap;
    const atBottom = sw.scrollTop + sw.clientHeight >= sw.scrollHeight - 2;
    const atTop = sw.scrollTop <= 1;
    const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
    if (!dir || (dir > 0 && !atBottom) || (dir < 0 && !atTop)) { edgePush = 0; return; }
    if ((dir > 0 && state.currentPage >= state.numPages) || (dir < 0 && state.currentPage <= 1)) return;
    e.preventDefault();
    if (Date.now() < pageFlipLock) return;
    if (dir !== edgeDir) { edgeDir = dir; edgePush = 0; }
    edgePush += Math.abs(e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY);
    // a page that fits entirely on screen has nothing to scroll -- flip on the first real notch
    const fits = sw.scrollHeight <= sw.clientHeight + 2;
    if (edgePush < (fits ? 40 : 160)) return;
    edgePush = 0;
    pageFlipLock = Date.now() + 350;
    goToPage(state.currentPage + dir, dir > 0 ? "top" : "bottom");
  }, { passive: false });

  // ---------------------------------------------------------------- page numbers
  function parsePageRange(text, max) {
    const t = (text || "").trim();
    if (!t) return Array.from({ length: max }, (_, i) => i + 1);
    const set = new Set();
    t.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d))).split(/[,\s]+/).forEach((part) => {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) return;
      let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(max, b); i++) set.add(i);
    });
    return [...set].sort((x, y) => x - y);
  }
  let measureCtx = null;
  function measureTextPdf(text, fontKey, size) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = "400 " + size + "px " + (FONT_LIBRARY[fontKey] || FONT_LIBRARY.hind).cssFamily;
    return measureCtx.measureText(text).width;
  }
  els.btnPageNumbers.addEventListener("click", () => {
    if (!state.pdfDoc) return;
    els.modalBackdrop.hidden = false;
    els.pageNumModal.hidden = false;
  });
  els.pnCancelBtn.addEventListener("click", () => { els.modalBackdrop.hidden = true; els.pageNumModal.hidden = true; });
  els.pnApplyBtn.addEventListener("click", async () => {
    const pagesSel = parsePageRange(els.pnRange.value, state.numPages);
    if (!pagesSel.length) { showToast("পাতার সীমা ঠিকভাবে লিখুন, যেমন 2-5 অথবা ফাঁকা রাখুন (সব পাতা)।", "warn"); return; }
    const start = parseInt(els.pnStart.value, 10) || 1;
    const size = Math.max(6, Math.min(36, parseFloat(els.pnSize.value) || 11));
    const fmt = els.pnFormat.value, pos = els.pnPosition.value, bn = els.pnDigits.value === "bn";
    const total = state.numPages + start - 1;
    const sel = new Set(pagesSel);
    // re-running replaces earlier page numbers instead of stacking a second set
    state.boxes = state.boxes.filter((b) => !(b.pageNumber && sel.has(b.page)));
    const fontKey = bn ? "hind" : "tinos";
    for (const pg of pagesSel) {
      const n = pg + start - 1;
      const N = (v) => (bn ? bnNum(v) : String(v));
      const text = fmt === "n" ? N(n)
        : fmt === "dash" ? "— " + N(n) + " —"
        : fmt === "of" ? (bn ? "পাতা " + N(n) + " / " + N(total) : "Page " + n + " of " + total)
        : (bn ? "পৃষ্ঠা " + N(n) : "Page " + n);
      const page = await state.pdfDoc.getPage(pg);
      const [vx0, vy0, vx1, vy1] = page.view;
      const w = measureTextPdf(text, fontKey, size);
      const margin = 26;
      const xs = { left: vx0 + margin, center: (vx0 + vx1) / 2 - w / 2, right: vx1 - margin - w };
      const [vert, horiz] = pos.split("-");
      const baseline = vert === "top" ? vy1 - margin - size * 0.8 : vy0 + margin;
      state.boxes.push({
        id: state.nextId++, page: pg, type: "text",
        xPdf: xs[horiz], yTopPdf: baseline + BASELINE_RATIO * size, widthPdf: w + size * 1.5,
        fontSize: size, bold: false, color: "#333333", fontKey, autoFont: false, text, pageNumber: true,
      });
    }
    els.modalBackdrop.hidden = true;
    els.pageNumModal.hidden = true;
    renderBoxes();
    commit();
    showToast(bnNum(pagesSel.length) + "টি পাতায় নম্বর বসানো হয়েছে — যেকোনোটা ক্লিক করে বদলাতে বা সরাতে পারবেন।", "success");
  });

  // ---------------------------------------------------------------- page operations (sidebar)
  // Insert / delete / rotate / duplicate / reorder pages and append another PDF, right inside the
  // editor. The document is rebuilt with pdf-lib and reopened; every box follows its page.
  // The step before each page operation is kept so Undo can go back across it.
  const pageUndoStack = [];
  async function restructurePages(mutate, message) {
    if (history.timer) commit();
    let doc;
    try {
      doc = await PDFLib.PDFDocument.load(state.pdfBytes.slice());
    } catch (err) {
      showToast("পাতা বদলানো যায়নি: " + err.message, "error");
      return;
    }
    showLoading("পাতা সাজানো হচ্ছে...");
    let map, extraBoxes = [], newCurrent;
    try {
      const r = await mutate(doc);
      if (!r) { hideLoading(); return; }
      map = r.map;
      extraBoxes = r.extraBoxes || [];
      newCurrent = r.current;
    } catch (err) {
      hideLoading();
      console.error(err);
      showToast("পাতা বদলানো যায়নি: " + err.message, "error");
      return;
    }
    const bytes = await doc.save();
    const remapKey = (k, np) => (k ? k.replace(/^\d+:/, np + ":") : k);
    const moveBox = (b) => {
      const np = map(b.page);
      if (!np) return null;
      const nb = { ...b, page: np };
      if (b.sourceKey) nb.sourceKey = remapKey(b.sourceKey, np);
      if (b._orig) nb._orig = { ...b._orig, page: np };
      return nb;
    };
    pageUndoStack.push({ bytes: state.pdfBytes, snap: snapshot(), page: state.currentPage, scale: state.scale, mode: state.mode });
    if (pageUndoStack.length > 10) pageUndoStack.shift();
    const boxes = state.boxes.map(moveBox).filter(Boolean).concat(extraBoxes);
    const deleted = state.deletedRestoredBoxes.map((o) => { const np = map(o.page); return np ? { ...o, page: np } : null; }).filter(Boolean);
    hideLoading();
    const ok = await openDocument(bytes, state.sourceFileName, {
      silent: true,
      restore: { boxes, deleted, formValues: state.formValues, page: newCurrent || map(state.currentPage) || 1, scale: state.scale, mode: state.mode },
    });
    if (ok) {
      updateUndoButtons();
      if (message) showToast(message, "success", 2500);
    }
  }
  async function undoPageOperation() {
    const prev = pageUndoStack.pop();
    if (!prev) return;
    await openDocument(prev.bytes, state.sourceFileName, {
      silent: true,
      restore: { boxes: prev.snap.boxes, deleted: prev.snap.deleted, formValues: prev.snap.formValues, page: prev.page, scale: prev.scale, mode: prev.mode },
    });
    updateUndoButtons();
    showToast("পাতার আগের অবস্থা ফিরিয়ে আনা হয়েছে।", "info", 2500);
  }

  function pageDeleteOp(p) {
    if (state.numPages <= 1) { showToast("একমাত্র পাতাটা মোছা যাবে না।", "warn"); return; }
    const n = state.boxes.filter((b) => b.page === p).length;
    if (n && !confirm("পাতা " + bnNum(p) + "-এ আপনার " + bnNum(n) + "টি এডিট আছে। পাতাটা মুছবেন?")) return;
    restructurePages(async (doc) => {
      doc.removePage(p - 1);
      return { map: (i) => (i < p ? i : i === p ? null : i - 1), current: Math.min(p, state.numPages - 1) };
    }, "পাতা " + bnNum(p) + " মুছে ফেলা হয়েছে।");
  }
  function pageRotateOp(p) {
    restructurePages(async (doc) => {
      const pg = doc.getPage(p - 1);
      pg.setRotation(PDFLib.degrees(((pg.getRotation().angle || 0) + 90) % 360));
      return { map: (i) => i, current: p };
    });
  }
  function pageDuplicateOp(p) {
    restructurePages(async (doc) => {
      const [copy] = await doc.copyPages(doc, [p - 1]);
      doc.insertPage(p, copy);
      // the copy carries the same original content, so this page's edits are copied with it
      const extra = state.boxes.filter((b) => b.page === p).map((b) => {
        const nb = { ...b, id: state.nextId++, page: p + 1 };
        if (b.sourceKey) nb.sourceKey = b.sourceKey.replace(/^\d+:/, (p + 1) + ":");
        if (b._orig) nb._orig = { ...b._orig, page: p + 1 };
        return nb;
      });
      return { map: (i) => (i <= p ? i : i + 1), extraBoxes: extra, current: p + 1 };
    }, "পাতা " + bnNum(p) + "-এর কপি যোগ হয়েছে।");
  }
  function pageInsertBlankOp(after) {
    restructurePages(async (doc) => {
      const ref = doc.getPage(Math.max(0, after - 1));
      const { width, height } = ref.getSize();
      doc.insertPage(after, [width, height]);
      return { map: (i) => (i <= after ? i : i + 1), current: after + 1 };
    }, "ফাঁকা পাতা যোগ হয়েছে।");
  }
  function pageMoveOp(from, to) {
    if (from === to) return;
    restructurePages(async (doc) => {
      const [copy] = await doc.copyPages(doc, [from - 1]);
      doc.removePage(from - 1);
      doc.insertPage(to - 1, copy);
      const map = (i) => {
        if (i === from) return to;
        if (from < to && i > from && i <= to) return i - 1;
        if (from > to && i >= to && i < from) return i + 1;
        return i;
      };
      return { map, current: to };
    });
  }
  async function pageInsertPdfOp(file, after) {
    let bytes = new Uint8Array(await file.arrayBuffer());
    let other;
    try {
      other = await PDFLib.PDFDocument.load(bytes.slice());
    } catch (err) {
      if (/encrypt/i.test(err.message || "")) {
        const dec = await askPasswordAndDecrypt(bytes, "যে PDF যোগ করছেন সেটা পাসওয়ার্ড দিয়ে সুরক্ষিত — পাসওয়ার্ড দিন।");
        if (!dec) return;
        other = await PDFLib.PDFDocument.load(dec);
      } else { showToast("এই PDF যোগ করা যায়নি: " + err.message, "error"); return; }
    }
    const count = other.getPageCount();
    restructurePages(async (doc) => {
      const copies = await doc.copyPages(other, other.getPageIndices());
      copies.forEach((pg, k) => doc.insertPage(after + k, pg));
      return { map: (i) => (i <= after ? i : i + count), current: after + 1 };
    }, bnNum(count) + "টি পাতা যোগ হয়েছে।");
  }
  els.insertPdfInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) pageInsertPdfOp(f, insertPdfAfter);
  });
  let insertPdfAfter = 0;

  // ---------------------------------------------------------------- coordinates
  function pdfToCss(xPdf, yPdf) {
    const p = state.viewport.convertToViewportPoint(xPdf, yPdf);
    return { x: p[0], y: p[1] };
  }
  function cssToPdf(xCss, yCss) {
    const p = state.viewport.convertToPdfPoint(xCss, yCss);
    return { x: p[0], y: p[1] };
  }
  function pdfRectToCss(x, y, w, h) {
    const a = pdfToCss(x, y), b = pdfToCss(x + w, y + h);
    return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }

  function autoResizeTextarea(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  // ---------------------------------------------------------------- text box geometry
  // The export draws a text box's first baseline at yTopPdf - 0.82*fontSize. The on-screen
  // textarea is positioned so its first baseline lands on exactly that spot (measured from the
  // real font's metrics), so what you see while editing is where the text ends up in the PDF --
  // essential when retyping text in place over the original.
  const BASELINE_RATIO = 0.82;
  const DEFAULT_LINE_HEIGHT = 1.35;
  const TEXT_INSET_X = 4;  // 1px border + 3px textarea padding
  const TEXT_INSET_Y = 2;  // 1px border + 1px textarea padding
  const metricCache = new Map();
  let metricCtx = null;
  function fontMetrics(fontKey, bold) {
    const key = (fontKey || "hind") + (bold ? "-b" : "");
    if (metricCache.has(key)) return metricCache.get(key);
    if (!metricCtx) metricCtx = document.createElement("canvas").getContext("2d");
    metricCtx.font = (bold ? "700" : "400") + " 100px " + (FONT_LIBRARY[fontKey] || FONT_LIBRARY.hind).cssFamily;
    const m = metricCtx.measureText("অকগHxg");
    let asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
    const ok = asc > 0 && desc >= 0;
    if (!ok) { asc = 92; desc = 28; }
    const r = { asc: asc / 100, desc: desc / 100 };
    if (ok) metricCache.set(key, r);
    return r;
  }
  function lineHeightOf(box) { return box.lineHeight || DEFAULT_LINE_HEIGHT; }
  function baselineOffsetCss(box) {
    const px = box.fontSize * state.scale;
    const m = fontMetrics(box.fontKey, box.bold);
    const L = lineHeightOf(box) * px;
    return TEXT_INSET_Y + (L - (m.asc + m.desc) * px) / 2 + m.asc * px;
  }
  function boxCssPos(box) {
    if (box.type === "text") {
      const p = pdfToCss(box.xPdf, box.yTopPdf - BASELINE_RATIO * box.fontSize);
      return { left: p.x - TEXT_INSET_X, top: p.y - baselineOffsetCss(box) };
    }
    const p = pdfToCss(box.xPdf, box.yTopPdf);
    return { left: p.x, top: p.y };
  }
  function pdfPosFromCss(box, left, top) {
    if (box.type === "text") {
      const p = cssToPdf(left + TEXT_INSET_X, top + baselineOffsetCss(box));
      return { xPdf: p.x, yTopPdf: p.y + BASELINE_RATIO * box.fontSize };
    }
    const p = cssToPdf(left, top);
    return { xPdf: p.x, yTopPdf: p.y };
  }
  function boxEl(id) { return els.overlay.querySelector('.textbox[data-id="' + id + '"]'); }
  function placeBoxEl(box, el) {
    const pos = boxCssPos(box);
    el.style.left = pos.left + "px";
    el.style.top = pos.top + "px";
  }

  // ---------------------------------------------------------------- overlay layers
  function ensureLayer(cls) {
    let layer = els.overlay.querySelector(":scope > ." + cls);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "ov-layer " + cls;
      els.overlay.insertBefore(layer, els.overlay.firstChild);
    }
    return layer;
  }

  function renderBoxes() {
    els.overlay.querySelectorAll(".textbox").forEach((n) => n.remove());
    renderCovers();
    state.boxes
      .filter((b) => b.page === state.currentPage)
      .forEach((box) => {
        const el = buildBoxEl(box);
        els.overlay.appendChild(el);
        const ta = el.querySelector(".tb-content");
        if (ta) autoResizeTextarea(ta);
      });
    refreshSelectionUI();
  }

  // Edited-text boxes hide the original words under them on screen with a patch in the page's
  // own background color (sampled when editing started); the patch stays put if the new text is
  // moved, exactly like the export.
  function renderCovers() {
    const layer = ensureLayer("cover-layer");
    layer.innerHTML = "";
    state.boxes.forEach((b) => {
      if (b.page !== state.currentPage || !b.cover || (b.type !== "text" && b.type !== "image")) return;
      const r = pdfRectToCss(b.cover.x, b.cover.y, b.cover.w, b.cover.h);
      const d = document.createElement("div");
      d.className = "tb-cover";
      d.style.left = r.left + "px";
      d.style.top = r.top + "px";
      d.style.width = r.width + "px";
      d.style.height = r.height + "px";
      d.style.background = b.cover.color || "#ffffff";
      layer.appendChild(d);
    });
  }

  function makeDeleteHandle(box) {
    const del = document.createElement("div");
    del.className = "tb-del";
    del.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';
    del.title = "মুছুন";
    // Only a press that STARTED on this handle deletes. On touch screens, the click that follows
    // the tap which created the box lands at the same spot -- often exactly on this new handle --
    // and used to delete the box the instant it appeared.
    let armed = false;
    del.addEventListener("pointerdown", (e) => { e.stopPropagation(); armed = true; });
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!armed) return;
      armed = false;
      deleteBoxes([box.id]);
    });
    return del;
  }

  const CHECK_PATH = "M4 12.5 9.5 18 20 6";
  const CROSS_PATH = "M5 5 19 19M19 5 5 19";

  function buildBoxEl(box) {
    const pos = boxCssPos(box);
    const div = document.createElement("div");
    div.className = "textbox" + (state.selection.has(box.id) ? " selected" : "");
    div.dataset.id = String(box.id);
    div.style.left = pos.left + "px";
    div.style.top = pos.top + "px";

    if (box.type === "image" || box.type === "shape") {
      div.style.width = box.widthPdf * state.scale + "px";
      div.style.height = box.heightPdf * state.scale + "px";
      let inner;
      if (box.type === "image") {
        div.classList.add("imgbox");
        inner = document.createElement("img");
        inner.className = "imgbox-content";
        inner.src = box.imageDataUrl;
        inner.draggable = false;
        inner.alt = "";
      } else {
        div.classList.add("shapebox", "shape-" + box.shape);
        inner = document.createElement("div");
        inner.className = "shape-content";
        styleShapeInner(box, inner);
      }
      const handle = document.createElement("div");
      if (box.type === "shape" && box.shape === "line") {
        handle.className = "tb-resize";
        handle.title = "টেনে লম্বা/ছোট করুন";
        handle.addEventListener("pointerdown", (e) => startResize(e, box, div, "x"));
      } else {
        handle.className = "tb-resize-corner";
        handle.title = "টেনে সাইজ বদলান";
        const keep = box.type === "image" || box.shape === "check" || box.shape === "cross";
        handle.addEventListener("pointerdown", (e) => startResize(e, box, div, keep ? "aspect" : "xy"));
      }
      div.addEventListener("pointerdown", (e) => {
        if (e.target !== div && e.target !== inner && !inner.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        onBoxPointerDown(e, box, div);
      });
      div.appendChild(inner);
      div.appendChild(makeDeleteHandle(box));
      div.appendChild(handle);
      return div;
    }

    // ---- text box
    div.style.width = box.widthPdf * state.scale + "px";
    if (box.cover) div.classList.add("edited");
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "tb-resize";
    resizeHandle.title = "টেনে চৌড়া বাড়ান/কমান";

    // A real <textarea> (not contenteditable): IME/composition input -- how Bangla is typed
    // (Avro and friends) -- is only reliable in native form controls.
    const content = document.createElement("textarea");
    content.className = "tb-content";
    content.rows = 1;
    content.spellcheck = false;
    content.placeholder = box.unreliable ? "এই লেখাটা পড়া যায়নি — নতুন করে লিখুন" : "টাইপ করুন...";
    applyTextStyle(box, content);
    content.value = box.text || "";

    content.addEventListener("input", () => { box.text = content.value; autoResizeTextarea(content); commitSoon(); });
    content.addEventListener("focus", () => { if (!state.selection.has(box.id) || state.selection.size > 1) setSelection([box.id]); });
    content.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.shiftKey) { e.preventDefault(); toggleSelection(box.id); }
    });
    content.addEventListener("blur", (e) => {
      const goingTo = e.relatedTarget;
      if (goingTo && els.floatingBar.contains(goingTo)) return;
      setTimeout(() => {
        const active = document.activeElement;
        if (active === content || els.floatingBar.contains(active)) return;
        if (!state.boxes.includes(box)) return;
        if (!box.text || !box.text.trim()) {
          discardIfEmpty(box);
        } else if (state.selectedId === box.id && state.selection.size === 1) {
          setSelection([]);
        }
      }, 150);
    });

    resizeHandle.addEventListener("pointerdown", (e) => startResize(e, box, div, "x"));
    div.addEventListener("pointerdown", (e) => {
      if (e.target !== div) return;
      e.preventDefault();
      onBoxPointerDown(e, box, div);
    });

    div.appendChild(makeDeleteHandle(box));
    div.appendChild(resizeHandle);
    div.appendChild(content);

    if (box.id === state.pendingFocusId) {
      state.pendingFocusId = null;
      requestAnimationFrame(() => {
        content.focus();
        const end = content.value.length;
        try { content.setSelectionRange(end, end); } catch (err) { /* fine */ }
      });
    }
    return div;
  }

  function applyTextStyle(box, content) {
    content.style.fontSize = box.fontSize * state.scale + "px";
    content.style.fontWeight = box.bold ? "700" : "400";
    content.style.color = box.color;
    content.style.fontFamily = (FONT_LIBRARY[box.fontKey] || FONT_LIBRARY.hind).cssFamily;
    content.style.lineHeight = String(lineHeightOf(box));
  }

  function styleShapeInner(box, inner) {
    const color = box.color || SHAPE_DEFAULT_COLOR[box.shape];
    const sw = Math.max(1, (box.strokeWidth || 2) * state.scale);
    inner.style.cssText = "";
    inner.innerHTML = "";
    if (box.shape === "whiteout") inner.style.background = color;
    else if (box.shape === "highlight") { inner.style.background = color; inner.style.opacity = "0.4"; }
    else if (box.shape === "rect" || box.shape === "ellipse") {
      inner.style.border = sw + "px solid " + color;
      if (box.fill) inner.style.background = color + "33";
      if (box.shape === "ellipse") inner.style.borderRadius = "50%";
    } else if (box.shape === "line") {
      inner.style.height = sw + "px";
      inner.style.background = color;
      inner.style.top = "50%";
      inner.style.transform = "translateY(-50%)";
      inner.style.position = "absolute";
      inner.style.left = "0";
      inner.style.right = "0";
    } else if (box.shape === "check" || box.shape === "cross") {
      inner.innerHTML = '<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="' +
        (box.shape === "check" ? CHECK_PATH : CROSS_PATH) + '" fill="none" stroke="' + color +
        '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  }

  // ---------------------------------------------------------------- selection
  // state.selection holds every selected box id; state.selectedId is the "primary" one the
  // floating toolbar edits.
  function setSelection(ids) {
    state.selection = new Set(ids.filter((id) => id != null));
    state.selectedId = ids.length ? ids[ids.length - 1] : null;
    refreshSelectionUI();
  }
  function toggleSelection(id) {
    if (state.selection.has(id)) {
      state.selection.delete(id);
      const rest = [...state.selection];
      state.selectedId = rest.length ? rest[rest.length - 1] : null;
    } else {
      state.selection.add(id);
      state.selectedId = id;
    }
    refreshSelectionUI();
  }
  function selectBox(id) { setSelection(id == null ? [] : [id]); }
  function refreshSelectionUI() {
    els.overlay.querySelectorAll(".textbox").forEach((n) => {
      n.classList.toggle("selected", state.selection.has(Number(n.dataset.id)));
    });
    const box = currentBox();
    if (!box || box.page !== state.currentPage) { hideFloatingBar(); return; }
    const kind = box.type === "image" ? "image" : box.type === "shape" ? "shape" : "text";
    els.floatingBar.classList.remove("fb-kind-text", "fb-kind-image", "fb-kind-shape");
    els.floatingBar.classList.add("fb-kind-" + kind);
    els.floatingBar.classList.toggle("fb-edited", !!box.cover);
    els.floatingBar.classList.toggle("fb-strokable", kind === "shape" && ["rect", "ellipse", "line"].includes(box.shape));
    els.floatingBar.classList.toggle("fb-fillable", kind === "shape" && ["rect", "ellipse"].includes(box.shape));
    els.floatingBar.dataset.count = state.selection.size > 1 ? bnNum(state.selection.size) + "টি" : "";
    if (kind === "text") {
      els.fbFontSize.value = box.fontSize;
      els.fbBold.classList.toggle("active", !!box.bold);
      els.fbColor.value = box.color;
      els.fbFont.value = box.fontKey || "hind";
      els.fbAutoFont.classList.toggle("active", !!box.autoFont);
      els.fbLineHeight.value = String(nearestLineHeightOption(lineHeightOf(box)));
    } else if (kind === "shape") {
      els.fbColor.value = box.color || SHAPE_DEFAULT_COLOR[box.shape];
      els.fbStroke.value = String(box.strokeWidth || 2);
      els.fbFill.classList.toggle("active", !!box.fill);
    }
    positionFloatingBar(box);
  }
  function nearestLineHeightOption(v) {
    const opts = [...els.fbLineHeight.options].map((o) => parseFloat(o.value));
    let best = opts[0];
    opts.forEach((o) => { if (Math.abs(o - v) < Math.abs(best - v)) best = o; });
    return best;
  }
  function hideFloatingBar() { els.floatingBar.style.display = "none"; }
  function positionFloatingBar(box) {
    const el = boxEl(box.id);
    const pos = el ? { left: parseFloat(el.style.left), top: parseFloat(el.style.top) } : boxCssPos(box);
    const h = el ? el.offsetHeight : 20;
    positionFloatingBarAt(pos.left, pos.top, h);
  }
  function positionFloatingBarAt(left, top, height) {
    els.floatingBar.style.display = "flex";
    const barH = els.floatingBar.offsetHeight || 36;
    const barW = els.floatingBar.offsetWidth || 190;
    let y = top - barH - 10;
    if (y < 4) y = top + height + 10;
    const x = Math.max(4, Math.min(left, els.overlay.clientWidth - barW - 4));
    els.floatingBar.style.top = y + "px";
    els.floatingBar.style.left = x + "px";
  }

  // ---------------------------------------------------------------- delete / discard
  // Deleting edited original text doesn't bring the original back -- it leaves a "removed text"
  // patch (a whiteout shape) behind, because "I deleted this line" means the line should be gone.
  // Deleting that patch in turn restores the original. Undo covers everything else.
  function whiteoutFromEdited(box) {
    return {
      id: state.nextId++, page: box.page, type: "shape", shape: "whiteout",
      xPdf: box.cover.x, yTopPdf: box.cover.y + box.cover.h, widthPdf: box.cover.w, heightPdf: box.cover.h,
      color: box.cover.color || "#ffffff", sourceKey: box.sourceKey, fromEdit: true,
      coverKind: box.type === "image" ? "image" : "text",
    };
  }
  function removeBoxInternal(box) {
    if (box._orig) state.deletedRestoredBoxes.push(box._orig);
    const idx = state.boxes.indexOf(box);
    if (idx < 0) return;
    if ((box.type === "text" || box.type === "image") && box.cover) state.boxes.splice(idx, 1, whiteoutFromEdited(box));
    else state.boxes.splice(idx, 1);
  }
  function deleteBoxes(ids) {
    const set = new Set(ids);
    state.boxes.filter((b) => set.has(b.id)).forEach(removeBoxInternal);
    setSelection([]);
    renderBoxes();
    renderTextLayer();
    commit();
  }
  // A box clicked into but never typed in disappears the moment you click away.
  function discardIfEmpty(box) {
    removeBoxInternal(box);
    state.selection.delete(box.id);
    if (state.selectedId === box.id) state.selectedId = null;
    if (box.cover) renderBoxes();
    else {
      const el = boxEl(box.id);
      if (el) el.remove();
      refreshSelectionUI();
    }
    renderTextLayer();
    commit();
  }

  // ---------------------------------------------------------------- overlay pointer: create / draw / band-select
  els.floatingBar.addEventListener("pointerdown", (e) => {
    if (e.target === els.floatingBar) setSelection([]);
  });

  els.overlay.addEventListener("pointerdown", (e) => {
    if (e.target !== els.overlay && !e.target.classList.contains("ov-layer")) return;
    if (e.button && e.button !== 0) return;
    // preventDefault: stop the browser's synthesized mousedown/click for this same press from
    // landing on the box we're about to create (it used to swallow the first click).
    e.preventDefault();
    const rect = els.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (state.mode === "text") { createTextBoxAt(x, y); return; }
    if (state.mode === "shape") { startShapeDraw(e, x, y); return; }
    if (state.mode === "select") { startBandSelect(e, x, y); return; }
    setSelection([]);
  });

  function createTextBoxAt(xCss, yCss) {
    const p = cssToPdf(xCss, yCss);
    const box = {
      id: state.nextId++,
      page: state.currentPage,
      type: "text",
      xPdf: p.x,
      yTopPdf: p.y,
      widthPdf: 240,
      fontSize: parseFloat(els.fbFontSize.value) || 16,
      bold: els.fbBold.classList.contains("active"),
      color: lastTextColor,
      fontKey: els.fbFont.value || "hind",
      autoFont: false,
      text: "",
    };
    state.boxes.push(box);
    state.pendingFocusId = box.id;
    state.selection = new Set([box.id]);
    state.selectedId = box.id;
    renderBoxes();
  }
  let lastTextColor = "#1a1a1a";

  function startShapeDraw(e, x0, y0) {
    const kind = state.shapeKind;
    const preview = document.createElement("div");
    preview.className = "draw-preview shape-" + kind;
    els.overlay.appendChild(preview);
    let x1 = x0, y1 = y0;
    function draw() {
      const l = Math.min(x0, x1), t = Math.min(y0, y1);
      preview.style.left = l + "px";
      preview.style.top = (kind === "line" ? y0 - 1 : t) + "px";
      preview.style.width = Math.abs(x1 - x0) + "px";
      preview.style.height = (kind === "line" ? 2 : Math.abs(y1 - y0)) + "px";
    }
    draw();
    const rect = els.overlay.getBoundingClientRect();
    function onMove(ev) {
      x1 = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      y1 = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
      if (ev.shiftKey && (kind === "rect" || kind === "ellipse")) {
        const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
      }
      draw();
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      preview.remove();
      const sc = state.scale;
      let wCss = Math.abs(x1 - x0), hCss = Math.abs(y1 - y0);
      let l = Math.min(x0, x1), t = Math.min(y0, y1);
      const clicked = wCss < 6 && hCss < 6;
      const defaults = {
        whiteout: [120, 24], highlight: [140, 18], rect: [120, 60], ellipse: [80, 80],
        line: [140, 0], check: [18, 18], cross: [18, 18],
      }[kind];
      if (clicked) { wCss = defaults[0] * sc; hCss = defaults[1] * sc; l = x0 - (kind === "check" || kind === "cross" ? wCss / 2 : 0); t = y0 - (kind === "check" || kind === "cross" ? hCss / 2 : 0); }
      if (kind === "line") { hCss = 10 * sc; t = y0 - hCss / 2; }
      if (kind === "check" || kind === "cross") { const s = Math.max(wCss, hCss, 10 * sc); wCss = hCss = s; }
      const p = cssToPdf(l, t);
      const box = {
        id: state.nextId++, page: state.currentPage, type: "shape", shape: kind,
        xPdf: p.x, yTopPdf: p.y, widthPdf: Math.max(4, wCss / sc), heightPdf: Math.max(2, hCss / sc),
        color: SHAPE_DEFAULT_COLOR[kind], strokeWidth: 2, fill: false,
      };
      state.boxes.push(box);
      setSelection([box.id]);
      renderBoxes();
      commit();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function startBandSelect(e, x0, y0) {
    const band = document.createElement("div");
    band.className = "select-band";
    els.overlay.appendChild(band);
    const rect = els.overlay.getBoundingClientRect();
    const additive = e.shiftKey;
    const startSel = additive ? [...state.selection] : [];
    let moved = false;
    function onMove(ev) {
      const x1 = ev.clientX - rect.left, y1 = ev.clientY - rect.top;
      const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (w > 3 || h > 3) moved = true;
      band.style.left = l + "px"; band.style.top = t + "px"; band.style.width = w + "px"; band.style.height = h + "px";
      const hits = [];
      els.overlay.querySelectorAll(".textbox").forEach((el) => {
        const bl = parseFloat(el.style.left), bt = parseFloat(el.style.top);
        if (bl < l + w && bl + el.offsetWidth > l && bt < t + h && bt + el.offsetHeight > t) hits.push(Number(el.dataset.id));
      });
      setSelection([...new Set([...startSel, ...hits])]);
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      band.remove();
      if (!moved && !additive) setSelection([]);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // ---------------------------------------------------------------- resize
  // axis "x": width only (text reflows; lines) · "aspect": proportional (images, ✓/✗) · "xy": free.
  function startResize(e, box, el, axis) {
    e.preventDefault();
    e.stopPropagation();
    if (!state.selection.has(box.id) || state.selection.size > 1) setSelection([box.id]);
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    const startX = e.clientX, startY = e.clientY;
    const startW = box.widthPdf * state.scale;
    const startH = (box.heightPdf || 0) * state.scale;
    const aspect = box.heightPdf && box.widthPdf ? box.heightPdf / box.widthPdf : 1;
    const content = el.querySelector(".tb-content");
    const minW = box.type === "text" ? 40 : 8;

    function onMove(ev) {
      const w = Math.max(minW, startW + (ev.clientX - startX));
      box.widthPdf = w / state.scale;
      el.style.width = w + "px";
      if (axis === "aspect") {
        box.heightPdf = box.widthPdf * aspect;
        el.style.height = box.heightPdf * state.scale + "px";
      } else if (axis === "xy") {
        const h = Math.max(4, startH + (ev.clientY - startY));
        box.heightPdf = h / state.scale;
        el.style.height = h + "px";
      }
      if (box.type === "shape") styleShapeInner(box, el.querySelector(".shape-content"));
      if (content) autoResizeTextarea(content);
      positionFloatingBar(box);
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      commit();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // ---------------------------------------------------------------- drag + smart alignment guides
  const SNAP_PX = 6;
  function collectAlignmentTargets(excludeIds) {
    const overlayRect = els.overlay.getBoundingClientRect();
    const xs = [0, overlayRect.width, overlayRect.width / 2];
    const ys = [0, overlayRect.height, overlayRect.height / 2];
    els.overlay.querySelectorAll(".textbox").forEach((el) => {
      if (excludeIds.has(Number(el.dataset.id))) return;
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;
      const w = el.offsetWidth, h = el.offsetHeight;
      xs.push(left, left + w, left + w / 2);
      ys.push(top, top + h, top + h / 2);
    });
    return { xs, ys };
  }
  function findAxisSnap(pos, size, targets) {
    for (const t of targets) {
      if (Math.abs(pos - t) <= SNAP_PX) return { pos: t, guide: t };
      if (Math.abs(pos + size - t) <= SNAP_PX) return { pos: t - size, guide: t };
      if (Math.abs(pos + size / 2 - t) <= SNAP_PX) return { pos: t - size / 2, guide: t };
    }
    return null;
  }

  function onBoxPointerDown(e, box, el) {
    if (e.shiftKey) { toggleSelection(box.id); return; }
    if (!state.selection.has(box.id)) setSelection([box.id]);
    else { state.selectedId = box.id; refreshSelectionUI(); }
    startDrag(e, box, el);
  }

  function startDrag(e, box, el) {
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    const overlayRect = els.overlay.getBoundingClientRect();
    const group = [...state.selection]
      .filter((id) => id !== box.id)
      .map((id) => ({ box: state.boxes.find((b) => b.id === id), el: boxEl(id) }))
      .filter((g) => g.box && g.el)
      .map((g) => ({ ...g, startLeft: parseFloat(g.el.style.left) || 0, startTop: parseFloat(g.el.style.top) || 0 }));
    state.dragging = {
      box, el, group, moved: false,
      startX: e.clientX, startY: e.clientY,
      startLeft: parseFloat(el.style.left) || 0,
      startTop: parseFloat(el.style.top) || 0,
      overlayRect,
      width: el.offsetWidth, height: el.offsetHeight,
      targets: collectAlignmentTargets(new Set([box.id, ...group.map((g) => g.box.id)])),
    };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
  }
  function onDragMove(e) {
    const d = state.dragging;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 2) d.moved = true;
    let x = d.startLeft + (e.clientX - d.startX);
    let y = d.startTop + (e.clientY - d.startY);
    x = Math.max(-d.width + 10, Math.min(x, d.overlayRect.width - 10));
    y = Math.max(-d.height + 10, Math.min(y, d.overlayRect.height - 10));

    const snapX = e.altKey ? null : findAxisSnap(x, d.width, d.targets.xs);
    if (snapX) {
      x = snapX.pos;
      els.guideV.style.left = snapX.guide + "px";
      els.guideV.classList.add("visible");
    } else els.guideV.classList.remove("visible");
    const snapY = e.altKey ? null : findAxisSnap(y, d.height, d.targets.ys);
    if (snapY) {
      y = snapY.pos;
      els.guideH.style.top = snapY.guide + "px";
      els.guideH.classList.add("visible");
    } else els.guideH.classList.remove("visible");

    d.el.style.left = x + "px";
    d.el.style.top = y + "px";
    const dx = x - d.startLeft, dy = y - d.startTop;
    d.group.forEach((g) => {
      g.el.style.left = g.startLeft + dx + "px";
      g.el.style.top = g.startTop + dy + "px";
    });
    positionFloatingBarAt(x, y, d.height);
  }
  function onDragEnd() {
    const d = state.dragging;
    if (!d) return;
    state.dragging = null;
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    els.guideV.classList.remove("visible");
    els.guideH.classList.remove("visible");
    if (!d.moved) { positionFloatingBar(d.box); return; }
    [{ box: d.box, el: d.el }, ...d.group].forEach(({ box, el }) => {
      const p = pdfPosFromCss(box, parseFloat(el.style.left), parseFloat(el.style.top));
      box.xPdf = p.xPdf;
      box.yTopPdf = p.yTopPdf;
    });
    positionFloatingBar(d.box);
    commit();
  }

  function nudgeSelection(dxPdf, dyPdf) {
    const boxes = state.boxes.filter((b) => state.selection.has(b.id) && b.page === state.currentPage);
    if (!boxes.length) return;
    boxes.forEach((b) => {
      b.xPdf += dxPdf;
      b.yTopPdf += dyPdf;
      const el = boxEl(b.id);
      if (el) placeBoxEl(b, el);
    });
    refreshSelectionUI();
    commitSoon();
  }

  // -------------------------------------------------------------- page / zoom
  els.btnPrev.addEventListener("click", () => goToPage(state.currentPage - 1));
  els.btnNext.addEventListener("click", () => goToPage(state.currentPage + 1));
  els.btnZoomIn.addEventListener("click", async () => {
    state.scale = Math.min(state.baseScale * 3, +(state.scale + state.baseScale * 0.15).toFixed(3));
    await renderPage();
  });
  els.btnZoomOut.addEventListener("click", async () => {
    state.scale = Math.max(state.baseScale * 0.4, +(state.scale - state.baseScale * 0.15).toFixed(3));
    await renderPage();
  });
  els.zoomLabel.addEventListener("click", async () => {
    if (!state.pdfDoc) return;
    await fitPageToViewport();
    await renderPage();
  });

  // Ctrl/Cmd + wheel zooms around the cursor; plain wheel still scrolls.
  els.stageWrap.addEventListener("wheel", async (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.pdfDoc) return;
    e.preventDefault();
    const delta = (e.deltaY < 0 ? 0.12 : -0.12) * state.baseScale;
    const newScale = Math.max(state.baseScale * 0.4, Math.min(state.baseScale * 3, +(state.scale + delta).toFixed(3)));
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
  // Style changes apply to every selected box of a compatible kind, not just the primary one.
  function selectedBoxes(kind) {
    return state.boxes.filter((b) => state.selection.has(b.id) && (!kind || (b.type === kind)));
  }
  function refreshTextEl(box) {
    const el = boxEl(box.id);
    if (!el) return;
    const c = el.querySelector(".tb-content");
    if (c) { applyTextStyle(box, c); autoResizeTextarea(c); }
    placeBoxEl(box, el);
  }
  function updateTexts(fn) {
    const boxes = selectedBoxes("text");
    if (!boxes.length) return;
    boxes.forEach((b) => { fn(b); refreshTextEl(b); });
    refreshSelectionUI();
    commitSoon();
  }
  els.fbFontSize.addEventListener("input", () => {
    const v = parseFloat(els.fbFontSize.value);
    if (!(v >= 4 && v <= 200)) return;
    updateTexts((b) => { b.fontSize = v; });
  });
  els.fbFontDown.addEventListener("click", () => updateTexts((b) => { b.fontSize = Math.max(4, round1(b.fontSize - 1)); }));
  els.fbFontUp.addEventListener("click", () => updateTexts((b) => { b.fontSize = Math.min(200, round1(b.fontSize + 1)); }));
  els.fbBold.addEventListener("click", () => {
    const box = currentBox();
    const next = box && box.type === "text" ? !box.bold : !els.fbBold.classList.contains("active");
    els.fbBold.classList.toggle("active", next);
    updateTexts((b) => { b.bold = next; });
  });
  els.fbColor.addEventListener("input", () => {
    const v = els.fbColor.value;
    const box = currentBox();
    if (box && box.type === "shape") {
      selectedBoxes("shape").forEach((b) => { b.color = v; const el = boxEl(b.id); if (el) styleShapeInner(b, el.querySelector(".shape-content")); });
      commitSoon();
      return;
    }
    lastTextColor = v;
    updateTexts((b) => { b.color = v; });
  });
  els.fbFont.addEventListener("change", () => updateTexts((b) => { b.fontKey = els.fbFont.value; }));
  els.fbAutoFont.addEventListener("click", () => {
    const box = currentBox(); if (!box || box.type !== "text") return;
    const next = !box.autoFont;
    els.fbAutoFont.classList.toggle("active", next);
    updateTexts((b) => { b.autoFont = next; });
  });
  els.fbLineHeight.addEventListener("change", () => updateTexts((b) => { b.lineHeight = parseFloat(els.fbLineHeight.value) || DEFAULT_LINE_HEIGHT; }));
  els.fbStroke.addEventListener("change", () => {
    selectedBoxes("shape").forEach((b) => { b.strokeWidth = parseFloat(els.fbStroke.value) || 2; const el = boxEl(b.id); if (el) styleShapeInner(b, el.querySelector(".shape-content")); });
    commit();
  });
  els.fbFill.addEventListener("click", () => {
    const box = currentBox(); if (!box || box.type !== "shape") return;
    const next = !box.fill;
    els.fbFill.classList.toggle("active", next);
    selectedBoxes("shape").forEach((b) => { b.fill = next; const el = boxEl(b.id); if (el) styleShapeInner(b, el.querySelector(".shape-content")); });
    commit();
  });
  els.fbMove.addEventListener("pointerdown", (e) => {
    const box = currentBox(); if (!box) return;
    e.preventDefault();
    const el = boxEl(box.id);
    if (el) startDrag(e, box, el);
  });
  els.fbDuplicate.addEventListener("click", () => duplicateSelection());
  els.fbDelete.addEventListener("click", () => { if (state.selection.size) deleteBoxes([...state.selection]); });
  document.getElementById("fbOcrFix").addEventListener("click", () => ocrFixSelected());

  function cloneForPaste(b, dx, dy, page) {
    const { _orig, id, sourceKey, cover, fromEdit, ...rest } = b;
    const copy = { ...rest, id: state.nextId++, page, xPdf: b.xPdf + dx, yTopPdf: b.yTopPdf + dy };
    return copy;
  }
  function duplicateSelection() {
    const src = state.boxes.filter((b) => state.selection.has(b.id));
    if (!src.length) return;
    const copies = src.map((b) => cloneForPaste(b, 14, -14, b.page));
    state.boxes.push(...copies);
    setSelection(copies.map((c) => c.id));
    renderBoxes();
    commit();
  }
  let clipboard = [];
  function copySelection() {
    clipboard = state.boxes.filter((b) => state.selection.has(b.id)).map((b) => ({ ...b }));
    if (clipboard.length) showToast(bnNum(clipboard.length) + "টি বক্স কপি হয়েছে — অন্য পাতায় গিয়ে Ctrl+V চাপুন।", "info", 2500);
  }
  function pasteClipboard() {
    if (!clipboard.length) return;
    const samePage = clipboard.every((b) => b.page === state.currentPage);
    const off = samePage ? 14 : 0;
    const copies = clipboard.map((b) => cloneForPaste(b, off, -off, state.currentPage));
    state.boxes.push(...copies);
    setSelection(copies.map((c) => c.id));
    renderBoxes();
    commit();
  }

  // ---------------------------------------------------------------- edit existing text
  // pdf.js tells us every piece of text on the page with its exact position and font size. Those
  // pieces are stitched into lines (same baseline, small gaps) and lines into paragraphs (same left
  // edge, regular spacing). Clicking one turns it into a normal text box pre-filled with the same
  // words, size, weight and color, sitting exactly on the original baseline; on export the
  // original glyphs are removed from the page (see pdf-text-remove.js) and the new text drawn.
  const textBlockCache = new Map(); // page -> Promise<{ blocks, source }>

  const BN_CONSONANT = "[\\u0995-\\u09B9\\u09CE\\u09DC-\\u09DF\\u09F0\\u09F1]";
  const PRE_BASE = "[\\u09BF\\u09C7\\u09C8]";
  const VISUAL_EVIDENCE = new RegExp("(^|[^\\u0995-\\u09B9\\u09BC\\u09CE\\u09DC-\\u09DF\\u09F0\\u09F1])" + PRE_BASE);
  const PRE_BASE_MOVE = new RegExp("(" + PRE_BASE + ")((?:" + BN_CONSONANT + "\\u09BC?\\u09CD)*" + BN_CONSONANT + "\\u09BC?)", "g");
  // Many PDF producers store Bangla in *visual* order -- the ি/ে/ৈ sign that's drawn before its
  // consonant comes out first ("িক" instead of "কি"), and ো/ৌ come apart as ে…া. In real
  // (logical) Unicode a vowel sign always follows a consonant, so a sign at the start or after a
  // vowel/space proves the line is visual; only then is every such sign moved after its cluster.
  // Producers that shape Bangla with several width-variants of the ি glyph often leave those
  // variants out of the font's Unicode map, so pdf.js reports them as U+0000. In a Bangla run, an
  // unmapped character right before a consonant sits exactly where a visual-order ি would be.
  const UNMAPPED_BEFORE_CONSONANT = new RegExp("[\\u0000\\uFFFD](?=" + BN_CONSONANT + ")", "g");
  function fixBanglaOrder(s) {
    if (/[ঀ-৿]/.test(s)) s = s.replace(UNMAPPED_BEFORE_CONSONANT, "ি");
    s = s.replace(/[\u0000-\u0008\u000B-\u001F�]/g, "");
    if (!/[িেৈ]/.test(s) || !VISUAL_EVIDENCE.test(s)) return s;
    return s.replace(PRE_BASE_MOVE, "$2$1")
      .replace(/ো/g, "ো")
      .replace(/ৌ/g, "ৌ");
  }
  const LEGACY_BANGLA_FONT = /sutonny|bijoy|mj\b|mj-|-mj|mjb?$|ananda|boishakhi|kongsho|jamuna|padma|nikosh-?bijoy/i;

  function getTextBlocks(pageNum) {
    if (!textBlockCache.has(pageNum)) {
      const p = extractTextBlocks(pageNum).catch((err) => {
        console.error("[Nothi] text extraction failed:", err);
        textBlockCache.delete(pageNum);
        return { blocks: [], source: "pdf" };
      });
      textBlockCache.set(pageNum, p);
    }
    return textBlockCache.get(pageNum);
  }

  async function extractTextBlocks(pageNum) {
    const page = await state.pdfDoc.getPage(pageNum);
    const tc = await page.getTextContent();
    const fontNameOf = (id) => {
      try { return page.commonObjs.has(id) ? (page.commonObjs.get(id).name || "") : ""; }
      catch (err) { return ""; }
    };
    const items = [];
    tc.items.forEach((it) => {
      if (typeof it.str !== "string" || !it.str) return;
      const t = it.transform;
      // horizontal text only -- rotated/skewed text keeps its original form
      if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3 || t[0] <= 0 || t[3] <= 0) return;
      const size = t[3];
      if (size < 2.5 || size > 400) return;
      const style = tc.styles[it.fontName] || {};
      items.push({
        str: it.str, x: t[4], y: t[5], w: it.width || 0, size, fontId: it.fontName,
        realName: fontNameOf(it.fontName), family: style.fontFamily || "",
        asc: style.ascent > 0.3 && style.ascent < 1.3 ? style.ascent : 0.8,
        desc: style.descent < 0 && style.descent > -0.6 ? style.descent : -0.22,
      });
    });

    // rows: same baseline (within 40% of the font size)
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      let row = null;
      for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
        const r = rows[k];
        if (Math.abs(r.y - it.y) < Math.min(r.size, it.size) * 0.4) { row = r; break; }
      }
      if (row) { row.items.push(it); row.size = Math.max(row.size, it.size); }
      else rows.push({ y: it.y, size: it.size, items: [it] });
    }

    // segments: split a row where there's a big gap (columns, form fields) or a size change
    const segments = [];
    rows.forEach((row) => {
      row.items.sort((a, b) => a.x - b.x);
      let seg = null;
      const flush = () => { if (seg && seg.text.trim()) segments.push(finishSegment(seg)); seg = null; };
      for (const it of row.items) {
        const isSpace = !it.str.trim();
        if (seg) {
          const gap = it.x - seg.x1;
          const sizeRatio = it.size / seg.size;
          if (gap > Math.max(seg.size, it.size) * 1.6 || sizeRatio > 1.3 || sizeRatio < 0.77) flush();
        }
        if (!seg) {
          if (isSpace) continue;
          seg = { x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, text: "", parts: [] };
        } else {
          const gap = it.x - seg.x1;
          if (gap > seg.size * 0.18 && !/\s$/.test(seg.text) && !/^\s/.test(it.str)) seg.text += " ";
        }
        seg.text += it.str;
        seg.x1 = Math.max(seg.x1, it.x + it.w);
        if (!isSpace) seg.parts.push(it);
      }
      flush();
    });
    function finishSegment(seg) {
      // dominant font = the one covering the most characters
      const tally = new Map();
      seg.parts.forEach((p) => tally.set(p.fontId, (tally.get(p.fontId) || 0) + p.str.length));
      let fontId = null, best = -1;
      tally.forEach((v, k) => { if (v > best) { best = v; fontId = k; } });
      const main = seg.parts.find((p) => p.fontId === fontId) || seg.parts[0];
      const size = Math.max(...seg.parts.map((p) => p.size));
      const baseline = main.y;
      const text = fixBanglaOrder(seg.text.replace(/\s+/g, " ").trim());
      return {
        x0: seg.x0, x1: seg.x1, baseline, size, text,
        top: baseline + main.asc * size, bottom: baseline + main.desc * size,
        fontId, realName: main.realName, family: main.family,
      };
    }
    return { blocks: segmentsToBlocks(segments, pageNum, "t"), source: "pdf" };
  }

  // Lines -> paragraphs: consecutive lines with the same left edge, same font and size, and a
  // regular line gap become one block (line breaks kept), so a paragraph is edited as a whole.
  function segmentsToBlocks(segments, pageNum, prefix) {
    segments.sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0);
    const blocks = [];
    const open = [];
    for (const seg of segments) {
      let target = null;
      for (const bl of open) {
        const last = bl.lines[bl.lines.length - 1];
        const gap = last.baseline - seg.baseline;
        const ratio = seg.size / last.size;
        if (Math.abs(seg.x0 - bl.x0) < last.size * 0.6 && ratio > 0.92 && ratio < 1.08 &&
            seg.fontId === last.fontId && gap > last.size * 0.95 && gap < last.size * 1.75 &&
            (bl.lines.length < 2 || Math.abs(gap - bl.spacing) < last.size * 0.2)) {
          target = bl; break;
        }
      }
      if (target) {
        target.spacing = target.lines[target.lines.length - 1].baseline - seg.baseline;
        target.lines.push(seg);
        target.x1 = Math.max(target.x1, seg.x1);
        target.bottom = seg.bottom;
      } else {
        const bl = { lines: [seg], x0: seg.x0, x1: seg.x1, top: seg.top, bottom: seg.bottom, spacing: 0 };
        open.push(bl);
        blocks.push(bl);
      }
      // a block can only grow downward from its last line -- drop ones far above the current line
      for (let k = open.length - 1; k >= 0; k--) {
        const last = open[k].lines[open[k].lines.length - 1];
        if (last.baseline - seg.baseline > last.size * 2.2) open.splice(k, 1);
      }
    }
    return blocks.map((bl, i) => {
      const first = bl.lines[0];
      const text = bl.lines.map((l) => l.text).join("\n");
      const name = (first.realName || "").replace(/^[A-Z]{6}\+/, "");
      const bengali = /[ঀ-৿]/.test(text);
      const latin = /[A-Za-z]/.test(text);
      const legacy = LEGACY_BANGLA_FONT.test(name) || /�/.test(text);
      return {
        key: pageNum + ":" + prefix + i,
        page: pageNum,
        x0: bl.x0, x1: bl.x1, top: bl.top, bottom: bl.bottom,
        baseline: first.baseline, size: first.size,
        lineHeight: bl.lines.length > 1 ? Math.max(0.9, Math.min(2.2, bl.spacing / first.size)) : null,
        text, bengali, mixed: bengali && latin,
        bold: /bold|black|heavy|semibold|demi/i.test(name),
        serif: first.family === "serif" || (/times|roman|serif|georgia|garamond|cambria|book|minion/i.test(name) && !/sans/i.test(name)),
        unreliable: legacy,
        ocr: prefix === "o",
      };
    });
  }

  let textLayerToken = 0;
  async function renderTextLayer() {
    const layer = ensureLayer("te-layer");
    const token = ++textLayerToken;
    if (state.mode !== "edit" || !state.pdfDoc) { layer.innerHTML = ""; updateModeHint(); return; }
    updateModeHint(null);
    const pageNum = state.currentPage;
    const [info, images] = await Promise.all([getTextBlocks(pageNum), getImageBlocks(pageNum)]);
    if (token !== textLayerToken || pageNum !== state.currentPage || state.mode !== "edit") return;
    layer.innerHTML = "";
    const used = new Set(state.boxes.filter((b) => b.page === pageNum && b.sourceKey).map((b) => b.sourceKey));
    images.forEach((im) => {
      if (used.has(im.key)) return;
      const r = pdfRectToCss(im.x0, im.y0, im.x1 - im.x0, im.y1 - im.y0);
      const hot = document.createElement("div");
      hot.className = "te-hot te-image";
      hot.style.left = r.left + "px";
      hot.style.top = r.top + "px";
      hot.style.width = r.width + "px";
      hot.style.height = r.height + "px";
      hot.title = "ছবি: ক্লিক করে সরান, সাইজ বদলান, বদলে দিন বা মুছুন";
      hot.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginEditImage(im);
      });
      layer.appendChild(hot);
    });
    info.blocks.forEach((bl) => {
      if (used.has(bl.key)) return;
      const r = pdfRectToCss(bl.x0, bl.bottom, bl.x1 - bl.x0, bl.top - bl.bottom);
      const hot = document.createElement("div");
      hot.className = "te-hot" + (bl.unreliable ? " te-unreliable" : "");
      hot.style.left = r.left - 2 + "px";
      hot.style.top = r.top - 2 + "px";
      hot.style.width = r.width + 4 + "px";
      hot.style.height = r.height + 4 + "px";
      hot.title = bl.unreliable ? "পুরনো (Bijoy/SutonnyMJ) ফন্টের লেখা — ক্লিক করে নতুন করে লিখুন" : "ক্লিক করে এডিট করুন";
      hot.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginEditBlock(bl);
      });
      layer.appendChild(hot);
    });
    updateModeHint(info);
  }

  // Reads the page's own pixels under a block: the most common color is the background (the
  // cover patch gets painted in it, so colored/tinted forms don't get white rectangles), and the
  // pixels farthest from it are the ink (so red text stays red).
  function sampleColors(cssRect) {
    const fallback = { bg: "#ffffff", ink: "#1a1a1a" };
    try {
      const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
      const s = els.canvas.width / parseFloat(els.canvas.style.width);
      const x = Math.max(0, Math.floor(cssRect.left * s));
      const y = Math.max(0, Math.floor(cssRect.top * s));
      const w = Math.min(els.canvas.width - x, Math.ceil(cssRect.width * s));
      const h = Math.min(els.canvas.height - y, Math.ceil(cssRect.height * s));
      if (w < 1 || h < 1) return fallback;
      const data = ctx.getImageData(x, y, w, h).data;
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let bgKey = 0, bgCount = -1;
      counts.forEach((v, k) => { if (v > bgCount) { bgCount = v; bgKey = k; } });
      let br = 0, bgG = 0, bb = 0, bn = 0;
      for (let i = 0; i < data.length; i += 4) {
        const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        if (k === bgKey) { br += data[i]; bgG += data[i + 1]; bb += data[i + 2]; bn++; }
      }
      br /= bn; bgG /= bn; bb /= bn;
      const ink = [];
      for (let i = 0; i < data.length; i += 4) {
        const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb);
        if (d > 110) ink.push([d, data[i], data[i + 1], data[i + 2]]);
      }
      let inkHex = fallback.ink;
      if (ink.length) {
        ink.sort((a, b) => b[0] - a[0]);
        const top = ink.slice(0, Math.max(1, Math.floor(ink.length * 0.3)));
        const avg = top.reduce((acc, p) => [acc[0] + p[1], acc[1] + p[2], acc[2] + p[3]], [0, 0, 0]).map((v) => v / top.length);
        inkHex = rgbToHex(avg[0], avg[1], avg[2]);
      }
      return { bg: rgbToHex(br, bgG, bb), ink: inkHex };
    } catch (err) {
      return fallback;
    }
  }

  function beginEditBlock(bl) {
    const pad = Math.max(0.6, bl.size * 0.1);
    // a little extra on the right: pdf.js widths often stop short of the last glyph's ink
    // (Bangla vowel signs overhang), which left a sliver of the old text peeking out
    const cover = { x: bl.x0 - pad, y: bl.bottom - pad, w: bl.x1 - bl.x0 + pad * 2 + bl.size * 0.3, h: bl.top - bl.bottom + pad * 2 };
    const colors = sampleColors(pdfRectToCss(cover.x, cover.y, cover.w, cover.h));
    cover.color = colors.bg;
    const fontKey = bl.bengali ? "hind" : (bl.serif ? "tinos" : "hind");
    const box = {
      id: state.nextId++,
      page: bl.page,
      type: "text",
      xPdf: bl.x0,
      yTopPdf: bl.baseline + BASELINE_RATIO * bl.size,
      // a little slack: the replacement font is rarely exactly as narrow as the original, and an
      // unexpected wrap is far more jarring than a slightly wide box
      widthPdf: Math.max(40, (bl.x1 - bl.x0) * 1.1 + bl.size),
      fontSize: round1(bl.size),
      bold: bl.bold,
      color: colors.ink,
      fontKey,
      autoFont: bl.mixed || (bl.bengali && bl.serif),
      text: bl.unreliable ? "" : bl.text,
      cover,
      sourceKey: bl.key,
      unreliable: bl.unreliable || undefined,
    };
    if (bl.lineHeight) box.lineHeight = round1(bl.lineHeight * 100) / 100;
    if (box.autoFont && bl.serif) box.fontKey = "kalpurush";
    box.pristine = pristineSig(box);
    state.boxes.push(box);
    state.pendingFocusId = box.id;
    state.selection = new Set([box.id]);
    state.selectedId = box.id;
    renderBoxes();
    renderTextLayer();
    commit();
    if (bl.unreliable) {
      showToast("এই লেখাটা পুরনো Bijoy/SutonnyMJ ফন্টে লেখা, তাই সঠিকভাবে পড়া যায় না — নতুন করে টাইপ করুন (আসল লেখা মুছে যাবে)।", "warn", 7000);
    }
  }

  // ---------------------------------------------------------------- edit existing images
  // Found through pdf.js's operator list (tracking the transform stack), so we know each image's
  // exact box on the page. Full-page images (scans) are skipped -- that's OCR's job.
  const imageBlockCache = new Map();
  function getImageBlocks(pageNum) {
    if (!imageBlockCache.has(pageNum)) {
      imageBlockCache.set(pageNum, extractImageBlocks(pageNum).catch((err) => {
        console.warn("[Nothi] image scan failed:", err);
        return [];
      }));
    }
    return imageBlockCache.get(pageNum);
  }
  function mul6(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ];
  }
  async function extractImageBlocks(pageNum) {
    const page = await state.pdfDoc.getPage(pageNum);
    const ol = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const view = page.view;
    const pageArea = Math.abs((view[2] - view[0]) * (view[3] - view[1]));
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let annotDepth = 0;
    const out = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], args = ol.argsArray[i];
      if (fn === OPS.beginAnnotation) { annotDepth++; continue; }
      if (fn === OPS.endAnnotation) { annotDepth = Math.max(0, annotDepth - 1); continue; }
      if (annotDepth) continue;
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) { const g = stack.pop(); if (g) ctm = g; }
      else if (fn === OPS.transform) ctm = mul6(args, ctm);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (args && args[0]) ctm = mul6(args[0], ctm); }
      else if (fn === OPS.paintFormXObjectEnd) { const g = stack.pop(); if (g) ctm = g; }
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
        const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
        const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
        const w = x1 - x0, h = y1 - y0;
        if (w < 10 || h < 10 || w * h > pageArea * 0.85) continue;
        out.push({
          key: pageNum + ":i" + out.length, page: pageNum, x0, y0, x1, y1,
          objId: fn === OPS.paintImageXObject && args ? args[0] : null,
          upright: Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6 && ctm[0] > 0 && ctm[3] > 0,
          pdfPage: page,
        });
      }
    }
    return out;
  }
  // The image's own pixels when pdf.js still holds them (full quality), otherwise a sharp crop of
  // that area rendered at high resolution.
  async function imageBlockDataUrl(im) {
    if (im.objId && im.upright) {
      try {
        const store = im.objId.startsWith("g_") ? im.pdfPage.commonObjs : im.pdfPage.objs;
        if (store.has(im.objId)) {
          const obj = store.get(im.objId);
          if (obj && obj.width && obj.height) {
            const c = document.createElement("canvas");
            c.width = obj.width; c.height = obj.height;
            const cx = c.getContext("2d");
            let alpha = false;
            if (obj.bitmap) { cx.drawImage(obj.bitmap, 0, 0); alpha = true; }
            else if (obj.data) {
              const id = cx.createImageData(obj.width, obj.height);
              const src = obj.data, dst = id.data, n = obj.width * obj.height;
              if (obj.kind === 3) { dst.set(src.subarray(0, n * 4)); alpha = true; }
              else if (obj.kind === 2) {
                for (let k = 0; k < n; k++) { dst[k * 4] = src[k * 3]; dst[k * 4 + 1] = src[k * 3 + 1]; dst[k * 4 + 2] = src[k * 3 + 2]; dst[k * 4 + 3] = 255; }
              } else throw new Error("unsupported image kind");
              cx.putImageData(id, 0, 0);
            } else throw new Error("no pixels");
            return alpha ? { url: c.toDataURL("image/png"), mime: "image/png" } : { url: c.toDataURL("image/jpeg", 0.92), mime: "image/jpeg" };
          }
        }
      } catch (err) { /* fall through to the crop */ }
    }
    const { canvas, viewport } = await renderPageToCanvas(im.page, 2400);
    const a = viewport.convertToViewportPoint(im.x0, im.y1), b = viewport.convertToViewportPoint(im.x1, im.y0);
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(b[0] - a[0]));
    crop.height = Math.max(1, Math.round(b[1] - a[1]));
    crop.getContext("2d").drawImage(canvas, a[0], a[1], b[0] - a[0], b[1] - a[1], 0, 0, crop.width, crop.height);
    return { url: crop.toDataURL("image/jpeg", 0.92), mime: "image/jpeg" };
  }
  async function beginEditImage(im) {
    showLoading("ছবি তৈরি হচ্ছে...");
    try {
      const { url, mime } = await imageBlockDataUrl(im);
      const box = {
        id: state.nextId++, page: im.page, type: "image",
        xPdf: im.x0, yTopPdf: im.y1, widthPdf: im.x1 - im.x0, heightPdf: im.y1 - im.y0,
        imageDataUrl: url, mime,
        // 1pt bleed so the original's anti-aliased edge doesn't peek out around the patch
        cover: { x: im.x0 - 1, y: im.y0 - 1, w: im.x1 - im.x0 + 2, h: im.y1 - im.y0 + 2, color: "#ffffff" },
        sourceKey: im.key,
      };
      box.pristine = pristineSig(box);
      state.boxes.push(box);
      setSelection([box.id]);
      renderBoxes();
      renderTextLayer();
      commit();
    } catch (err) {
      console.error(err);
      showToast("ছবিটা এডিটের জন্য আনা যায়নি: " + err.message, "error");
    } finally {
      hideLoading();
    }
  }
  // Untouched edited items (clicked, then left alone) keep the original exactly as it was.
  function pristineSig(b) {
    return JSON.stringify([b.text, b.xPdf, b.yTopPdf, b.widthPdf, b.heightPdf, b.fontSize, b.bold, b.color,
      b.fontKey, b.autoFont, b.lineHeight, b.imageDataUrl && b.imageDataUrl.length]);
  }
  function isPristine(b) { return !!b.pristine && pristineSig(b) === b.pristine; }

  // Replace the selected image (new or original) with another picture, keeping its place.
  let replaceTarget = null;
  document.getElementById("fbReplaceImg").addEventListener("click", () => {
    const box = currentBox();
    if (!box || box.type !== "image") return;
    replaceTarget = box.id;
    els.imageBoxInput.click();
  });

  // ---------------------------------------------------------------- OCR (scanned pages)
  function ocrProgressToast() {
    let last = -1;
    return (m) => {
      if (m.status === "recognizing text") {
        const pct = Math.round((m.progress || 0) * 100);
        if (pct !== last) { last = pct; showLoading("লেখা পড়া হচ্ছে... " + bnNum(pct) + "%"); }
      } else if (/loading|initializ/i.test(m.status || "")) {
        showLoading("OCR প্রস্তুত হচ্ছে (প্রথমবার একটু সময় লাগে)...");
      }
    };
  }
  async function renderPageToCanvas(pageNum, targetWidth) {
    const page = await state.pdfDoc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, targetWidth / base.width);
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    return { canvas: c, viewport: vp };
  }

  async function ocrCurrentPage() {
    const pageNum = state.currentPage;
    showLoading("OCR প্রস্তুত হচ্ছে...");
    try {
      const worker = await getOcrWorker(ocrProgressToast());
      setOcrProgressHandler(ocrProgressToast());
      const { canvas, viewport } = await renderPageToCanvas(pageNum, 2400);
      const { data } = await worker.recognize(canvas);
      const segments = [];
      (data.lines || []).forEach((ln) => {
        const text = (ln.text || "").replace(/\s+/g, " ").trim();
        if (!text || (ln.confidence != null && ln.confidence < 35)) return;
        const b = ln.bbox;
        const p0 = viewport.convertToPdfPoint(b.x0, b.y0), p1 = viewport.convertToPdfPoint(b.x1, b.y1);
        const top = Math.max(p0[1], p1[1]), bottom = Math.min(p0[1], p1[1]);
        const bl = ln.baseline && isFinite(ln.baseline.y0)
          ? viewport.convertToPdfPoint(b.x0, (ln.baseline.y0 + ln.baseline.y1) / 2)[1]
          : bottom + (top - bottom) * 0.22;
        const size = Math.max(4, (top - bottom) / 1.25);
        segments.push({
          x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]), baseline: bl, size, text,
          top, bottom, fontId: "ocr", realName: "", family: "",
        });
      });
      const blocks = segmentsToBlocks(segments, pageNum, "o");
      textBlockCache.set(pageNum, Promise.resolve({ blocks, source: "ocr" }));
      if (!blocks.length) showToast("এই পাতায় পড়ার মতো কোনো লেখা পাওয়া যায়নি।", "warn");
      else showToast(bnNum(blocks.length) + "টি লেখার অংশ পাওয়া গেছে — ক্লিক করে এডিট করুন। OCR-এ ছোটখাটো ভুল থাকতে পারে, মিলিয়ে নিন।", "success", 6000);
      renderTextLayer();
    } catch (err) {
      console.error(err);
      showToast(err.message || "OCR করা যায়নি।", "error");
    } finally {
      setOcrProgressHandler(null);
      hideLoading();
    }
  }

  // Re-reads one edited block's original area with OCR -- for text the PDF itself stores badly
  // (old Bijoy fonts, broken Bangla extraction).
  async function ocrFixSelected() {
    const box = currentBox();
    if (!box || box.type !== "text" || !box.cover) return;
    showLoading("OCR প্রস্তুত হচ্ছে...");
    try {
      const worker = await getOcrWorker(ocrProgressToast());
      setOcrProgressHandler(ocrProgressToast());
      const { canvas, viewport } = await renderPageToCanvas(box.page, 3000);
      const c = box.cover;
      const a = viewport.convertToViewportPoint(c.x, c.y + c.h), b = viewport.convertToViewportPoint(c.x + c.w, c.y);
      const crop = document.createElement("canvas");
      const pad = 12;
      crop.width = Math.max(1, Math.round(b[0] - a[0]) + pad * 2);
      crop.height = Math.max(1, Math.round(b[1] - a[1]) + pad * 2);
      const cctx = crop.getContext("2d");
      cctx.fillStyle = "#fff";
      cctx.fillRect(0, 0, crop.width, crop.height);
      cctx.drawImage(canvas, a[0], a[1], b[0] - a[0], b[1] - a[1], pad, pad, b[0] - a[0], b[1] - a[1]);
      const { data } = await worker.recognize(crop);
      const text = (data.text || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      if (!text) { showToast("এই অংশে কোনো লেখা পড়া যায়নি।", "warn"); return; }
      box.text = text;
      box.unreliable = undefined;
      renderBoxes();
      commit();
      showToast("OCR দিয়ে লেখা আবার পড়া হয়েছে — মিলিয়ে নিন।", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "OCR করা যায়নি।", "error");
    } finally {
      setOcrProgressHandler(null);
      hideLoading();
    }
  }

  // ---------------------------------------------------------------- fillable forms
  const formAnnotCache = new Map(); // page -> Promise<annotations>
  function fieldWidgets(pageNum) {
    if (!formAnnotCache.has(pageNum)) {
      formAnnotCache.set(pageNum, state.pdfDoc.getPage(pageNum)
        .then((p) => p.getAnnotations({ intent: "display" }))
        .then((list) => list.filter((a) => a.subtype === "Widget" && a.fieldName && !a.hidden))
        .catch(() => []));
    }
    return formAnnotCache.get(pageNum);
  }
  function setFormValue(name, value) {
    state.formValues[name] = value;
    commitSoon();
  }
  let formLayerToken = 0;
  async function renderFormLayer() {
    const layer = ensureLayer("form-layer");
    const token = ++formLayerToken;
    if (!state.hasForm || !state.pdfDoc) { layer.innerHTML = ""; return; }
    const pageNum = state.currentPage;
    const widgets = await fieldWidgets(pageNum);
    if (token !== formLayerToken || pageNum !== state.currentPage) return;
    layer.innerHTML = "";
    widgets.forEach((a) => {
      const [x1, y1, x2, y2] = a.rect;
      const r = pdfRectToCss(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      const name = a.fieldName;
      const has = Object.prototype.hasOwnProperty.call(state.formValues, name);
      let el = null;
      if (a.fieldType === "Tx") {
        el = document.createElement(a.multiLine ? "textarea" : "input");
        if (!a.multiLine) el.type = "text";
        el.value = has ? state.formValues[name] : (a.fieldValue || "");
        if (a.maxLen) el.maxLength = a.maxLen;
        const fs = a.textFormat && a.textFormat.fontSize ? a.textFormat.fontSize : (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || 0;
        el.style.fontSize = (fs ? fs * state.scale : Math.min(r.height * 0.7, 14 * state.scale)) + "px";
        el.addEventListener("input", () => {
          setFormValue(name, el.value);
          layer.querySelectorAll('[data-field="' + CSS.escape(name) + '"]').forEach((o) => { if (o !== el) o.value = el.value; });
        });
      } else if (a.fieldType === "Btn" && (a.checkBox || a.radioButton)) {
        el = document.createElement("input");
        el.type = a.checkBox ? "checkbox" : "radio";
        if (a.radioButton) el.name = "nothi-radio-" + name;
        const on = a.checkBox ? a.exportValue : a.buttonValue;
        const current = has ? state.formValues[name] : a.fieldValue;
        el.checked = a.checkBox ? (has ? !!current : (current && current !== "Off" && current === on)) : current === on;
        el.addEventListener("change", () => {
          if (a.checkBox) setFormValue(name, el.checked);
          else if (el.checked) setFormValue(name, on);
        });
      } else if (a.fieldType === "Ch") {
        el = document.createElement("select");
        (a.options || []).forEach((o) => {
          const opt = document.createElement("option");
          opt.value = o.exportValue != null ? o.exportValue : o.displayValue;
          opt.textContent = o.displayValue != null ? o.displayValue : o.exportValue;
          el.appendChild(opt);
        });
        const cur = has ? state.formValues[name] : (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue);
        if (cur != null) el.value = cur;
        el.style.fontSize = Math.min(r.height * 0.7, 13 * state.scale) + "px";
        el.addEventListener("change", () => setFormValue(name, el.value));
      }
      if (!el) return;
      el.className = "form-field form-" + (el.type || el.tagName.toLowerCase());
      el.dataset.field = name;
      el.disabled = !!a.readOnly;
      el.title = a.alternativeText || name;
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
      el.style.width = r.width + "px";
      el.style.height = r.height + "px";
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      layer.appendChild(el);
    });
  }

  async function applyFormValues(outDoc, font) {
    const names = Object.keys(state.formValues);
    if (!names.length) return;
    let form;
    try { form = outDoc.getForm(); } catch (err) { return; }
    let failed = 0;
    for (const name of names) {
      const v = state.formValues[name];
      try {
        const f = form.getField(name);
        if (f instanceof PDFLib.PDFTextField) f.setText(String(v || ""));
        else if (f instanceof PDFLib.PDFCheckBox) { if (v) f.check(); else f.uncheck(); }
        else if (f instanceof PDFLib.PDFRadioGroup) f.select(String(v));
        else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) f.select(String(v));
      } catch (err) {
        failed++;
        console.warn("[Nothi] couldn't fill field " + name, err);
      }
    }
    // Hind Siliguri covers both Bangla and Latin, so Bangla typed into a field renders correctly
    // instead of failing on Helvetica's Latin-only encoding.
    try { form.updateFieldAppearances(font); }
    catch (err) { console.warn("[Nothi] field appearance update failed:", err); }
    if (failed) showToast(bnNum(failed) + "টি ফর্ম-ঘর পূরণ করা যায়নি।", "warn");
  }

  // ---------------------------------------------------------------- undo / redo
  // Snapshots of the whole editable state. Boxes are copied shallowly -- strings (including big
  // image data URLs) are immutable and shared, so 100 snapshots cost little memory.
  const history = { stack: [], index: -1, timer: null };
  const HISTORY_LIMIT = 100;
  function snapshot() {
    return {
      boxes: state.boxes.map((b) => ({ ...b })),
      deleted: state.deletedRestoredBoxes.slice(),
      formValues: { ...state.formValues },
    };
  }
  function signature(s) {
    return JSON.stringify(s, (k, v) => (k === "imageDataUrl" ? (v ? v.length + ":" + v.slice(-24) : v) : k === "_orig" ? undefined : v));
  }
  function commit() {
    clearTimeout(history.timer);
    history.timer = null;
    const s = snapshot();
    const sig = signature(s);
    const cur = history.stack[history.index];
    if (cur && cur.sig === sig) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push({ s, sig });
    if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
    history.index = history.stack.length - 1;
    updateUndoButtons();
    scheduleAutosave();
  }
  function commitSoon() {
    clearTimeout(history.timer);
    history.timer = setTimeout(commit, 450);
  }
  function resetHistory() {
    clearTimeout(history.timer);
    history.stack = [];
    history.index = -1;
    commit();
  }
  function restoreSnapshot(s) {
    state.boxes = s.boxes.map((b) => ({ ...b }));
    state.deletedRestoredBoxes = s.deleted.slice();
    state.formValues = { ...s.formValues };
    setSelection([...state.selection].filter((id) => state.boxes.some((b) => b.id === id)));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderBoxes();
    renderTextLayer();
    renderFormLayer();
    updateUndoButtons();
    scheduleAutosave();
  }
  function undo() {
    if (history.timer) commit();
    if (history.index <= 0) { if (pageUndoStack.length) undoPageOperation(); return; }
    history.index--;
    restoreSnapshot(history.stack[history.index].s);
  }
  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    restoreSnapshot(history.stack[history.index].s);
  }
  function updateUndoButtons() {
    els.btnUndo.disabled = !state.pdfDoc || (history.index <= 0 && !pageUndoStack.length);
    els.btnRedo.disabled = !state.pdfDoc || history.index >= history.stack.length - 1;
  }
  els.btnUndo.addEventListener("click", undo);
  els.btnRedo.addEventListener("click", redo);

  // ---------------------------------------------------------------- autosave
  // The open PDF and every edit are kept in this browser's IndexedDB, so a closed tab, crash or
  // accidental refresh no longer loses work -- the landing page offers to continue.
  const AUTOSAVE_META = "autosave-meta", AUTOSAVE_PDF = "autosave-pdf";
  const AUTOSAVE_MAX_BYTES = 80 * 1024 * 1024;
  let autosaveTimer = null;
  function saveAutosavePdf() {
    if (!state.pdfBytes || state.pdfBytes.length > AUTOSAVE_MAX_BYTES) return;
    idbSet(AUTOSAVE_PDF, state.pdfBytes);
    scheduleAutosave();
  }
  function scheduleAutosave() {
    if (!state.pdfBytes) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (!state.pdfBytes || state.pdfBytes.length > AUTOSAVE_MAX_BYTES) return;
      idbSet(AUTOSAVE_META, {
        fileName: state.sourceFileName,
        boxes: state.boxes,
        deleted: state.deletedRestoredBoxes,
        formValues: state.formValues,
        page: state.currentPage,
        numPages: state.numPages,
        savedAt: Date.now(),
      });
    }, 900);
  }
  function clearAutosave() {
    clearTimeout(autosaveTimer);
    idbDel(AUTOSAVE_META);
    idbDel(AUTOSAVE_PDF);
  }
  function timeAgoBn(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "এইমাত্র";
    if (s < 3600) return bnNum(Math.round(s / 60)) + " মিনিট আগে";
    if (s < 86400) return bnNum(Math.round(s / 3600)) + " ঘণ্টা আগে";
    return bnNum(Math.round(s / 86400)) + " দিন আগে";
  }
  async function checkAutosave() {
    els.restoreCard.hidden = true;
    const meta = await idbGet(AUTOSAVE_META);
    if (!meta || state.pdfDoc) return;
    const edits = (meta.boxes || []).length + Object.keys(meta.formValues || {}).length;
    if (!edits) return;
    els.restoreName.textContent = (meta.fileName || "nothi") + ".pdf";
    els.restoreTime.textContent = bnNum(edits) + "টি এডিট · " + timeAgoBn(meta.savedAt || Date.now());
    els.restoreCard.hidden = false;
  }
  els.restoreBtn.addEventListener("click", async () => {
    const meta = await idbGet(AUTOSAVE_META);
    const bytes = await idbGet(AUTOSAVE_PDF);
    els.restoreCard.hidden = true;
    if (!meta || !bytes) { showToast("আগের কাজ আর পাওয়া যাচ্ছে না।", "warn"); return; }
    await openDocument(new Uint8Array(bytes), meta.fileName, { restore: meta });
  });
  els.restoreDiscardBtn.addEventListener("click", () => {
    clearAutosave();
    els.restoreCard.hidden = true;
  });
  window.addEventListener("beforeunload", () => {
    if (history.timer) commit();
  });
  checkAutosave();

  // ---------------------------------------------------------------- keyboard
  function isTypingTarget(t) {
    return t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
  }
  document.addEventListener("keydown", (e) => {
    if (!state.pdfDoc) return;
    if (!els.modalBackdrop.hidden || document.querySelector(".filename-backdrop:not([hidden])")) return;
    const mod = e.ctrlKey || e.metaKey;
    const typing = isTypingTarget(e.target);
    const k = e.key.toLowerCase();

    if (mod && k === "s") { e.preventDefault(); els.btnDownload.click(); return; }
    // inside a text box, the browser's own text undo is what people expect
    if (typing) {
      if (e.key === "Escape") { e.target.blur(); setSelection([]); }
      return;
    }
    if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && k === "a") {
      e.preventDefault();
      setSelection(state.boxes.filter((b) => b.page === state.currentPage).map((b) => b.id));
      return;
    }
    if (mod && k === "c") { copySelection(); return; }
    if (mod && k === "v") { e.preventDefault(); pasteClipboard(); return; }
    if (mod && k === "d") { e.preventDefault(); duplicateSelection(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selection.size) {
      e.preventDefault();
      deleteBoxes([...state.selection]);
      return;
    }
    if (e.key === "Escape") { setSelection([]); closeShapeMenu(); return; }
    if (e.key.startsWith("Arrow") && state.selection.size) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1);
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
      nudgeSelection(dx, dy);
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp" || e.key === "ArrowDown" || e.key === "ArrowUp" ||
        e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const sw = els.stageWrap;
      const down = e.key === "PageDown" || e.key === "ArrowDown" || e.key === "ArrowRight";
      const line = e.key.startsWith("Arrow") && (e.key === "ArrowDown" || e.key === "ArrowUp");
      if (line) {
        // arrow keys scroll the page first, then continue onto the next/previous page at the edge
        const atBottom = sw.scrollTop + sw.clientHeight >= sw.scrollHeight - 2;
        const atTop = sw.scrollTop <= 1;
        if (down && !atBottom) { sw.scrollBy({ top: 80 }); return; }
        if (!down && !atTop) { sw.scrollBy({ top: -80 }); return; }
      }
      goToPage(state.currentPage + (down ? 1 : -1), down ? "top" : "bottom");
      return;
    }
    if (e.key === "Home") { e.preventDefault(); goToPage(1, "top"); return; }
    if (e.key === "End") { e.preventDefault(); goToPage(state.numPages, "top"); return; }
    if (mod || e.altKey) return;
    if (k === "v") setMode("select");
    else if (k === "e") setMode("edit");
    else if (k === "t") setMode("text");
    else if (k === "r") { state.shapeKind = "rect"; els.toolShapeIcon.setAttribute("href", "#i-shape-rect"); setMode("shape"); }
    else if (k === "h") { state.shapeKind = "highlight"; els.toolShapeIcon.setAttribute("href", "#i-shape-highlight"); setMode("shape"); }
    else if (k === "w") { state.shapeKind = "whiteout"; els.toolShapeIcon.setAttribute("href", "#i-shape-whiteout"); setMode("shape"); }
  });

  // -------------------------------------------------------------- export
  function splitByScript(text) {
    // Word-level split: a Bangla sentence's own punctuation/digits/spaces stay with their Bangla
    // neighbors; only an actual run of Latin/other-script words switches font.
    const BENGALI_RE = /[ঀ-৿]/;
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

  // A box restored from an earlier export that nobody touched is already baked into the page --
  // drawing it again (or painting over its old footprint) would only damage what's under it.
  function stripForCompare(b) {
    const { id, _orig, ...rest } = b;
    return JSON.stringify(rest);
  }
  function isUnchangedRestored(box) {
    return !!box._orig && stripForCompare(box) === stripForCompare(box._orig);
  }

  els.btnDownload.addEventListener("click", async () => {
    if (!state.pdfBytes) return;
    if (history.timer) commit();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const label = els.btnDownload.querySelector("span");
    const original = label ? label.textContent : "";
    els.btnDownload.disabled = true;
    if (label) label.textContent = "তৈরি হচ্ছে...";
    try {
      const outDoc = await PDFLib.PDFDocument.load(state.pdfBytes.slice());
      outDoc.registerFontkit(window.fontkit);
      // Kalpurush ships one weight, so bold on it is a faux-bold double strike.
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

      function fontFor(b) {
        const fontDef = FONT_LIBRARY[b.fontKey] || FONT_LIBRARY.hind;
        const fontSet = embeds[b.fontKey] || embeds.hind;
        return (b.bold && fontDef.hasBold) ? fontSet.bold : fontSet.regular;
      }
      // footprint of text drawn by an earlier export, from that box's own saved values
      function textFootprint(orig) {
        const font = fontFor(orig);
        let count = 6;
        try {
          const lines = orig.autoFont
            ? wrapMixedText(orig.text, orig.fontSize, orig.widthPdf, font, orig.bold ? embeds.tinos.bold : embeds.tinos.regular)
            : wrapText(orig.text, font, orig.fontSize, orig.widthPdf);
          count = Math.max(1, lines.length);
        } catch (err) { /* keep the generous fallback */ }
        const lineHeight = orig.fontSize * (orig.lineHeight || DEFAULT_LINE_HEIGHT);
        const pad = 3;
        const height = count * lineHeight + pad * 2;
        return { x: orig.xPdf - pad, y: orig.yTopPdf - height + pad, w: orig.widthPdf + pad * 2, h: height };
      }
      function boxRect(b) { return { x: b.xPdf, y: b.yTopPdf - b.heightPdf, w: b.widthPdf, h: b.heightPdf }; }

      // ---- pass 1: collect, per page, every area whose old text must go
      // jobs: { rect, color, paint: "always" | "ifNeeded", needsCover }
      const jobsByPage = new Map();
      function addJob(pageIdx, rect, color, paint, removeText, removeImage) {
        if (!pages[pageIdx]) return;
        if (!jobsByPage.has(pageIdx)) jobsByPage.set(pageIdx, []);
        jobsByPage.get(pageIdx).push({ rect, color: color || "#ffffff", paint, removeText, removeImage, needsCover: true });
      }
      for (const orig of state.deletedRestoredBoxes) {
        if (orig.type === "text") addJob(orig.page - 1, textFootprint(orig), "#ffffff", "ifNeeded", true);
        else if (orig.type === "image" || (orig.type === "shape" && orig.shape !== "whiteout")) addJob(orig.page - 1, boxRect(orig), "#ffffff", "always", false);
      }
      const drawList = [];
      for (const box of state.boxes) {
        if (isUnchangedRestored(box) || isPristine(box)) continue;
        const pi = box.page - 1;
        if (box._orig) {
          const o = box._orig;
          if (o.type === "text") addJob(o.page - 1, textFootprint(o), "#ffffff", "ifNeeded", true);
          else if (o.type === "image" || (o.type === "shape" && o.shape !== "whiteout")) addJob(o.page - 1, boxRect(o), "#ffffff", "always", false);
        }
        if (box.type === "text" && box.cover) addJob(pi, box.cover, box.cover.color, "ifNeeded", true);
        if (box.type === "image" && box.cover) addJob(pi, box.cover, "#ffffff", "ifNeeded", false, true);
        if (box.type === "shape" && box.shape === "whiteout") {
          const img = box.fromEdit && box.coverKind === "image";
          addJob(pi, boxRect(box), box.color || "#ffffff", box.fromEdit ? "ifNeeded" : "always", !img, img);
          continue;
        }
        drawList.push(box);
      }

      // ---- pass 2: really remove the old glyphs, then paint covers only where that wasn't enough
      const stdWidths = makeStandardWidthLookup();
      let coverOnly = 0;
      for (const [pageIdx, jobs] of jobsByPage) {
        const removable = jobs.filter((j) => j.removeText);
        if (removable.length) {
          try {
            const res = await removeTextInRects(outDoc, pageIdx, removable.map((j) => j.rect), stdWidths);
            removable.forEach((j, i) => { j.needsCover = res.needsCover[i]; });
          } catch (err) {
            console.warn("[Nothi] text removal failed on page " + (pageIdx + 1) + ", using cover boxes:", err);
          }
        }
        const imageJobs = jobs.filter((j) => j.removeImage);
        if (imageJobs.length) {
          try {
            const res = await removeImagesInRects(outDoc, pageIdx, imageJobs.map((j) => j.rect));
            imageJobs.forEach((j, i) => { j.needsCover = !res.removed[i]; });
          } catch (err) {
            console.warn("[Nothi] image removal failed on page " + (pageIdx + 1) + ", using cover boxes:", err);
          }
        }
        const page = pages[pageIdx];
        for (const j of jobs) {
          if (j.paint === "ifNeeded" && !j.needsCover) continue;
          if (j.paint === "ifNeeded" && (j.removeText || j.removeImage)) coverOnly++;
          const { r, g, b } = hexToRgb01(j.color);
          page.drawRectangle({ x: j.rect.x, y: j.rect.y, width: j.rect.w, height: j.rect.h, color: PDFLib.rgb(r, g, b) });
        }
      }

      // ---- pass 3: draw everything new, in z-order
      for (const box of drawList) {
        const page = pages[box.page - 1];
        if (!page) continue;

        if (box.type === "image") {
          if (!box.imageDataUrl) continue;
          try {
            const base64 = box.imageDataUrl.split(",")[1] || "";
            const imgBytes = b64ToUint8Array(base64);
            const embedded = box.mime === "image/png" ? await outDoc.embedPng(imgBytes) : await outDoc.embedJpg(imgBytes);
            page.drawImage(embedded, { x: box.xPdf, y: box.yTopPdf - box.heightPdf, width: box.widthPdf, height: box.heightPdf });
          } catch (err) {
            console.error("Could not embed an image box:", err);
            showToast("একটা ছবি PDF-এ বসাতে সমস্যা হয়েছে: " + err.message, "error");
          }
          continue;
        }

        if (box.type === "shape") {
          drawShape(page, box);
          continue;
        }

        if (!box.text || !box.text.trim()) continue;
        const fontDef = FONT_LIBRARY[box.fontKey] || FONT_LIBRARY.hind;
        const faux = box.bold && !fontDef.hasBold;
        const font = fontFor(box);
        const { r, g, b } = hexToRgb01(box.color);
        const color = PDFLib.rgb(r, g, b);
        const lineHeight = box.fontSize * lineHeightOf(box);
        const baseline = box.yTopPdf - box.fontSize * BASELINE_RATIO;
        const fauxOffset = box.fontSize * 0.035;

        if (box.autoFont) {
          // Bangla runs in the box's Bangla font, everything else in Tinos.
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
            if (faux) page.drawText(line, { x: box.xPdf + fauxOffset, y: ly, size: box.fontSize, font, color });
          });
        }
      }

      await applyFormValues(outDoc, embeds.hind.regular);

      // Every box goes into the PDF as private data, so re-uploading this file restores them all.
      try {
        const projectPayload = JSON.stringify({ nothiVersion: 2, boxes: state.boxes });
        const projectBytes = new TextEncoder().encode(projectPayload);
        const streamDict = outDoc.context.obj({ Length: projectBytes.length });
        const stream = PDFLib.PDFRawStream.of(streamDict, projectBytes);
        const ref = outDoc.context.register(stream);
        outDoc.catalog.set(PDFLib.PDFName.of("NothiProjectData"), ref);
      } catch (err) {
        console.error("Could not embed project data for later re-editing (download still proceeds):", err);
      }

      const outBytes = await outDoc.save();
      const saved = await saveFileToDisk(`${state.sourceFileName || "nothi"}-edited.pdf`, outBytes);
      if (saved && coverOnly) {
        showToast("কিছু লেখা (স্ক্যান/ছবি বা বিশেষ ফন্টের) ফাইল থেকে মোছা যায়নি, তাই সেগুলো ঢেকে দেওয়া হয়েছে।", "info", 6000);
      }
    } catch (err) {
      console.error(err);
      showToast("এক্সপোর্ট করতে সমস্যা হয়েছে: " + err.message, "error");
    } finally {
      els.btnDownload.disabled = false;
      if (label) label.textContent = original;
    }
  });

  function drawShape(page, box) {
    const { r, g, b } = hexToRgb01(box.color || SHAPE_DEFAULT_COLOR[box.shape]);
    const color = PDFLib.rgb(r, g, b);
    const x = box.xPdf, yTop = box.yTopPdf, w = box.widthPdf, h = box.heightPdf;
    const sw = box.strokeWidth || 2;
    switch (box.shape) {
      case "highlight":
        page.drawRectangle({ x, y: yTop - h, width: w, height: h, color, opacity: 0.4, blendMode: PDFLib.BlendMode.Multiply });
        break;
      case "rect":
        page.drawRectangle({
          x: x + sw / 2, y: yTop - h + sw / 2, width: Math.max(0, w - sw), height: Math.max(0, h - sw),
          borderColor: color, borderWidth: sw,
          ...(box.fill ? { color, opacity: 0.2, borderOpacity: 1 } : {}),
        });
        break;
      case "ellipse":
        page.drawEllipse({
          x: x + w / 2, y: yTop - h / 2, xScale: Math.max(0, w / 2 - sw / 2), yScale: Math.max(0, h / 2 - sw / 2),
          borderColor: color, borderWidth: sw,
          ...(box.fill ? { color, opacity: 0.2, borderOpacity: 1 } : {}),
        });
        break;
      case "line":
        page.drawLine({ start: { x, y: yTop - h / 2 }, end: { x: x + w, y: yTop - h / 2 }, thickness: sw, color, lineCap: PDFLib.LineCapStyle.Round });
        break;
      case "check":
      case "cross": {
        const s = Math.min(w, h) / 24;
        page.drawSvgPath(box.shape === "check" ? CHECK_PATH : CROSS_PATH, {
          x: x + (w - 24 * s) / 2, y: yTop - (h - 24 * s) / 2, scale: s,
          borderColor: color, borderWidth: 2.6, borderLineCap: PDFLib.LineCapStyle.Round,
        });
        break;
      }
      default: break;
    }
  }

  setMode("edit");
  updateUndoButtons();
