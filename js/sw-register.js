export function registerSW() {
  try {
    if (
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.search.includes("nosw")
    ) {
      return;
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("./sw.js", { scope: "./" })
        .catch(() => {});
    }
  } catch (e) {
    // never throw
  }
}

export function checkForUpdate() {
  try {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .getRegistration("./")
      .then((reg) => {
        if (!reg) return;
        reg.update().catch(() => {});
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      })
      .catch(() => {});
  } catch (e) {
    // never throw
  }
}
