import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_URL, SITE_ORIGIN, VERSION, capabilitySummary, conversationId, describeStatusKind, isBusyKind,
  isOpenHands, isRequestId, pageKindOf, samePage, statusKind, tabLabel, withTimeout, TimeoutError
} from '../core.js';

test('the site origin and home url are the only supported entry points', () => {
  assert.equal(SITE_ORIGIN, 'https://app.all-hands.dev');
  assert.equal(HOME_URL, `${SITE_ORIGIN}/conversations`);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('isOpenHands accepts only the real origin', () => {
  assert.equal(isOpenHands('https://app.all-hands.dev/conversations/abc'), true);
  assert.equal(isOpenHands('https://app.all-hands.dev.evil.example/'), false);
  assert.equal(isOpenHands('http://app.all-hands.dev/'), false);
  assert.equal(isOpenHands('https://arena.ai/agent'), false);
  assert.equal(isOpenHands('not a url'), false);
});

test('pageKindOf maps every OpenHands route family', () => {
  assert.equal(pageKindOf('https://app.all-hands.dev/'), 'chat');
  assert.equal(pageKindOf('https://app.all-hands.dev/conversations'), 'chat');
  assert.equal(pageKindOf('https://app.all-hands.dev/conversations/abc'), 'chat');
  assert.equal(pageKindOf('https://app.all-hands.dev/conversations/abc/panel'), 'chat');
  assert.equal(pageKindOf('https://app.all-hands.dev/login'), 'login');
  assert.equal(pageKindOf('https://app.all-hands.dev/oauth/device/verify'), 'login');
  assert.equal(pageKindOf('https://app.all-hands.dev/shared/conversations/abc'), 'shared');
  assert.equal(pageKindOf('https://app.all-hands.dev/settings/llm'), 'other');
  assert.equal(pageKindOf('https://example.com/'), 'other');
});

test('conversationId reads the route segment and nothing else', () => {
  assert.equal(conversationId('https://app.all-hands.dev/conversations/abc-123'), 'abc-123');
  assert.equal(conversationId('https://app.all-hands.dev/conversations/abc-123/panel?x=1'), 'abc-123');
  assert.equal(conversationId('https://app.all-hands.dev/conversations'), '');
  assert.equal(conversationId('https://app.all-hands.dev/settings'), '');
  assert.equal(conversationId('nope'), '');
});

test('samePage ignores the /panel suffix, query and hash but never the conversation', () => {
  const base = 'https://app.all-hands.dev/conversations/abc';
  assert.equal(samePage(base, `${base}/panel`), true);
  assert.equal(samePage(`${base}/panel`, base), true);
  assert.equal(samePage(`${base}?filter=x`, `${base}#bottom`), true);
  assert.equal(samePage(`${base}/`, base), true);
  assert.equal(samePage(base, 'https://app.all-hands.dev/conversations/def'), false);
  assert.equal(samePage(base, 'https://app.all-hands.dev/conversations'), false);
  assert.equal(samePage(base, 'https://other.example/conversations/abc'), false);
  assert.equal(samePage('https://app.all-hands.dev/', 'https://app.all-hands.dev/conversations'), false);
  assert.equal(samePage('broken', base), false);
});

test('statusKind matches the site vocabulary exactly and reports unknown otherwise', () => {
  assert.equal(statusKind('Running'), 'running');
  assert.equal(statusKind('Ready'), 'ready');
  assert.equal(statusKind('Done'), 'done');
  assert.equal(statusKind('User needed'), 'user-needed');
  assert.equal(statusKind('Stopped'), 'stopped');
  assert.equal(statusKind('Agent error'), 'error');
  assert.equal(statusKind('Disconnected'), 'disconnected');
  assert.equal(statusKind('Connecting'), 'connecting');
  assert.equal(statusKind('Adding git hooks'), 'starting');
  assert.equal(statusKind(''), 'none');
  assert.equal(statusKind('Deploying the moon'), 'unknown');
});

test('busy kinds are exactly running and starting', () => {
  for (const kind of ['running', 'starting']) assert.equal(isBusyKind(kind), true);
  for (const kind of ['ready', 'done', 'stopped', 'error', 'none', 'unknown']) assert.equal(isBusyKind(kind), false);
});

test('describeStatusKind never guesses: unknown stays unknown', () => {
  assert.match(describeStatusKind('running'), /running/);
  assert.match(describeStatusKind('weird'), /unrecognized status/);
});

test('tabLabel names the tab without leaking secrets', () => {
  const label = tabLabel({ id: 7, title: 'Fix tests', url: 'https://app.all-hands.dev/conversations/abc?token=secret' });
  assert.equal(label, 'Tab 7 · Fix tests · app.all-hands.dev/conversations/abc');
  assert.equal(tabLabel({ id: 7 }), 'Tab 7 · OpenHands · ');
});

test('capabilitySummary distinguishes drift from transient absence', () => {
  const all = { pageKind: 'conversation', checks: { composer: true, send: true, transcript: true, scrollContainer: true, status: true, confirmation: false, upload: false, liveActivity: false } };
  const none = { reported: false, drift: false };
  const missing = capabilitySummary(all);
  assert.equal(missing.drift, false);
  assert.match(missing.text, /not currently showing/);
  const broken = capabilitySummary({ ...all, checks: { ...all.checks, send: false } });
  assert.equal(broken.drift, true);
  assert.match(broken.text, /missing: Send control/);
  assert.equal(capabilitySummary(undefined).reported, none.reported);
  assert.equal(capabilitySummary({}).drift, false);
  const full = { composer: true, send: true, transcript: true, scrollContainer: true, status: true, confirmation: true, upload: true, liveActivity: true };
  assert.match(capabilitySummary({ pageKind: 'home', checks: full }).text, /launcher layout: every expected control/);
  assert.match(capabilitySummary({ pageKind: 'conversation', conversationId: 'abc', checks: full }).text, /conversation layout: every expected control/);
});

test('withTimeout resolves fast promises and rejects with TimeoutError after the budget', async () => {
  assert.equal(await withTimeout(Promise.resolve(41 + 1), 500, 'never'), 42);
  let slow;
  const pending = new Promise(resolve => { slow = resolve; });
  const timed = withTimeout(pending, 20, 'too slow');
  await assert.rejects(timed, error => error instanceof TimeoutError && error.code === 'TIMEOUT' && error.message === 'too slow');
  slow('late'); // the late answer must not reject anything or throw
});

test('isRequestId accepts only uuid-shaped ids', () => {
  assert.equal(isRequestId('6f9a3b10-1f2e-4c5d-8a9b-0c1d2e3f4a5b'), true);
  assert.equal(isRequestId('6F9A3B10-1F2E-4C5D-8A9B-0C1D2E3F4A5B'), true);
  assert.equal(isRequestId(''), false);
  assert.equal(isRequestId('nope'), false);
  assert.equal(isRequestId(42), false);
  assert.equal(isRequestId(null), false);
});
