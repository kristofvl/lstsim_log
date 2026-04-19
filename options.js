const browser = window.browser || window.chrome;

function exportDataToFile(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lstsim_telemetry_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("export-data").addEventListener("click", () => {
  browser.storage.local.get("logs").then((res) => {
    exportDataToFile(res.logs || []);
  });
});
document.getElementById("export-clear").addEventListener("click", () => {
  browser.storage.local.get("logs").then((res) => {
    const data = res.logs || [];

    exportDataToFile(data);

    browser.storage.local.set({ logs: [] });
  });
});


function onError(error) {
  console.log(error)
}
function setItem() {
  console.log("ok")
}

function loadOptions(item) {
  if (item && item.idobject && item.idobject.id) {
    document.querySelector("#managed-id").innerText = item.idobject.id;
  } else {
    document.querySelector("#managed-id").innerText = "not set";
  }
}

function saveOptions(e) {
    let idobject = {
        id: document.querySelector("#id").value
    }
    browser.storage.local.set({idobject}).then(setItem, onError);
    e.preventDefault();
}

function restoreOptions() {
    browser.storage.local.get("idobject").then(loadOptions, onError);
}
function changeId(changes, area){
    alert(area);
    let changedItems = Object.keys(changes);
    for (let item of changedItems) {
        alert(item);
        alert(changes[item].newValue);
    }
}
browser.storage.onChanged.addListener(changeId);
document.addEventListener('DOMContentLoaded', restoreOptions);
document.querySelector("form").addEventListener("submit", saveOptions);