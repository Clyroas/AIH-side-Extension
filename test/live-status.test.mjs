import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationState, formatElapsed, latestSentence, liveStatus, siteStatus } from '../live-status.js';

const T0 = 1_700_000_000_000;

test('formatElapsed keeps hours, minutes and seconds readable', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(9_999), '0:09');
  assert.equal(formatElapsed(65_000), '1:05');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
  assert.equal(formatElapsed(-5), '0:00');
  assert.equal(formatElapsed(Number.NaN), '0:00');
});

test('latestSentence prefers the tail of the stream and never returns a fragment', () => {
  assert.equal(latestSentence(''), '');
  assert.equal(latestSentence('Drafting now. The checkout fixture needed a newer action version.', 140),
    'The checkout fixture needed a newer action version.');
  // A one- or two-word tail reads as a fragment, so the prior sentence is kept with it.
  assert.equal(latestSentence('First sentence. Ok.', 140), 'First sentence. Ok.');
  const long = 'x'.repeat(300);
  const tail = latestSentence(long, 40);
  assert.ok(tail.startsWith('…'));
  assert.ok(tail.length <= 41);
});

test('confirmationState separates an answerable card from one still rendering', () => {
  assert.equal(confirmationState(null), 'none');
  assert.equal(confirmationState({ ready: true }), 'answerable');
  assert.equal(confirmationState({ ready: false }), 'held');
});

test('a stopped capture says so and points at the tab', () => {
  const status = liveStatus({ status: 'error', code: 'AGENT_BUSY' }, T0);
  assert.equal(status.step, 'Capture stopped');
  assert.equal(status.kind, 'error');
  assert.match(status.detail, /check the OpenHands tab/);
});

test('security and pause holds are reported as pauses, never as failures', () => {
  const blocked = liveStatus({ status: 'waiting', securityHold: true }, T0);
  assert.equal(blocked.step, 'Waiting for verification');
  assert.equal(blocked.kind, 'blocked');
  const paused = liveStatus({ status: 'waiting', pauseHold: true }, T0);
  assert.equal(paused.step, 'Agent paused');
  assert.match(paused.detail, /Resume it in the OpenHands tab/);
});

test('reconnect in flight is its own state', () => {
  const status = liveStatus({ status: 'waiting', phase: 'reconnecting' }, T0);
  assert.equal(status.step, 'Reconnecting to OpenHands');
  assert.equal(status.kind, 'reconnecting');
});

test('sending states name the exactly-once click and the staging step', () => {
  assert.equal(liveStatus({ status: 'sending' }, T0).step, 'Sending your message');
  assert.equal(liveStatus({ status: 'sending', phase: 'upload' }, T0).step, 'Placing your files');
});

test('an answerable confirmation always wins over live text', () => {
  const status = liveStatus({
    status: 'waiting',
    live: { text: 'Writing…', confirmation: { prompt: 'Do you want to continue with this action?', highRisk: true, ready: true } }
  }, T0);
  assert.equal(status.step, 'Waiting for your confirmation');
  assert.equal(status.kind, 'question');
  assert.match(status.detail, /High Risk/);
});

test('fresh text reads as writing; a running step reads as working on that step', () => {
  const writing = liveStatus({ status: 'waiting', acceptedAt: T0, lastActivityAt: T0, textChangedAt: T0 - 1000, live: { text: 'Drafting the reply now.' } }, T0);
  assert.equal(writing.step, 'Writing');
  assert.equal(writing.detail, 'Drafting the reply now.');
  const tool = liveStatus({
    status: 'waiting', acceptedAt: T0, lastActivityAt: T0, textChangedAt: 0,
    live: { steps: [{ kind: 'group', label: 'Read 4 files', state: 'activity' }, { kind: 'action', label: 'Ran pytest', state: 'done' }] }
  }, T0);
  assert.match(tool.step, /Read 4 files/);
  assert.equal(tool.kind, 'tool');
  assert.match(tool.detail, /2 steps so far/);
});

test('the elapsed and quiet clocks appear in the meta line', () => {
  const status = liveStatus({ status: 'waiting', acceptedAt: T0 - 65_000, lastActivityAt: T0 - 15_000, live: { text: 'x' } }, T0);
  assert.match(status.meta, /1:05 elapsed/);
  assert.match(status.meta, /last change 0:15 ago/);
});

test('siteStatus reports the site label literally and flags inference', () => {
  assert.equal(siteStatus(null).kind, 'unknown');
  const running = siteStatus({ status: 'Running', kind: 'running' });
  assert.equal(running.label, 'Running');
  assert.match(running.text, /running/);
  const mismatch = siteStatus({ status: 'Done', kind: 'done' }, { busy: true });
  assert.equal(mismatch.kind, 'working');
  assert.match(mismatch.text, /while this panel tracks a reply/);
});
