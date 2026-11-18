// Mixed formatting inside one text box: a word or a line can have its own size, weight and color.
//
// Model: box.text stays the plain text (search, export, undo signatures all keep working), and
// box.styles is an optional list of non-overlapping ranges [{ s, e, size?, bold?, color? }] in
// UTF-16 offsets (the same units the DOM selection uses). A property missing from a range means
// "same as the box". No box.styles = a plain box, exactly as before.
//
// On screen the box is a contenteditable <div> whose styled ranges are <span data-size/...>.
// While typing, the DOM is the source of truth (re-rendering mid-composition would break Bangla
// IME input) and the model is read back from it; when a style is applied, the model is changed
// and the DOM re-rendered from it.
"use strict";

const PROPS = ["size", "bold", "color"];

export function effective(box, st) {
  return {
    size: st && st.size != null ? st.size : box.fontSize,
    bold: st && st.bold != null ? st.bold : !!box.bold,
    color: st && st.color != null ? st.color : (box.color || "#1a1a1a"),
  };
}

// keep only what actually differs from the box itself
function clean(box, st) {
  if (!st) return null;
  const out = {};
  if (st.size != null && Math.abs(st.size - box.fontSize) > 0.01) out.size = Math.round(st.size * 10) / 10;
  if (st.bold != null && st.bold !== !!box.bold) out.bold = st.bold;
  if (st.color != null && String(st.color).toLowerCase() !== String(box.color || "").toLowerCase()) out.color = st.color;
  return Object.keys(out).length ? out : null;
}
function sameStyle(a, b) {
  if (!a || !b) return !a && !b;
  return PROPS.every((p) => a[p] === b[p]);
}

// one style object (or null) per UTF-16 code unit
export function charStyles(box) {
  const text = box.text || "";
  const arr = new Array(text.length).fill(null);
  (box.styles || []).forEach((r) => {
    const st = {};
    PROPS.forEach((p) => { if (r[p] != null) st[p] = r[p]; });
    for (let i = Math.max(0, r.s); i < Math.min(text.length, r.e); i++) arr[i] = st;
  });
  return arr;
}

function compress(box, arr) {
  const out = [];
  let cur = null;
  for (let i = 0; i < arr.length; i++) {
    const st = clean(box, arr[i]);
    if (cur && sameStyle(cur.st, st)) { cur.e = i + 1; continue; }
    if (cur && cur.st) out.push({ s: cur.s, e: cur.e, ...cur.st });
    cur = { s: i, e: i + 1, st };
  }
  if (cur && cur.st) out.push({ s: cur.s, e: cur.e, ...cur.st });
  return out.length ? out : undefined;
}

// fn(effectiveStyleOfChar) -> patch; returns the new box.styles (a fresh array -- never mutated
// in place, because undo snapshots share these arrays)
export function applyRange(box, s, e, fn) {
  const arr = charStyles(box);
  for (let i = Math.max(0, s); i < Math.min(arr.length, e); i++) {
    const patch = fn(effective(box, arr[i]));
    arr[i] = { ...(arr[i] || {}), ...patch };
  }
  return compress(box, arr);
}

// rewrite every range (used when a whole-box change has to carry the ranges along with it)
export function mapStyles(box, fn) {
  if (!box.styles) return undefined;
  const arr = charStyles(box).map((st) => (st ? fn({ ...st }) : null));
  return compress(box, arr);
}

// Joins the soft line breaks of a paragraph that came from a PDF into flowing text (so it can
// rewrap / justify). "word-\nnext" keeps the hyphen and drops the break; other single breaks
// become spaces; a blank line (paragraph gap) is kept. Styles follow their characters.
export function joinSoftBreaks(box) {
  const text = box.text || "";
  const arr = charStyles(box);
  let out = "";
  const outArr = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" && text[i + 1] !== "\n" && text[i - 1] !== "\n" && i > 0 && i < text.length - 1) {
      if (text[i - 1] === "-" || text[i - 1] === "\u2010") continue;
      if (/\s/.test(text[i - 1]) || /\s/.test(text[i + 1])) continue;
      out += " ";
      outArr.push(arr[i - 1] || null);
      continue;
    }
    out += ch;
    outArr.push(arr[i]);
  }
  return { text: out, styles: compress({ ...box, text: out }, outArr) };
}

