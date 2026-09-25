import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ConversationView } from '../conversation-view.js';
import '../attachment-policy.js';

const MARKUP = `
<div id="chat-scroll"><div id="history"></div></div>
<button id="latest-reply" hidden></button>
<p id="chat-announcement"></p>
<section id="history-section" hidden></section>
<div id="chat-empty"><p id="empty-help"></p></div>
<p id="turn-count"></p>
<header id="toolbar"></header><div class="composer-dock"></div>`;

function open() {
  const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, { url: 'https://extension.test/panel.html', pretendToBeVisual: true });
  const confirmations = [];
  const view = new ConversationView(dom.window.document, (turnId, accept) => confirmations.push({ turnId, accept }));
  return { dom, view, confirmations, $: id => dom.window.document.getElementById(id) };
}
const turn = (id, extra = {}) => ({
  id, prompt: 'fix the tests', status: 'complete', reply: '', rich: null, live: null, liveRevision: 0,
  steps: [], attachments: [], ...extra
});

test('an empty conversation shows the connect hint and no turns', () => {
  const page = open();
  page.view.render([], null, 'disconnected');
  assert.equal(page.$('chat-empty').hidden, false);
  assert.equal(page.$('history-section').hidden, true);
  assert.equal(page.$('turn-count').textContent, '0 turns');
  assert.match(page.$('empty-help').textContent, /Connect your signed-in OpenHands tab/);
});

test('a captured turn renders the prompt, the reply and a copy button only with a reply', () => {
  const page = open();
  const rich = [['div', {}, ['p', {}, 'All green now.']]];
  page.view.render([turn('t1', { reply: 'All green now.', rich })], null, 'ready');
  const article = page.$('history').querySelector('article.turn');
  assert.ok(article);
  assert.equal(article.querySelector('.bubble.user').textContent, 'fix the tests');
  assert.equal(article.querySelector('.assistant-message').hidden, false);
  assert.equal(article.querySelector('.bubble.assistant').textContent, 'All green now.');
  assert.equal(article.querySelector('.bubble.assistant').classList.contains('rich'), true);
  assert.equal(article.querySelector('.bubble.assistant p').textContent, 'All green now.', 'the rich tree was rebuilt, not injected');
  assert.equal(article.querySelector('.reply-copy').hidden, false);
  assert.match(article.querySelector('.reply-label').textContent, /Agent reply/);
  // A turn without a reply text keeps its copy button hidden: nothing to copy, nothing pretended.
  page.view.render([turn('t2')], null, 'ready');
  const bare = page.$('history').querySelector('article.turn');
  assert.equal(bare.querySelector('.assistant-message').hidden, true, 'no reply block without a reply');
  assert.equal(bare.querySelector('.bubble.assistant').textContent, '');
  assert.equal(bare.querySelector('.reply-copy').hidden, true);
  assert.equal(page.$('history').querySelectorAll('article.turn').length, 1, 'the list is replaced, not appended');
});

test('imported turns are labelled and orphan replies are honest about having none', () => {
  const page = open();
  page.view.render([turn('i1', { imported: true, status: 'imported-no-reply', reply: '' })], null, 'ready');
  const article = page.$('history').querySelector('article.turn');
  assert.equal(article.classList.contains('imported'), true);
  assert.match(article.querySelector('.imported-badge').textContent, /OpenHands page/);
  assert.match(article.querySelector('.turn-outcome').textContent, /No reply text is on the page/);
});

test('an error turn says capture stopped without inventing a reply', () => {
  const page = open();
  page.view.render([turn('e1', { status: 'error', outcomeText: 'AGENT_BUSY: OpenHands is already working.' })], null, 'error');
  const article = page.$('history').querySelector('article.turn');
  assert.equal(article.dataset.state, 'error');
  assert.match(article.querySelector('.turn-outcome').textContent, /AGENT_BUSY/);
});

test('the live view shows streamed text, steps and the confirmation card', () => {
  const page = open();
  const pending = turn('p1', {
    status: 'waiting',
    live: {
      text: 'Reading the checkout workflow…', generating: true, steps: [{ kind: 'group', label: 'Read 2 files', state: 'activity' }],
      activity: 'Reading ci/checkout.yml', confirmation: { prompt: 'Do you want to continue with this action?', highRisk: true, ready: true }
    }
  });
  page.view.render([pending], pending, 'waiting');
  const article = page.$('history').querySelector('article.turn');
  const live = article.querySelector('.live-output');
  assert.equal(live.hidden, false);
  assert.match(live.querySelector('.live-text').textContent, /Reading the checkout workflow/);
  assert.equal(live.querySelector('.live-text').classList.contains('streaming'), true);
  assert.match(live.querySelector('.step-activity').textContent, /Read 2 files/);
  assert.match(live.querySelector('.live-activity').textContent, /Reading ci\/checkout.yml/);
  const card = live.querySelector('.confirm-card');
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.risk, 'true');
  const yes = card.querySelector('.confirm-yes');
  assert.equal(yes.disabled, false);
  yes.click();
  assert.deepEqual(page.confirmations, [{ turnId: 'p1', accept: true }]);
  // Once the turn completes, the live preview is replaced by the final reply.
  page.view.render([turn('p1', { reply: 'Done.', steps: pending.live.steps })], null, 'ready');
  assert.equal(article.querySelector('.live-output').hidden, true);
  assert.equal(article.querySelector('.bubble.assistant').hidden, false);
});

test('a stopped live view is labelled as stopped, not live', () => {
  const page = open();
  const pending = turn('p2', { status: 'waiting', live: { text: 'partial', generating: true } });
  page.view.render([pending], pending, 'error');
  const heading = page.$('history').querySelector('.live-heading').textContent;
  assert.match(heading, /Stopped activity/);
});

test('turn order changes move the nodes instead of rebuilding them', () => {
  const page = open();
  page.view.render([turn('a', { reply: 'one' }), turn('b', { reply: 'two' })], null, 'ready');
  const first = page.$('history').querySelector('article.turn');
  page.view.render([turn('b', { reply: 'two' }), turn('a', { reply: 'one' })], null, 'ready');
  const articles = [...page.$('history').querySelectorAll('article.turn')];
  assert.deepEqual(articles.map(node => node.dataset.turnId), ['b', 'a']);
  assert.equal(articles[1], first); // the same node was moved, not recreated
  assert.equal(page.$('turn-count').textContent, '2 turns');
});
