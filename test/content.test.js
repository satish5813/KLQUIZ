// Checks for question-content validation (formulas, structures, diagrams, escape repair). Run: npm test
const assert = require('assert');
const c = require('../server/content');

const BS = String.fromCharCode(92); // one backslash
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test('under-escaped JSON LaTeX is repaired', () => {
  const raw = JSON.parse(`{"q":"$${BS}frac{a}{b}$, $${BS}theta$, $${BS}beta$, $${BS}rho$"}`).q;
  assert.strictEqual(c.repairEscapes(raw), `$${BS}frac{a}{b}$, $${BS}theta$, $${BS}beta$, $${BS}rho$`);
});
test('real newlines are kept', () => assert.strictEqual(c.repairEscapes('a\nb'), 'a\nb'));
test('literal backslash-n becomes a line break', () => assert.strictEqual(c.repairEscapes(`Steps:${BS}n1. Push`), 'Steps:\n1. Push'));
test('code string "\\n" is kept', () => assert.strictEqual(c.repairEscapes(`cout << "${BS}n";`), `cout << "${BS}n";`));
test('LaTeX \\nu and \\neq are kept', () => assert.strictEqual(c.repairEscapes(`$${BS}nu ${BS}neq 0$`), `$${BS}nu ${BS}neq 0$`));

test('valid LaTeX and mhchem pass', () => {
  assert.strictEqual(c.checkMath(`$E = -${BS}frac{k}{2a^2}$ and $$${BS}int_0^1 x^2${BS},dx$$`), null);
  assert.strictEqual(c.checkMath(`$${BS}ce{2H2 + O2 -> 2H2O}$`), null);
});
test('broken LaTeX is rejected', () => assert.notStrictEqual(c.checkMath(`$${BS}frac{1}{$`), null));
test('stray $ is rejected', () => assert.notStrictEqual(c.checkMath('Costs $5 only'), null));
test('plain Unicode text passes', () => assert.strictEqual(c.checkMath('₹500 and x²'), null));

test('SMILES validation', () => {
  assert.ok(c.isSmiles('CC(=O)OC1=CC=CC=C1C(=O)O'));
  assert.ok(!c.isSmiles('<script>'));
});
test('SVG sanitiser keeps safe drawings', () => {
  const s = c.sanitizeSvg('<svg viewBox="0 0 100 50"><line x1="0" y1="0" x2="100" y2="50" stroke="black"/><text x="5" y="20">R = 4 Ω</text></svg>');
  assert.ok(s && s.includes('viewBox'));
});
test('SVG sanitiser blocks scripts, handlers and external content', () => {
  assert.strictEqual(c.sanitizeSvg('<svg><script>alert(1)</script></svg>'), null);
  assert.ok(!/onload/.test(c.sanitizeSvg('<svg onload="alert(1)"><rect width="5" height="5"/></svg>')));
  assert.strictEqual(c.sanitizeSvg('<svg><image href="http://x/y.png"/></svg>'), null);
  assert.strictEqual(c.sanitizeSvg('<svg><foreignObject><div>x</div></foreignObject></svg>'), null);
  assert.ok(!/javascript/.test(c.sanitizeSvg('<svg><rect fill="javascript:alert(1)" width="2" height="2"/></svg>')));
});

console.log(`${passed} content checks passed${process.exitCode ? ' (with failures above)' : ''}`);
