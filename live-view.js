// The in-flight view of one turn: what OpenHands is visibly doing, its streamed text, and its
// "Do you want to continue with this action?" card. Presentation only — no tab, transport, credential or
// storage access, and nothing here decides whether a reply is finished (see agent-dom.js matchTurn).
import { renderRich } from './rich-view.js';
import { copyText } from './copy.js';

export class LiveView {
  // onConfirm(turnId, accept) is called at most once per user click; the panel enforces the one-click rule.
  constructor(parent, onConfirm = () => {}) {
    this.doc = parent.ownerDocument;
    this.onConfirm = onConfirm;
    this.onCopy = copyText;
    this.root = this.node('section', 'live-output');
    this.root.setAttribute('aria-label', 'Live OpenHands activity');
    this.heading = this.node('h3', 'live-heading', 'Live activity · not a final answer');
    this.activity = this.node('p', 'live-activity');
    this.text = this.node('div', 'live-text');
    this.steps = this.node('ul', 'live-steps');
    this.pendingLine = this.node('p', 'live-pending hint');
    this.confirmation = this.buildConfirmation();
    this.root.append(this.heading, this.activity, this.text, this.steps, this.pendingLine, this.confirmation.card);
    parent.append(this.root);
    this.root.hidden = true;
  }

  node(tag, className, text = '') {
    const el = this.doc.createElement(tag);
    el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  buildConfirmation() {
    const card = this.node('section', 'confirm-card');
    card.hidden = true;
    card.setAttribute('aria-label', 'OpenHands asks whether to continue with an action');
    const title = this.node('h4', 'confirm-title', 'OpenHands is asking for a confirmation');
    const risk = this.node('span', 'confirm-risk', 'High Risk');
    risk.hidden = true;
    const prompt = this.node('p', 'confirm-prompt');
    const hint = this.node('p', 'confirm-hint hint',
      'One click, exactly one direction. Confirm runs the action OpenHands proposed; Reject declines it. Nothing is chosen for you, and this extension never retries a click.');
    const buttons = this.node('div', 'confirm-buttons');
    const confirm = this.node('button', 'confirm-yes', 'Confirm action');
    const reject = this.node('button', 'confirm-no', 'Reject action');
    for (const button of [confirm, reject]) button.type = 'button';
    confirm.addEventListener('click', () => { if (!confirm.disabled) this.onConfirm(this.turnId, true); });
    reject.addEventListener('click', () => { if (!reject.disabled) this.onConfirm(this.turnId, false); });
    buttons.append(confirm, reject);
    const status = this.node('p', 'confirm-status', '');
    status.setAttribute('role', 'status');
    card.append(title, risk, prompt, hint, buttons, status);
    return { card, title, risk, prompt, hint, confirm, reject, status, signature: '', choice: '' };
  }

  renderConfirmation(confirmation, turn, active) {
    const view = this.confirmation;
    const shown = !!confirmation && !turn.reply;
    view.card.hidden = !shown;
    if (!shown) { view.signature = ''; view.choice = ''; return; }
    const choice = turn.confirmChoice || '';
    const signature = JSON.stringify([confirmation.prompt || '', !!confirmation.highRisk, !!confirmation.ready, choice, active]);
    if (signature !== view.signature) {
      view.prompt.textContent = confirmation.prompt || 'Do you want to continue with this action?';
      view.risk.hidden = !confirmation.highRisk;
      view.card.dataset.risk = String(!!confirmation.highRisk);
      const locked = !active || !confirmation.ready || !!choice || !!turn.confirmBusy;
      view.confirm.disabled = locked;
      view.reject.disabled = locked;
      view.confirm.dataset.chosen = String(choice === 'confirm');
      view.reject.dataset.chosen = String(choice === 'reject');
      view.status.textContent = turn.confirmState
        || (choice ? `You ${choice === 'confirm' ? 'confirmed' : 'rejected'} this action in OpenHands. Tracking continues.`
          : !active ? 'Tracking stopped. Answer it in the OpenHands tab.'
            : !confirmation.ready ? 'OpenHands has not finished rendering its controls for this action yet.'
              : 'Nothing is clicked until you choose.');
      view.signature = signature;
      view.choice = choice;
    }
  }

  render(turn, active) {
    this.turnId = turn.id;
    const live = turn.live || {};
    const steps = Array.isArray(live.steps) ? live.steps : [];
    const preview = turn.reply ? '' : (live.text || '');
    this.heading.textContent = turn.imported ? 'Activity shown on the OpenHands page'
      : turn.reply ? 'Activity during this turn'
        : active ? 'Live activity · not a final answer'
          : 'Stopped activity · not a final answer';

    // The site's own activity chip ("Reading …", "Running …") is mirrored verbatim; nothing is inferred.
    const activity = live.activity ? `OpenHands: “${live.activity}”` : '';
    if (this.activity.textContent !== activity) this.activity.textContent = activity;
    this.activity.hidden = !activity;

    // Formatted like OpenHands while it writes, when the structure could be read; otherwise plain text.
    const rich = preview && live.rich ? live.rich : null;
    if (preview !== this.shownText || rich !== this.shownRich) {
      const formatted = rich ? renderRich(this.doc, rich, { onCopy: this.onCopy }) : null;
      if (formatted) this.text.replaceChildren(formatted); else this.text.textContent = preview;
      this.text.classList.toggle('rich', !!formatted);
      this.shownText = preview; this.shownRich = rich;
    }
    this.text.hidden = !preview;
    // A caret marks text OpenHands is still writing. Only that one class changes, and only when its value
    // really flips, so the streaming animation never fights the text replacements above.
    const streaming = !!preview && !!live.generating && !!active;
    if (this.streaming !== streaming) { this.streaming = streaming; this.text.classList.toggle('streaming', streaming); }

    const signature = JSON.stringify(steps);
    if (signature !== this.stepSignature) {
      // Only genuinely new steps animate in; a state change (activity → done) is the same row.
      const known = this.stepCount || 0;
      this.steps.replaceChildren(...steps.map((step, index) => this.node('li',
        `step-activity step-${step.state || 'done'} step-${step.kind || 'action'}${index >= known ? ' step-new' : ''}`,
        `${stepLabel(step)}${step.expanded ? ' · expanded in OpenHands' : ''}`)));
      this.stepSignature = signature; this.stepCount = steps.length;
    }
    this.steps.hidden = !steps.length;

    const pending = Array.isArray(live.pending) ? live.pending : [];
    const pendingText = pending.length
      ? pending.map(item => item.status === 'error'
        ? `OpenHands could not send a queued message${item.text ? ` (“${item.text}”)` : ''}. Use Retry in the OpenHands tab; this extension never resends.`
        : `OpenHands is still queueing your message${item.text ? ` (“${item.text}”)` : ''}…`).join(' ')
      : '';
    if (this.pendingLine.textContent !== pendingText) this.pendingLine.textContent = pendingText;
    this.pendingLine.hidden = !pendingText;
    this.pendingLine.dataset.failed = String(pending.some(item => item.status === 'error'));

    this.renderConfirmation(live.confirmation || null, turn, active);
    this.root.hidden = !preview && !steps.length && !pendingText && !activity && this.confirmation.card.hidden;
  }
}

// Steps are OpenHands' own collapsed action groups and thinking blocks: the label the toggle prints
// ("3 actions completed", "Thinking"), plus whether a spinner says it is still running. Their hidden
// detail is never expanded or read.
function stepLabel(step) {
  const label = String(step?.label || '').replace(/\s+/g, ' ').trim();
  const kind = step?.kind === 'thinking' ? 'Thinking' : step?.kind === 'group' ? 'Actions' : 'Action';
  const state = step?.state === 'activity' ? 'running' : 'completed';
  return label ? `${label}` : `${kind} · ${state}`;
}
