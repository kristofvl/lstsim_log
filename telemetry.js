// Uses the `chrome` namespace: it supports callbacks in both Chrome and Firefox
// (Firefox's `browser` namespace is promise-only).

let loggingActive = true;
let onGamePage = false;
let username = null;
let userid = null;
let sessionId = null;

const currentTime = () => new Date().toTimeString().split(" ")[0];
const newSessionId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

chrome.storage.local.get(["username", "userid", "sessionId", "loggingActive"], (res) => {
  if (chrome.runtime.lastError) return;
  userid = res.userid || userid || 1;
  username = res.username || username || `Disponent_${userid}`;
  sessionId = res.sessionId || sessionId;
  if (typeof res.loggingActive === "boolean") loggingActive = res.loggingActive;

  if (!sessionId) {
    sessionId = newSessionId();
    chrome.storage.local.set({ username, userid, sessionId });
  }
  updateStatusIndicator();
});

// Starting a new shift on the lstsim.de start page begins a new participant session.
// The form posts and navigates away, so the session_start entry is sent immediately.
document.addEventListener("submit", (e) => {
  const input = e.target.querySelector?.("input[name='playername'], #playername");
  if (!input) return;
  userid = (parseInt(userid, 10) || 0) + 1;
  username = input.value.trim() || `Disponent_${userid}`;
  sessionId = newSessionId();
  chrome.storage.local.set({ username, userid, sessionId });
  if (loggingActive) {
    sendEntries([stamp({ type: "session_start" })]);
  }
  updateStatusIndicator();
});

/* ---------------------------------------------------------------------------------------
   GAME PAGE DETECTION
------------------------------------------------------------------------------------------ */
function detectGamePage() {
  onGamePage = !!document.querySelector("#gradient, #logpanel");
  if (onGamePage) {
    startInteractionObserver();
    updateStatusIndicator();
  } else {
    setTimeout(detectGamePage, 1000);
  }
}

/* ---------------------------------------------------------------------------------------
   SAVE QUEUE (entries are appended to storage by the background worker)
------------------------------------------------------------------------------------------ */
const saveQueue = [];
let flushTimer = null;

function stamp(d) {
  return { timestamp: currentTime(), id: userid, uname: username, sid: sessionId, ...d };
}

function scheduleFlush(delay) {
  if (!flushTimer) {
    flushTimer = setTimeout(flushSaveQueue, delay);
  }
}

function flushSaveQueue() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (saveQueue.length === 0) return;
  sendEntries(saveQueue.splice(0, saveQueue.length));
}

function sendEntries(entries) {
  try {
    chrome.runtime.sendMessage({ type: "appendLogs", entries }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        // Background not reachable right now: keep the entries and retry
        saveQueue.unshift(...entries);
        scheduleFlush(2000);
      }
    });
  } catch (e) {
    // Extension was reloaded or updated; this content script is orphaned
  }
}

function saveData(d) {
  if (!loggingActive || !onGamePage) return;
  saveQueue.push(stamp(d));
  scheduleFlush(500);
}

/* ---------------------------------------------------------------------------------------
   Aggregate Mouse and Key Statistics
------------------------------------------------------------------------------------------ */
let mouseStats = {
  clicks: 0,
  moveDistance: 0,
  lastX: null,
  lastY: null
};

document.addEventListener("mousedown", () => {
  if (!loggingActive) return;
  mouseStats.clicks++;
});

document.addEventListener("mousemove", (event) => {
  if (!loggingActive) return;
  if (mouseStats.lastX !== null) {
    const dx = event.clientX - mouseStats.lastX;
    const dy = event.clientY - mouseStats.lastY;
    mouseStats.moveDistance += Math.sqrt(dx * dx + dy * dy);
  }
  mouseStats.lastX = event.clientX;
  mouseStats.lastY = event.clientY;
});

function flushMouseStats() {
  if (mouseStats.clicks > 0 || mouseStats.moveDistance > 0) {
    saveData({
      type: "mouse",
      clicks: mouseStats.clicks,
      moveDistance: Math.floor(mouseStats.moveDistance)
    });
    mouseStats.clicks = 0;
    mouseStats.moveDistance = 0;
  }
}

setInterval(flushMouseStats, 3000);

document.addEventListener("keydown", (e) => {
  saveData({
    type: "key",
    key: e.key,
    code: e.code
  });
});

// Don't lose the last queued entries when the page is closed or reloaded
window.addEventListener("pagehide", () => {
  flushMouseStats();
  flushSaveQueue();
});

/* ---------------------------------------------------------------------------------------
   LOGPANEL & CALL OBSERVER
------------------------------------------------------------------------------------------ */
const processedLogs = new WeakSet();

