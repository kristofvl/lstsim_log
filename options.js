const browser = window.browser || window.chrome;

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
  if (item && item.userid) {
    document.querySelector("#id").value = item.userid; // prefill input
  }
}

function restoreOptions() {
  getStorage(["username", "userid", "loggingActive"])
  .then((res) => { loadOptions(res); })
  .catch(onError);
}

document.addEventListener('DOMContentLoaded', restoreOptions);

