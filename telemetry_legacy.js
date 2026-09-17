/**
 * LEGACY RECORDER
 * Reproduces the original telemetry format (commit 0d89a50) unchanged, so exports can be analysed
 * exactly like the earlier data collection (e.g. with viz.html). Entries go to storage.local.legacyLogs
 * and are downloaded by "Legacy-Export (altes Format)" on the options page.
 *
 * The original behaviour is kept ON PURPOSE, including its known errors:
 * - every button click is stored; unrecognised ones as action "unknown"
 * - "Neuen Einsatz erstellen" and "Auf Karte zeigen" never match (capitalised strings compared with
 *   lowercased text) and are stored as "unknown"
 * - hang-up is any logitem button whose label contains "egen"
 * - ingame_time on clicks is the log item's time, or null outside a log item
 * - only the radio log (#logpanel) is observed: phone rings are not recorded
 * - acknowledgement only for "verstanden"; message is the first div's innerText
 * - mouse entries every 5 s, also with zero activity
 * - mission details and a mission overview snapshot every 10 s
 * - entries carry only `id` (no name, no run ID)
 * Only data loss is not reproduced: the queue is flushed when the page closes.
 *
 * Runs in the same content-script scope as telemetry.js and reads its `loggingActive`, `onGamePage`
 * and `userid`. Wrapped in a function so its names don't clash with telemetry.js.
 */
