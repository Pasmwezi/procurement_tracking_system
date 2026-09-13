const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('public/index.html', 'utf8');
test('workspace theme is loaded after legacy component layout', () => {
    assert.ok(html.indexOf('/css/workspace.css') > html.indexOf('/css/styles.css'));
});
test('mobile navigation has an accessible control and dismiss surface', () => {
    assert.match(html, /id="btnHamburger"[^>]*aria-controls="sidebar"/);
    assert.match(html, /id="sidebarBackdrop"/);
    assert.match(html, /class="skip-link"/);
});
test('workspace presentation preserves responsive table labels and keyboard navigation', () => {
    const js = fs.readFileSync('public/js/workspace.js', 'utf8');
    assert.match(js, /dataset.label/);
    assert.match(js, /aria-current/);
    assert.match(js, /Escape/);
    const css = fs.readFileSync('public/css/workspace.css', 'utf8');
    assert.match(css, /content: attr\(data-label\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /focus-visible/);
});
