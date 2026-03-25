/**
 * GOOGLE APPS SCRIPT — Harassment Swipe Game Data Collector
 *
 * SETUP INSTRUCTIONS (one-time):
 *
 * 1. Go to https://sheets.google.com and create a new spreadsheet.
 *    Name it something like "Swipe Game Responses".
 *
 * 2. In the spreadsheet, go to Extensions > Apps Script.
 *
 * 3. Delete the default code and paste THIS entire file into the editor.
 *
 * 4. Click Save (floppy disk icon), then click Deploy > New deployment.
 *
 * 5. Click the gear icon next to "Type" and select "Web app".
 *    - Description: Swipe Game Collector
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    Click Deploy, then Authorize access when prompted.
 *
 * 6. Copy the Web app URL shown after deployment.
 *
 * 7. Open js/app.js and paste the URL as the value of SHEETS_URL
 *    at the top of the file.
 *
 * REDEPLOYMENT (after updating this script):
 *   Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
 *   The URL stays the same.
 *
 * MIGRATION from previous version:
 *   The Responses sheet column layout has changed. Before deploying,
 *   rename the existing "Responses" tab to "Responses_old" in Google Sheets.
 *   Apps Script will auto-create a fresh "Responses" tab with the new schema.
 *
 * Sheets auto-created:
 *   "Responses"       — one row per session, progressively filled
 *   "Scenario Results" — one row per card swipe, linked by Session ID
 *
 * Responses columns:
 *   Session ID | Timestamp | Language | Status |
 *   Confidence Pre (1-5) | Training Clicked |
 *   Total Scenarios | Correct | Incorrect | Intervention Scenarios | Cards Completed |
 *   Age | Gender | City | Confidence Post (1-5)
 *
 * Status values:  "In Progress" (game started)  →  "Completed" (all cards swiped)
 * Rows with Status = "In Progress" are abandoned sessions.
 */

// ── Column index constants (1-based, matching Responses sheet) ──────────────
const COL_SESSION_ID   = 1;
const COL_TIMESTAMP    = 2;
const COL_LANGUAGE     = 3;
const COL_STATUS       = 4;
const COL_CONF_PRE     = 5;
const COL_TRAINING     = 6;
const COL_TOTAL        = 7;
const COL_CORRECT      = 8;
const COL_INCORRECT    = 9;
const COL_INTERVENTION = 10;
const COL_CARDS        = 11;
const COL_AGE          = 12;
const COL_GENDER       = 13;
const COL_CITY         = 14;
const COL_CONF_POST    = 15;

// ── Entry point ──────────────────────────────────────────────────────────────

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialise concurrent requests — prevents conflict sheets
  try {
    const ss   = SpreadsheetApp.getActiveSpreadsheet();
    const data = JSON.parse(e.postData.contents);

    switch (data.type) {
      case 'session_start':          logSessionStart(ss, data);          break;
      case 'session_complete':       logSessionComplete(ss, data);       break;
      case 'session_demographics':   logSessionDemographics(ss, data);   break;
      case 'session_confidence_post':logSessionConfidencePost(ss, data); break;
      case 'session_abandon':        logSessionAbandon(ss, data);        break;
      case 'training_update':        logTrainingUpdate(ss, data);        break;
      case 'scenario_result':        logScenarioResult(ss, data);        break;
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function getOrCreateResponsesSheet(ss) {
  let sheet = ss.getSheetByName('Responses');
  if (!sheet) {
    sheet = ss.insertSheet('Responses');
    sheet.appendRow([
      'Session ID', 'Timestamp', 'Language', 'Status',
      'Confidence Pre (1-5)', 'Training Clicked',
      'Total Scenarios', 'Correct', 'Incorrect', 'Intervention Scenarios', 'Cards Completed',
      'Age', 'Gender', 'City', 'Confidence Post (1-5)'
    ]);
    sheet.getRange(1, 1, 1, 15).setFontWeight('bold');
  }
  return sheet;
}

/** Returns the 1-based row number matching sessionId, or -1 if not found. */
function findRowBySessionId(sheet, sessionId) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(sessionId)) return i + 1;
  }
  return -1;
}

// ── Session lifecycle writers ────────────────────────────────────────────────

/** Called when the game starts — creates the row with status "In Progress". */
function logSessionStart(ss, data) {
  const sheet = getOrCreateResponsesSheet(ss);
  sheet.appendRow([
    data.sessionId  || '',
    data.timestamp  || new Date().toISOString(),
    data.language   || '',
    'In Progress',
    data.confidence || '',
    'FALSE',
    '', '', '', '', '', '', '', '', ''
  ]);
}

