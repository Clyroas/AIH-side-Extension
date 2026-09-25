// Pure: turns the adapter's snapshot of what OpenHands is visibly doing into one line of panel status.
// It only summarizes data the page already shows (the status label, the live activity chip, collapsed
// action-group titles, and the public live text) — it never infers progress from timing alone.
import { describeStatusKind } from './core.js';

const RECENT_TEXT_MS = 4000;

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The tail of the streamed text, trimmed to one readable sentence. Used for "Writing …" only; the full
// text is always shown in the live view.
export function latestSentence(text, max = 140) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const parts = clean.split(/(?<=[.!?…])\s+/).filter(Boolean);
  let last = parts.at(-1) || clean;
  // A one- or two-word fragment just after a full stop is hard to read; include the prior sentence.
  if (last.split(' ').length < 3 && parts.length > 1) last = `${parts.at(-2)} ${last}`;
  if (last.length <= max) return last;
  const cut = last.slice(-max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 30 ? cut.slice(space + 1) : cut}`;
}

// 'none' — no card; 'answerable' — the panel can click Confirm/Reject; 'held' — OpenHands has the card
// but its controls are not usable yet (still rendering, or the action is not ready).
export function confirmationState(confirmation) {
  if (!confirmation || typeof confirmation !== 'object') return 'none';
  return confirmation.ready ? 'answerable' : 'held';
}

const stepLabel = step => String(step?.label || '').replace(/\s+/g, ' ').trim();

export function liveStatus(turn, now = Date.now()) {
  if (!turn) return null;
  const live = turn.live || {};
  const steps = Array.isArray(live.steps) ? live.steps : [];
  const lastStep = [...steps].reverse().find(step => step.state === 'activity') || steps.at(-1);
  const since = turn.acceptedAt ? formatElapsed(now - turn.acceptedAt) : '';
  const quiet = turn.lastActivityAt ? Math.floor((now - turn.lastActivityAt) / 1000) : null;
  const meta = [
    since && `${since} elapsed`,
    quiet !== null && quiet >= 10 ? `last change ${formatElapsed(quiet * 1000)} ago` : ''
  ].filter(Boolean).join(' · ');
  const result = (step, detail, kind) => ({ step, detail, kind, meta });
  const status = live.state || turn.state || null;

  if (turn.status === 'error')
    return result('Capture stopped', 'Read the error above and check the OpenHands tab. Nothing was resent.', 'error');
  // A security verification pauses tracking instead of ending it, so it is reported distinctly from both
  // "stopped" and "reconnecting".
  if (turn.securityHold)
    return result('Waiting for verification', 'OpenHands is showing a security verification. Complete it in the OpenHands tab — tracking resumes on its own once it passes, and nothing is resent.', 'blocked');
  if (turn.pauseHold)
    return result('Agent paused', 'OpenHands shows the agent stopped or paused. Resume it in the OpenHands tab (or with Resume below) and tracking continues by itself; nothing is resent.', 'blocked');
  if (turn.phase === 'reconnecting')
    return result('Reconnecting to OpenHands', 'The connection dropped. Reattaching to the same tab to keep tracking this reply — nothing is resent.', 'reconnecting');
  if (turn.status === 'sending') {
    if (turn.phase === 'upload') return result('Placing your files', 'The staged files are being inserted into the OpenHands composer before the one Send click.', 'sending');
    return result('Sending your message', 'Attempting exactly one Send click in OpenHands.', 'sending');
  }
  if (confirmationState(live.confirmation) === 'answerable')
    return result('Waiting for your confirmation', `${live.confirmation.prompt || 'OpenHands asks whether to continue with an action.'}${live.confirmation.highRisk ? ' OpenHands marks this action High Risk.' : ''} Nothing is confirmed for you.`, 'question');
  if (confirmationState(live.confirmation) === 'held')
    return result('Confirmation is not ready', 'OpenHands is showing its confirmation card but its controls are not usable yet. Wait a moment, or answer it in the OpenHands tab.', 'question');
  if (status?.kind === 'user-needed')
    return result('OpenHands needs you', 'The site says user input is needed. Look for a confirmation card or a prompt in the OpenHands tab.', 'question');

  const textFresh = !!live.text && turn.textChangedAt && now - turn.textChangedAt < RECENT_TEXT_MS;
  if (lastStep?.kind === 'thinking' && !textFresh)
    return result('Thinking', `OpenHands is showing its reasoning step${steps.length > 1 ? ` (${steps.length} steps so far)` : ''}. The thought text stays collapsed in OpenHands.`, 'thinking');
  if (lastStep && lastStep.state === 'activity' && !textFresh) {
    const label = stepLabel(lastStep);
    return result(label ? `Working · ${label.slice(0, 60)}` : 'Working',
      `${steps.length} step${steps.length === 1 ? '' : 's'} so far${live.activity ? ` · OpenHands: “${live.activity}”` : ''}.`, 'tool');
  }
  if (textFresh) return result('Writing', latestSentence(live.text), 'writing');

  const summary = [
    steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}${lastStep ? ` · last: ${stepLabel(lastStep).slice(0, 60) || lastStep.kind}` : ''}` : '',
    live.activity ? `OpenHands: “${live.activity}”` : ''
  ].filter(Boolean).join(' · ');
  if (status?.kind && status.kind !== 'none' && status.kind !== 'unknown')
    return result(live.generating ? 'Working' : 'Finishing up', `${describeStatusKind(status.kind)}${summary ? ` · ${summary}` : ''}`, live.generating ? 'working' : 'settling');
  if (live.text)
    return result(live.generating ? 'Working' : 'Finishing up', summary || latestSentence(live.text), live.generating ? 'working' : 'settling');
  return result('Working', summary || (live.generating
    ? 'OpenHands is generating. Waiting for its first visible update.'
    : 'Waiting for OpenHands’ first visible update.'), 'working');
}

// The header chip: what OpenHands itself says about the agent, in the panel's words. Pure so it can be
// tested without a DOM, and deliberately literal — an unrecognized status is reported as unrecognized.
export function siteStatus(state, { busy = false } = {}) {
  const kind = state?.kind || 'none';
  const label = String(state?.status || '').trim();
  if (busy && kind !== 'running' && kind !== 'starting')
    return { kind: 'working', label: label || 'Working', text: `OpenHands shows “${label || 'no status'}” while this panel tracks a reply.` };
  if (!label && kind === 'none')
    return { kind: 'unknown', label: 'No status', text: 'OpenHands is not showing an agent status on this page.' };
  return { kind: kind === 'unknown' ? 'unknown' : kind, label: label || kind, text: describeStatusKind(kind) };
}
