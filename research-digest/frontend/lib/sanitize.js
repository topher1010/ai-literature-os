// lib/sanitize.js — strict allowlist HTML sanitizer for full_text_summary.
//
// The pipeline (process-summary-queue.js) builds full_text_summary HTML from
// a fixed set of tags: <h4>, <p>, <ul>, <li>. Inner text content is escaped
// at generation time via esc(). This module provides a defense-in-depth layer
// at render time: any tag NOT in the allowlist is stripped, and any tag IN
// the allowlist has all attributes removed. So even if the pipeline ever
// emits unsanitized content, the library page cannot execute injected JS.
//
// UMD wrapper: works as a CommonJS module (for node:test) and as a browser
// global (for library.js via <script src="/lib/sanitize.js">).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.sanitize = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  const ALLOWED = new Set(['h4', 'p', 'ul', 'li']);
  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const COMMENT_RE = /<!--[\s\S]*?-->/g;

  function sanitize(html) {
    if (typeof html !== 'string') return '';
    return html
      .replace(COMMENT_RE, '')
      .replace(TAG_RE, function (match, tag) {
        const isClosing = match.charAt(1) === '/';
        const t = tag.toLowerCase();
        if (!ALLOWED.has(t)) return '';
        return isClosing ? '</' + t + '>' : '<' + t + '>';
      });
  }

  return sanitize;
}));
