const browser = window.browser || window.chrome;

let uniqueKey = null;

const saveQueue = [];
let flushTimer = null;
function flushSaveQueue() {
  const batch = saveQueue.splice(0, saveQueue.length);
  flushTimer = null;
  if (batch.length === 0) return;
  browser.storage.local.get("logs").then((res) => {
    const existing = res.logs || [];
    browser.storage.local.set({
      logs: existing.concat(batch)
    });
  });
}
function saveData(d) {
  console.log(d); // temporary fix
  saveQueue.push(d);
  if (!flushTimer) {
    flushTimer = setTimeout(flushSaveQueue, 1000); // batch every 1s
  }
}

function loadOptions(item) {
  if (item && item.idobject && item.idobject.id) {
    uniqueKey = item.idobject.id;
  } else {
    const fallback = "default-" + crypto.randomUUID();
    uniqueKey = fallback;
    browser.storage.local.set({ idobject: { id: fallback } });
    console.warn("No idobject found, using fallback:", fallback);
  }
}

function onError(error) {
  console.error("Storage error:", error);
}

function getStorage(key) {
  return new Promise((resolve, reject) => {
    browser.storage.local.get(key, (result) => {
      if (browser.runtime.lastError) {
        reject(browser.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}

getStorage("idobject").then(loadOptions).catch(onError);


/* ------------------ Aggregate Mouse and Key Statistics ---------------------- */
let mouseStats = {
  clicks: 0,
  moveDistance: 0,
  lastX: null,
  lastY: null
};
document.addEventListener("mousedown", () => {
  mouseStats.clicks++;
});
document.addEventListener("mousemove", (event) => {
  if (mouseStats.lastX !== null) {
    const dx = event.clientX - mouseStats.lastX;
    const dy = event.clientY - mouseStats.lastY;

    mouseStats.moveDistance += Math.sqrt(dx * dx + dy * dy);
  }
  mouseStats.lastX = event.clientX;
  mouseStats.lastY = event.clientY;
});
setInterval(() => {
  if (mouseStats.clicks === 0 && mouseStats.moveDistance === 0) return;
  saveData({ timestamp: new Date().toTimeString().split(" ")[0], id: uniqueKey, type: "mouse", 
         clicks: mouseStats.clicks, moveDistance: Math.floor(mouseStats.moveDistance) });
  // reset after saving
  mouseStats.clicks = 0; mouseStats.moveDistance = 0;
}, 5000);

document.addEventListener("keydown", (e) => {
  saveData({
    id: uniqueKey,
    type: "key", key: e.key,
    code: e.code,
    timestamp: new Date().toTimeString().split(" ")[0]
  });
});


/* ---------------------------------------------------------------------------------------
   MISSION DETAILS OBSERVER
------------------------------------------------------------------------------------------ */

const processedMissions = new WeakSet();

function extractMission(root, type) {
  try {
    // mission text (more robust than style matching)
    let missiontext = "";
    const textCandidate = root.querySelector("div");
    if (textCandidate) {
      missiontext = textCandidate.innerText || "";
    }
    // cars
    const car_list = [];
    root.querySelectorAll(".patient_row .log_car_type").forEach((el) => {
      car_list.push({ id: el.getAttribute("data-car"), 
                      name: el.innerText, type: el.classList[1] || "" });
    });
    // forces
    const forcesdict = { RTW: 0, KTW: 0, NEF: 0 };
    root.querySelectorAll(".patients .required_forces").forEach((el) => {
      const txt = el.innerText;
      if (txt.includes("NEF")) forcesdict.NEF++;
      if (txt.includes("RTW")) forcesdict.RTW++;
      if (txt.includes("KTW")) forcesdict.KTW++;
    });

/*<div class="patient_row">       <div class="status_row status_2">         <div class="status">2</div>     </div>   <span class="log_car_type log_car_type_ktw car_name" style="" data-car="2182">13/85-1</span>    </div>*/

    // clock
    const clock = document.querySelector("#clock")?.textContent || "";
    // mission type label
    const missiontype = root.querySelector(".type")?.textContent || "";
    return {  timestamp: new Date().toTimeString().split(" ")[0], id: uniqueKey, 
              type, missiontext, assigned_cars: car_list, 
              requested_forces: forcesdict, ingame_time: clock, mission_type: missiontype };
  } catch (e) {
    console.warn("Failed to parse mission:", e);
    return null;
  }
}

const missionObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      // find mission nodes inside this change
      const missionNodes = node.matches?.("#missiontab_0 > div, #missiontab_1 > div, #missiontab_2 > div")
        ? [node]
        : node.querySelectorAll?.("#missiontab_0 > div, #missiontab_1 > div, #missiontab_2 > div") || [];
      for (const missionNode of missionNodes) {
        if (processedMissions.has(missionNode)) continue;
        processedMissions.add(missionNode);
        // detect type based on parent tab
        let type = null;
        if (missionNode.closest("#missiontab_0")) type = "notfall";
        else if (missionNode.closest("#missiontab_1")) type = "krankentransport";
        else if (missionNode.closest("#missiontab_2")) type = "vorgeplant";
        if (!type) continue;
        const data = extractMission(missionNode, type);
        if (data) saveData(data);
      }
    }
  }
});

function startObserver() {
  const container = document.querySelector("#missionlist");
  if (!container) {
    setTimeout(startObserver, 500);
    return;
  }
  missionObserver.observe(container, {
    childList: true,
    subtree: true
  });
  console.log("Mission observer started");
}

startObserver();



/* ---------------------------------------------------------------------------------------
   INTERACTION OBSERVER
------------------------------------------------------------------------------------------ */

const processedLogs = new WeakSet();

function parseLogEntry(node) {
  try {
    // avoid re-processing
    if (processedLogs.has(node)) return null;
    processedLogs.add(node);
    const text = node.innerText || "";
    // timestamp (usually first column)
    const time = node.querySelector("span")?.textContent || "";
    ////////  CASE 1: Sprechaufforderung  //////////////////////////
    if (text.includes("Sprechaufforderung")) {
      const carEl = node.querySelector("[data-car]");
      return {  timestamp: new Date().toTimeString().split(" ")[0], 
        id: uniqueKey, type: "call_request", time,
        caller: {
          carid: carEl?.getAttribute("data-car") || "",
          carname: carEl?.textContent || ""
        }
      };
    }
    ////////  CASE 2: verstanden. //////////////////////////////////
    if (text.toLowerCase().includes("verstanden")) {
      const message = node.querySelector("div")?.innerText || text;
      return { id: uniqueKey, type: "acknowledgement", time, message };
    }
    return null;
  } catch (e) {
    console.warn("Failed to parse log entry:", e);
    return null;
  }
}

const interactionObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue; // only elements
      // direct match OR nested entries
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
  interactionObserver.observe(container, {
    childList: true,
    subtree: true
  });
  console.log("Interaction observer started");
}

startInteractionObserver();


/* ---------------------------------------------------------------------------------------
   PARSE SINGLE DISPO ENTRY / KARTE ZEIGEN
------------------------------------------------------------------------------------------ */
// User clicked "Einen Neuen Einsatz ..."
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const entry = btn.closest(".logitem");
  // fallback-safe extraction
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
  saveData({ timestamp: new Date().toTimeString().split(" ")[0], ingame_time: time, 
    id: uniqueKey,
    action,    
    message
  });
});