(() => {
  const isActive = () => loggingActive && onGamePage;
  const currentTime = () => new Date().toTimeString().split(" ")[0];

  const saveQueue = [];
  let flushTimer = null;

  function flushSaveQueue() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (saveQueue.length === 0) return;
    const entries = saveQueue.splice(0, saveQueue.length);
    try {
      chrome.runtime.sendMessage({ type: "appendLogs", key: "legacyLogs", entries }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          saveQueue.unshift(...entries);
          if (!flushTimer) flushTimer = setTimeout(flushSaveQueue, 2000);
        }
      });
    } catch (e) {
      // Extension was reloaded or updated; this content script is orphaned
    }
  }

  function saveData(d) {
    if (!isActive()) return;
    saveQueue.push(d);
    if (!flushTimer) {
      flushTimer = setTimeout(flushSaveQueue, 1000); // batch every 1s
    }
  }

  window.addEventListener("pagehide", flushSaveQueue);

  /* ---------------------------------------------------------------------------------------
     Aggregate Mouse and Key Statistics
  ------------------------------------------------------------------------------------------ */
  const mouseStats = {
    clicks: 0,
    moveDistance: 0,
    lastX: null,
    lastY: null
  };
  document.addEventListener("mousedown", () => {
    if (!isActive()) return;
    mouseStats.clicks++;
  });
  document.addEventListener("mousemove", (event) => {
    if (!isActive()) return;
    if (mouseStats.lastX !== null) {
      const dx = event.clientX - mouseStats.lastX;
      const dy = event.clientY - mouseStats.lastY;
      mouseStats.moveDistance += Math.sqrt(dx * dx + dy * dy);
    }
    mouseStats.lastX = event.clientX;
    mouseStats.lastY = event.clientY;
  });
  setInterval(() => {
    if (!isActive()) return;
    saveData({ timestamp: currentTime(), id: userid, type: "mouse",
      clicks: mouseStats.clicks, moveDistance: Math.floor(mouseStats.moveDistance) });
    mouseStats.clicks = 0; mouseStats.moveDistance = 0;
  }, 5000);

  document.addEventListener("keydown", (e) => {
    saveData({ id: userid, type: "key", key: e.key,
      code: e.code, timestamp: currentTime()
    });
  });

  /* ---------------------------------------------------------------------------------------
     MISSION DETAILS OBSERVER
  ------------------------------------------------------------------------------------------ */
  const processedMissions = new WeakSet();

  function extractMission(root) {
    try {
      let missiontext = "";
      const textCandidate = root.querySelector("div");
      if (textCandidate) {
        missiontext = textCandidate.innerText || "";
      }
      const car_list = [];
      root.querySelectorAll(".patient_row .log_car_type").forEach((el) => {
        car_list.push({ id: el.getAttribute("data-car"),
          name: el.innerText, type: el.classList[1] || "" });
      });
      const clock = document.querySelector("#clock")?.textContent || "";
      const missiontype = root.querySelector(".type")?.textContent || "";
      return { timestamp: currentTime(), id: userid,
        missiontext, cars: car_list, ingame_time: clock, mission_type: missiontype };
    } catch (e) {
      return null;
    }
  }

  const missionObserver = new MutationObserver((mutations) => {
    if (!isActive()) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const missionNodes = node.matches?.("#missiontab_0 > div, #missiontab_1 > div, #missiontab_2 > div")
          ? [node]
          : node.querySelectorAll?.("#missiontab_0 > div, #missiontab_1 > div, #missiontab_2 > div") || [];
        for (const missionNode of missionNodes) {
          if (processedMissions.has(missionNode)) continue;
          processedMissions.add(missionNode);
          const data = extractMission(missionNode);
          if (data) saveData(data);
        }
      }
    }
  });

  function startMissionObserver() {
    const container = document.querySelector("#missionlist");
    if (!container) {
      setTimeout(startMissionObserver, 500);
      return;
    }
    missionObserver.observe(container, { childList: true, subtree: true });
  }
  startMissionObserver();

  /* ---------------------------------------------------------------------------------------
     INTERACTION OBSERVER (radio log only)
  ------------------------------------------------------------------------------------------ */
  const processedLogs = new WeakSet();

  function parseLogEntry(node) {
    try {
      if (processedLogs.has(node)) return null;
      processedLogs.add(node);
      const text = node.innerText || "";
      const time = node.querySelector("span")?.textContent || "";
      if (text.includes("Sprechaufforderung")) {
        const carEl = node.querySelector("[data-car]");
        return { timestamp: currentTime(),
          id: userid, type: "call_request", time,
          caller: {
            carid: carEl?.getAttribute("data-car") || "",
            carname: carEl?.textContent || ""
          }
        };
      }
      if (text.toLowerCase().includes("verstanden")) {
        const message = node.querySelector("div")?.innerText || text;
        return { timestamp: currentTime(),
          id: userid, type: "acknowledgement", time, message };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  const interactionObserver = new MutationObserver((mutations) => {
    if (!isActive()) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const entries = node.matches?.("div")
          ? [node]
          : node.querySelectorAll?.("div") || [];
        for (const entry of entries) {
          const data = parseLogEntry(entry);
          if (data) saveData(data);
        }
      }
    }
  });

  function startInteractionObserver() {
    const container = document.querySelector("#logpanel .logcontainer");
    if (!container) {
      setTimeout(startInteractionObserver, 500);
      return;
    }
    interactionObserver.observe(container, { childList: true, subtree: true });
  }
  startInteractionObserver();

  /* ---------------------------------------------------------------------------------------
     BUTTON CLICKS (original matching, errors included)
  ------------------------------------------------------------------------------------------ */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const entry = btn.closest(".logitem");
    const time = entry?.querySelector(".time")?.textContent?.trim() || null;
    const message = entry?.querySelector(".text")?.textContent?.trim() || "";
    let action = "unknown";
    if (btn.closest(".logitem")) {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes("gegennehmen")) action = "phone_accept";
      else if (text.includes("Einsatz ers")) action = "dispo_create";
      else if (text.includes("egen")) action = "hangup";
      else if (text.includes("Karte")) action = "map_view";
    }
    if (btn.matches('button.dialog_ok[alarm="1"]')) {
      action = "mission_create_and_alarm";
    }
    saveData({ timestamp: currentTime(), ingame_time: time,
      id: userid, action, message });
  });

  /* ---------------------------------------------------------------------------------------
     AGGREGATE MISSION OVERVIEW
  ------------------------------------------------------------------------------------------ */
  function buildMissionSnapshot() {
    const rtw = {};
    document.querySelectorAll("#missiontab_0_title > div > span")
      .forEach((div) => { rtw[div.title] = div.textContent; });
    const ktw = {};
    document.querySelectorAll("#missiontab_1_title > div > span")
      .forEach((div) => { ktw[div.title] = div.textContent; });
    const vor = {};
    document.querySelectorAll("#missiontab_2_title > div > span")
      .forEach((div) => { vor[div.title] = div.textContent; });
    return { einsaetze: rtw, krankentransport: ktw, vorbestellungen: vor };
  }

  setInterval(() => {
    if (!isActive()) return;
    saveData({ timestamp: currentTime(), id: userid,
      type: "mission_overview", data: buildMissionSnapshot() });
  }, 10000);
})();