/** Called when all cards are swiped — fills in scores and sets status "Completed". */
function logSessionComplete(ss, data) {
  const sheet = getOrCreateResponsesSheet(ss);
  const row   = findRowBySessionId(sheet, data.sessionId);
  if (row === -1) return;
  sheet.getRange(row, COL_STATUS).setValue('Completed');
  sheet.getRange(row, COL_TOTAL).setValue(data.total        || 0);
  sheet.getRange(row, COL_CORRECT).setValue(data.correct     || 0);
  sheet.getRange(row, COL_INCORRECT).setValue(data.incorrect   || 0);
  sheet.getRange(row, COL_INTERVENTION).setNumberFormat('@').setValue(data.interventionScenarios || '');
  sheet.getRange(row, COL_CARDS).setValue(data.cardsCompleted || 0);
}

/** Called if/when user submits the end-screen demographics form. */
function logSessionDemographics(ss, data) {
  const sheet = ss.getSheetByName('Responses');
  if (!sheet) return;
  const row = findRowBySessionId(sheet, data.sessionId);
  if (row === -1) return;
  sheet.getRange(row, COL_AGE).setValue(data.age    || '');
  sheet.getRange(row, COL_GENDER).setValue(data.gender || '');
  sheet.getRange(row, COL_CITY).setValue(data.city   || '');
}

/** Called immediately when user selects the post-game confidence rating. */
function logSessionConfidencePost(ss, data) {
  const sheet = ss.getSheetByName('Responses');
  if (!sheet) return;
  const row = findRowBySessionId(sheet, data.sessionId);
  if (row === -1) return;
  sheet.getRange(row, COL_CONF_POST).setValue(data.confidencePost || '');
}

/** Called via beforeunload if user closes the page before finishing the game. */
function logSessionAbandon(ss, data) {
  const sheet = ss.getSheetByName('Responses');
  if (!sheet) return;
  const row = findRowBySessionId(sheet, data.sessionId);
  if (row === -1) return;

  sheet.getRange(row, COL_STATUS).setValue('Abandoned');
  sheet.getRange(row, COL_TOTAL).setValue(data.total        || 0);
  sheet.getRange(row, COL_CORRECT).setValue(data.correct     || 0);
  sheet.getRange(row, COL_INCORRECT).setValue(data.incorrect   || 0);
  sheet.getRange(row, COL_INTERVENTION).setNumberFormat('@').setValue(data.interventionScenarios || '');
  sheet.getRange(row, COL_CARDS).setValue(data.cardsCompleted || 0);

  // Write partial scenario results (bundled in the same keepalive payload)
  if (Array.isArray(data.scenarioResults) && data.scenarioResults.length > 0) {
    const ts = new Date().toISOString();
    data.scenarioResults.forEach(r => {
      logScenarioResult(ss, {
        sessionId:      data.sessionId,
        timestamp:      ts,
        id:             r.id,
        harassmentType: r.harassmentType,
        subtype:        r.subtype,
        correctSwipe:   r.correctSwipe,
        userSwipe:      r.userSwipe,
        correct:        r.correct,
      });
    });
  }
}

/** Called when user clicks any "Join 5D Training" link — flips Training Clicked to TRUE. */
function logTrainingUpdate(ss, data) {
  const sheet = ss.getSheetByName('Responses');
  if (!sheet) return;
  const row = findRowBySessionId(sheet, data.sessionId);
  if (row === -1) return;
  sheet.getRange(row, COL_TRAINING).setValue('TRUE');
}

// ── Scenario Results sheet ───────────────────────────────────────────────────

/** Called once per card swipe — appends a row to the Scenario Results sheet. */
function logScenarioResult(ss, data) {
  let sheet = ss.getSheetByName('Scenario Results');
  if (!sheet) {
    sheet = ss.insertSheet('Scenario Results');
    sheet.appendRow([
      'Session ID', 'Timestamp', 'Scenario ID',
      'Harassment Type', 'Subtype',
      'Correct Swipe', 'User Swipe', 'Correct'
    ]);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }

  sheet.appendRow([
    data.sessionId      || '',
    data.timestamp      || new Date().toISOString(),
    data.id             || '',
    data.harassmentType || '',
    data.subtype        || '',
    data.correctSwipe   || '',
    data.userSwipe      || '',
    data.correct        ? 'TRUE' : 'FALSE',
  ]);
}
