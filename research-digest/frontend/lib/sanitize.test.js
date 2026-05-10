// Tests for lib/sanitize.js — strict allowlist HTML sanitizer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sanitize = require('./sanitize');

test('preserves the four allowlisted tags as bare opening/closing forms', () => {
  const input = '<h4>Title</h4><p>body</p><ul><li>item</li></ul>';
  assert.equal(sanitize(input), input);
});

test('strips disallowed tags entirely (script tag content survives as text)', () => {
  // The dangerous part is the <script>...</script> structure; the inner text
  // becomes inert when re-injected via innerHTML because the tags are gone.
  const input = '<p>safe</p><script>alert(1)</script>';
  assert.equal(sanitize(input), '<p>safe</p>alert(1)');
});

test('drops attributes from allowlisted tags', () => {
  const input = '<h4 class="foo" id="bar">Title</h4>';
  assert.equal(sanitize(input), '<h4>Title</h4>');
});

test('drops event-handler attributes (onclick, onerror)', () => {
  // Even on allowlisted tags — the strip is total.
  assert.equal(sanitize('<p onclick="evil()">x</p>'), '<p>x</p>');
  assert.equal(sanitize('<h4 onmouseover="x">y</h4>'), '<h4>y</h4>');
});

test('drops img/iframe/svg/style/link entirely', () => {
  assert.equal(sanitize('<img src=x onerror=alert(1)>'), '');
  assert.equal(sanitize('<iframe src="evil"></iframe>'), '');
  assert.equal(sanitize('<svg><script>x</script></svg>'), 'x');
  assert.equal(sanitize('<style>body{display:none}</style>'), 'body{display:none}');
  assert.equal(sanitize('<link rel="stylesheet" href="evil">'), '');
});

test('strips HTML comments', () => {
  assert.equal(sanitize('<p>before</p><!-- evil --><p>after</p>'), '<p>before</p><p>after</p>');
});

test('lowercases tag names so <H4>, <P> etc still render', () => {
  assert.equal(sanitize('<H4>Title</H4>'), '<h4>Title</h4>');
  assert.equal(sanitize('<P>x</P>'), '<p>x</p>');
});

test('handles non-string input gracefully', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(42), '');
  assert.equal(sanitize({}), '');
});

test('preserves plain text including punctuation', () => {
  // Important: the sanitizer must not eat ordinary `<` or `>` symbols when they
  // aren't part of a tag (e.g. in a math expression).
  assert.equal(sanitize('5 < 6 and 7 > 3'), '5 < 6 and 7 > 3');
});

test('preserves already-escaped entities', () => {
  assert.equal(sanitize('&lt;script&gt;'), '&lt;script&gt;');
  assert.equal(sanitize('A &amp; B'), 'A &amp; B');
});

test('idempotent on already-clean input', () => {
  const clean = '<h4>Findings</h4><ul><li>one</li><li>two</li></ul><p>end.</p>';
  assert.equal(sanitize(sanitize(clean)), clean);
});

test('nested tag-injection trick: <scr<script>ipt> does not reconstitute', () => {
  // A common WAF-evasion pattern. After our regex passes, the dangerous
  // <script> tag must not appear in the output.
  const out = sanitize('<scr<script>ipt>alert(1)</script>');
  assert.ok(!/<script/i.test(out), 'output must not contain <script>');
});

test('handles realistic full_text_summary shape', () => {
  // Mirrors what the pipeline's renderSummaryHtml() produces.
  const realistic = [
    '<h4>Key Findings</h4>',
    '<ul>',
    '<li>The intervention significantly increased the measured outcome (p<0.001).</li>',
    '<li>The effect depends on signaling through the relevant pathway.</li>',
    '</ul>',
    '<h4>Methods</h4>',
    '<p>Controlled comparison across two conditions; sample size N=24.</p>',
  ].join('\n');
  assert.equal(sanitize(realistic), realistic);
});
