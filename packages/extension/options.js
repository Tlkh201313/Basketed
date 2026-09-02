/**
 * Basketed Connect — settings.
 *
 * One value: which local origin is the real panel. See background.js for why
 * that is the whole security model of this extension.
 */

/**
 * The port `basketed serve` prefers. Pinning this by default is what keeps the
 * common case a zero-step install: only a panel that had to fall back to
 * another port needs anything typed here.
 */
const DEFAULT_ORIGIN = "http://127.0.0.1:8787";

const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

const field = document.getElementById("origin");
const note = document.getElementById("note");

function say(text, ok) {
  note.textContent = text;
  note.className = "note " + (ok ? "ok" : "bad");
}

chrome.storage.local.get({ panelOrigin: DEFAULT_ORIGIN }).then((stored) => {
  field.value = stored.panelOrigin;
});

document.getElementById("save").addEventListener("click", () => {
  const raw = field.value.trim().replace(/\/+$/, "");
  if (!LOCAL_ORIGIN.test(raw)) {
    say("That is not a local origin. It should look like " + DEFAULT_ORIGIN + " — no path, no trailing slash.", false);
    return;
  }
  chrome.storage.local.set({ panelOrigin: raw }).then(() => {
    field.value = raw;
    say("Saved. This extension will now answer only " + raw + ".", true);
  });
});
