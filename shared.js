// Helpers shared by the extension pages (leaderboard.html, options.html)

/**
 * Zero-dependency pure JS PKZip Generator (stored, no compression)
 */
function createZipArchive(files) {
  const enc = new TextEncoder();
  const fileEntries = [];
  let offset = 0;

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    crcTable[i] = c >>> 0;
  }

  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const parts = [];

  files.forEach((f) => {
    const nameBytes = enc.encode(f.name);
    const dataBytes = typeof f.content === 'string' ? enc.encode(f.content) : new Uint8Array(f.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;
    const localHeaderOffset = offset;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    parts.push(localHeader);
    parts.push(dataBytes);

    offset += localHeader.length + dataBytes.length;

    fileEntries.push({
      nameBytes,
      crc,
      size,
      localHeaderOffset
    });
  });

  const centralDirStart = offset;
  let centralDirSize = 0;

  fileEntries.forEach((f) => {
    const cdHeader = new Uint8Array(46 + f.nameBytes.length);
    const view = new DataView(cdHeader.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, f.crc, true);
    view.setUint32(20, f.size, true);
    view.setUint32(24, f.size, true);
    view.setUint16(28, f.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, f.localHeaderOffset, true);
    cdHeader.set(f.nameBytes, 46);

    parts.push(cdHeader);
    offset += cdHeader.length;
    centralDirSize += cdHeader.length;
  });

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, fileEntries.length, true);
  eocdView.setUint16(10, fileEntries.length, true);
  eocdView.setUint32(12, centralDirSize, true);
  eocdView.setUint32(16, centralDirStart, true);
  eocdView.setUint16(20, 0, true);

  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Groups raw log entries into recorded game sessions, in order of first appearance.
 * New entries carry a unique `sid` per game run; older logs only have the participant id.
 */
function groupLogsBySession(logs) {
  const sessions = new Map();
  logs.forEach((entry) => {
    const id = String(entry.uid || entry.id || entry.participant || '1');
    const key = entry.sid ? `sid:${entry.sid}` : `id:${id}`;
    let session = sessions.get(key);
    if (!session) {
      session = { key, sid: entry.sid || null, id, name: null, entries: [] };
      sessions.set(key, session);
    }
    if (entry.uname || entry.username) {
      session.name = entry.uname || entry.username;
    }
    session.entries.push(entry);
  });
  return [...sessions.values()];
}

// One JSON file per session plus the combined raw log
function buildSessionZipFiles(logs, prefix) {
  const files = groupLogsBySession(logs).map((s, i) => ({
    name: `${prefix}_session_${String(i + 1).padStart(2, '0')}_id${s.id}_${(s.name || 'Teilnehmer').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
    content: JSON.stringify(s.entries, null, 2)
  }));
  files.push({
    name: `${prefix}_telemetry_all_combined.json`,
    content: JSON.stringify(logs, null, 2)
  });
  return files;
}

// Sends a log mutation to the background worker (appendLogs / removeLogs / clearLogs)
function sendLogCommand(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!res?.ok) {
        reject(new Error(res?.error || 'Speichern fehlgeschlagen'));
      } else {
        resolve(res);
      }
    });
  });
}
