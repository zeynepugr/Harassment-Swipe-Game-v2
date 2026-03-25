/**
 * Harassment Recognition Swipe Game — Fairspace
 * app.js — Game logic, card rendering, swipe interaction
 */

/* ============================================================
   SVG ICON HELPER
   References symbols defined in the HTML SVG sprite.
   ============================================================ */
function icon(id, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#icon-${id}"/></svg>`;
}

/* ============================================================
   CONFIG — paste your Google Apps Script URL here after setup
   ============================================================ */
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzGfIGJeear8O-IAWVX0-EYmwGonN-wupzliAqH7ufD2lGCcRrwH54Q1Jqhb0yaXdQj/exec';

/* ============================================================
   STATE
   ============================================================ */
let scenarios = [];
let currentIndex = 0;
let currentLang = 'nl';
let wtStep = 0;
let cardScene = null; // the .card-scene container created by renderDeck

// Survey + game performance data collected per session
let userData = { age: '', gender: '', city: '', confidence: '', confidencePost: '', sessionId: '', language: '' };
let scoreCorrect   = 0;
let scoreIncorrect = 0;
let scenarioResults    = [];  // {id, type, subtype, correctSwipe, userSwipe, correct}
let interventionClicks = [];  // scenario IDs where user opened the intervention tip
let gameDataSent     = false; // prevents double-sending session_complete
let demographicsSent = false; // prevents double-sending end-form demographics

/* ============================================================
   I18N LABELS
   ============================================================ */
const LABELS = {
  nl: {
    // correct feedback — keyed by correct swipe direction
    correct_right:   'Goed ingeschat!',
    correct_left:    'Goed herkend!',
    correct_down:    'Goed gevoel!',
    // incorrect feedback — keyed by correct_userswipe
    incorrect_right_left:  'Eigenlijk...',
    incorrect_right_down:  'Eigenlijk...',
    incorrect_left_right:  'Dit gaat te ver!',
    incorrect_left_down:   'Dit gaat te ver!',
    incorrect_down_left:   'Goed gevoel!',
    incorrect_down_right:  'Let op!',
    okay_type: 'Dit is oké ✓',
    next_card: 'Volgende kaart →',
    training:  'Verbeter je vaardigheden ↗',
    intervene: 'Hoe kan ik ingrijpen?',
    unsure_stamp: 'Weet niet',
    yes_stamp:    'Oké!',
    no_stamp:     'Niet oké!',
  },
  en: {
    // correct feedback — keyed by correct swipe direction
    correct_right:   'Good call!',
    correct_left:    'Well spotted!',
    correct_down:    'Good instinct!',
    // incorrect feedback — keyed by correct_userswipe
    incorrect_right_left:  'Actually...',
    incorrect_right_down:  'Actually...',
    incorrect_left_right:  'This crosses a line!',
    incorrect_left_down:   'This crosses a line!',
    incorrect_down_left:   'Good instinct!',
    incorrect_down_right:  'Watch out!',
    okay_type: 'This is okay ✓',
    next_card: 'Next card →',
    training:  'Level up your intervention skills ↗',
    intervene: 'How can I intervene?',
    unsure_stamp: 'Unsure',
    yes_stamp:    'Okay!',
    no_stamp:     'Not okay!',
  }
};

/* ============================================================
   DOM REFERENCES
   ============================================================ */
