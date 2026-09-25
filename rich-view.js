// Formatted replies. Rebuilds the JSON tree captured by agent-dom.js richOf() with createElement and
// textContent only — never innerHTML, never a template string, never a site-provided node. Everything is
// re-validated on this side of the port: unknown tags are dropped (their text kept), links must be
// http(s)/mailto and open in a new tab, and the only other attributes are a code language and a list start.
const TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'br', 'strong', 'em', 'del', 'code', 'a']);
const BLOCKS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr']);
const MAX_NODES = 25000, MAX_DEPTH = 45;

export function safeHref(value) {
  try {
    const url = new URL(String(value));
    return /^(?:https?:|mailto:)$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Returns a DocumentFragment, or null when the tree is missing, over budget or invalid — the caller then
// shows the plain text it already has instead of guessing at a partial render.
// options.onCopy(text, button): optional; adds a Copy button to each code block.
export function renderRich(doc, tree, options = {}) {
  if (!Array.isArray(tree) || !tree.length) return null;
  let count = 0, bad = false;
  const build = (node, depth, parent) => {
    if (bad) return;
    if (++count > MAX_NODES || depth > MAX_DEPTH) { bad = true; return; }
    if (typeof node === 'string') { parent.append(doc.createTextNode(node)); return; }
    if (!Array.isArray(node) || typeof node[0] !== 'string') { bad = true; return; }
    const [tag, attrs, ...children] = node;
    const opts = attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? attrs : {};
    if (!TAGS.has(tag)) { for (const child of children) build(child, depth + 1, parent); return; }
    if (tag === 'pre') {
      const block = doc.createElement('div'); block.className = 'rich-code';
      const lang = typeof opts.lang === 'string' ? opts.lang.replace(/[^\w+#.-]/g, '').slice(0, 30) : '';
      const source = children.filter(child => typeof child === 'string').join('');
      const head = doc.createElement('div'); head.className = 'rich-code-head';
      const label = doc.createElement('span'); label.className = 'rich-code-lang';
      label.textContent = lang || 'code';
      head.append(label);
      if (options.onCopy) {
        const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'rich-copy';
        copy.textContent = 'Copy'; copy.setAttribute('aria-label', `Copy ${lang || 'code'} block`);
        copy.addEventListener('click', () => options.onCopy(source, copy));
        head.append(copy);
      }
      block.append(head);
      const pre = doc.createElement('pre'), code = doc.createElement('code');
      code.textContent = source;
      pre.append(code); block.append(pre); parent.append(block); return;
    }
    if (tag === 'table') {
      // Wide diffs and logs from a coding agent scroll sideways instead of squeezing the panel.
      const wrap = doc.createElement('div'); wrap.className = 'rich-table';
      const table = doc.createElement('table'); wrap.append(table); parent.append(wrap);
      for (const child of children) build(child, depth + 1, table);
      return;
    }
    let el;
    if (tag === 'a') {
      const href = safeHref(opts.href);
      if (!href) { for (const child of children) build(child, depth + 1, parent); return; }
      el = doc.createElement('a'); el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.title = href;
    } else {
      el = doc.createElement(tag);
      if (tag === 'ol' && Number.isInteger(opts.start) && opts.start > 1 && opts.start < 1e6) el.start = opts.start;
    }
    if (tag !== 'hr' && tag !== 'br') for (const child of children) build(child, depth + 1, el);
    parent.append(el);
  };
  const fragment = doc.createDocumentFragment();
  for (const node of tree) build(node, 1, fragment);
  if (bad || !fragment.textContent.trim()) return null;
  return fragment;
}

// Markdown for "Copy reply": the same tree written back as Markdown (headings, lists, code fences, tables),
// so what the user pastes elsewhere matches what OpenHands rendered.
export function richToMarkdown(tree) {
  if (!Array.isArray(tree)) return '';
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.slice(2).map(text).join('') : '';
  const inline = nodes => nodes.map(node => {
    if (typeof node === 'string') return node.replace(/\s+/g, ' ');
    if (!Array.isArray(node)) return '';
    const [tag, attrs = {}, ...kids] = node, inner = inline(kids);
    switch (tag) {
      case 'strong': return inner.trim() ? `**${inner.trim()}**` : '';
      case 'em': return inner.trim() ? `*${inner.trim()}*` : '';
      case 'del': return inner.trim() ? `~~${inner.trim()}~~` : '';
      case 'code': {
        const body = kids.map(text).join('');
        if (!body) return '';
        const ticks = body.includes('`') ? '``' : '`';
        return `${ticks}${body}${ticks}`;
      }
      case 'a': { const href = safeHref(attrs.href); return href ? `[${inner.trim() || href}](${href})` : inner; }
      case 'br': return '  \n';
      default: return BLOCKS.has(tag) ? `\n\n${block(node, '').trim()}\n\n` : inner;
    }
  }).join('');
  const list = (node, indent) => {
    const [tag, attrs = {}, ...items] = node;
    let n = Number.isInteger(attrs.start) ? attrs.start : 1;
    return items.filter(item => Array.isArray(item) && item[0] === 'li').map(item => {
      const marker = tag === 'ol' ? `${n++}. ` : '- ';
      const kids = item.slice(2), own = [], nested = [];
      for (const kid of kids) (Array.isArray(kid) && (kid[0] === 'ul' || kid[0] === 'ol') ? nested : own).push(kid);
      const body = own.some(kid => Array.isArray(kid) && BLOCKS.has(kid[0]))
        ? own.map(kid => Array.isArray(kid) && BLOCKS.has(kid[0]) ? block(kid, '').trim() : inline([kid])).join(' ').replace(/\n{2,}/g, '\n')
        : inline(own).trim();
      const pad = ' '.repeat(marker.length);
      const first = `${indent}${marker}${body.split('\n').join(`\n${indent}${pad}`)}`;
      return [first, ...nested.map(child => list(child, indent + pad))].join('\n');
    }).join('\n');
  };
  const table = node => {
    const rows = [];
    const collect = n => {
      if (!Array.isArray(n)) return;
      if (n[0] === 'tr') rows.push(n.slice(2).filter(c => Array.isArray(c) && (c[0] === 'th' || c[0] === 'td')));
      else n.slice(2).forEach(collect);
    };
    collect(node);
    if (!rows.length) return '';
    const cell = c => inline(c.slice(2)).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    const width = Math.max(...rows.map(r => r.length));
    const line = r => `| ${Array.from({ length: width }, (_, i) => r[i] ? cell(r[i]) : '').join(' | ')} |`;
    return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  };
  function block(node, indent) {
    if (typeof node === 'string') return node.replace(/\s+/g, ' ');
    if (!Array.isArray(node)) return '';
    const [tag, attrs = {}, ...kids] = node;
    switch (tag) {
      case 'div': return blocks(kids);
      case 'p': return `${inline(kids).trim()}\n\n`;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return `${'#'.repeat(+tag[1])} ${inline(kids).trim()}\n\n`;
      case 'ul': case 'ol': return `${list(node, indent)}\n\n`;
      case 'blockquote': return `${blocks(kids).trim().split('\n').map(l => `> ${l}`.trimEnd()).join('\n')}\n\n`;
      case 'pre': {
        const body = kids.map(text).join('').replace(/\n$/, '');
        const fence = body.includes('```') ? '~~~' : '```';
        return `${fence}${typeof attrs.lang === 'string' ? attrs.lang.replace(/[^\w+#.-]/g, '') : ''}\n${body}\n${fence}\n\n`;
      }
      case 'table': return `${table(node)}\n\n`;
      case 'hr': return '---\n\n';
      default: return inline([node]);
    }
  }
  // Consecutive inline pieces form one paragraph; block elements stand alone.
  const blocks = nodes => {
    let out = '', run = [];
    const flush = () => { const t = inline(run).trim(); if (t) out += `${t}\n\n`; run = []; };
    for (const node of nodes) {
      if (Array.isArray(node) && BLOCKS.has(node[0])) { flush(); out += block(node, ''); }
      else run.push(node);
    }
    flush();
    return out;
  };
  return blocks(tree).replace(/\n{3,}/g, '\n\n').trim();
}
