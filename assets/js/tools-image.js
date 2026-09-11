// Image tools: the classical (non-ML) background-removal algorithm, the Photo/Signature Studio
// (Teletalk-spec crop/resize), and the Signature drawing pad.
"use strict";
import { els, showToast, downloadDataUrl, closeModals } from "./core.js";

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
    // radius 1, not 2 -- this mask is computed at up-to-1000px source resolution but the Photo
    // Studio output is often tiny (300x300, or 300x80 for a signature), so whatever softness this
    // adds gets proportionally MAGNIFIED after the big downscale. A 2px feather on thin signature
    // ink strokes was visibly smudging them; 1px still avoids a jagged 1-bit edge on a portrait's
    // hair/shoulder line without eating into fine detail as much.
    const smoothed = boxBlur(fgScore, width, height, 1);
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