export function effectiveAt(box, i) {
  const arr = charStyles(box);
  return effective(box, arr[Math.max(0, Math.min(arr.length - 1, i))] || null);
}
export function everyInRange(box, s, e, pred) {
  const arr = charStyles(box);
  for (let i = s; i < Math.min(arr.length, e); i++) if (!pred(effective(box, arr[i]))) return false;
  return true;
}

// [{ text, st }] with st = the range style (null = box style); text may contain "\n"
export function segments(box) {
  const text = box.text || "";
  const arr = charStyles(box);
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && sameStyle(last.st, arr[i])) last.text += text[i];
    else out.push({ text: text[i], st: arr[i] });
  }
  return out;
}

// ---------------------------------------------------------------- DOM <-> model
export function makeEditable(el) {
  // plaintext-only: Enter inserts a line break and paste arrives as plain text, while our own
  // spans still work. Older browsers fall back to full contenteditable (paste/Enter handled below).
  try { el.contentEditable = "plaintext-only"; } catch (err) { /* unsupported value */ }
  if (el.contentEditable !== "plaintext-only") {
    el.contentEditable = "true";
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      document.execCommand("insertText", false, t);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); document.execCommand("insertLineBreak"); }
    });
  }
}

export function renderInto(el, box, scale) {
  el.textContent = "";
  for (const seg of segments(box)) {
    if (!seg.st) { el.appendChild(document.createTextNode(seg.text)); continue; }
    const span = document.createElement("span");
    if (seg.st.size != null) { span.dataset.size = String(seg.st.size); span.style.fontSize = seg.st.size * scale + "px"; }
    if (seg.st.bold != null) { span.dataset.bold = seg.st.bold ? "1" : "0"; span.style.fontWeight = seg.st.bold ? "700" : "400"; }
    if (seg.st.color != null) { span.dataset.color = seg.st.color; span.style.color = seg.st.color; }
    span.textContent = seg.text;
    el.appendChild(span);
  }
  // a trailing line break only shows (and can hold the caret) with a <br> after it
  if ((box.text || "").endsWith("\n")) el.appendChild(document.createElement("br"));
}

function isTrailing(node, root) {
  for (let n = node; n && n !== root; n = n.parentNode) if (n.nextSibling) return false;
  return true;
}
function isBlock(node) { return node.nodeName === "DIV" || node.nodeName === "P"; }

// Linear map of the editor: text nodes, <br>s and block starts with their model offsets.
function walk(root) {
  const entries = [];
  let text = "";
  const styles = [];
  function visit(node, st) {
    if (node.nodeType === 3) {
      entries.push({ type: "text", node, start: text.length, len: node.data.length });
      text += node.data;
      for (let i = 0; i < node.data.length; i++) styles.push(st);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.nodeName === "BR") {
      if (isTrailing(node, root) && (text === "" || text.endsWith("\n"))) return;
      entries.push({ type: "br", node, start: text.length });
      text += "\n";
      styles.push(st);
      return;
    }
    let nst = st;
    const ds = node.dataset || {};
    if (ds.size || ds.bold || ds.color) {
      nst = { ...(st || {}) };
      if (ds.size) nst.size = parseFloat(ds.size);
      if (ds.bold) nst.bold = ds.bold === "1";
      if (ds.color) nst.color = ds.color;
    }
    if (node !== root && isBlock(node) && text.length && !text.endsWith("\n")) {
      entries.push({ type: "block", node, start: text.length });
      text += "\n";
      styles.push(st);
    }
    node.childNodes.forEach((c) => visit(c, nst));
  }
  visit(root, null);
  return { entries, text, styles };
}

export function readFrom(el, box) {
  const { text, styles } = walk(el);
  const probe = { ...box, text };
  return { text, styles: compress(probe, styles) };
}

