/**
 * MONEY — toast/snackbar with an optional action button.
 *
 * Self-mounting and deliberately independent of #app: main.js does a full
 * `app.innerHTML = ...` on every screen/sheet change, which would delete a
 * toast node living inside #app mid-countdown. initToast() mounts into
 * `document.body` instead, so the undo snackbar survives the add-expense
 * sheet closing right underneath it.
 *
 * Primary caller: the 3s "Undo" window after an expense commits.
 */

let els = null; // {root, msg, action}
let hideTimer = null;
let onActionCb = null;

function build(root) {
  const node = document.createElement("div");
  node.className = "toast";
  node.hidden = true;
  node.innerHTML =
    '<span class="toast-msg"></span>' +
    '<button class="toast-action" type="button" data-action="toast-action" hidden></button>';
  root.appendChild(node);

  const action = node.querySelector(".toast-action");
  // Own listener, not routed through main.js's #app delegation — the toast
  // lives outside #app and must work regardless of screen/sheet state.
  action.addEventListener("click", (e) => {
    e.stopPropagation();
    const cb = onActionCb;
    hideToast();
    cb?.();
  });

  return { root: node, msg: node.querySelector(".toast-msg"), action };
}

/** Mount the toast DOM once. Safe to call more than once — no-ops after the first. */
export function initToast(root) {
  if (els) return;
  els = build(root || document.body);
}

/**
 * @param {string} message
 * @param {{actionLabel?:string, onAction?:Function, duration?:number,
 *          kind?:'success'|'error'}} [opts]
 * @returns {void}
 */
export function showToast(message, opts = {}) {
  if (!els) return; // initToast() must run first — fail quiet, never throw
  clearTimeout(hideTimer);

  // Success and error must not look identical. Callers pass kind:'success'
  // or kind:'error'; no kind keeps the neutral base look. CSS renders the
  // difference as a leading glyph + border treatment, never colour alone.
  els.root.classList.toggle("toast--error", opts.kind === "error");
  els.root.classList.toggle("toast--success", opts.kind === "success");

  els.msg.textContent = message;
  if (opts.actionLabel && typeof opts.onAction === "function") {
    els.action.textContent = opts.actionLabel;
    els.action.hidden = false;
    onActionCb = opts.onAction;
  } else {
    els.action.hidden = true;
    onActionCb = null;
  }

  els.root.hidden = false;
  const duration = Number.isFinite(opts.duration) ? opts.duration : 3000;
  hideTimer = setTimeout(hideToast, duration);
}

/** Dismiss immediately without running the action callback. */
export function hideToast() {
  clearTimeout(hideTimer);
  hideTimer = null;
  onActionCb = null;
  if (els) els.root.hidden = true;
}
