// MONEY — boot + controller.
// P0 scaffold stub. P2a (UI engineer) owns the real implementation.
//
// TWO RULES INHERITED FROM lift THAT MUST NOT BE BROKEN:
//   1. Never re-render a list while an <input> inside it has focus — it kills
//      the iOS keyboard and caret mid-entry. Use targeted patch helpers.
//   2. Commit input values on `change`/`blur`, NEVER on `input`.

import { registerSW } from "./sw-register.js";

const app = document.getElementById("app");

function boot() {
  app.innerHTML =
    '<div style="padding:24px;color:#9ba3a1;font:15px/1.5 -apple-system,system-ui,sans-serif">' +
    '<strong style="color:#f2f5f4">Money</strong><br>scaffold ok — awaiting P1 data core.' +
    "</div>";
  registerSW();
}

boot();