/* ---------------------------------------------------------------------------------------
   AGGREGATE MISSION OVERVIEW
------------------------------------------------------------------------------------------ */

let missionDirty = true;
let lastSnapshot = null;

function buildMissionSnapshot() {
  const rtw = {};
  document.querySelectorAll('#missiontab_0_title > div > span')
    .forEach(div => rtw[div.title] = div.textContent);
  const ktw = {};
  document.querySelectorAll('#missiontab_1_title > div > span')
    .forEach(div => ktw[div.title] = div.textContent);
  const vor = {};
  document.querySelectorAll('#missiontab_2_title > div > span')
    .forEach(div => vor[div.title] = div.textContent);
  return { einsaetze: rtw, krankentransport: ktw, vorbestellungen: vor };
}

const missionsObserver = new MutationObserver(() => { missionDirty = true; });

missionsObserver.observe(document.querySelector("#missionlist"), {
  childList: true,
  subtree: true
});

setInterval(() => {
  if (!missionDirty) return;
  missionDirty = false;
  const snapshot = buildMissionSnapshot();
  // optional: skip if nothing changed
  const changed = JSON.stringify(snapshot) !== JSON.stringify(lastSnapshot);
  if (!changed) return;
  lastSnapshot = snapshot;
  saveData({ timestamp: new Date().toTimeString().split(" ")[0], id: uniqueKey, 
             type: "mission_overview", data: snapshot });
}, 10000);  // every 10 secs