const screenIntro  = document.getElementById('screen-intro');
const screenGame   = document.getElementById('screen-game');
const screenEnd    = document.getElementById('screen-end');
const screenSurvey = document.getElementById('screen-survey');
const cardArea     = document.getElementById('card-area');
const actionBtns   = document.getElementById('action-buttons');
const progressFill = document.getElementById('progress-bar-fill');
const progressLabel = document.getElementById('progress-label');
const btnStart     = document.getElementById('btn-start');
const btnRestart   = document.getElementById('btn-restart');
const btnNo        = document.getElementById('btn-no');
const btnUnsure    = document.getElementById('btn-unsure');
const btnYes       = document.getElementById('btn-yes');

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Block scroll/pull-to-refresh only when touching the swipeable card front
  cardArea.addEventListener('touchstart', e => {
    if (e.target.closest('.card-front')) e.preventDefault();
  }, { passive: false });
  cardArea.addEventListener('touchmove', e => {
    if (e.target.closest('.card-front')) e.preventDefault();
  }, { passive: false });

  initLangToggles();
  loadCSV();
  btnStart.addEventListener('click', startGame);

  // Survey
  document.getElementById('survey-form').addEventListener('submit', onSurveySubmit);
  document.getElementById('btn-survey-skip').addEventListener('click', () => {
    userData = { age: '', gender: '', city: '', confidence: '', confidencePost: '', language: currentLang, sessionId: '' };
    scoreCorrect   = 0;
    scoreIncorrect = 0;
    beginGame();
  });
  document.getElementById('btn-end-training').addEventListener('click', trackTrainingClick);
  document.getElementById('end-form').addEventListener('submit', onEndFormSubmit);
  document.getElementById('btn-end-data-skip').addEventListener('click', submitEndData);
  btnRestart.addEventListener('click', () => { submitEndData(); restartGame(); });
  btnNo.addEventListener('click', () => handleButtonSwipe('left'));
  btnUnsure.addEventListener('click', () => handleButtonSwipe('down'));
  btnYes.addEventListener('click', () => handleButtonSwipe('right'));

  // Walkthrough navigation
  document.getElementById('btn-wt-next').addEventListener('click', onWtNext);
  document.getElementById('btn-wt-skip').addEventListener('click', showSurvey);
  document.querySelectorAll('.wt-dot').forEach(dot => {
    dot.addEventListener('click', () => setWtStep(parseInt(dot.dataset.step, 10)));
  });

  // Keyboard arrow keys
  document.addEventListener('keydown', onKeyDown);

  // Capture Confidence Post immediately when user selects a value (before form submit)
  document.querySelectorAll('[name="confidence-post"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!userData.sessionId) return;
      sendToSheets({
        type:           'session_confidence_post',
        sessionId:      userData.sessionId,
        confidencePost: radio.value,
      });
    });
  });

  // Record dropout: how many cards completed if user leaves mid-game
  window.addEventListener('beforeunload', () => {
    if (!userData.sessionId || gameDataSent) return;
    fetch(SHEETS_URL, {
      method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        type:                  'session_abandon',
        sessionId:             userData.sessionId,
        cardsCompleted:        currentIndex,
        total:                 scoreCorrect + scoreIncorrect,
        correct:               scoreCorrect,
        incorrect:             scoreIncorrect,
        interventionScenarios: interventionClicks.join(', '),
        scenarioResults:       scenarioResults,
      }),
    }).catch(() => {});
  });
});

/* ============================================================
   DATA LOADING
   Prefers scenarios.csv (when hosted on a server).
   Falls back to window.SCENARIOS_DATA (from scenarios-data.js)
   so the app works when opened directly as a file.
   ============================================================ */
function loadCSV() {
  // If inline data is available (file:// or no server), use it immediately
  if (window.SCENARIOS_DATA && window.SCENARIOS_DATA.length > 0) {
    scenarios = window.SCENARIOS_DATA;
    return;
  }

  // Otherwise fetch the CSV (requires a server / hosted environment)
  Papa.parse('data/scenarios.csv', {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      scenarios = results.data;
    },
    error: (err) => {
      console.error('CSV load error:', err);
    }
  });
}

/* ============================================================
   LANGUAGE
   ============================================================ */
function initLangToggles() {
  // Sync both toggle groups (intro + game)
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });

  // Restore from localStorage
  const saved = localStorage.getItem('fairspace_lang');
  if (saved) setLang(saved, false);
}

function setLang(lang, save = true) {
  currentLang = lang;
  if (save) localStorage.setItem('fairspace_lang', lang);

  // Update all toggle buttons
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  // Update all [data-nl] / [data-en] text nodes
  document.querySelectorAll('[data-nl]').forEach(el => {
    el.textContent = lang === 'nl' ? el.dataset.nl : el.dataset.en;
  });

  // Update city placeholders (works for both pre-game survey and end screen)
  document.querySelectorAll('[data-placeholder-nl]').forEach(el => {
    el.placeholder = lang === 'nl' ? el.dataset.placeholderNl : el.dataset.placeholderEn;
  });

  // Update action button aria-labels
  if (btnNo)     btnNo.setAttribute('aria-label',     lang === 'nl' ? 'Niet oké' : 'Not okay');
  if (btnUnsure) btnUnsure.setAttribute('aria-label', lang === 'nl' ? 'Weet niet' : 'Unsure');
  if (btnYes)    btnYes.setAttribute('aria-label',    lang === 'nl' ? 'Oké' : 'Okay');

  // Refresh walkthrough stamps if on walkthrough screen
  if (document.getElementById('screen-walkthrough').classList.contains('active')) {
    refreshWtStamps();
    setWtStep(wtStep); // re-labels the Next button
  }

  // Re-render active card content if game is running
  if (!screenGame.classList.contains('active')) return;
  updateCardLanguage();
}

