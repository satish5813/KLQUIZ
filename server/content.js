// Validation for rich question content: LaTeX/mhchem formulas, SMILES structures and SVG diagrams.
// Everything here runs before content is stored, so browsers only ever receive checked markup.
const katex = require('katex');
require('katex/contrib/mhchem');

// When an LLM under-escapes JSON, "\frac" arrives as form-feed + "rac", "\theta" as tab + "heta", etc.
// Restore those control characters to the LaTeX commands they came from.
// LaTeX commands that start with "\n" — never turned into line breaks.
const LATEX_N = /^(u|eq|e\b|abla|eg|ot|i\b|exists|leq|geq|parallel|mid|subset|supset|leftarrow|rightarrow|cong|sim|vdash|ewline)/;
const KEEP_SPANS = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/;

// Over-escaped JSON can leave a literal backslash-n where a line break was meant. Convert those,
// leaving formulas and quoted code strings (e.g. cout << "\n") untouched.
function literalNewlines(s) {
  if (!s.includes('\\n')) return s;
  return s.split(KEEP_SPANS).map((p, i) => {
    if (i % 2) return p;
    let out = '';
    for (let k = 0; k < p.length; k++) {
      if (p[k] === '\\' && p[k + 1] === 'n' && !LATEX_N.test(p.slice(k + 2))) { out += '\n'; k++; } else out += p[k];
    }
    return out;
  }).join('');
}

function repairEscapes(s) {
  if (typeof s !== 'string') return s;
  return literalNewlines(s)
    .replace(/\f/g, '\\f')
    .replace(/\x08/g, '\\b')
    .replace(/\t(?=[a-zA-Z])/g, '\\t')
    .replace(/\r(?=[a-zA-Z])/g, '\\r')
    .replace(/\n(?=(?:u|eq|e\b|abla|eg|ot|i\b|exists|leq|geq|parallel|mid|subset|supset|leftarrow|rightarrow|cong|sim|vdash)\b)/g, '\\n');
}

// Splits text into [{math, display, tex} | {text}] using $$…$$ and $…$ delimiters.
function mathSegments(s) {
  const out = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ math: true, display: !!m[1], tex: m[1] || m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

// Returns an error message if any formula in the text fails to parse, else null.
function checkMath(s) {
  if (!s) return null;
  const segs = mathSegments(s);
  // An odd leftover "$" means an unclosed formula.
  if (segs.some((g) => g.text && g.text.includes('$'))) return 'Unbalanced $ delimiter';
  for (const g of segs) {
    if (!g.math) continue;
    try {
      katex.renderToString(g.tex, { throwOnError: true, displayMode: g.display, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 500 });
    } catch (e) {
      return `Formula error in "${g.tex.slice(0, 60)}": ${String(e.message).replace(/^KaTeX parse error: /, '').slice(0, 120)}`;
    }
  }
  return null;
}

const SMILES_RE = /^[A-Za-z0-9@+\-[\]()=#$:./\\%*]{1,300}$/;
const isSmiles = (s) => typeof s === 'string' && SMILES_RE.test(s.trim());

// Strict allowlist SVG sanitiser: only basic shapes, text and paths with presentational attributes.
const SVG_TAGS = new Set(['svg', 'g', 'line', 'polyline', 'polygon', 'path', 'rect', 'circle', 'ellipse', 'text', 'tspan', 'defs', 'marker', 'title']);
const SVG_ATTRS = new Set(['xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'stroke-opacity', 'opacity',
  'transform', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy',
  'id', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'marker-end', 'marker-start', 'preserveaspectratio']);
const SAFE_VALUE = /^[\w\s.,#%()+\-/]*$/; // no ":" — blocks javascript:, data:, http: in any attribute
// SVG attribute names are case-sensitive; restore the ones we lower-cased for matching.
const CAMEL = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', markerwidth: 'markerWidth', markerheight: 'markerHeight', refx: 'refX', refy: 'refY' };

function sanitizeSvg(svg) {
  if (typeof svg !== 'string') return null;
  const src = svg.trim();
  if (!/^<svg[\s>]/i.test(src) || !/<\/svg>\s*$/i.test(src) || src.length > 30000) return null;
  if (/<!|<\?|&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(src)) return null;
  let ok = true;
  const cleaned = src.replace(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g, (all, slash, tag, rest) => {
    const t = tag.toLowerCase();
    if (!SVG_TAGS.has(t)) { ok = false; return ''; }
    if (slash) return `</${t}>`;
    const selfClose = /\/\s*$/.test(rest);
    const attrs = [];
    const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(rest))) {
      const name = m[1].toLowerCase();
      const val = m[3] !== undefined ? m[3] : m[4];
      if (!SVG_ATTRS.has(name) || name === 'xmlns') continue;
      if (!SAFE_VALUE.test(val) || /url\s*\(/i.test(val) && !/^url\(#[\w-]+\)$/.test(val.trim())) continue;
      attrs.push(`${CAMEL[name] || name}="${val}"`);
    }
    if (t === 'svg') attrs.unshift('xmlns="http://www.w3.org/2000/svg"');
    return `<${t}${attrs.length ? ` ${attrs.join(' ')}` : ''}${selfClose ? ' /' : ''}>`;
  });
  if (!ok) return null;
  // Text between tags must not contain markup remnants.
  if (/[<>]/.test(cleaned.replace(/<\/?[a-z]+[^<>]*>/g, ''))) return null;
  return cleaned;
}

/**
 * Normalises and validates the optional diagram attached to a question.
 * Returns null (no diagram), a {kind, code, caption} object, or throws a message string.
 */
function cleanDiagram(d) {
  if (!d || !d.kind || d.kind === 'none' || !d.code) return null;
  const caption = String(d.caption || '').trim().slice(0, 200);
  if (d.kind === 'smiles') {
    if (!isSmiles(d.code)) throw new Error('Invalid SMILES structure');
    return { kind: 'smiles', code: d.code.trim(), caption };
  }
  if (d.kind === 'svg') {
    const svg = sanitizeSvg(d.code);
    if (!svg) throw new Error('Diagram SVG contains unsupported or unsafe markup');
    return { kind: 'svg', code: svg, caption };
  }
  throw new Error('Unknown diagram type');
}

module.exports = { repairEscapes, checkMath, mathSegments, isSmiles, sanitizeSvg, cleanDiagram };