function parseLogEntry(node) {
  try {
    if (processedLogs.has(node)) return null;
    processedLogs.add(node);
    // Message text only, without button labels such as "Anrufer weiterleiten"
    const text = (node.querySelector(".text")?.textContent || node.innerText || "").replace(/\s+/g, " ").trim();
    const time = node.querySelector(".time, span")?.textContent?.trim() || "";
    const clock = document.querySelector("#clock")?.textContent?.trim() || time;
    const lower = text.toLowerCase();

    if (node.closest("#phonepanel")) {
      // Phone rings: emergency call or colleague handing over a mission.
      // `time` is the log item's in-game time; the accept click on the same item carries it too.
      if (lower.startsWith("neuer telefonanruf") || lower.startsWith("kollege von tisch")) {
        return {
          ingame_time: clock,
          action: "unknown",
          type: "call_incoming",
          time,
          message: text
        };
      }
      // Caller's statement, offered with a "Neuen Einsatz erstellen" button
      if (node.querySelector("button[action='create']")) {
        return {
          ingame_time: clock,
          action: "unknown",
          type: "call_message",
          time,
          message: text
        };
      }
      return null;
    }

    // 1. Radio Sprechaufforderung
    if (text.includes("Sprechaufforderung")) {
      const carEl = node.querySelector("[data-car]");
      return {
        ingame_time: clock,
        type: "call_request",
        time,
        message: text,
        caller: {
          carid: carEl?.getAttribute("data-car") || "",
          carname: carEl?.textContent || ""
        }
      };
    }

    // 2. Radio Acknowledgement / Status
    if (lower.includes("verstanden") || lower.includes("status")) {
      return {
        ingame_time: clock,
        type: "acknowledgement",
        time,
        message: text
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

const interactionObserver = new MutationObserver((mutations) => {
  if (!loggingActive) return;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      const entries = node.matches(".logitem, .logentry, div")
        ? [node]
        : node.querySelectorAll(".logitem, .logentry, div");
      for (const entry of entries) {
        const data = parseLogEntry(entry);
        if (data) saveData(data);
      }
    }
  }
});

let observerStarted = false;

function observeWhenPresent(selector) {
  const container = document.querySelector(selector);
  if (container) {
    interactionObserver.observe(container, { childList: true, subtree: true });
  } else {
    setTimeout(() => observeWhenPresent(selector), 500);
  }
}

// Radio messages appear in #logpanel, phone calls in #phonepanel
function startInteractionObserver() {
  if (observerStarted) return;
  observerStarted = true;
  observeWhenPresent("#logpanel .logcontainer");
  observeWhenPresent("#phonepanel .logcontainer");
}

/* ---------------------------------------------------------------------------------------
   DISPATCH & BUTTON CLICKS OBSERVER
------------------------------------------------------------------------------------------ */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button, .btn, a.button, input[type='button'], input[type='submit']");
  if (!btn) return;

  const entry = btn.closest(".logitem") || btn.closest(".dialog") || btn.closest(".mission") || btn.closest("form");
  const time = entry?.querySelector(".time, .clock")?.textContent?.trim() || document.querySelector("#clock")?.textContent?.trim() || null;
  const message = entry?.querySelector(".text, p, div")?.textContent?.trim() || "";
  let action = "unknown";

  const text = (btn.textContent || btn.value || "").trim().toLowerCase();
  const buttonAction = btn.getAttribute("action");
  if (text.includes("gegennehmen") || text.includes("annehmen") || text.includes("ja, bitte")) action = "phone_accept";
  else if (buttonAction === "create" || text.includes("einsatz ers") || text.includes("erstellen")) action = "dispo_create";
  else if (buttonAction === "hangup" || text.includes("auflegen")) action = "hangup";
  else if (buttonAction === "forward") action = "call_forward";
  else if (buttonAction === "locate" || text.includes("karte")) action = "map_view";

  if (btn.matches('button.dialog_ok[alarm="1"]') || text.includes("alarm") || text.includes("disponieren")) {
    action = "mission_create_and_alarm";
  }

  if (action !== "unknown") {
    saveData({
      ingame_time: time,
      action,
      message: message || text
    });
  }
});

/* ---------------------------------------------------------------------------------------
   ON-SCREEN STATUS INDICATOR
------------------------------------------------------------------------------------------ */
function createStatusIndicator() {
  if (document.getElementById("logging-status-indicator") || !document.body) return;
  const el = document.createElement("div");
  el.id = "logging-status-indicator";
  Object.assign(el.style, {
    position: "fixed",
    top: "2px",
    right: "4px",
    zIndex: 99999,
    color: "#fff",
    padding: "3px 6px",
    borderRadius: "4px",
    fontSize: "10px",
    cursor: "pointer",
    fontFamily: "monospace",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)"
  });
  el.addEventListener("click", () => {
    loggingActive = !loggingActive;
    chrome.storage.local.set({ loggingActive });
    updateStatusIndicator();
  });
  document.body.appendChild(el);
}

function updateStatusIndicator() {
  createStatusIndicator();
  const el = document.getElementById("logging-status-indicator");
  if (!el) return;
  if (!loggingActive) {
    el.textContent = "Telemetry: PAUSED";
    el.style.background = "rgba(180,0,0,0.85)";
  } else if (!onGamePage) {
    el.textContent = "Telemetry: STANDBY (wartet auf Spielstart)";
    el.style.background = "rgba(90,90,90,0.85)";
  } else {
    el.textContent = `Telemetry: ON (${username || "Disponent"}, #${userid || 1})`;
    el.style.background = "rgba(0,128,0,0.85)";
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.loggingActive) loggingActive = changes.loggingActive.newValue !== false;
  if (changes.username) username = changes.username.newValue;
  if (changes.userid) userid = changes.userid.newValue;
  if (changes.sessionId) sessionId = changes.sessionId.newValue;
  if (changes.loggingActive || changes.username || changes.userid) updateStatusIndicator();
});

updateStatusIndicator();
detectGamePage();
