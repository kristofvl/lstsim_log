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

function loadOptions(item) {
  if (item && item.username) {
    document.querySelector("#id").value = item.username; // prefill input
  }
}

function restoreOptions() {
  //browser.storage.local.get("idobject").then(loadOptions, onError);
  getStorage(["idobject", "username", "loggingActive"])
  .then((res) => {
    loadOptions(res); // keeps your existing logic
  })
  .catch(onError);
}

document.addEventListener('DOMContentLoaded', restoreOptions);

