// Requires shared.js (createZipArchive, downloadBlob, buildSessionZipFiles, sendLogCommand)

function showStatus(msg) {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; }, 3500);
  }
}

function performBulkZipExport(andClear = false) {
  chrome.storage.local.get(['logs', 'legacyLogs'], async (res) => {
    const logs = res.logs || [];
    const legacyLogs = res.legacyLogs || [];
    if (logs.length === 0 && legacyLogs.length === 0) {
      alert('Keine Telemetriedaten vorhanden.');
      return;
    }

    const zipFiles = buildSessionZipFiles(logs, 'lstsim');
    if (legacyLogs.length > 0) {
      zipFiles.push({ name: 'lstsim_telemetry_legacy_format.json', content: JSON.stringify(legacyLogs, null, 2) });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(createZipArchive(zipFiles), `lstsim_telemetry_bulk_${timestamp}.zip`);

    if (!andClear) {
      showStatus('Bulk-Export abgeschlossen.');
      return;
    }
    try {
      // Only remove the exported entries; events recorded in the meantime are kept
      await Promise.all([
        sendLogCommand({ type: 'removeLogs', key: 'logs', count: logs.length }),
        sendLogCommand({ type: 'removeLogs', key: 'legacyLogs', count: legacyLogs.length })
      ]);
      showStatus('Daten exportiert und erfolgreich gelöscht.');
    } catch (err) {
      showStatus(`Löschen fehlgeschlagen: ${err.message}`);
    }
  });
}

// Same file name and layout as the original "Export + Clear" (one JSON array), without clearing
function performLegacyExport() {
  chrome.storage.local.get('legacyLogs', (res) => {
    const legacyLogs = res.legacyLogs || [];
    if (legacyLogs.length === 0) {
      alert('Keine Daten im alten Format vorhanden.');
      return;
    }
    const blob = new Blob([JSON.stringify(legacyLogs, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `lstsim_telemetry_${Date.now()}.json`);
    showStatus('Legacy-Export abgeschlossen.');
  });
}

document.getElementById('btn-save').addEventListener('click', () => {
  const idValue = document.getElementById('id').value.trim();
  const userid = parseInt(idValue, 10) || idValue || 1;
  const username = document.getElementById('username').value.trim() || `Disponent_${userid}`;

  chrome.storage.local.get(['userid', 'username'], (prev) => {
    const update = { userid, username };
    // A different participant gets a new session so their data isn't merged with the previous run
    if (String(prev.userid) !== String(userid) || prev.username !== username) {
      update.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    chrome.storage.local.set(update, () => {
      showStatus('Einstellungen gespeichert.');
    });
  });
});

document.getElementById('export-bulk').addEventListener('click', () => {
  performBulkZipExport(false);
});

document.getElementById('export-legacy').addEventListener('click', performLegacyExport);

document.getElementById('export-clear').addEventListener('click', () => {
  if (confirm('Möchtest du alle Telemetriedaten exportieren und den Speicher anschließend leeren?')) {
    performBulkZipExport(true);
  }
});

chrome.storage.local.get(['username', 'userid'], (res) => {
  if (res.userid) document.getElementById('id').value = res.userid;
  if (res.username) document.getElementById('username').value = res.username;
});
