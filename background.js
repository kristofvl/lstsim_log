// Background Service Worker (Manifest V3)
// - Opens (or focuses) the leaderboard when the extension icon is clicked
// - Owns all writes to the stored logs so concurrent tabs/pages cannot overwrite each other

const LEADERBOARD_URL = chrome.runtime.getURL('leaderboard.html');

// `logs`: current format (telemetry.js); `legacyLogs`: original format (telemetry_legacy.js)
const LOG_KEYS = ['logs', 'legacyLogs'];

chrome.action.onClicked.addListener(async () => {
  if (chrome.runtime.getContexts) {
    const [existing] = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [LEADERBOARD_URL]
    });
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId >= 0) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
  }
  chrome.tabs.create({ url: LEADERBOARD_URL });
});

// Serializes read-modify-write cycles on the log arrays
let logQueue = Promise.resolve();

function updateLogs(key, mutate) {
  const run = logQueue.then(async () => {
    const { [key]: logs = [] } = await chrome.storage.local.get(key);
    const next = mutate(logs);
    await chrome.storage.local.set({ [key]: next, lastUpdated: Date.now() });
    return next.length;
  });
  logQueue = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const key = msg?.key ?? 'logs';
  if (!LOG_KEYS.includes(key)) return false;

  let op;
  if (msg?.type === 'appendLogs' && Array.isArray(msg.entries)) {
    op = updateLogs(key, (logs) => logs.concat(msg.entries));
  } else if (msg?.type === 'removeLogs' && Number.isInteger(msg.count)) {
    // Drops the oldest `count` entries (e.g. after exporting them); newer entries survive
    op = updateLogs(key, (logs) => logs.slice(msg.count));
  } else if (msg?.type === 'clearLogs') {
    op = updateLogs(key, () => []);
  } else {
    return false;
  }

  op.then(
    (total) => sendResponse({ ok: true, total }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true;
});
