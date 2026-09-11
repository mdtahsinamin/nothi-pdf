// The core PDF viewing/editing engine: upload, render, text boxes (create/select/drag/resize),
// smart alignment guides, floating toolbar, zoom/page nav, and the main export (download) pipeline.
"use strict";
import { els, state, FONT_LIBRARY, BN_FONT_READY, b64ToUint8Array, showToast, saveFileToDisk } from "./core.js";

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

  // ---------------------------------------------------------------- image / signature boxes
  // Not a persistent "mode" like select/text -- clicking it immediately opens a file picker, and
  // the picked image is dropped onto the current page pre-centered, ready to drag/resize like any
  // text box. No separate "click to place" step: the box needs the image's own aspect ratio before
  // it can be drawn at all, so there's nothing useful to do between picking the file and placing it.
  els.toolImage.addEventListener("click", () => {
    if (!state.pdfDoc) { showToast("প্রথমে একটা PDF আপলোড করুন।", "warn"); return; }
    els.imageBoxInput.click();
  });
  els.imageBoxInput.addEventListener("change", async (e) => {
    const file = (e.target.files && e.target.files[0]) || null;
    e.target.value = "";
    if (file) await addImageBox(file);
  });

  function dataUrlMime(dataUrl) {
    const m = /^data:([^;]+);base64,/.exec(dataUrl || "");
    return m ? m[1] : "";
  }

  async function addImageBox(file) {
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

    // pdf-lib can only embed PNG/JPEG -- anything else the browser accepted (webp, gif, bmp, svg)
    // gets normalized to PNG here via canvas, once, so the export step never has to guess or fail
    // on an unsupported format later.
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

    const pageWidthPdf = state.viewport ? state.viewport.width / state.scale : 595;
    const pageHeightPdf = state.viewport ? state.viewport.height / state.scale : 842;
    const aspect = img.naturalHeight / img.naturalWidth || 1;
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
    renderBoxes();
    selectBox(box.id);
    showToast("ছবি বসানো হয়েছে — টেনে সরান, কোণা ধরে সাইজ বদলান।", "info");
  }

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
              // Snapshot every persistable field (not a hand-picked list) so this works for any
              // box type, including image boxes -- their own fields (heightPdf, imageDataUrl,
              // mime) would otherwise be silently dropped from `_orig`, breaking the "whiteout
              // the old footprint before redrawing" logic in the export step below.
              state.boxes = payload.boxes.map((b) => {
                const { id: _oldId, _orig: _oldOrig, ...rest } = b;
                const restored = { ...rest, id: state.nextId++ };
                restored._orig = { ...rest };
                return restored;
              });
              console.log(`[Nothi] restored ${state.boxes.length} box(es) from this PDF's saved data.`);
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

    const del = document.createElement("div");
    del.className = "tb-del";
    del.textContent = "×";
    del.title = "মুছুন";
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteBox(box.id); });

    if (box.type === "image") {
      div.style.width = box.widthPdf * state.scale + "px";
      div.style.height = box.heightPdf * state.scale + "px";

      const img = document.createElement("img");
      img.className = "imgbox-content";
      img.src = box.imageDataUrl;
      img.draggable = false;
      img.alt = "";

      const resizeCorner = document.createElement("div");
      resizeCorner.className = "tb-resize-corner";
      resizeCorner.title = "টেনে সাইজ বদলান";
      resizeCorner.addEventListener("pointerdown", (e) => startResizeImage(e, box, div));

      div.addEventListener("pointerdown", (e) => {
        if (e.target !== div && e.target !== img) return;
        e.preventDefault();
        startDrag(e, box, div);
      });

      div.appendChild(img);
      div.appendChild(del);
      div.appendChild(resizeCorner);
      return div;
    }

    div.style.width = box.widthPdf * state.scale + "px";

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
    const isImage = box.type === "image";
    els.floatingBar.classList.toggle("fb-image-mode", isImage);
    if (!isImage) {
      els.fbFontSize.value = box.fontSize;
      els.fbBold.classList.toggle("active", !!box.bold);
      els.fbColor.value = box.color;
      els.fbFont.value = box.fontKey || "hind";
      els.fbAutoFont.classList.toggle("active", !!box.autoFont);
    }
    positionFloatingBar(box);
  }
  function hideFloatingBar() { els.floatingBar.style.display = "none"; }
  function positionFloatingBar(box) {
    const pos = pdfToCss(box.xPdf, box.yTopPdf);
    els.floatingBar.style.display = "flex";
    const barH = els.floatingBar.offsetHeight || 36;
    const barW = els.floatingBar.offsetWidth || 190;
    let top = pos.y - barH - 8;
    const boxHeightCss = (box.fontSize != null ? box.fontSize : box.heightPdf || 20) * state.scale;
    if (top < 4) top = pos.y + boxHeightCss + 8;
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
      type: "text",
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

  // Image/signature boxes resize both dimensions together from a corner handle, keeping the
  // original aspect ratio -- unlike a text box, there's no wrapped-text reflow to fall back on,
  // so a free (non-proportional) resize would just stretch/squash the picture.
  function startResizeImage(e, box, el) {
    e.preventDefault();
    e.stopPropagation();
    selectBox(box.id);
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* not supported for this pointer type -- fine */ }
    const startX = e.clientX;
    const startWidthCss = box.widthPdf * state.scale;
    const aspect = box.heightPdf / box.widthPdf;

    function onMove(ev) {
      const newWidthCss = Math.max(20, startWidthCss + (ev.clientX - startX));
      box.widthPdf = newWidthCss / state.scale;
      box.heightPdf = box.widthPdf * aspect;
      el.style.width = newWidthCss + "px";
      el.style.height = (box.heightPdf * state.scale) + "px";
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
    positionFloatingBar({ xPdf: cssToPdf(x, y).x, yTopPdf: cssToPdf(x, y).y, fontSize: d.box.fontSize, heightPdf: d.box.heightPdf });
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
      // An image box's old footprint is just its own rectangle -- no text-wrap measuring needed.
      function whiteoutOrigImage(page, orig) {
        page.drawRectangle({
          x: orig.xPdf, y: orig.yTopPdf - orig.heightPdf,
          width: orig.widthPdf, height: orig.heightPdf,
          color: PDFLib.rgb(1, 1, 1),
        });
      }

      // Boxes restored from a previous export, then deleted/emptied in this session -- their old
      // content must disappear even though there's no current box left to draw over it.
      for (const orig of state.deletedRestoredBoxes) {
        const page = pages[orig.page - 1];
        if (!page) continue;
        if (orig.type === "image") whiteoutOrigImage(page, orig);
        else whiteoutOrig(page, orig);
      }

      for (const box of state.boxes) {
        const page = pages[box.page - 1];
        if (!page) continue;

        if (box.type === "image") {
          if (!box.imageDataUrl) continue;
          if (box._orig) whiteoutOrigImage(page, box._orig);
          try {
            const base64 = box.imageDataUrl.split(",")[1] || "";
            const imgBytes = b64ToUint8Array(base64);
            const embedded = box.mime === "image/png"
              ? await outDoc.embedPng(imgBytes)
              : await outDoc.embedJpg(imgBytes);
            page.drawImage(embedded, {
              x: box.xPdf, y: box.yTopPdf - box.heightPdf,
              width: box.widthPdf, height: box.heightPdf,
            });
          } catch (err) {
            console.error("Could not embed an image box:", err);
            showToast("একটা ছবি PDF-এ বসাতে সমস্যা হয়েছে: " + err.message, "error");
          }
          continue;
        }

        if (!box.text || !box.text.trim()) continue;
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