function t(key) {
  return LABELS[currentLang][key] || LABELS.en[key] || key;
}

function scenarioText(s) {
  return currentLang === 'nl' ? s['Scenario (NL)'] : s['Scenario (EN)'];
}
function harassmentType(s) {
  return currentLang === 'nl' ? s['Harassment type (NL)'] : s['Harassment type (EN)'];
}
function harassmentSubtype(s) {
  return currentLang === 'nl' ? s['Harassment Subtype (NL)'] : s['Harassment Subtype (EN)'];
}
function explanation(s) {
  return currentLang === 'nl' ? s['Explanation (NL)'] : s['Explanation (EN)'];
}
function interventionTip(s) {
  return currentLang === 'nl' ? s['Intervention tip (NL)'] : s['Intervention tip (EN)'];
}

/* ============================================================
   SCREENS
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   SURVEY
   ============================================================ */
function showSurvey() {
  if (scenarios.length === 0) {
    alert(currentLang === 'nl'
      ? 'Scenario\'s kunnen niet worden geladen. Controleer of het CSV-bestand aanwezig is.'
      : 'Scenarios could not be loaded. Please check that the CSV file is present.');
    return;
  }
  showScreen('screen-survey');
}

function onSurveySubmit(e) {
  e.preventDefault();
  const form = e.target;
  const consent = form.querySelector('#survey-consent');
  if (!consent.checked) {
    consent.focus();
    return;
  }
  const confidence = form.querySelector('[name="confidence"]:checked');
  userData = {
    age:        '',
    gender:     '',
    city:       '',
    confidence: confidence ? confidence.value : '',
    language:   currentLang,
  };
  scoreCorrect   = 0;
  scoreIncorrect = 0;
  beginGame();
}

function sendToSheets(data) {
  if (!SHEETS_URL || SHEETS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_URL') return;
  fetch(SHEETS_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(data),
  }).catch(() => {}); // silent fail — never block the user
}

function trackTrainingClick() {
  if (!userData.sessionId) return; // game hasn't started yet
  sendToSheets({
    type:      'training_update',
    sessionId: userData.sessionId,
  });
}

function startGame() {
  currentIndex = 0;
  setWtStep(0);
  showScreen('screen-walkthrough');
}

function shuffleScenarios() {
  for (let i = scenarios.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [scenarios[i], scenarios[j]] = [scenarios[j], scenarios[i]];
  }
}

function beginGame() {
  userData.sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  gameDataSent     = false;
  demographicsSent = false;
  sendToSheets({
    type:       'session_start',
    sessionId:  userData.sessionId,
    timestamp:  new Date().toISOString(),
    language:   currentLang,
    confidence: userData.confidence || '',
  });
  shuffleScenarios();
  showScreen('screen-game');
  cardArea.innerHTML = '';
  renderDeck();
  updateProgress();
  actionBtns.classList.remove('hidden');
}

function restartGame() {
  currentIndex = 0;
  scoreCorrect          = 0;
  scoreIncorrect        = 0;
  scenarioResults       = [];
  interventionClicks    = [];
  userData.sessionId    = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  gameDataSent          = false;
  demographicsSent      = false;
  sendToSheets({
    type:       'session_start',
    sessionId:  userData.sessionId,
    timestamp:  new Date().toISOString(),
    language:   currentLang,
    confidence: userData.confidence || '',
  });
  shuffleScenarios();
  showScreen('screen-game');
  cardArea.innerHTML = '';
  renderDeck();
  updateProgress();
  actionBtns.classList.remove('hidden');
}

/* ============================================================
   WALKTHROUGH
   ============================================================ */
const WT_TOTAL = 3;