// selection -> { s, e } model offsets (null if the selection isn't inside el)
export function getSelOffsets(el) {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const total = walk(el).text.length;
  const pos = (node, offset) => {
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(node, offset);
    const frag = document.createElement("div");
    frag.appendChild(pre.cloneContents());
    // a trailing <br> inside the clone is a real newline here (the caret is past it)
    let n = 0;
    (function count(nd) {
      if (nd.nodeType === 3) { n += nd.data.length; return; }
      if (nd.nodeName === "BR") { n += 1; return; }
      nd.childNodes.forEach(count);
    })(frag);
    return Math.min(total, n);
  };
  const s = pos(r.startContainer, r.startOffset);
  const e = pos(r.endContainer, r.endOffset);
  return { s: Math.min(s, e), e: Math.max(s, e) };
}

function pointAt(el, p) {
  const { entries } = walk(el);
  let fallback = null;
  for (const en of entries) {
    if (en.type === "text" && p >= en.start && p <= en.start + en.len) {
      // prefer the start of the next node over the end of this one only when this one is empty
      return [en.node, p - en.start];
    }
    if ((en.type === "br" || en.type === "block") && (p === en.start || p === en.start + 1) && !fallback) {
      const parent = en.node.parentNode;
      const idx = Array.prototype.indexOf.call(parent.childNodes, en.node);
      fallback = en.type === "br"
        ? [parent, p === en.start ? idx : idx + 1]
        : (p === en.start ? [parent, idx] : [en.node, 0]);
    }
  }
  return fallback || [el, el.childNodes.length];
}

export function setSelOffsets(el, s, e) {
  const sel = document.getSelection();
  if (!sel) return;
  const r = document.createRange();
  try {
    const a = pointAt(el, s), b = pointAt(el, e);
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (err) { /* stale offsets -- leave the caret where it is */ }
}

// ---------------------------------------------------------------- layout for export
// Lines with per-run sizes, wrapped at maxWidth. measure(text, eff) -> width in PDF units.
// Each line's height is lineHeight x its biggest size (never below the box's own size -- the same
// rule CSS applies through the line's "strut"), so the exported PDF breaks and spaces lines the
// way the editor shows them.
export function layoutLines(box, maxWidth, measure) {
  const paras = [[]];
  for (const seg of segments(box)) {
    const eff = effective(box, seg.st);
    seg.text.split("\n").forEach((piece, k) => {
      if (k > 0) paras.push([]);
      if (piece) paras[paras.length - 1].push({ text: piece, eff });
    });
  }
  const lines = [];
  for (const para of paras) {
    // tokens: words and spaces, each a list of styled atoms
    const tokens = [];
    for (const run of para) {
      run.text.split(/(\s+)/).forEach((t) => {
        if (!t) return;
        const space = /^\s+$/.test(t);
        const last = tokens[tokens.length - 1];
        const atom = { text: t, eff: run.eff, w: measure(t, run.eff), space };
        if (last && last.space === space) last.atoms.push(atom);
        else tokens.push({ space, atoms: [atom] });
      });
    }
    let cur = { atoms: [], width: 0 };
    let pending = [];
    const width = (atoms) => atoms.reduce((a, x) => a + x.w, 0);
    for (const tok of tokens) {
      if (tok.space) { pending.push(...tok.atoms); continue; }
      const ww = width(tok.atoms), sw = width(pending);
      if (cur.atoms.length && cur.width + sw + ww > maxWidth) {
        lines.push(cur);
        cur = { atoms: [...tok.atoms], width: ww };
      } else {
        cur.atoms.push(...pending, ...tok.atoms);
        cur.width += sw + ww;
      }
      pending = [];
    }
    cur.paraEnd = true; // last line of a paragraph: never stretched by "justify"
    lines.push(cur);
  }
  lines.forEach((ln) => {
    ln.maxSize = Math.max(box.fontSize, ...ln.atoms.map((a) => a.eff.size));
  });
  return lines;
}
