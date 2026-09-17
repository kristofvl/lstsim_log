/**
 * Leitstellen-Simulator: RettMobil Rangliste
 * Computes per-session metrics and points from the recorded telemetry.
 * Any missing or unmeasured data is strictly shown as a dash ('–').
 * Requires shared.js (createZipArchive, downloadBlob, groupLogsBySession, buildSessionZipFiles, sendLogCommand)
 */

document.addEventListener('DOMContentLoaded', () => {
  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  // Call events closer together than this (ring, accept, caller statement) count as one call
  const CALL_MERGE_WINDOW_SEC = 20;
  // A call counts as answered when an alarm follows within this time
  const MAX_RESPONSE_SEC = 300;

  // Convert time string (HH:MM:SS or HH:MM) or number to seconds
  function parseTimeToSeconds(ts) {
    if (ts === null || ts === undefined) return null;
    if (typeof ts === 'number') return ts;
    if (typeof ts !== 'string') return null;

    const parts = ts.trim().split(':').map(Number);
    if (parts.length === 3 && !parts.some(isNaN)) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2 && !parts.some(isNaN)) {
      return parts[0] * 3600 + parts[1] * 60;
    }
    const num = parseFloat(ts);
    return isNaN(num) ? null : num;
  }

  // Adds a continuous `_sec` timeline. Entries are stored in chronological order,
  // so a backwards jump of more than 12 hours is a midnight rollover.
  function toTimeline(entries) {
    const timeline = [];
    let dayOffset = 0;
    let prevSec = null;
    entries.forEach((e) => {
      const sec = parseTimeToSeconds(e.timestamp || e.ingame_time || e.time);
      if (sec === null) return;
      if (prevSec !== null && sec + dayOffset < prevSec - 43200) dayOffset += 86400;
      prevSec = sec + dayOffset;
      timeline.push({ ...e, _sec: prevSec });
    });
    return timeline.sort((a, b) => a._sec - b._sec);
  }

  /**
   * Current logs record each ring (`call_incoming`). A call counts as unanswered from the moment
   * it rings until it is handled: an alarm is sent for it, or the dispatcher hangs up or forwards
   * the caller (not every call needs a response). An alarm belongs to the most recently accepted
   * call that is still open; follow-up alarms without an open call don't answer other calls.
   * Only alarms contribute a reaction time. `pickupRts` measures from picking up the call instead of
   * the ring, which matches reaction times from the earlier data collection.
   */
  function pairRingsWithAlarms(evList) {
    const calls = [];
    const openAccepted = [];
    const rts = [];
    const pickupRts = [];
    const hasAccepts = evList.some((e) => e.action === 'phone_accept');

    const closeCall = (call) => {
      call.answered = true;
      const idx = openAccepted.indexOf(call);
      if (idx !== -1) openAccepted.splice(idx, 1);
    };

    evList.forEach((e) => {
      if (e.type === 'call_incoming') {
        calls.push({ ring: e, accepted: false, acceptSec: null, answered: false, messageTime: null });
      } else if (e.type === 'call_message') {
        // The caller's statement follows the accept; its log item holds the hang-up/forward buttons
        const call = [...openAccepted].reverse().find((c) => c.messageTime === null);
        if (call) call.messageTime = e.time;
      } else if (e.action === 'hangup' || e.action === 'call_forward') {
        // The click carries the in-game time of the caller's message it belongs to
        const call = calls.find((c) => e.ingame_time && c.messageTime === e.ingame_time)
          || openAccepted[openAccepted.length - 1];
        if (call && !call.answered) closeCall(call);
      } else if (e.action === 'phone_accept') {
        // The accept click happens on the ring's log item, so both carry its in-game time
        const call = calls.find((c) => !c.accepted && e.ingame_time && c.ring.time === e.ingame_time)
          || calls.find((c) => !c.accepted && !c.answered);
        if (call) {
          call.accepted = true;
          call.acceptSec = e._sec;
          openAccepted.push(call);
        }
      } else if (isDispatchEvent(e)) {
        const inWindow = (c) => !c.answered && e._sec - c.ring._sec <= MAX_RESPONSE_SEC;
        let call = null;
        while (openAccepted.length > 0 && !call) {
          const candidate = openAccepted.pop();
          if (inWindow(candidate)) call = candidate;
        }
        if (!call && !hasAccepts) {
          call = [...calls].reverse().find(inWindow) || null;
        }
        if (call) {
          closeCall(call);
          rts.push(Math.max(1, e._sec - call.ring._sec));
          if (call.acceptSec !== null) pickupRts.push(Math.max(1, e._sec - call.acceptSec));
        }
      }
    });

    return { totalCalls: calls.length, answered: calls.filter((c) => c.answered).length, rts, pickupRts };
  }

  // Older logs without ring events: calls are inferred from accept clicks and caller messages
  function pairLegacyCalls(evList) {
    const isCallEvent = (e) => e.type === 'call_message' ||
      e.action === 'phone_accept' ||
      (!e.type && e.action === 'unknown' && typeof e.message === 'string' && e.message.trim().length > 10);

    const calls = [];
    let callStartSec = -Infinity;
    evList.filter(isCallEvent).forEach((c) => {
      if (c._sec - callStartSec >= CALL_MERGE_WINDOW_SEC) {
        calls.push(c);
        callStartSec = c._sec;
      }
    });

    // Each call is paired with the next unused alarm within MAX_RESPONSE_SEC
    const dispatches = evList.filter(isDispatchEvent);
    const rts = [];
    const usedDispatches = new Set();
    calls.forEach((call) => {
      const idx = dispatches.findIndex((d, i) => (
        !usedDispatches.has(i) && d._sec >= call._sec && d._sec - call._sec <= MAX_RESPONSE_SEC
      ));
      if (idx !== -1) {
        usedDispatches.add(idx);
        rts.push(Math.max(1, dispatches[idx]._sec - call._sec));
      }
    });

    // Legacy calls already start at the pickup (or the caller's message)
    return { totalCalls: calls.length, answered: rts.length, rts, pickupRts: rts };
  }

  // Only real alarms count as dispatches (radio acknowledgements are not missions)
  function isDispatchEvent(e) {
    return typeof e.action === 'string' && e.action.includes('alarm');
  }

  const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeSessionMetrics(session) {
    const evList = toTimeline(session.entries);

    const dispatches = evList.filter(isDispatchEvent);

    // Reaction time = ring (or inferred call) until its alarm; unhandled calls are unanswered
    const { totalCalls, answered, rts, pickupRts } = evList.some((e) => e.type === 'call_incoming')
      ? pairRingsWithAlarms(evList)
      : pairLegacyCalls(evList);
    // No calls at all means "no measurement" (null / '–'), NOT 100%
    const answerRate = totalCalls > 0 ? answered / totalCalls : null;
    const medianRt = rts.length > 0 ? median(rts) : null;
    const meanRt = rts.length > 0 ? average(rts) : null;

    const keys = evList.filter((e) => e.type === 'key');
    const isCorrectionKey = (k) => ['Backspace', 'Delete'].includes(k.key) || ['Backspace', 'Delete'].includes(k.code);
    const backspaces = keys.filter(isCorrectionKey).length;
    const bpRatio = keys.length > 0 ? backspaces / keys.length : null;

    const mouseTotal = evList
      .filter((e) => e.type === 'mouse')
      .reduce((sum, m) => sum + (m.moveDistance || 0), 0);

    const rtBonus = medianRt !== null ? Math.max(0, 100 - medianRt) * 25 : 0;
    const bpBonus = bpRatio !== null ? Math.max(0, 1 - bpRatio) * 1500 : 0;
    const ansPoints = answerRate !== null ? Math.round(answerRate * 2500) : 0;
    const missionPoints = (dispatches.length * 300) + (answered * 120);

    return {
      id: session.id,
      name: session.name || `Teilnehmer ${session.id}`,
      dispatches: dispatches.length,
      totalCalls,
      answered,
      unanswered: totalCalls - answered,
      answerRate,
      medianRt,
      meanRt,
      // Pickup-to-alarm (seconds), comparable with reaction times from the earlier data collection
      medianPickupRt: pickupRts.length > 0 ? median(pickupRts) : null,
      totalKeys: keys.length,
      backspaces,
      bpRatio,
      mouseTotal,
      points: Math.max(0, Math.round(missionPoints + ansPoints + rtBonus + bpBonus))
    };
  }

  /**
   * Process raw logs and compute the leaderboard (one row per recorded session)
   */
  function processRettMobilLogs(rawLogs, current = {}) {
    if (!Array.isArray(rawLogs) || rawLogs.length === 0) {
      return { leaderboard: [], overview: null, lastSession: null };
    }

    const participants = groupLogsBySession(rawLogs).map((s) => ({
      ...computeSessionMetrics(s),
      isCurrent: current.sessionId
        ? s.sid === current.sessionId
        : (!s.sid && s.id === String(current.userid))
    }));
    // Sessions are in recording order, so the last one is the most recent run
    const lastSession = participants.find((p) => p.isCurrent) || participants[participants.length - 1];

    participants.sort((a, b) => b.points - a.points);
    participants.forEach((p, idx) => {
      p.rank = idx + 1;
      p.isMedal = idx === 0;
      p.isTopTier = idx < 3;
    });

    const validValues = (key) => participants.map((p) => p[key]).filter((v) => v !== null && !isNaN(v));
    const formatAverage = (values, factor, unit) => (
      values.length > 0 ? `${(average(values) * factor).toFixed(1)}${unit}` : '–'
    );

    const overview = {
      totalMissions: `${participants.reduce((sum, p) => sum + p.dispatches, 0).toLocaleString('de-DE')} gesamt`,
      avgResponse: formatAverage(validValues('medianRt'), 1, 's'),
      avgAnswerRate: formatAverage(validValues('answerRate'), 100, '%'),
      avgBpRate: formatAverage(validValues('bpRatio'), 100, '%'),
      topDispatcher: participants[0].name
    };

    return { leaderboard: participants, overview, lastSession };
  }

  const formatPoints = (points) => points.toLocaleString('de-DE');
  const formatPercent = (ratio) => (ratio !== null ? `${(ratio * 100).toFixed(1)}%` : '–');

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderLeaderboard(data) {
    const tbody = document.getElementById('leaderboard-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (data.length === 0) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      tr.innerHTML = `
        <td colspan="7" class="empty-state-cell">
          <div class="empty-state-wrap">
            <span class="material-symbols-outlined text-muted" style="font-size: 42px;">cloud_sync</span>
            <div class="empty-text">Noch keine Telemetriedaten erfasst</div>
            <div class="empty-sub">
              Spiele eine Leitstelle auf <strong>lstsim.de</strong> oder nutze oben <strong>"Importieren"</strong>, um deine echten Ergebnisse in die RettMobil Rangliste einzutragen.
            </div>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
      return;
    }

    data.forEach((entry) => {
      const tr = document.createElement('tr');
      tr.className = `data-table-row font-mono ${entry.isCurrent ? 'current-player-row' : ''}`;

      const addCell = (className, text) => {
        const td = document.createElement('td');
        td.className = className;
        td.textContent = text;
        tr.appendChild(td);
        return td;
      };

      // 1. Rang
      const tdRank = addCell('col-rank', '');
      tdRank.innerHTML = entry.isMedal
        ? `<div class="rank-badge-wrap">
            <span class="material-symbols-outlined medal-gold" title="1. Platz">military_tech</span>
          </div>`
        : `<span class="rank-number ${entry.rank <= 3 ? 'font-bold' : ''}">${entry.rank}</span>`;

      // 2. Teilnehmer / Name (user-provided, so never inserted as HTML)
      const tdName = addCell(`col-name ${entry.isTopTier ? 'top-rank-cell' : 'dispatcher-cell'}`, entry.name);
      if (entry.isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'you-badge';
        badge.textContent = '(Du)';
        tdName.append(' ', badge);
      }

      // 3.–6. Metriken
      addCell('col-missions', entry.dispatches);
      addCell('col-answer-rate', formatPercent(entry.answerRate));
      addCell('col-rt', entry.medianRt !== null ? `${entry.medianRt.toFixed(1)}s` : '–');
      addCell('col-bp', formatPercent(entry.bpRatio));

      // 7. Punkte
      addCell(`col-score ${entry.isTopTier ? 'score-top' : 'score-cell'}`, formatPoints(entry.points));

      tbody.appendChild(tr);
    });
  }

  function renderOverview(metrics) {
    setText('stat-total-missions', metrics ? metrics.totalMissions : '0 gesamt');
    setText('stat-avg-response', metrics ? metrics.avgResponse : '–');
    setText('stat-avg-answer-rate', metrics ? metrics.avgAnswerRate : '–');
    setText('stat-avg-bp-rate', metrics ? metrics.avgBpRate : '–');
    setText('stat-top-dispatcher', metrics ? metrics.topDispatcher : '–');
  }

  function renderRecap(recap) {
    setText('recap-dispatcher', recap ? recap.name : '–');
    setText('recap-score', recap ? `${formatPoints(recap.points)} Pkt` : '–');
    setText('recap-rank', recap ? `Platz ${recap.rank}` : '–');
    setText('recap-efficiency-text', recap ? formatPercent(recap.answerRate) : '–');

    const bar = document.getElementById('recap-efficiency-bar');
    if (bar) {
      const barPct = recap && recap.answerRate !== null ? Math.min(100, Math.max(0, recap.answerRate * 100)) : 0;
      bar.style.width = `${barPct}%`;
    }
  }

  function render(result) {
    renderLeaderboard(result.leaderboard);
    renderOverview(result.overview);
    renderRecap(result.lastSession);
  }

  function refreshDataFromStorage() {
    if (!hasStorage) {
      render(processRettMobilLogs([]));
      return;
    }
    chrome.storage.local.get(['logs', 'userid', 'sessionId'], (res) => {
      const rawLogs = res.logs || [];
      render(processRettMobilLogs(rawLogs, { userid: res.userid, sessionId: res.sessionId }));

      setText('data-source-info', rawLogs.length > 0
        ? `${rawLogs.length.toLocaleString('de-DE')} Events erfasst`
        : 'Warte auf Telemetrie...');
    });
  }

  // File import for real JSON logs (several files at once)
  const fileInput = document.getElementById('log-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      // Reset so the same files can be picked again
      e.target.value = '';
      if (files.length === 0) return;

      const importedLogs = [];
      const failed = [];
      for (const file of files) {
        let entries;
        try {
          entries = JSON.parse(await file.text());
        } catch (err) {
          failed.push(`${file.name}: kein gültiges JSON`);
          continue;
        }
        if (!Array.isArray(entries)) {
          failed.push(`${file.name}: keine Telemetrie-Liste (JSON-Array erwartet)`);
          continue;
        }

        // Legacy entries carry only `id`: name them after the file, and give each file its own
        // session so files that reuse the same id aren't merged
        const fileName = file.name.replace(/\.json$/i, '').trim() || file.name;
        entries
          .filter((entry) => entry && typeof entry === 'object')
          .forEach((entry) => importedLogs.push(
            entry.sid || entry.uname || entry.username
              ? entry
              : { ...entry, uname: fileName, sid: `legacy:${fileName}:${entry.id ?? ''}` }
          ));
      }

      if (failed.length > 0) {
        alert(`${failed.length} von ${files.length} Datei(en) nicht importiert:\n${failed.join('\n')}`);
      }
      if (importedLogs.length === 0) return;

      if (!hasStorage) {
        render(processRettMobilLogs(importedLogs));
        return;
      }
      try {
        await sendLogCommand({ type: 'appendLogs', entries: importedLogs });
      } catch (err) {
        alert(`Import fehlgeschlagen: ${err.message}`);
      }
    });
  }

  // Bulk Export: ZIP file with separate recordings
  const btnExportAll = document.getElementById('btn-export-all');
  if (btnExportAll) {
    btnExportAll.addEventListener('click', () => {
      if (!hasStorage) return;

      chrome.storage.local.get(['logs', 'legacyLogs', 'userid', 'sessionId'], (res) => {
        const logs = res.logs || [];
        const legacyLogs = res.legacyLogs || [];
        if (logs.length === 0 && legacyLogs.length === 0) {
          alert('Keine Telemetriedaten zum Exportieren vorhanden.');
          return;
        }

        const zipFiles = buildSessionZipFiles(logs, 'rettmobil');
        const computed = processRettMobilLogs(logs, { userid: res.userid, sessionId: res.sessionId });
        zipFiles.push({
          name: 'rettmobil_metrics_summary.json',
          content: JSON.stringify(computed, null, 2)
        });
        if (legacyLogs.length > 0) {
          // Original recording format, e.g. for viz.html
          zipFiles.push({
            name: 'rettmobil_telemetry_legacy_format.json',
            content: JSON.stringify(legacyLogs, null, 2)
          });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadBlob(createZipArchive(zipFiles), `rettmobil_bulk_export_${timestamp}.zip`);
      });
    });
  }

  // Delete All
  const btnDeleteAll = document.getElementById('btn-delete-all');
  if (btnDeleteAll) {
    btnDeleteAll.addEventListener('click', async () => {
      const confirmed = confirm(
        'Möchtest du wirklich alle aufgezeichneten Telemetriedaten und Ranglisten-Einträge unwiderruflich löschen?'
      );
      if (!confirmed || !hasStorage) return;

      try {
        await Promise.all([
          sendLogCommand({ type: 'clearLogs', key: 'logs' }),
          sendLogCommand({ type: 'clearLogs', key: 'legacyLogs' })
        ]);
      } catch (err) {
        alert(`Löschen fehlgeschlagen: ${err.message}`);
      }
    });
  }

  const btnRefresh = document.getElementById('btn-refresh-data');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', refreshDataFromStorage);
  }

  if (hasStorage && chrome.storage.onChanged) {
    // Logs change every ~500 ms during a game; coalesce bursts into one recompute
    let refreshTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(changes.logs || changes.userid || changes.sessionId)) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshDataFromStorage, 300);
    });
  }

  refreshDataFromStorage();
});