function setWtStep(step) {
  wtStep = step;

  // Counter
  document.getElementById('wt-counter').textContent = `${step + 1} / ${WT_TOTAL}`;

  // Show/hide step panels (use class, not display, so all panels stay in layout)
  for (let i = 0; i < WT_TOTAL; i++) {
    const el = document.getElementById(`wt-step-${i}`);
    if (el) el.classList.toggle('wt-step--active', i === step);
  }

  // Dots
  document.querySelectorAll('.wt-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === step);
  });

  // Next button label
  const isLast = step === WT_TOTAL - 1;
  const btnNext = document.getElementById('btn-wt-next');
  const nlLabel = isLast ? 'Begin met spelen!' : 'Volgende';
  const enLabel = isLast ? 'Start playing!' : 'Next';
  btnNext.dataset.nl = nlLabel;
  btnNext.dataset.en = enLabel;
  btnNext.textContent = currentLang === 'nl' ? nlLabel : enLabel;

  // Animate demo card — restart animation by forcing reflow
  const demo = document.getElementById('wt-demo-card');
  demo.className = 'wt-demo-card';
  void demo.offsetWidth; // reflow triggers animation restart
  demo.classList.add(['anim-right', 'anim-left', 'anim-down'][step]);

  // Update stamp text for current language
  refreshWtStamps();
}

function refreshWtStamps() {
  const r = document.getElementById('wt-stamp-right');
  const l = document.getElementById('wt-stamp-left');
  const d = document.getElementById('wt-stamp-down');
  if (r) r.textContent = t('yes_stamp');
  if (l) l.textContent = t('no_stamp');
  if (d) d.textContent = t('unsure_stamp');
}

function onWtNext() {
  if (wtStep < WT_TOTAL - 1) {
    setWtStep(wtStep + 1);
  } else {
    showSurvey();
  }
}

/* ============================================================
   KEYBOARD NAVIGATION
   ============================================================ */
function onKeyDown(e) {
  if (!screenGame.classList.contains('active')) return;
  const wrapper = getTopCardWrapper();
  if (!wrapper) return;

  const flipped = wrapper.querySelector('.card-flip.flipped');
  if (flipped) {
    if (e.key === ' ') { e.preventDefault(); advanceCard(); }
    return;
  }

  if (e.key === 'ArrowRight') { e.preventDefault(); handleButtonSwipe('right'); }
  else if (e.key === 'ArrowLeft')  { e.preventDefault(); handleButtonSwipe('left'); }
  else if (e.key === 'ArrowDown')  { e.preventDefault(); handleButtonSwipe('down'); }
}

/* ============================================================
   CARD RENDERING
   ============================================================ */
function renderDeck() {
  isCommitting = false;
  cardArea.innerHTML = '';
  cardScene = document.createElement('div');
  cardScene.className = 'card-scene';

  // Render up to 3 cards. Cards are appended furthest-back first so the
  // top/active card ends up as the LAST child (highest DOM order = front).
  const count = Math.min(2, scenarios.length - currentIndex);
  for (let i = count - 1; i >= 0; i--) {
    const idx = currentIndex + i;
    const card = buildCardWrapper(idx, i === 0);
    cardScene.appendChild(card);
  }
  cardArea.appendChild(cardScene);
}

function buildCardWrapper(dataIndex, isActive) {
  const s = scenarios[dataIndex];
  const wrapper = document.createElement('div');
  wrapper.className = 'card-wrapper';
  if (isActive) wrapper.classList.add('card-enter');
  wrapper.dataset.index = dataIndex;

  // The flip container
  const flip = document.createElement('div');
  flip.className = 'card-flip';

  // Front face
  const front = buildCardFront(s);
  flip.appendChild(front);

  // Single back face — populated with correct content at swipe time
  const back = document.createElement('div');
  back.className = 'card-face card-back card-back-face';
  flip.appendChild(back);

  wrapper.appendChild(flip);

  // Only attach drag events to the active (top) card
  if (isActive) {
    attachSwipeEvents(wrapper, flip);
  }

  return wrapper;
}

