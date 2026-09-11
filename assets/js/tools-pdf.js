// PDF-manipulation tools that operate on independently-uploaded files (not the document open in
// the main editor): Merge, Compress, the Tools Hub launcher, Images->PDF, Page Manager, Stamp Tools.
"use strict";
import { els, showToast, saveFileToDisk, downloadDataUrl, openModal, closeModals, b64ToUint8Array } from "./core.js";

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
  els.hubOpenNidJoin.addEventListener("click", () => { closeModals(); openModal(els.nidJoinModal); });
  els.hubOpenPageMgr.addEventListener("click", () => { closeModals(); openModal(els.pageMgrModal); });
  els.hubOpenStamp.addEventListener("click", () => { closeModals(); openModal(els.stampModal); });

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
        // NID-style "front+back on one page": dividing the page into equal slots and letting
        // each image fill its own slot width made every card blow up to nearly the full page
        // width (the width constraint was looser than the height one for two landscape cards).
        // A real scanned-card sheet instead prints each card at a modest, consistent size and
        // centers the whole stack -- so cap each image's own width first, then vertically
        // center the resulting block on the page (only shrinking further if it still overflows).
        const page = outDoc.addPage(A4);
        const margin = 32;
        const gap = 24;
        const maxContentW = A4[0] - margin * 2;
        const perImageMaxW = Math.min(maxContentW, A4[0] * 0.46);

        let sized = embedded.map((img) => {
          const scale = Math.min(perImageMaxW / img.width, 1);
          return { img, w: img.width * scale, h: img.height * scale };
        });
        let totalH = sized.reduce((sum, s) => sum + s.h, 0) + gap * (sized.length - 1);
        const maxContentH = A4[1] - margin * 2;
        if (totalH > maxContentH) {
          const shrink = maxContentH / totalH;
          sized = sized.map((s) => ({ img: s.img, w: s.w * shrink, h: s.h * shrink }));
          totalH = maxContentH;
        }

        let y = (A4[1] + totalH) / 2;
        for (const s of sized) {
          y -= s.h;
          page.drawImage(s.img, { x: (A4[0] - s.w) / 2, y, width: s.w, height: s.h });
          y -= gap;
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
          // pdf-lib's `rotate` spins the text around the (x,y) anchor itself, not around the
          // text's own visual center -- placing x,y at the page's center and rotating 45deg swings
          // the text noticeably off-center (was rendering shifted toward the top-left). Solve for
          // the anchor that puts the ROTATED text's center back on the page's actual center.
          const angleRad = (45 * Math.PI) / 180;
          const dx = textWidth / 2, dy = size / 2;
          const rotatedOffsetX = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
          const rotatedOffsetY = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
          page.drawText(text, {
            x: width / 2 - rotatedOffsetX, y: height / 2 - rotatedOffsetY,
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
