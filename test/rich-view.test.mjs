import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderRich, richToMarkdown, safeHref } from '../rich-view.js';

const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;

test('safeHref allows only http(s) and mailto, without credentials', () => {
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.match(safeHref('mailto:a@b.c'), /^mailto:a@b\.c$/);
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeHref('https://user:pw@example.com/'), '');
  assert.equal(safeHref('not a url'), '');
});

test('a formatted reply is rebuilt from createElement and textContent only', () => {
  const tree = [
    ['div', {},
      ['p', {}, 'Hello ', ['strong', {}, 'world'], '.'],
      ['ul', {}, ['li', {}, ['p', {}, 'item']]],
      ['pre', { lang: 'py' }, 'print("hi")\n'],
      ['a', { href: 'https://example.com' }, 'link']]
  ];
  const fragment = renderRich(doc, tree);
  const host = doc.createElement('div');
  host.append(fragment);
  assert.equal(host.querySelector('pre code').textContent, 'print("hi")\n');
  assert.equal(host.querySelector('.rich-code-lang').textContent, 'py');
  assert.equal(host.querySelectorAll('li').length, 1);
  const link = host.querySelector('a');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  // The whole tree is text: no element may carry site-controlled markup.
  assert.equal(host.querySelector('strong').outerHTML, '<strong>world</strong>');
});

test('unknown tags are dropped but their text is kept', () => {
  const fragment = renderRich(doc, [['div', {}, ['marquee', {}, 'kept'], ['script', {}, 'gone']]]);
  const host = doc.createElement('div');
  host.append(fragment);
  assert.equal(host.querySelector('marquee'), null);
  assert.equal(host.querySelector('script'), null);
  assert.equal(host.textContent, 'keptgone');
});

test('dangerous link schemes fall back to plain text', () => {
  const fragment = renderRich(doc, [['div', {}, ['a', { href: 'javascript:alert(1)' }, 'click']]]);
  const host = doc.createElement('div');
  host.append(fragment);
  assert.equal(host.querySelector('a'), null);
  assert.equal(host.textContent, 'click');
});

test('over-budget and empty trees render nothing rather than half a reply', () => {
  assert.equal(renderRich(doc, null), null);
  assert.equal(renderRich(doc, []), null);
  assert.equal(renderRich(doc, [['div', {}, '   ']]), null);
  const deep = ['div', {}];
  let node = deep;
  for (let i = 0; i < 60; i++) { const child = ['div', {}]; node.push(child); node = child; }
  assert.equal(renderRich(doc, [deep]), null);
});

test('tables survive into a scrollable wrapper', () => {
  const fragment = renderRich(doc, [['div', {},
    ['table', {},
      ['thead', {}, ['tr', {}, ['th', {}, 'file'], ['th', {}, 'result']]],
      ['tbody', {}, ['tr', {}, ['td', {}, 'a.py'], ['td', {}, 'fail']]]]]]);
  const host = doc.createElement('div');
  host.append(fragment);
  assert.equal(host.querySelector('.rich-table table').rows.length, 2);
});

test('markdown round-trips headings, lists, code fences and tables', () => {
  const tree = [['div', {},
    ['h2', {}, 'Summary'],
    ['p', {}, 'Two fixes:'],
    ['ol', {}, ['li', {}, ['p', {}, 'one']], ['li', {}, ['p', {}, ['code', {}, 'two(x)']]]],
    ['pre', { lang: 'diff' }, '- a\n+ b\n'],
    ['table', {}, ['tr', {}, ['th', {}, 'k'], ['th', {}, 'v']], ['tr', {}, ['td', {}, '1'], ['td', {}, '2']]]]];
  const markdown = richToMarkdown(tree);
  assert.match(markdown, /^## Summary/);
  assert.match(markdown, /1\. one/);
  assert.match(markdown, /2\. `two\(x\)`/);
  assert.match(markdown, /```diff\n- a\n\+ b\n```/);
  assert.match(markdown, /\| k \| v \|/);
  assert.match(markdown, /\| --- \| --- \|/);
});

test('the copy helper gives the raw source to the copy button', async () => {
  const { copyText } = await import('../copy.js');
  const host = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const button = host.createElement('button');
  button.textContent = 'Copy';
  host.body.append(button);
  // jsdom has neither clipboard API nor execCommand: the failure path must be honest, not silent.
  const ok = await copyText('secret', button);
  assert.equal(ok, false);
  assert.equal(button.textContent, 'Copy failed');
  assert.equal(button.dataset.state, 'error');
});
