// Renders question content: plain text with $…$ / $$…$$ LaTeX (KaTeX + mhchem),
// SMILES chemical structures (SmilesDrawer) and pre-sanitised SVG diagrams (DOMPurify, again).
(function () {
  const MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  const KATEX_OPTS = { throwOnError: false, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 500 };

  // Plain text with *phrase* (italic, e.g. the part to improve in a sentence) and **phrase** (bold).
  // The phrase is inserted as a text node inside <em>/<strong>, never as HTML.
  const EMPH_RE = /\*\*(\S(?:[^*\n]*?\S)?)\*\*|\*(\S(?:[^*\n]*?\S)?)\*/g;
  function appendText(node, s) {
    let last = 0;
    let m;
    EMPH_RE.lastIndex = 0;
    while ((m = EMPH_RE.exec(s))) {
      if (m.index > last) node.appendChild(document.createTextNode(s.slice(last, m.index)));
      const e = document.createElement(m[1] !== undefined ? 'strong' : 'em');
      e.textContent = m[1] !== undefined ? m[1] : m[2];
      node.appendChild(e);
      last = EMPH_RE.lastIndex;
    }
    if (last < s.length) node.appendChild(document.createTextNode(s.slice(last)));
  }

  // Fills `node` with text and typeset formulas. Text is only ever inserted as text nodes.
  function rich(node, text) {
    while (node.firstChild) node.removeChild(node.firstChild);
    const s = String(text ?? '');
    let last = 0;
    let m;
    MATH_RE.lastIndex = 0;
    while ((m = MATH_RE.exec(s))) {
      if (m.index > last) appendText(node, s.slice(last, m.index));
      const display = !!m[1];
      const span = document.createElement(display ? 'div' : 'span');
      span.className = display ? 'math-display' : 'math-inline';
      if (window.katex) window.katex.render(m[1] || m[2], span, { ...KATEX_OPTS, displayMode: display });
      else span.textContent = m[0];
      node.appendChild(span);
      last = MATH_RE.lastIndex;
    }
    if (last < s.length) appendText(node, s.slice(last));
    return node;
  }

  function smiles(code, { width = 240, height = 170 } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'structure';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Chemical structure');
    wrap.appendChild(svg);
    if (!window.SmilesDrawer) { wrap.textContent = code; return wrap; }
    const drawer = new window.SmilesDrawer.SvgDrawer({ width, height, bondThickness: 1.6, bondLength: 24, fontSizeLarge: 11, fontSizeSmall: 8, padding: 14, compactDrawing: false });
    window.SmilesDrawer.parse(code, (tree) => {
      try { drawer.draw(tree, svg, 'light'); } catch { wrap.textContent = code; }
    }, () => { wrap.textContent = code; });
    return wrap;
  }

  function svgDiagram(code) {
    const wrap = document.createElement('div');
    wrap.className = 'diagram-svg';
    if (!window.DOMPurify) return wrap;
    const frag = window.DOMPurify.sanitize(code, {
      USE_PROFILES: { svg: true, svgFilters: false },
      FORBID_TAGS: ['style', 'image', 'use', 'a', 'foreignObject', 'animate', 'set'],
      RETURN_DOM_FRAGMENT: true,
    });
    wrap.appendChild(frag);
    return wrap;
  }

  // Diagram block shown under the question text.
  function diagram(d) {
    if (!d || !d.code) return null;
    const fig = document.createElement('figure');
    fig.className = 'q-figure';
    fig.appendChild(d.kind === 'smiles' ? smiles(d.code, { width: 300, height: 200 }) : svgDiagram(d.code));
    if (d.caption) {
      const cap = document.createElement('figcaption');
      rich(cap, d.caption);
      fig.appendChild(cap);
    }
    return fig;
  }

  // Content of one option: a structure for SMILES-format questions, otherwise rich text.
  function option(text, format) {
    if (format === 'smiles') return smiles(text, { width: 240, height: 170 });
    // An option that is a single formula (e.g. "$\frac{48}{13}$") is typeset at full display size.
    const only = /^\s*\$([^$]+)\$\s*$/.exec(String(text));
    return rich(document.createElement('span'), only ? `$\\displaystyle ${only[1]}$` : text);
  }

  window.KLRender = { rich, smiles, diagram, option };
}());