function buildCardFront(s) {
  const face = document.createElement('div');
  face.className = 'card-face card-front';

  // Illustration
  const illus = document.createElement('div');
  illus.className = 'card-illustration';
  const img = document.createElement('img');
  const filename = s['Illustration'] || '';
  img.src = filename ? `images/${filename}` : 'images/placeholder.svg';
  img.alt = '';
  img.onerror = () => { img.src = 'images/placeholder.svg'; };
  illus.appendChild(img);

  // Scenario text
  const scenDiv = document.createElement('div');
  scenDiv.className = 'card-scenario';
  const p = document.createElement('p');
  p.className = 'scenario-text';
  p.textContent = scenarioText(s);
  scenDiv.appendChild(p);

  // Drag stamps (hidden until drag)
  const stampYes    = stamp('stamp-yes',    t('yes_stamp'));
  const stampNo     = stamp('stamp-no',     t('no_stamp'));
  const stampUnsure = stamp('stamp-unsure', t('unsure_stamp'));

  // Tint overlay
  const tint = document.createElement('div');
  tint.className = 'card-tint';

  face.appendChild(illus);
  face.appendChild(scenDiv);
  face.appendChild(stampYes);
  face.appendChild(stampNo);
  face.appendChild(stampUnsure);
  face.appendChild(tint);

  return face;
}

function stamp(cls, text) {
  const el = document.createElement('div');
  el.className = `card-stamp ${cls}`;
  el.textContent = text;
  return el;
}

