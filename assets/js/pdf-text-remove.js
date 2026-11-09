// Real text removal for "edit existing text": instead of only painting a white box over the old
// words (which leaves them in the file -- still selectable, copyable and searchable underneath),
// this rewrites the page's content stream and drops every glyph whose position falls inside the
// given rectangles. Each removed glyph is replaced by an equal-width TJ spacing number, so every
// OTHER glyph on the page keeps its exact original position.
//
// It only rewrites what it fully understands: text shown directly in the page's content stream,
// in simple (1-byte) fonts with a Widths array, standard-14 fonts, or Type0 fonts with
// Identity-H/V encoding. Anything else -- Type3 fonts, text inside Form XObjects, unusual CMaps --
// is left untouched and reported as `needsCover`, so the caller can still paint a cover box over it.
// Uses the global PDFLib (pdf-lib 1.17.1).
"use strict";

// ---------------------------------------------------------------- tokenizer
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIMS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %

function isDigitStart(c) { return (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46; }

// Returns { ops, inlineImageRanges } -- each op: { op, operands, start, end } with byte offsets
// into `bytes`, so the caller can splice replacements in and copy everything else verbatim.
function parseContent(bytes) {
  const n = bytes.length;
  let i = 0;
  const ops = [];
  let stack = [];            // operands for the next operator
  const containers = [];     // open [ / << containers: { kind, items, start, parentStack }
  let opStart = -1;

  function pushOperand(tok) {
    if (containers.length) containers[containers.length - 1].items.push(tok);
    else {
      if (!stack.length) opStart = tok.start;
      stack.push(tok);
    }
  }

  while (i < n) {
    const c = bytes[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { // % comment
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    const start = i;
    if (c === 40) { // literal string
      const out = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        let ch = bytes[i];
        if (ch === 92) { // backslash
          i++;
          const e = bytes[i];
          if (e === 110) { out.push(10); i++; }
          else if (e === 114) { out.push(13); i++; }
          else if (e === 116) { out.push(9); i++; }
          else if (e === 98) { out.push(8); i++; }
          else if (e === 102) { out.push(12); i++; }
          else if (e === 13) { i++; if (bytes[i] === 10) i++; }
          else if (e === 10) { i++; }
          else if (e >= 48 && e <= 55) {
            let v = 0, k = 0;
            while (k < 3 && bytes[i] >= 48 && bytes[i] <= 55) { v = v * 8 + (bytes[i] - 48); i++; k++; }
            out.push(v & 255);
          } else { out.push(e); i++; }
          continue;
        }
        if (ch === 40) depth++;
        else if (ch === 41) { depth--; if (depth === 0) { i++; break; } }
        out.push(ch);
        i++;
      }
      pushOperand({ type: "str", value: Uint8Array.from(out), start, end: i });
      continue;
    }
    if (c === 60 && bytes[i + 1] === 60) { // <<
      i += 2;
      containers.push({ kind: "dict", items: [], start });
      continue;
    }
    if (c === 62 && bytes[i + 1] === 62) { // >>
      i += 2;
      const cont = containers.pop();
      if (cont) pushOperand({ type: "dict", items: cont.items, start: cont.start, end: i });
      continue;
    }
    if (c === 60) { // hex string
      i++;
      const hex = [];
      while (i < n && bytes[i] !== 62) {
        const ch = bytes[i];
        if (!WS.has(ch)) hex.push(ch);
        i++;
      }
      i++; // skip >
      if (hex.length % 2) hex.push(48);
      const out = new Uint8Array(hex.length / 2);
      for (let k = 0; k < out.length; k++) {
        out[k] = parseInt(String.fromCharCode(hex[2 * k], hex[2 * k + 1]), 16) || 0;
      }
      pushOperand({ type: "str", value: out, start, end: i, hex: true });
      continue;
    }
    if (c === 91) { i++; containers.push({ kind: "array", items: [], start }); continue; }
    if (c === 93) {
      i++;
      const cont = containers.pop();
      if (cont) pushOperand({ type: "array", items: cont.items, start: cont.start, end: i });
      continue;
    }
    if (c === 47) { // name
      i++;
      while (i < n && !WS.has(bytes[i]) && !DELIMS.has(bytes[i])) i++;
      pushOperand({ type: "name", value: decodeName(bytes, start + 1, i), start, end: i });
      continue;
    }
    if (isDigitStart(c)) {
      i++;
      while (i < n && ((bytes[i] >= 48 && bytes[i] <= 57) || bytes[i] === 46)) i++;
      const txt = String.fromCharCode.apply(null, bytes.subarray(start, i));
      pushOperand({ type: "num", value: parseFloat(txt) || 0, start, end: i });
      continue;
    }
    if (c === 123 || c === 125) { i++; continue; } // PostScript braces -- not used in content streams
    // keyword / operator
    while (i < n && !WS.has(bytes[i]) && !DELIMS.has(bytes[i])) i++;
    if (i === start) { i++; continue; } // stray delimiter, skip
    const word = String.fromCharCode.apply(null, bytes.subarray(start, i));
    if (word === "true" || word === "false" || word === "null") {
      pushOperand({ type: "kw", value: word, start, end: i });
      continue;
    }
    if (containers.length) {
      // an operator inside an unclosed array/dict means the stream is malformed -- recover by
      // closing everything so one bad token can't swallow the rest of the page.
      containers.length = 0;
    }
    if (word === "BI") {
      // Inline image: key/value pairs until ID, then raw binary until whitespace + EI.
      let j = i;
      const idPos = findKeyword(bytes, j, "ID");
      if (idPos < 0) { i = n; break; }
      j = idPos + 2;
      if (WS.has(bytes[j])) j++;
      let endPos = -1;
      for (let k = j; k < n - 1; k++) {
        if (bytes[k] === 69 && bytes[k + 1] === 73 && (k === 0 || WS.has(bytes[k - 1])) &&
            (k + 2 >= n || WS.has(bytes[k + 2]) || DELIMS.has(bytes[k + 2]))) { endPos = k + 2; break; }
      }
      i = endPos < 0 ? n : endPos;
      ops.push({ op: "BI", operands: [], start, end: i });
      stack = [];
      opStart = -1;
      continue;
    }
    ops.push({ op: word, operands: stack, start: stack.length ? opStart : start, end: i });
    stack = [];
    opStart = -1;
  }
  return ops;
}

function findKeyword(bytes, from, word) {
  const a = word.charCodeAt(0), b = word.charCodeAt(1);
  for (let k = from; k < bytes.length - 1; k++) {
    if (bytes[k] === a && bytes[k + 1] === b && (k === 0 || WS.has(bytes[k - 1])) &&
        (k + 2 >= bytes.length || WS.has(bytes[k + 2]))) return k;
  }
  return -1;
}

function decodeName(bytes, from, to) {
  let s = "";
  for (let k = from; k < to; k++) {
    if (bytes[k] === 35 && k + 2 < to) { // #xx
      s += String.fromCharCode(parseInt(String.fromCharCode(bytes[k + 1], bytes[k + 2]), 16));
      k += 2;
    } else s += String.fromCharCode(bytes[k]);
  }
  return s;
}

// ---------------------------------------------------------------- matrices (PDF row-vector form)
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

// ---------------------------------------------------------------- fonts
const STANDARD_ALIASES = {
  arial: "Helvetica", arialmt: "Helvetica", helvetica: "Helvetica",
  "arial-bold": "Helvetica-Bold", "arial-boldmt": "Helvetica-Bold", "helvetica-bold": "Helvetica-Bold", "arial,bold": "Helvetica-Bold",
  "arial-italic": "Helvetica-Oblique", "arial-italicmt": "Helvetica-Oblique", "helvetica-oblique": "Helvetica-Oblique",
  "arial-bolditalic": "Helvetica-BoldOblique", "arial-bolditalicmt": "Helvetica-BoldOblique", "helvetica-boldoblique": "Helvetica-BoldOblique",
  "times-roman": "Times-Roman", timesnewroman: "Times-Roman", timesnewromanpsmt: "Times-Roman", "times new roman": "Times-Roman",
  "times-bold": "Times-Bold", "timesnewroman,bold": "Times-Bold", "timesnewromanps-boldmt": "Times-Bold",
  "times-italic": "Times-Italic", "timesnewromanps-italicmt": "Times-Italic",
  "times-bolditalic": "Times-BoldItalic", "timesnewromanps-bolditalicmt": "Times-BoldItalic",
  courier: "Courier", couriernew: "Courier", couriernewpsmt: "Courier",
  "courier-bold": "Courier-Bold", "couriernewps-boldmt": "Courier-Bold",
  "courier-oblique": "Courier-Oblique", "courier-boldoblique": "Courier-BoldOblique",
  symbol: "Symbol", zapfdingbats: "ZapfDingbats",
};

function num(ctx, obj, fallback) {
  const v = obj ? ctx.lookup(obj) : null;
  return v && typeof v.asNumber === "function" ? v.asNumber() : fallback;
}
function nameOf(ctx, obj) {
  const v = obj ? ctx.lookup(obj) : null;
  return v instanceof PDFLib.PDFName ? v.toString().slice(1) : null;
}
function arr(ctx, obj) {
  const v = obj ? ctx.lookup(obj) : null;
  return v && typeof v.asArray === "function" ? v.asArray() : null;
}
function dictGet(ctx, dict, key) {
  if (!dict || typeof dict.get !== "function") return undefined;
  return dict.get(PDFLib.PDFName.of(key));
}

// Builds { bytesPerCode, width(code) -> glyph-space width (1/1000 em) } or null if unsupported.
async function buildFontInfo(ctx, fontDict, standardWidthFor) {
  const subtype = nameOf(ctx, dictGet(ctx, fontDict, "Subtype"));
  if (subtype === "Type0") {
    const enc = nameOf(ctx, dictGet(ctx, fontDict, "Encoding"));
    if (enc !== "Identity-H" && enc !== "Identity-V") return null;
    const descArr = arr(ctx, dictGet(ctx, fontDict, "DescendantFonts"));
    const desc = descArr && descArr.length ? ctx.lookup(descArr[0]) : null;
    if (!desc) return null;
    const dw = num(ctx, dictGet(ctx, desc, "DW"), 1000);
    const widths = new Map();
    const w = arr(ctx, dictGet(ctx, desc, "W")) || [];
    for (let k = 0; k < w.length; ) {
      const first = num(ctx, w[k], null);
      const next = ctx.lookup(w[k + 1]);
      if (first == null || next == null) break;
      if (typeof next.asArray === "function") {
        next.asArray().forEach((wv, idx) => widths.set(first + idx, num(ctx, wv, dw)));
        k += 2;
      } else {
        const last = num(ctx, w[k + 1], first);
        const wv = num(ctx, w[k + 2], dw);
        for (let cid = first; cid <= last && cid - first < 65536; cid++) widths.set(cid, wv);
        k += 3;
      }
    }
    return { bytesPerCode: 2, width: (code) => (widths.has(code) ? widths.get(code) : dw) };
  }
  if (subtype === "Type1" || subtype === "TrueType" || subtype === "MMType1") {
    const widthsArr = arr(ctx, dictGet(ctx, fontDict, "Widths"));
    if (widthsArr) {
      const firstChar = num(ctx, dictGet(ctx, fontDict, "FirstChar"), 0);
      const fd = ctx.lookup(dictGet(ctx, fontDict, "FontDescriptor"));
      const missing = num(ctx, dictGet(ctx, fd, "MissingWidth"), 0);
      const ws = widthsArr.map((v) => num(ctx, v, missing));
      return { bytesPerCode: 1, width: (code) => (code >= firstChar && code - firstChar < ws.length ? ws[code - firstChar] : missing) };
    }
    // No Widths: only safe for the standard 14 fonts, whose metrics are fixed by the spec.
    let base = (nameOf(ctx, dictGet(ctx, fontDict, "BaseFont")) || "").replace(/^[A-Z]{6}\+/, "");
    const std = STANDARD_ALIASES[base.toLowerCase()] || (Object.values(STANDARD_ALIASES).includes(base) ? base : null);
    if (!std || !standardWidthFor) return null;
    const widthOf = await standardWidthFor(std);
    return widthOf ? { bytesPerCode: 1, width: widthOf } : null;
  }
  return null; // Type3 and anything unknown
}

// ---------------------------------------------------------------- output helpers
function fmt(v) {
  if (!isFinite(v)) return "0";
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}
function hexOf(codes, bytesPerCode) {
  let s = "<";
  for (const code of codes) s += code.toString(16).padStart(bytesPerCode * 2, "0");
  return s + ">";
}

// ---------------------------------------------------------------- main
// rects: [{ x, y, w, h }] in PDF user space (bottom-left origin). Returns
// { removed: number[] (glyphs removed per rect), needsCover: boolean[] (per rect), changed }.
async function removeTextInRects(pdfDoc, pageIndex, rects, standardWidthFor) {
  const result = { removed: rects.map(() => 0), needsCover: rects.map(() => false), changed: false };
  if (!rects.length) return result;
  const ctx = pdfDoc.context;
  const page = pdfDoc.getPage(pageIndex);
  const node = page.node;
  const contentsObj = ctx.lookup(node.get(PDFLib.PDFName.of("Contents")));
  if (!contentsObj) return result;

  const streams = typeof contentsObj.asArray === "function"
    ? contentsObj.asArray().map((r) => ctx.lookup(r))
    : [contentsObj];
  const parts = [];
  for (const st of streams) {
    if (!st) continue;
    let decoded;
    try {
      decoded = st instanceof PDFLib.PDFRawStream
        ? PDFLib.decodePDFRawStream(st).decode()
        : (st.getUnencodedContents ? st.getUnencodedContents() : st.getContents());
    } catch (err) {
      result.needsCover.fill(true);
      return result; // a filter we can't decode -- leave the page alone
    }
    parts.push(decoded);
  }
  let total = 0;
  parts.forEach((p) => { total += p.length + 1; });
  const bytes = new Uint8Array(total);
  let off = 0;
  parts.forEach((p) => { bytes.set(p, off); off += p.length; bytes[off++] = 10; });

  let ops;
  try { ops = parseContent(bytes); }
  catch (err) { result.needsCover.fill(true); return result; }

  const resources = node.Resources();
  const fontRes = resources ? ctx.lookup(dictGet(ctx, resources, "Font")) : null;
  const xobjRes = resources ? ctx.lookup(dictGet(ctx, resources, "XObject")) : null;
  const fontCache = new Map();
  async function getFont(name) {
    if (fontCache.has(name)) return fontCache.get(name);
    let info = null;
    try {
      const fd = fontRes ? ctx.lookup(dictGet(ctx, fontRes, name)) : null;
      if (fd) info = await buildFontInfo(ctx, fd, standardWidthFor);
    } catch (err) { info = null; }
    fontCache.set(name, info);
    return info;
  }

  function rectIndexAt(x, y) {
    for (let r = 0; r < rects.length; r++) {
      const R = rects[r];
      if (x >= R.x && x <= R.x + R.w && y >= R.y && y <= R.y + R.h) return r;
    }
    return -1;
  }
  function markRectsTouchedBy(m, x0, x1, fs) {
    // an op we can't rewrite: flag every rect its rough extent reaches
    for (const [tx, ty] of [[x0, fs * 0.35], [(x0 + x1) / 2, fs * 0.35], [x1, fs * 0.35]]) {
      const [ux, uy] = apply(m, tx, ty);
      const r = rectIndexAt(ux, uy);
      if (r >= 0) result.needsCover[r] = true;
    }
  }

  // graphics + text state
  let ctm = [1, 0, 0, 1, 0, 0];
  const gstack = [];
  let ts = { font: null, fontName: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 };
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
  const edits = []; // { start, end, text }

  function nextLine(tx, ty) {
    Tlm = mul([1, 0, 0, 1, tx, ty], Tlm);
    Tm = Tlm.slice();
  }

  // Walks one show-text op. `items`: array of str/num tokens (TJ form). Returns the replacement
  // TJ array source, or null if nothing in it was removed.
  async function showText(items) {
    const font = ts.fontName ? await getFont(ts.fontName) : null;
    const fs = ts.size, Th = ts.Th;
    if (!font || !fs) {
      // Can't measure -- still advance nothing (unknown), flag rects near the start point.
      const m = mul(Tm, ctm);
      markRectsTouchedBy(m, 0, fs * 2, fs || 10);
      return null;
    }
    let removedAny = false;
    const out = [];       // pieces: { kind: "codes", codes: [] } | { kind: "num", value }
    function pushNum(v) {
      if (!v) return;
      const last = out[out.length - 1];
      if (last && last.kind === "num") last.value += v; else out.push({ kind: "num", value: v });
    }
    function pushCode(code) {
      const last = out[out.length - 1];
      if (last && last.kind === "codes") last.codes.push(code); else out.push({ kind: "codes", codes: [code] });
    }
    for (const it of items) {
      if (it.type === "num") {
        pushNum(it.value);
        const tx = (-it.value / 1000) * fs * Th;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        continue;
      }
      if (it.type !== "str") continue;
      const b = it.value;
      const bpc = font.bytesPerCode;
      for (let k = 0; k + bpc <= b.length; k += bpc) {
        const code = bpc === 2 ? (b[k] << 8) | b[k + 1] : b[k];
        const w0 = font.width(code) / 1000;
        const isSpace = bpc === 1 && code === 32;
        const adv = (w0 * fs + ts.Tc + (isSpace ? ts.Tw : 0)) * Th;
        const m = mul(Tm, ctm);
        const [ux, uy] = apply(m, adv / 2, ts.Ts + fs * 0.35);
        const r = rectIndexAt(ux, uy);
        if (r >= 0) {
          removedAny = true;
          if (!isSpace) result.removed[r]++;
          // same advance, expressed as a TJ number (thousandths of text space, sign inverted)
          pushNum(-(adv / (fs * Th)) * 1000);
        } else {
          pushCode(code);
        }
        Tm = mul([1, 0, 0, 1, adv, 0], Tm);
      }
    }
    if (!removedAny) return null;
    let src = "[";
    for (const p of out) {
      src += p.kind === "num" ? " " + fmt(p.value) + " " : hexOf(p.codes, font.bytesPerCode);
    }
    return src + "] TJ";
  }

  for (const o of ops) {
    const a = o.operands;
    const nums = () => a.map((t) => (t.type === "num" ? t.value : 0));
    switch (o.op) {
      case "q": gstack.push({ ctm: ctm.slice(), ts: { ...ts } }); break;
      case "Q": { const g = gstack.pop(); if (g) { ctm = g.ctm; ts = g.ts; } break; }
      case "cm": if (a.length === 6) ctm = mul(nums(), ctm); break;
      case "BT": Tm = [1, 0, 0, 1, 0, 0]; Tlm = [1, 0, 0, 1, 0, 0]; break;
      case "Tf":
        if (a.length >= 2) {
          ts.fontName = a[0].type === "name" ? a[0].value : null;
          ts.size = a[1].type === "num" ? a[1].value : 0;
        }
        break;
      case "Tc": if (a[0]) ts.Tc = a[0].value || 0; break;
      case "Tw": if (a[0]) ts.Tw = a[0].value || 0; break;
      case "Tz": if (a[0]) ts.Th = (a[0].value || 100) / 100; break;
      case "TL": if (a[0]) ts.TL = a[0].value || 0; break;
      case "Ts": if (a[0]) ts.Ts = a[0].value || 0; break;
      case "Td": if (a.length === 2) nextLine(a[0].value, a[1].value); break;
      case "TD": if (a.length === 2) { ts.TL = -a[1].value; nextLine(a[0].value, a[1].value); } break;
      case "Tm": if (a.length === 6) { Tlm = nums(); Tm = Tlm.slice(); } break;
      case "T*": nextLine(0, -ts.TL); break;
      case "Tj": {
        if (!a.length) break;
        const rep = await showText([a[a.length - 1]]);
        if (rep) edits.push({ start: o.start, end: o.end, text: rep });
        break;
      }
      case "TJ": {
        const arrTok = a[a.length - 1];
        if (!arrTok || arrTok.type !== "array") break;
        const rep = await showText(arrTok.items);
        if (rep) edits.push({ start: o.start, end: o.end, text: rep });
        break;
      }
      case "'": {
        nextLine(0, -ts.TL);
        if (!a.length) break;
        const rep = await showText([a[a.length - 1]]);
        if (rep) edits.push({ start: o.start, end: o.end, text: "T* " + rep });
        break;
      }
      case '"': {
        if (a.length < 3) break;
        ts.Tw = a[0].value || 0;
        ts.Tc = a[1].value || 0;
        nextLine(0, -ts.TL);
        const rep = await showText([a[2]]);
        if (rep) edits.push({ start: o.start, end: o.end, text: fmt(ts.Tw) + " Tw " + fmt(ts.Tc) + " Tc T* " + rep });
        break;
      }
      case "Do": {
        // A Form XObject may contain its own text that this pass can't reach -- if one is drawn
        // where an edit happens, keep the cover box for that rect.
        const nm = a[0] && a[0].type === "name" ? a[0].value : null;
        const xo = nm && xobjRes ? ctx.lookup(dictGet(ctx, xobjRes, nm)) : null;
        const sub = xo && xo.dict ? nameOf(ctx, xo.dict.get(PDFLib.PDFName.of("Subtype"))) : null;
        if (sub === "Form") {
          const bbox = arr(ctx, xo.dict.get(PDFLib.PDFName.of("BBox")));
          const matrix = arr(ctx, xo.dict.get(PDFLib.PDFName.of("Matrix")));
          const fm = matrix && matrix.length === 6 ? matrix.map((v) => num(ctx, v, 0)) : [1, 0, 0, 1, 0, 0];
          const m = mul(fm, ctm);
          if (bbox && bbox.length === 4) {
            const [x0, y0, x1, y1] = bbox.map((v) => num(ctx, v, 0));
            const corners = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
            const minX = Math.min(...corners.map((p) => p[0])), maxX = Math.max(...corners.map((p) => p[0]));
            const minY = Math.min(...corners.map((p) => p[1])), maxY = Math.max(...corners.map((p) => p[1]));
            rects.forEach((R, r) => {
              if (R.x < maxX && R.x + R.w > minX && R.y < maxY && R.y + R.h > minY) result.needsCover[r] = true;
            });
          } else {
            result.needsCover.fill(true);
          }
        }
        break;
      }
      default: break;
    }
  }

  // A rect nothing was removed from still gets its cover (the text may be in an image, a scan,
  // or a font this pass skipped).
  result.removed.forEach((cnt, r) => { if (!cnt) result.needsCover[r] = true; });
  if (!edits.length) return result;

  // splice the replacements in, copying every other byte through untouched
  edits.sort((x, y) => x.start - y.start);
  const enc = new TextEncoder();
  const chunks = [];
  let pos = 0, size = 0;
  for (const e of edits) {
    if (e.start < pos) continue;
    const before = bytes.subarray(pos, e.start);
    const rep = enc.encode(e.text);
    chunks.push(before, rep);
    size += before.length + rep.length;
    pos = e.end;
  }
  const tail = bytes.subarray(pos);
  chunks.push(tail);
  size += tail.length;
  const outBytes = new Uint8Array(size);
  let o2 = 0;
  for (const ch of chunks) { outBytes.set(ch, o2); o2 += ch.length; }

  const newStream = ctx.flateStream(outBytes);
  const ref = ctx.register(newStream);
  node.set(PDFLib.PDFName.of("Contents"), ctx.obj([ref]));
  result.changed = true;
  return result;
}

// Removes image XObjects drawn (directly in the page content stream) inside the given rects --
// an image counts when its on-page box is centered in a rect and roughly the same size. Used when
// an original image is moved, replaced or deleted in the editor. Returns { removed: boolean[] }.
async function removeImagesInRects(pdfDoc, pageIndex, rects) {
  const result = { removed: rects.map(() => false) };
  if (!rects.length) return result;
  const ctx = pdfDoc.context;
  const node = pdfDoc.getPage(pageIndex).node;
  const contentsObj = ctx.lookup(node.get(PDFLib.PDFName.of("Contents")));
  if (!contentsObj) return result;
  const streams = typeof contentsObj.asArray === "function" ? contentsObj.asArray().map((r) => ctx.lookup(r)) : [contentsObj];
  const parts = [];
  for (const st of streams) {
    if (!st) continue;
    try {
      parts.push(st instanceof PDFLib.PDFRawStream ? PDFLib.decodePDFRawStream(st).decode()
        : (st.getUnencodedContents ? st.getUnencodedContents() : st.getContents()));
    } catch (err) { return result; }
  }
  let total = 0;
  parts.forEach((p) => { total += p.length + 1; });
  const bytes = new Uint8Array(total);
  let off = 0;
  parts.forEach((p) => { bytes.set(p, off); off += p.length; bytes[off++] = 10; });
  let ops;
  try { ops = parseContent(bytes); } catch (err) { return result; }
  const resources = node.Resources();
  const xobjRes = resources ? ctx.lookup(dictGet(ctx, resources, "XObject")) : null;
  let ctm = [1, 0, 0, 1, 0, 0];
  const gstack = [];
  const cuts = [];
  for (const o of ops) {
    const a = o.operands;
    if (o.op === "q") gstack.push(ctm.slice());
    else if (o.op === "Q") { const g = gstack.pop(); if (g) ctm = g; }
    else if (o.op === "cm" && a.length === 6) ctm = mul(a.map((t) => (t.type === "num" ? t.value : 0)), ctm);
    else if (o.op === "Do") {
      const nm = a[0] && a[0].type === "name" ? a[0].value : null;
      const xo = nm && xobjRes ? ctx.lookup(dictGet(ctx, xobjRes, nm)) : null;
      const sub = xo && xo.dict ? nameOf(ctx, xo.dict.get(PDFLib.PDFName.of("Subtype"))) : null;
      if (sub !== "Image") continue;
      const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
      const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
      const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, w = maxX - minX, h = maxY - minY;
      rects.forEach((R, r) => {
        if (cx >= R.x && cx <= R.x + R.w && cy >= R.y && cy <= R.y + R.h &&
            w > R.w * 0.7 && w < R.w * 1.3 && h > R.h * 0.7 && h < R.h * 1.3) {
          result.removed[r] = true;
          cuts.push({ start: o.start, end: o.end });
        }
      });
    }
  }
  if (!cuts.length) return result;
  cuts.sort((x, y) => x.start - y.start);
  const chunks = [];
  let pos = 0, size = 0;
  for (const c of cuts) {
    if (c.start < pos) continue;
    chunks.push(bytes.subarray(pos, c.start));
    size += c.start - pos;
    pos = c.end;
  }
  chunks.push(bytes.subarray(pos));
  size += bytes.length - pos;
  const out = new Uint8Array(size);
  let o2 = 0;
  for (const ch of chunks) { out.set(ch, o2); o2 += ch.length; }
  node.set(PDFLib.PDFName.of("Contents"), ctx.obj([ctx.register(ctx.flateStream(out))]));
  return result;
}

// Metrics for the standard 14 fonts (which PDFs may use without a Widths array), borrowed from
// pdf-lib's own built-in AFM data via a throwaway document.
function makeStandardWidthLookup() {
  let scratch = null;
  const cache = new Map();
  return async function standardWidthFor(stdName) {
    if (cache.has(stdName)) return cache.get(stdName);
    let fn = null;
    try {
      if (!scratch) scratch = await PDFLib.PDFDocument.create();
      const font = await scratch.embedFont(stdName);
      fn = (code) => {
        if (code < 32) return 0;
        try { return font.widthOfTextAtSize(String.fromCharCode(code), 1000); }
        catch (err) { return 500; }
      };
    } catch (err) { fn = null; }
    cache.set(stdName, fn);
    return fn;
  };
}

export { removeTextInRects, removeImagesInRects, makeStandardWidthLookup, parseContent };