function populateCardBack(face, s, swipeDir) {
  face.innerHTML = '';

  const correctSwipe = (s['Correct Swipe'] || '').trim().toLowerCase();
  const isCorrect = swipeDir === correctSwipe;

  // Resolve feedback label from the 9-cell matrix
  let feedbackKey;
  if (isCorrect) {
    feedbackKey = `correct_${correctSwipe}`;
  } else {
    feedbackKey = `incorrect_${correctSwipe}_${swipeDir}`;
  }
  const bannerClass = (isCorrect && correctSwipe === 'down') || (!isCorrect && correctSwipe === 'down' && swipeDir === 'left')
    ? 'unsure'
    : isCorrect ? 'correct' : 'incorrect';

  // Feedback banner
  const banner = document.createElement('div');
  banner.className = `feedback-banner ${bannerClass}`;
  const bannerSpan = document.createElement('span');
  bannerSpan.className = 'feedback-text';
  bannerSpan.textContent = t(feedbackKey);
  banner.appendChild(bannerSpan);

  // Harassment type header
  const header = document.createElement('div');
  header.className = 'harassment-header';
  const typeEl = document.createElement('div');
  typeEl.className = 'harassment-type';
  const subtypeEl = document.createElement('div');
  subtypeEl.className = 'harassment-subtype';

  if (correctSwipe === 'right') {
    // Scenario is okay — no harassment type to display
    typeEl.className += ' okay-type';
    typeEl.textContent = t('okay_type');
    subtypeEl.textContent = '';
  } else {
    typeEl.textContent = harassmentType(s) || '—';
    subtypeEl.textContent = harassmentSubtype(s) || '';
  }
  header.appendChild(typeEl);
  if (subtypeEl.textContent) header.appendChild(subtypeEl);

  // Divider
  const divider = document.createElement('div');
  divider.className = 'card-divider';

  // Explanation
  const expl = document.createElement('div');
  expl.className = 'card-explanation';
  const explP = document.createElement('p');
  explP.className = 'explanation-text';
  explP.textContent = explanation(s) || '';
  expl.appendChild(explP);

  face.appendChild(banner);
  face.appendChild(header);
  face.appendChild(divider);
  face.appendChild(expl);

  // Intervention tip (only if data exists)
  const tip = interventionTip(s);
  const fiveD = (s['5D type'] || '').trim();
  if (tip || fiveD) {
    const section = buildInterventionSection(s);
    face.appendChild(section);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'card-back-actions';

  const btnNext = document.createElement('button');
  btnNext.className = 'btn-next-card next-card-btn';
  btnNext.textContent = t('next_card');
  btnNext.addEventListener('click', () => advanceCard());

  const btnTraining = document.createElement('a');
  btnTraining.href = 'https://fairspace.co/nl/doe-mee-met-5d/';
  btnTraining.target = '_blank';
  btnTraining.rel = 'noopener';
  btnTraining.className = 'btn-training-inline training-btn';
  btnTraining.textContent = t('training');
  btnTraining.addEventListener('click', trackTrainingClick);

  actions.appendChild(btnNext);
  actions.appendChild(btnTraining);
  face.appendChild(actions);
}

function buildInterventionSection(s) {
  const section = document.createElement('div');
  section.className = 'intervention-section';

  const toggle = document.createElement('button');
  toggle.className = 'intervention-toggle';
  toggle.innerHTML = `
    <span class="toggle-icon">${icon('shield', 'icon-shield')}</span>
    <span class="intervene-label">${t('intervene')}</span>
    <span class="toggle-arrow">${icon('chevron-down', 'icon-chevron')}</span>
  `;

  const content = document.createElement('div');
  content.className = 'intervention-content';

  const fiveD = (s['5D type'] || '').trim();
  if (fiveD) {
    const label = document.createElement('div');
    label.className = 'intervention-5d-label fived-label';
    label.textContent = fiveD;
    content.appendChild(label);
  }

  const tipP = document.createElement('p');
  tipP.className = 'intervention-tip-text';
  tipP.textContent = interventionTip(s) || '';
  content.appendChild(tipP);

  toggle.addEventListener('click', () => {
    const isOpen = content.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
    if (isOpen) interventionClicks.push(s['ID']);
  });

  section.appendChild(toggle);
  section.appendChild(content);
  return section;
}

/* ============================================================
   LANGUAGE REFRESH for rendered cards
   ============================================================ */
function updateCardLanguage() {
  const topWrapper = getTopCardWrapper();
  if (!topWrapper) return;
  const idx = parseInt(topWrapper.dataset.index, 10);
  const s = scenarios[idx];
  if (!s) return;

  // Front face text
  const scenText = topWrapper.querySelector('.scenario-text');
  if (scenText) scenText.textContent = scenarioText(s);

  // Stamps
  const stampY = topWrapper.querySelector('.stamp-yes');
  const stampN = topWrapper.querySelector('.stamp-no');
  const stampU = topWrapper.querySelector('.stamp-unsure');
  if (stampY) stampY.textContent = t('yes_stamp');
  if (stampN) stampN.textContent = t('no_stamp');
  if (stampU) stampU.textContent = t('unsure_stamp');

  // Back face — only re-populate if this card has already been swiped
  const swipeDir = topWrapper.dataset.swipeDir;
  if (swipeDir) {
    const back = topWrapper.querySelector('.card-back-face');
    if (back) populateCardBack(back, s, swipeDir);
  }
}

/* ============================================================
   SWIPE / DRAG INTERACTION
   ============================================================ */
const SWIPE_THRESHOLD = 60;   // px before swipe commits
const TILT_MAX = 20;          // degrees max tilt

let dragState = null;
let isCommitting = false; // prevents double-fire during button/key stamp delay

function attachSwipeEvents(wrapper, flip) {
  const front = flip.querySelector('.card-front');
  front.addEventListener('pointerdown', onPointerDown);
}

function onPointerDown(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  dragState = {
    startX: e.clientX,
    startY: e.clientY,
    currentX: e.clientX,
    currentY: e.clientY,
    wrapper: e.currentTarget.closest('.card-wrapper'),
    committed: false
  };
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(e) {
  if (!dragState) return;
  e.preventDefault();
  dragState.currentX = e.clientX;
  dragState.currentY = e.clientY;

  const dx = dragState.currentX - dragState.startX;
  const dy = dragState.currentY - dragState.startY;

  // Determine dominant direction
  const dir = getDragDirection(dx, dy, 30);

  // Apply transform to the wrapper
  const tilt = Math.min(Math.abs(dx) / 10, TILT_MAX) * Math.sign(dx);
  dragState.wrapper.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${tilt * 0.6}deg)`;

  // Show stamps / tint
  updateDragFeedback(dragState.wrapper, dir, dx, dy);
}

function removeDocumentPointerListeners() {
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerCancel);
}

function onPointerUp(e) {
  if (!dragState) return;
  removeDocumentPointerListeners();
  const dx = dragState.currentX - dragState.startX;
  const dy = dragState.currentY - dragState.startY;

  const dir = getDragDirection(dx, dy, SWIPE_THRESHOLD);

  if (dir) {
    commitSwipe(dragState.wrapper, dir, dx, dy);
  } else {
    // Snap back
    dragState.wrapper.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
    dragState.wrapper.style.transform = '';
    clearDragFeedback(dragState.wrapper);
    setTimeout(() => {
      if (dragState && dragState.wrapper) dragState.wrapper.style.transition = '';
    }, 300);
  }
  dragState = null;
}

function onPointerCancel() {
  if (!dragState) return;
  removeDocumentPointerListeners();
  dragState.wrapper.style.transform = '';
  dragState.wrapper.style.transition = '';
  clearDragFeedback(dragState.wrapper);
  dragState = null;
}

function getDragDirection(dx, dy, threshold) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return null;
  // Prefer horizontal over vertical unless clearly downward
  if (ay > ax && dy > threshold) return 'down';
  if (ax >= threshold) return dx > 0 ? 'right' : 'left';
  return null;
}

function updateDragFeedback(wrapper, dir, dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const intensity = Math.min(Math.max(ax, ay) / SWIPE_THRESHOLD, 1);

  const stampYes    = wrapper.querySelector('.stamp-yes');
  const stampNo     = wrapper.querySelector('.stamp-no');
  const stampUnsure = wrapper.querySelector('.stamp-unsure');
  const tint        = wrapper.querySelector('.card-tint');

  // Reset
  [stampYes, stampNo, stampUnsure].forEach(el => { if (el) el.style.opacity = 0; });
  if (tint) {
    tint.className = 'card-tint';
    tint.style.opacity = 0;
  }

  if (!dir) return;

  if (dir === 'right' && stampYes) {
    stampYes.style.opacity = intensity;
    if (tint) { tint.classList.add('tint-yes'); tint.style.opacity = intensity * 0.12; }
  } else if (dir === 'left' && stampNo) {
    stampNo.style.opacity = intensity;
    if (tint) { tint.classList.add('tint-no'); tint.style.opacity = intensity * 0.12; }
  } else if (dir === 'down' && stampUnsure) {
    stampUnsure.style.opacity = intensity;
    if (tint) { tint.classList.add('tint-unsure'); tint.style.opacity = intensity * 0.12; }
  }
}

function clearDragFeedback(wrapper) {
  const stamps = wrapper.querySelectorAll('.card-stamp');
  stamps.forEach(el => el.style.opacity = 0);
  const tint = wrapper.querySelector('.card-tint');
  if (tint) { tint.className = 'card-tint'; tint.style.opacity = 0; }
}

/* ============================================================
   SWIPE COMMIT
   ============================================================ */
function handleButtonSwipe(dir) {
  if (isCommitting) return;
  const wrapper = getTopCardWrapper();
  if (!wrapper) return;
  isCommitting = true;

  // Lean values — simulates a natural drag in this direction
  const leanX = dir === 'right' ? 65 : dir === 'left' ? -65 : 0;
  const leanY = dir === 'down'  ? 55 : 0;
  const tilt  = dir === 'right' ?  6 : dir === 'left' ? -6 : 2;

  // Show stamp at full intensity
  updateDragFeedback(wrapper, dir, leanX * 2, leanY * 2);

  // Bring to front before any animation
  wrapper.style.zIndex = 10;

  // Phase 1: lean toward direction (reflow between transition + transform so it actually animates)
  wrapper.style.transition = 'transform 0.18s ease-out';
  void wrapper.offsetWidth; // force reflow
  wrapper.style.transform = `translate(${leanX}px, ${leanY * 0.4}px) rotate(${tilt}deg)`;

  setTimeout(() => {
    isCommitting = false;
    wrapper.style.transition = '';
    commitSwipe(wrapper, dir, leanX, leanY);
  }, 180);
}

function commitSwipe(wrapper, dir, dragDx = 0, dragDy = 0) {
  // Detach drag events to prevent double-fire
  const front = wrapper.querySelector('.card-front');
  front.removeEventListener('pointerdown', onPointerDown);

  // Populate the back face now (before animation) and record direction for lang updates
  const idx = parseInt(wrapper.dataset.index, 10);
  const s = scenarios[idx];
  wrapper.dataset.swipeDir = dir;
  populateCardBack(wrapper.querySelector('.card-back-face'), s, dir);

  // Track score and per-scenario result
  const correctSwipe = (s['Correct Swipe'] || '').trim().toLowerCase();
  if (dir === correctSwipe) { scoreCorrect++; } else { scoreIncorrect++; }
  scenarioResults.push({
    id: s['ID'],
    harassmentType: s['Harassment type (EN)'],
    subtype: s['Harassment Subtype (EN)'],
    correctSwipe,
    userSwipe: dir,
    correct: dir === correctSwipe,
  });

  // Hide action buttons while feedback is shown
  actionBtns.classList.add('hidden');

  wrapper.style.zIndex = 10;

  const flip = wrapper.querySelector('.card-flip');
  const tilt = Math.min(Math.abs(dragDx) / 10, TILT_MAX) * Math.sign(dragDx);
  const extraX = dir === 'right' ? 55 : dir === 'left' ? -55 : 0;
  const extraY = dir === 'down'  ? 35 : 0;

  // Continue momentum from current position, then flip and snap back
  wrapper.style.transition = 'transform 0.18s ease-out';
  void wrapper.offsetWidth; // force reflow so transition animates
  wrapper.style.transform = `translate(${dragDx + extraX}px, ${(dragDy + extraY) * 0.4}px) rotate(${tilt * 0.6}deg)`;

  setTimeout(() => {
    flip.classList.add('flipped');
    wrapper.style.transition = 'transform 0.42s cubic-bezier(0.2, 0, 0.3, 1)';
    wrapper.style.transform  = '';
    setTimeout(() => { wrapper.style.transition = ''; }, 420);
  }, 180);
}

function getTopCardWrapper() {
  if (!cardScene) return null;
  return cardScene.querySelector('.card-wrapper:last-child') || cardScene.querySelector('.card-wrapper');
}

/* ============================================================
   ADVANCE CARD
   ============================================================ */
function advanceCard() {
  const wrapper = getTopCardWrapper();
  if (wrapper) wrapper.remove();

  currentIndex++;

  if (currentIndex >= scenarios.length) {
    showEndScreen();
    return;
  }

  updateProgress();
  actionBtns.classList.remove('hidden');

  // Rebuild deck (remaining cards already in DOM for the stack visual,
  // but we need to ensure the new top card has drag events attached)
  // Simplest approach: fully re-render the deck
  renderDeck();
}

/* ============================================================
   PROGRESS
   ============================================================ */
function updateProgress() {
  const total = scenarios.length;
  const done  = currentIndex;
  const pct   = total > 0 ? (done / total) * 100 : 0;
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${done + 1} / ${total}`;
}

/* ============================================================
   END SCREEN
   ============================================================ */
function showEndScreen() {
  actionBtns.classList.remove('hidden');
  showScreen('screen-end');

  // Apply language to end screen (including form fields)
  document.querySelectorAll('#screen-end [data-nl]').forEach(el => {
    el.textContent = currentLang === 'nl' ? el.dataset.nl : el.dataset.en;
  });
  const endCity = document.getElementById('end-city');
  if (endCity) {
    endCity.placeholder = currentLang === 'nl' ? endCity.dataset.placeholderNl : endCity.dataset.placeholderEn;
  }

  // Always auto-send game results — captured even if user never touches the end form
  if (!gameDataSent) {
    gameDataSent = true;
    sendToSheets({
      type:                  'session_complete',
      sessionId:             userData.sessionId,
      timestamp:             new Date().toISOString(),
      total:                 scoreCorrect + scoreIncorrect,
      correct:               scoreCorrect,
      incorrect:             scoreIncorrect,
      interventionScenarios: interventionClicks.join(', '),
      cardsCompleted:        currentIndex,
    });
    scenarioResults.forEach(r => sendToSheets({
      type:      'scenario_result',
      sessionId: userData.sessionId,
      timestamp: new Date().toISOString(),
      ...r,
    }));
  }
}

function collectEndScreenData() {
  const form = document.getElementById('end-form');
  const confidencePost = form.querySelector('[name="confidence-post"]:checked');
  userData.confidencePost = confidencePost ? confidencePost.value : '';
  userData.age    = form.querySelector('[name="age"]').value;
  userData.gender = form.querySelector('[name="gender"]').value;
  userData.city   = form.querySelector('[name="city"]').value.trim();
}

function submitEndData() {
  if (demographicsSent) return;
  demographicsSent = true;
  collectEndScreenData();
  sendToSheets({
    type:      'session_demographics',
    sessionId: userData.sessionId,
    age:       userData.age,
    gender:    userData.gender,
    city:      userData.city,
  });
  // Show confirmation, hide form
  document.getElementById('end-form').style.display = 'none';
  document.getElementById('btn-end-data-skip').style.display = 'none';
  const thanks = document.getElementById('end-form-thanks');
  thanks.style.display = 'flex';
  thanks.querySelector('[data-nl]').textContent =
    currentLang === 'nl'
      ? 'Bedankt :)'
      : 'Thanks :)';
}

function onEndFormSubmit(e) {
  e.preventDefault();
  submitEndData();
}
