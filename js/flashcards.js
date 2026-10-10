// ── KaTeX lazy loader ──────────────────────────────────────────
// KaTeX JS (~270 KB) and marked-katex-extension are only injected the first time a card
// text contains "$". After the load, marked renders math itself (inside marked.parse), so
// Markdown never changes the LaTeX source (backslashes, *, _).
// Subsequent calls are no-ops once the scripts have loaded.
let _katexState = 'idle'; // 'idle' | 'loading' | 'ready'
let _katexQueue = [];     // callbacks waiting for KaTeX to finish loading

function loadKaTeX(cb) {
  if (_katexState === 'ready')   { cb(); return; }
  if (_katexState === 'loading') { _katexQueue.push(cb); return; }
  _katexState = 'loading';
  _katexQueue.push(cb);

  function onReady() {
    // Inline math: "$" at the start or after a space, and the closing "$" before a space,
    // punctuation, or the end of the line. So "$5 and $10" stays text.
    marked.use(markedKatex({ throwOnError: false }));
    _katexState = 'ready';
    _katexQueue.forEach(fn => fn());
    _katexQueue = [];
  }

  // A failed load drops the queued callbacks (math stays as text) and allows a new attempt
  function onError(ev) {
    console.error('KaTeX could not be loaded:', ev.target.src);
    _katexState = 'idle';
    _katexQueue = [];
  }

  // Load katex.min.js first, then the extension (its UMD build reads the global katex on load)
  const s1 = document.createElement('script');
  s1.src = 'vendor/katex/katex.min.js';
  s1.onerror = onError;
  s1.onload = () => {
    const s2 = document.createElement('script');
    s2.src = 'vendor/marked-katex-extension/index.umd.js';
    s2.onerror = onError;
    s2.onload = onReady;
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}

// ── Mermaid lazy loader ────────────────────────────────────────
// Mermaid (~5.5 MB) is only loaded the first time a diagram must show.
// Returns a promise for the configured global `mermaid` object.
let _mermaidPromise = null;

function loadMermaid() {
  if (!_mermaidPromise) {
    _mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid/mermaid.min.js';
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('Mermaid could not be loaded'));
      document.head.appendChild(s);
    }).then(() => {
      // Colors and font come from the CSS variables, so diagrams match the app
      const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',        // Mermaid sanitizes labels; no click handlers or HTML from the deck
        suppressErrorRendering: true,   // throw on a syntax error instead of inserting an error diagram
        theme: 'base',
        themeVariables: {
          fontFamily:         css('--font-ui'),
          fontSize:           '14px',
          background:         css('--surface'),
          primaryColor:       css('--accent-soft'),
          primaryBorderColor: css('--accent'),
          primaryTextColor:   css('--ink'),
          secondaryColor:     css('--hit-soft'),
          tertiaryColor:      css('--bg'),
          lineColor:          css('--ink-soft'),
        },
      });
      return mermaid;
    });
    _mermaidPromise.catch(() => { _mermaidPromise = null; });   // allow a new attempt later
  }
  return _mermaidPromise;
}

// ── State ──────────────────────────────────────────────────────
let parsedDeck        = null;   // { filename, name, sections: [{title, cards:[{_id,front,back,frontMedia,backMedia}]}] }
let activeDeck        = [];
let lastDeck          = [];     // the cards of the last round ("Study missed" picks from these)
let selectionDeck     = [];     // the cards of the selected sections ("Study again" uses these)
let missedCards       = [];     // stores card._id values (integers), not card objects
let cardIndex         = 0;
let hits              = 0;
let misses            = 0;
let isFlipped         = false;
let isReversed        = false;
let isShuffled        = true;
let isAnimating       = false;
let prevState         = null;   // state before the last answer; null means nothing to undo
let btnShowTimeout    = null;
let backContentTimeout = null;  // deferred back-face update in renderCard()

// Persistence state
let saveBlocked          = false;   // true if the browser gives no IndexedDB
let hasSavedCurrentDeck  = false;
let currentRawMarkdown   = '';

// The flip duration comes from the CSS variable --flip-ms, the same value as the .card transition
const FLIP_MS        = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--flip-ms')) || 420;
const ANIM_THRESHOLD = 80;
const ANIM_MAX_TILT  = 12;
const ANIM_FLY_PX    = 420;
const ANIM_FLY_MS    = 380;

// Assigned in swipe IIFE
let animScene   = null;
let animOverlay = null;

// ── Helpers ────────────────────────────────────────────────────
// Escapes text for HTML content and attribute values. js/img-to-md.js has the same function.
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// ── DOM refs ───────────────────────────────────────────────────
const elCard        = document.getElementById('card');
const elCardFront   = document.getElementById('card-front');
const elCardBack    = document.getElementById('card-back');
const elAnswerBtns  = document.getElementById('answer-btns');
const elFaceFront   = elCard.querySelector('.face.front');
const elFaceBack    = elCard.querySelector('.face.back');
const elBtnGoBack   = document.getElementById('btn-goback');
const elProgFill    = document.getElementById('prog-fill');
const elProgText    = document.getElementById('prog-text');
const elProgPct     = document.getElementById('prog-pct');
const elScoreLive   = document.getElementById('score-live');
const elDoneEmoji   = document.getElementById('done-emoji');
const elDoneHeading = document.getElementById('done-heading');
const elDoneSub     = document.getElementById('done-sub');
const elDoneHit     = document.getElementById('done-hit');
const elDoneMiss    = document.getElementById('done-miss');
const elBtnMissed   = document.getElementById('btn-missed');
const elMediaPanel  = document.getElementById('card-media-panel');
const elImage       = document.getElementById('card-image');
const elDiagram     = document.getElementById('card-diagram');

// ── Storage (IndexedDB) ────────────────────────────────────────
// Two object stores, both keyed by deck id:
//   "decks"  — the metadata that the deck list shows { id, name, sections, cards, createdAt }
//   "bodies" — the raw markdown of the deck { id, raw }, which can be large (embedded images)
// The deck list reads only "decks". A deck id starts with Date.now() in base 36, so the key
// order of getAll() is the order in which the decks were saved.
const DB_NAME    = 'flashcards';
const DB_VERSION = 1;

let _dbPromise = null;

function requestResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

function openDB() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('decks',  { keyPath: 'id' });
        req.result.createObjectStore('bodies', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  return _dbPromise;
}

// Disable the save toggle if the browser gives no IndexedDB (for example a strict private mode)
openDB().catch(err => {
  console.error('Saved decks are not available:', err);
  saveBlocked = true;
  refreshSaveToggle();
});

async function getDecks() {
  const db = await openDB();
  return requestResult(db.transaction('decks').objectStore('decks').getAll());
}

async function getDeckRaw(id) {
  const db  = await openDB();
  const rec = await requestResult(db.transaction('bodies').objectStore('bodies').get(id));
  return rec ? rec.raw : null;
}

// Resolves only after the transaction has completed, so a resolved promise means the deck is stored
async function putDeck(meta, raw) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'bodies'], 'readwrite');
  tx.objectStore('decks').put(meta);
  tx.objectStore('bodies').put({ id: meta.id, raw });
  await transactionDone(tx);
}

async function removeDeck(id) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'bodies'], 'readwrite');
  tx.objectStore('decks').delete(id);
  tx.objectStore('bodies').delete(id);
  await transactionDone(tx);
}

// Ask the browser to keep the saved decks when it needs disk space. Safari grants this
// more easily to an installed app. Called on the first save, not at startup, because
// Firefox shows a permission prompt.
function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  navigator.storage.persisted()
    .then(persisted => persisted || navigator.storage.persist())
    .catch(() => {});
}

async function updateStorageMeter() {
  const meter = document.getElementById('storage-meter');
  if (!meter) return;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) throw new Error('no quota');
    const avail = 100 - Math.min(100, Math.round(usage / quota * 100));
    meter.textContent = `${avail}% storage available`;
    meter.classList.toggle('low', avail < 20);
    meter.style.display = '';
  } catch {
    meter.style.display = 'none';   // StorageManager.estimate() not available
  }
}

// SHA-256 of the deck markdown, stored with the deck to find identical decks.
// null if crypto.subtle is not available (it needs HTTPS or localhost).
async function deckHash(raw) {
  if (!window.crypto || !crypto.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function findSavedDeck(hash) {
  if (!hash) return null;
  return (await getDecks()).find(d => d.hash === hash) || null;
}

// Called when the save switch turns on. A deck with the same content is not saved twice.
async function saveDeck() {
  if (hasSavedCurrentDeck) return;
  hasSavedCurrentDeck = true;   // set before the async write, so a second call cannot save twice
  refreshSaveToggle();
  const deck = parsedDeck;
  const raw  = currentRawMarkdown;
  try {
    const hash = await deckHash(raw);
    if (!(await findSavedDeck(hash))) {
      await putDeck({
        id:        Date.now().toString(36) + Math.random().toString(36).slice(2),
        name:      deck.name,
        sections:  deck.sections.length,
        cards:     deck.sections.reduce((n, s) => n + s.cards.length, 0),
        createdAt: new Date().toISOString().slice(0, 10),
        hash
      }, raw);
      requestPersistentStorage();
    }
  } catch (err) {
    hasSavedCurrentDeck = false;   // the switch turns off again
    console.error('Could not save the deck:', err);
    alert(err && err.name === 'QuotaExceededError'
      ? 'Could not save the deck: the storage of this browser is full.'
      : 'Could not save the deck: the browser does not allow storage.');
  }
  refreshSaveToggle();
}

async function deleteDeck(id) {
  if (!confirm('Delete this deck?')) return;
  try {
    await removeDeck(id);
  } catch (err) {
    console.error('Could not delete the deck:', err);
    alert('Could not delete the deck.');
  }
  renderDeckList();
}

// ── Deck library ───────────────────────────────────────────────
const trashSVG = `<svg width="14" height="14" aria-hidden="true"><use href="img/icons.svg#icon-trash"/></svg>`;

async function renderDeckList() {
  const library = document.getElementById('deck-library');
  const list    = document.getElementById('deck-list');

  let decks = [];
  try {
    decks = await getDecks();
  } catch (err) {
    console.error('Could not read the saved decks:', err);
  }

  deckSwipeRevealed.clear();   // the new items start closed, so the swipe state must too
  if (!decks.length) { library.style.display = 'none'; return; }

  library.style.display = '';
  list.innerHTML = decks.map(deck => {
    const secLabel  = `${deck.sections} section${deck.sections !== 1 ? 's' : ''}`;
    const cardLabel = `${deck.cards} card${deck.cards !== 1 ? 's' : ''}`;
    return `<div class="deck-item" data-id="${esc(deck.id)}">
      <div class="deck-item-inner">
        <div class="deck-item-content" role="button" tabindex="0">
          <span class="deck-item-name">${esc(deck.name)}</span>
          <span class="deck-item-meta">${secLabel} · ${cardLabel} · ${esc(deck.createdAt)}</span>
        </div>
        <button class="deck-delete-btn" title="Delete deck" aria-label="Delete deck ${esc(deck.name)}">${trashSVG}</button>
      </div>
      <button class="deck-delete-reveal" tabindex="-1" aria-hidden="true">Delete</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.deck-item').forEach((item, i) => {
    const { id, name } = decks[i];
    item.querySelector('.deck-item-inner').addEventListener('click', () => loadDeckById(id, name));
    item.querySelector('.deck-item-content').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadDeckById(id, name); }
    });
    item.querySelector('.deck-delete-btn').addEventListener('click', e => { e.stopPropagation(); deleteDeck(id); });
    item.querySelector('.deck-delete-reveal').addEventListener('click', e => { e.stopPropagation(); deleteDeck(id); });
  });

  initDeckSwipe();
  updateStorageMeter();
}

async function loadDeckById(id, name) {
  let raw = null;
  try {
    raw = await getDeckRaw(id);
  } catch (err) {
    console.error('Could not read the deck:', err);
  }
  if (raw === null) { alert('Could not open this deck.'); return; }
  currentRawMarkdown  = raw;
  const deck = parseMD(raw, name, { warn: false });   // the warnings showed when the deck was loaded
  if (!deck.sections.length) return;
  parsedDeck          = deck;
  hasSavedCurrentDeck = true;  // already persisted — don't re-save
  buildSelectScreen();
  showScreen('screen-select');
}

// ── Deck swipe-to-delete (touch) ───────────────────────────────
// Tracks which deck items are swiped open; keyed by deck id. Shared with the
// global touchstart handler so both the DOM reset and the state reset stay in sync.
const deckSwipeRevealed = new Map();

function initDeckSwipe() {
  const SNAP_PX   = 76;
  const THRESHOLD = 36;

  document.querySelectorAll('.deck-item').forEach(item => {
    const id    = item.dataset.id;
    const inner = item.querySelector('.deck-item-inner');
    let startX  = 0, startY = 0, dragging = false;

    inner.addEventListener('touchstart', e => {
      startX   = e.changedTouches[0].clientX;
      startY   = e.changedTouches[0].clientY;
      dragging = false;
      inner.style.transition = 'none';
    }, { passive: true });

    inner.addEventListener('touchmove', e => {
      const dx    = e.changedTouches[0].clientX - startX;
      const dy    = e.changedTouches[0].clientY - startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (!dragging && absDx < 6) return;
      if (!dragging && absDy > absDx) return;
      dragging = true;
      e.preventDefault();

      const base   = deckSwipeRevealed.get(id) ? -SNAP_PX : 0;
      const offset = Math.max(-SNAP_PX, Math.min(0, base + dx));
      inner.style.transform = `translateX(${offset}px)`;
    }, { passive: false });

    inner.addEventListener('touchend', e => {
      if (!dragging) return;
      dragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      inner.style.transition = 'transform .25s var(--ease)';

      if ((!deckSwipeRevealed.get(id) && dx < -THRESHOLD) || (deckSwipeRevealed.get(id) && dx < THRESHOLD)) {
        inner.style.transform = `translateX(-${SNAP_PX}px)`;
        deckSwipeRevealed.set(id, true);
      } else {
        inner.style.transform = '';
        deckSwipeRevealed.set(id, false);
      }
    });
  });

}

// Tap outside to collapse any revealed deck item — registered once at startup
document.addEventListener('touchstart', e => {
  document.querySelectorAll('.deck-item-inner').forEach(inner => {
    if (!inner.closest('.deck-item').contains(e.target)) {
      inner.style.transition = 'transform .25s var(--ease)';
      inner.style.transform  = '';
      deckSwipeRevealed.set(inner.closest('.deck-item').dataset.id, false);
    }
  });
}, { passive: true });

// ── Screens ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
  if (id === 'screen-load') renderDeckList();
  // Leaving study screen: reset animation lock so it can't get stuck
  if (id !== 'screen-study') {
    isAnimating = false;
    clearMediaPanel();
  }
}

// ── Switches (shuffle, reverse, save) ──────────────────────────
// Each switch is a <button role="switch">: aria-checked and the knob class show the state.
function setSwitch(id, on) {
  const btn = document.getElementById(id);
  btn.setAttribute('aria-checked', String(on));
  btn.querySelector('.toggle-knob').classList.toggle('on', on);
}

document.getElementById('shuffle-toggle').addEventListener('click', () => {
  isShuffled = !isShuffled;
  setSwitch('shuffle-toggle', isShuffled);
});

document.getElementById('reverse-toggle').addEventListener('click', () => {
  isReversed = !isReversed;
  setSwitch('reverse-toggle', isReversed);
});

// The save switch saves the deck at once. It stays on (and disabled) for a saved deck.
document.getElementById('save-toggle').addEventListener('click', () => {
  if (hasSavedCurrentDeck || saveBlocked) return;
  saveDeck();
});

// ── File loading ───────────────────────────────────────────────
const VALID_EXTS = ['.md', '.markdown', '.txt'];

function loadFile(file) {
  if (!file) return;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!VALID_EXTS.includes(ext)) {
    alert(`Unsupported file type: "${file.name}"\n\nPlease use a .md, .markdown, or .txt file.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    const raw  = ev.target.result;
    const deck = parseMD(raw, file.name);
    if (!deck.sections.length) {
      parsedDeck = null;
      alert('Could not parse the file format. Check the sample for the expected layout.');
      return;
    }
    parsedDeck          = deck;
    currentRawMarkdown  = raw;
    hasSavedCurrentDeck = false;
    buildSelectScreen();
    showScreen('screen-select');
    // If the same deck is already saved, show the save switch as on (Q8)
    deckHash(raw).then(findSavedDeck).then(found => {
      if (found && currentRawMarkdown === raw) { hasSavedCurrentDeck = true; refreshSaveToggle(); }
    }).catch(() => {});
  };
  reader.onerror = () => alert('Could not read the file. Please try again.');
  reader.readAsText(file);
}

// ── marked config ──────────────────────────────────────────────
marked.use({ breaks: true });

// ── File input ─────────────────────────────────────────────────
document.getElementById('file-input').addEventListener('change', function (e) {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

document.getElementById('btn-choose-file').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

// ── Drag-and-drop ──────────────────────────────────────────────
(function () {
  const zone = document.getElementById('drop-zone');
  ['dragover', 'drop'].forEach(evt => document.addEventListener(evt, e => e.preventDefault()));
  zone.addEventListener('dragenter',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragover',   e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave',  e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop',       e => { e.preventDefault(); zone.classList.remove('drag-over'); if (document.getElementById('screen-load').classList.contains('active')) loadFile(e.dataTransfer.files[0]); });
})();

// ── Markdown parser ────────────────────────────────────────────
//
//   # Deck name
//   ## Section
//   ### Card front (the question)
//   Optional extra front text, and optionally one image or diagram
//
//   ---                            ← optional: the first "---" line splits front and back
//
//   Back text (the answer), and optionally one image or diagram
//
//   [label]: data:image/png;base64,...      ← image definitions, usually at the end of the file
//
// Without a "---" line, everything below the ### heading is the back.
// Media (shown in the panel below the card, never on the card face), at most one per side:
//   Image:   ![alt][label], ![label][], ![label]  (reference style, CommonMark label matching)
//            or ![alt](data:image/...)            (inline)
//   Diagram: a ```mermaid fenced code block
// Lines inside fenced code blocks are never read as headings, separators, or definitions.

const FENCE_RE      = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const DEFINITION_RE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+.*)?$/;
const SEPARATOR_RE  = /^ {0,3}---\s*$/;
// ![alt](url "title") | ![alt][label] | ![alt][] | ![alt]
const IMAGE_RE      = /!\[([^\]]*)\](?:\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)|\[([^\]]*)\])?/g;
const OLD_IMAGE_RE  = /<!--\s*img:[\w-]+\s*-->/;

// CommonMark label matching: case-insensitive, runs of whitespace count as one space
const normalizeLabel = label => label.trim().replace(/\s+/g, ' ').toLowerCase();

// True if position `index` in `str` is inside an inline code span (odd number of backticks before it)
const inCodeSpan = (str, index) => ((str.slice(0, index).match(/`/g) || []).length % 2) === 1;

// options.warn = false skips the warning alert (for a saved deck, which showed it when loaded)
function parseMD(text, filename, { warn = true } = {}) {
  const lines    = text.replace(/^﻿/, '').split(/\r?\n/);
  const warnings = [];

  // ── Pass 1: fenced code blocks and reference definitions ──
  // fence[i]: null outside a fence, else { role: 'open'|'inside'|'close', info } for the line
  const fence       = new Array(lines.length).fill(null);
  const isDefLine   = new Array(lines.length).fill(false);
  const definitions = new Map();   // normalized label → destination
  let open = null;                 // the fence that is open: { char, len, line }
  lines.forEach((line, i) => {
    const f = line.match(FENCE_RE);
    if (open) {
      const closes = f && f[1][0] === open.char && f[1].length >= open.len && !f[2].trim();
      fence[i] = { role: closes ? 'close' : 'inside' };
      if (closes) open = null;
      return;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      open = { char: f[1][0], len: f[1].length, line: i + 1 };
      fence[i] = { role: 'open', info: f[2].trim().toLowerCase() };
      return;
    }
    const d = line.match(DEFINITION_RE);
    if (d) {
      isDefLine[i] = true;
      const label = normalizeLabel(d[1]);
      if (!definitions.has(label)) definitions.set(label, d[2]);   // CommonMark: the first definition wins
    }
  });
  if (open) warnings.push(`The code block that starts on line ${open.line} has no closing fence. The rest of the file is read as code.`);

  // ── Pass 2: deck, sections, and cards ──
  const sections   = [];
  const usedLabels = new Set();
  let deckName  = null;
  let section   = null;
  let card      = null;   // { heading, items: [line index, ...], sep: index into items or -1 }
  let skipped   = 0;
  let deepHd    = 0;
  let oldFormat = false;
  let cardSeq   = 0;

  // Takes the media out of the lines of one side. Returns { text, media }.
  function extractMedia(indexes, side) {
    const out = [];
    let media = null;
    const addMedia = m => {
      if (media) warnings.push(`Card "${card.heading}": more than one image or diagram on the ${side}. Only the first one is used.`);
      else media = m;
    };

    for (let k = 0; k < indexes.length; k++) {
      const i    = indexes[k];
      const line = lines[i];

      if (fence[i]) {
        if (fence[i].role === 'open' && fence[i].info === 'mermaid') {
          const code = [];
          while (k + 1 < indexes.length && fence[indexes[k + 1]] && fence[indexes[k + 1]].role === 'inside') {
            code.push(lines[indexes[++k]]);
          }
          if (k + 1 < indexes.length && fence[indexes[k + 1]] && fence[indexes[k + 1]].role === 'close') k++;
          addMedia({ type: 'diagram', code: code.join('\n') });
        } else {
          out.push(line);
        }
        continue;
      }

      if (OLD_IMAGE_RE.test(line)) {
        oldFormat = true;
        const rest = line.replace(OLD_IMAGE_RE, '');
        if (rest.trim()) out.push(rest.trimEnd());
        continue;
      }

      let changed = false;
      const rest = line.replace(IMAGE_RE, (whole, alt, url, ref, offset, str) => {
        if (inCodeSpan(str, offset)) return whole;
        let src;
        if (url !== undefined) {
          src = url;
        } else {
          const label = normalizeLabel(ref ? ref : alt);
          if (!definitions.has(label)) {
            if (ref === undefined) return whole;   // "![text]" with no definition is plain text
            warnings.push(`Card "${card.heading}": there is no definition for the image label [${ref || alt}].`);
            changed = true;
            return '';
          }
          usedLabels.add(label);
          src = definitions.get(label);
        }
        changed = true;
        if (!/^data:image\//i.test(src)) {
          warnings.push(`Card "${card.heading}": the image "${alt}" is not a data:image URI, so it is not shown. The app must work offline.`);
          return '';
        }
        addMedia({ type: 'image', src, alt: alt.trim() });
        return '';
      });
      if (changed && !rest.trim()) continue;   // the line held only media
      out.push(changed ? rest.trimEnd() : line.trimEnd());
    }
    return { text: out.join('\n').trim(), media };
  }

  function saveCard() {
    if (!card) return;
    const hasSep = card.sep !== -1;
    const front  = extractMedia(hasSep ? card.items.slice(0, card.sep) : [], 'front');
    const back   = extractMedia(hasSep ? card.items.slice(card.sep) : card.items, 'back');
    if (back.text || back.media) {
      // _id is a stable integer identity used for missedCards lookup (avoids reference equality issues)
      section.cards.push({
        _id:        ++cardSeq,
        front:      [card.heading, front.text].filter(Boolean).join('\n\n'),
        back:       back.text,
        frontMedia: front.media,
        backMedia:  back.media,
      });
    } else {
      skipped++;
    }
    card = null;
  }

  function saveSection() {
    saveCard();
    if (section && section.cards.length) sections.push(section);
    section = null;
  }

  lines.forEach((raw, i) => {
    if (fence[i]) { if (card) card.items.push(i); return; }
    if (isDefLine[i]) return;

    const line   = raw.trim();
    const hMatch = line.match(/^(#{1,3}) (.+)/);
    if (!hMatch && /^#{4,} /.test(line)) { deepHd++; return; }   // reported after the parse

    if (hMatch) {
      const level   = hMatch[1].length;
      const heading = hMatch[2].trim();
      if (level === 1) {
        if (!deckName) deckName = heading;
      } else if (level === 2) {
        saveSection();
        section = { title: heading, cards: [] };
      } else {
        if (!section) section = { title: 'Cards', cards: [] };
        saveCard();
        card = { heading, items: [], sep: -1 };
      }
    } else if (card) {
      if (card.sep === -1 && SEPARATOR_RE.test(raw)) { card.sep = card.items.length; return; }
      card.items.push(i);
    }
  });
  saveSection();

  // ── Warnings, shown together after the parse ──
  for (const [label, dest] of definitions) {
    if (/^data:image\//i.test(dest) && !usedLabels.has(label)) {
      warnings.push(`The image definition [${label}] is not used by any card.`);
    }
  }
  if (oldFormat) {
    warnings.unshift('This deck uses the old image format (<!-- img:key -->), which is no longer supported. Its images are not shown. Convert the images again with the Image → Markdown tool.');
  }
  if (deepHd) {
    warnings.unshift(`${deepHd} heading${deepHd !== 1 ? 's' : ''} used #### or deeper and ${deepHd !== 1 ? 'were' : 'was'} ignored. Only # (deck), ## (section), and ### (card front) are supported.`);
  }
  if (skipped) {
    warnings.unshift(`${skipped} card${skipped !== 1 ? 's were' : ' was'} skipped (no answer).`);
  }
  if (warn && warnings.length) {
    const MAX = 10;
    const shown = warnings.slice(0, MAX).map(w => '• ' + w);
    if (warnings.length > MAX) shown.push(`… and ${warnings.length - MAX} more.`);
    alert(shown.join('\n\n'));
  }

  return {
    filename,
    name: deckName || filename.replace(/\.[^.]+$/, ''),
    sections
  };
}

// ── Card content rendering ─────────────────────────────────────
// Each call gets a sequence number. A render that waits for KaTeX only runs if no newer
// content was set on the same face in the meantime.
let _renderSeq = 0;

function setCardContent(el, text) {
  const seq = String(++_renderSeq);
  el.dataset.renderSeq = seq;
  renderMarkdown(el, text);
  // Only pay the KaTeX cost when the card actually contains "$". Until KaTeX is loaded,
  // the text shows without math rendering; it renders again once KaTeX is ready.
  if (text.includes('$') && _katexState !== 'ready') {
    loadKaTeX(() => {
      if (el.dataset.renderSeq === seq) renderMarkdown(el, text);
    });
  }
}

function renderMarkdown(el, text) {
  try {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    fitText(el);
  } catch (err) {
    console.error('setCardContent failed:', err);
    el.textContent = text;  // fall back to plain text so the card is never blank
  }
}

function fitText(el) {
  // KaTeX uses `font-size: 1em` so it scales proportionally with the parent — no special
  // treatment needed; the binary search works correctly for cards containing display math.
  el.style.fontSize = '';

  // One read to check if shrinking is needed at all — fast path for most cards.
  const h = el.clientHeight;
  if (el.scrollHeight <= h) return;

  // Run the binary search on an off-screen clone. The clone is a fixed-position element in
  // the document, so each read still forces a layout, but only of the small clone; the live
  // element gets a single write at the end.
  // Use clientWidth, not getBoundingClientRect(): the bounding box includes CSS transforms,
  // so during a flip or a swipe it is narrower than the real layout width.
  const naturalPx = parseFloat(getComputedStyle(el).fontSize);
  const w         = el.clientWidth;
  const proxy     = el.cloneNode(true);
  proxy.removeAttribute('id');   // no duplicate id in the document, not even for a moment
  proxy.style.cssText = [
    'position:fixed', 'top:-9999px', 'left:-9999px',
    `width:${w}px`, `height:${h}px`,
    'visibility:hidden', 'pointer-events:none',
    'overflow:hidden', 'font-size:' + naturalPx + 'px'
  ].join(';');
  document.body.appendChild(proxy);

  let lo = 11;
  let hi = Math.max(lo, Math.floor(naturalPx));
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    proxy.style.fontSize = mid + 'px';
    if (proxy.scrollHeight > h) hi = mid - 1;
    else lo = mid + 1;
  }

  document.body.removeChild(proxy);
  // Single write to the live element
  if (hi < Math.floor(naturalPx)) el.style.fontSize = hi + 'px';
}

// Fit both card faces again when the card size changes (window resize, phone or iPad
// rotation) or when a web font finishes loading (Lora, DM Sans, KaTeX fonts change the
// text size). Only while the study screen is visible; one fit per animation frame.
let _refitPending = false;

function refitCardText() {
  if (_refitPending) return;
  _refitPending = true;
  requestAnimationFrame(() => {
    _refitPending = false;
    if (!document.getElementById('screen-study').classList.contains('active')) return;
    fitText(elCardFront);
    fitText(elCardBack);
  });
}

if (window.ResizeObserver) {
  // The card has a fixed height and fills the width, so its size never depends on the text:
  // fitting the text cannot trigger the observer again.
  let lastWidth = 0;
  new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    if (width !== lastWidth) { lastWidth = width; refitCardText(); }
  }).observe(elCard);
}
if (document.fonts) {
  document.fonts.ready.then(refitCardText);
  document.fonts.addEventListener('loadingdone', refitCardText);
}

// ── Section select screen ──────────────────────────────────────
const chkSVG = `<svg aria-hidden="true"><use href="img/icons.svg#icon-check"/></svg>`;

function buildSelectScreen() {
  // Reset shuffle to on every time a deck is (re-)loaded from the main screen
  isShuffled = true;
  setSwitch('shuffle-toggle', true);
  // Reverse resets to off, so a new deck always starts with question → answer
  isReversed = false;
  setSwitch('reverse-toggle', false);

  document.getElementById('deck-name').textContent = parsedDeck.name;
  const list = document.getElementById('section-list');
  list.innerHTML = parsedDeck.sections.map((sec, i) =>
    `<div class="section-item checked" data-idx="${i}" role="checkbox" aria-checked="true" tabindex="0">
      <input type="checkbox" checked>
      <div class="chk">${chkSVG}</div>
      <div class="sec-label">
        <div class="name">${esc(sec.title)}</div>
        <div class="count">${sec.cards.length} card${sec.cards.length !== 1 ? 's' : ''}</div>
      </div>
    </div>`
  ).join('');

  list.querySelectorAll('.section-item').forEach(el => {
    el.addEventListener('click', () => toggleItem(el));
    el.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleItem(el); }
    });
  });

  refreshCount();
  refreshSaveToggle();
}

function toggleItem(el) {
  const cb  = el.querySelector('input');
  cb.checked = !cb.checked;
  el.classList.toggle('checked', cb.checked);
  el.setAttribute('aria-checked', String(cb.checked));
  refreshCount();
}

function toggleAll() {
  const items  = [...document.querySelectorAll('.section-item')];
  const allOn  = items.every(i => i.querySelector('input').checked);
  items.forEach(el => {
    el.querySelector('input').checked = !allOn;
    el.classList.toggle('checked', !allOn);
    el.setAttribute('aria-checked', String(!allOn));
  });
  refreshCount();
}

function refreshCount() {
  const items   = [...document.querySelectorAll('.section-item')];
  const checked = items.filter(i => i.querySelector('input').checked);
  const total   = checked.reduce((n, el) =>
    n + parsedDeck.sections[+el.dataset.idx].cards.length, 0);
  const allOn   = checked.length === items.length;

  document.getElementById('toggle-all-btn').textContent = allOn ? 'Deselect all' : 'Select all';
  document.getElementById('start-btn').disabled = total === 0;
  const countEl = document.getElementById('sel-count');
  const strong  = document.createElement('strong');
  strong.textContent = total;
  countEl.innerHTML  = '';
  countEl.appendChild(strong);
  countEl.append(` card${total !== 1 ? 's' : ''} selected`);
}

function refreshSaveToggle() {
  const toggle = document.getElementById('save-toggle');
  setSwitch('save-toggle', hasSavedCurrentDeck);
  toggle.disabled = hasSavedCurrentDeck || saveBlocked;
  toggle.classList.toggle('disabled', saveBlocked);
  toggle.querySelector('.toggle-hint').textContent =
    saveBlocked ? '(storage not available)' :
    hasSavedCurrentDeck ? '(saved in this browser)' : '(stored in browser)';
}

// ── Study ──────────────────────────────────────────────────────
function startStudy(cardsOverride) {
  if (cardsOverride) {
    activeDeck = isShuffled ? shuffle([...cardsOverride]) : [...cardsOverride];
  } else {
    const items   = [...document.querySelectorAll('.section-item')];
    const checked = items.filter(i => i.querySelector('input').checked);
    if (!checked.length) return;
    const cards   = checked.flatMap(el => parsedDeck.sections[+el.dataset.idx].cards);
    selectionDeck = cards;
    activeDeck    = isShuffled ? shuffle([...cards]) : [...cards];
  }

  if (!activeDeck.length) return;

  lastDeck    = [...activeDeck];
  missedCards = [];
  cardIndex   = 0;
  hits        = 0;
  misses      = 0;
  prevState   = null;

  showScreen('screen-study');
  refreshBackBtn();
  renderCard();
  elCard.focus({ preventScroll: true });   // keyboard and screen reader users start on the card
}

// ── Render card ────────────────────────────────────────────────
function renderCard() {
  const total       = activeDeck.length;
  const done        = cardIndex;
  const currentCard = activeDeck[cardIndex];

  elProgFill.style.width    = (done / total * 100) + '%';
  elProgText.textContent    = `${done + 1} / ${total}`;
  elProgPct.textContent     = `${Math.round(done / total * 100)} %`;
  elScoreLive.textContent   = `✓ ${hits}  ✗ ${misses}`;

  const frontMedia = isReversed ? currentCard.backMedia  : currentCard.frontMedia;
  const backMedia  = isReversed ? currentCard.frontMedia : currentCard.backMedia;
  const front = faceText(isReversed ? currentCard.back  : currentCard.front, frontMedia);
  const back  = faceText(isReversed ? currentCard.front : currentCard.back,  backMedia);

  setCardContent(elCardFront, front);

  const wasFlipped = elCard.classList.contains('flipped');

  if (btnShowTimeout) { clearTimeout(btnShowTimeout); btnShowTimeout = null; }
  // Cancel a pending back-face update from the previous render, or it overwrites this card's answer (e.g. after undo)
  if (backContentTimeout) { clearTimeout(backContentTimeout); backContentTimeout = null; }
  elCard.classList.remove('flipped');
  isFlipped = false;  // always show the new card face-up, including after undo — intentional
  updateFaceVisibility();
  setAnswerButtonsVisible(false);

  // Defer back content to avoid a flash during the flip-back transition
  if (wasFlipped) {
    backContentTimeout = setTimeout(() => {
      backContentTimeout = null;
      setCardContent(elCardBack, back);
    }, FLIP_MS);
  } else {
    setCardContent(elCardBack, back);
  }

  updateMediaPanel();
}

// ── Media panel ────────────────────────────────────────────────
// The panel below the answer buttons shows the image or diagram of the side that is visible:
// the front media before the flip, the back media after it. It is hidden if that side has none.
// In reverse mode the sides swap, media included.
const MEDIA_PLACEHOLDER = { image: 'see image', diagram: 'see diagram' };

// The text for a card face. A side with media but no text gets a placeholder.
function faceText(text, media) {
  return text || (media ? MEDIA_PLACEHOLDER[media.type] : '');
}

function visibleMedia() {
  const card = activeDeck[cardIndex];
  if (!card) return null;
  const showBack = isFlipped !== isReversed;   // the back of the card data is visible
  return showBack ? card.backMedia : card.frontMedia;
}

// mediaToken changes on each panel update, so a diagram that finishes drawing late
// is not shown on a card or side that is no longer visible.
let mediaToken = 0;
let diagramSeq = 0;
const diagramSvgCache = new Map();   // Mermaid source → SVG markup (undo, reverse, study again)

function updateMediaPanel() {
  const token = ++mediaToken;
  const media = visibleMedia();
  if (!media) { clearMediaPanel(); return; }
  if (media.type === 'image') {
    if (elImage.getAttribute('src') !== media.src) elImage.src = media.src;
    elImage.alt = media.alt;
    elImage.style.display = '';
    elDiagram.style.display = 'none';
    elDiagram.textContent = '';
  } else {
    elImage.style.display = 'none';
    elImage.removeAttribute('src');
    elDiagram.style.display = '';
    showDiagram(media.code, token);
  }
  elMediaPanel.style.display = '';
}

// The SVG from Mermaid is inserted as it is. A second pass through DOMPurify would remove
// parts of it (for example foreignObject labels); securityLevel 'strict' sanitizes the labels.
function showDiagram(code, token) {
  const cached = diagramSvgCache.get(code);
  if (cached) { elDiagram.innerHTML = cached; return; }

  elDiagram.innerHTML = '<p class="diagram-status">Drawing the diagram…</p>';
  loadMermaid()
    .then(m => m.render(`mermaid-${++diagramSeq}`, code))
    .then(({ svg }) => {
      diagramSvgCache.set(code, svg);
      if (token === mediaToken) elDiagram.innerHTML = svg;
    })
    .catch(err => {
      console.error('Mermaid could not draw the diagram:', err);
      if (token !== mediaToken) return;
      const msg = document.createElement('p');
      msg.className   = 'diagram-status error';
      msg.textContent = 'This diagram has an error. Its source:';
      const pre = document.createElement('pre');
      pre.textContent = code;
      elDiagram.replaceChildren(msg, pre);
    });
}

// removeAttribute('src') rather than src = '' avoids a request for the page URL
function clearMediaPanel() {
  mediaToken++;
  elMediaPanel.style.display = 'none';
  elImage.removeAttribute('src');
  elImage.alt = '';
  elDiagram.textContent = '';
}

function flipCard() {
  if (isAnimating) return;   // no flip while the card flies off (B17)
  isFlipped = !isFlipped;
  elCard.classList.toggle('flipped', isFlipped);
  updateFaceVisibility();
  updateMediaPanel();
  if (isFlipped) {
    btnShowTimeout = setTimeout(() => { btnShowTimeout = null; setAnswerButtonsVisible(true); }, 250);
  } else {
    if (btnShowTimeout) { clearTimeout(btnShowTimeout); btnShowTimeout = null; }
    setAnswerButtonsVisible(false);
  }
}

// Screen readers read only the visible face, so the answer stays hidden until the flip
function updateFaceVisibility() {
  elFaceFront.setAttribute('aria-hidden', String(isFlipped));
  elFaceBack.setAttribute('aria-hidden', String(!isFlipped));
}

// Hidden answer buttons are inert: Tab cannot reach them and they cannot be activated
function setAnswerButtonsVisible(visible) {
  elAnswerBtns.classList.toggle('visible', visible);
  elAnswerBtns.inert = !visible;
}

function answer(correct) {
  prevState = { card: activeDeck[cardIndex], correct, hits, misses, cardIndex };
  refreshBackBtn();

  if (!correct) missedCards.push(activeDeck[cardIndex]._id);
  if (correct) hits++; else misses++;
  cardIndex++;
  if (cardIndex >= activeDeck.length) showDone();
  else renderCard();
}

// ── Undo last card ─────────────────────────────────────────────
function goBack() {
  if (!prevState || isAnimating) return;
  cardIndex = prevState.cardIndex;
  hits      = prevState.hits;
  misses    = prevState.misses;
  if (!prevState.correct) {
    const idx = missedCards.indexOf(prevState.card._id);
    if (idx !== -1) missedCards.splice(idx, 1);
  }
  prevState = null;
  refreshBackBtn();
  renderCard();
}

function refreshBackBtn() {
  elBtnGoBack.style.display = prevState ? '' : 'none';
}

function exitStudy() {
  if (cardIndex > 0 && !confirm('Exit this session? Your progress will be lost.')) return;
  showScreen('screen-select');
  refreshSaveToggle();
}

// ── Done screen ────────────────────────────────────────────────
function showDone() {
  const total = activeDeck.length;
  const pct   = Math.round(hits / total * 100);
  const [emoji, heading] =
    pct === 100 ? ['🎉', 'Perfect round!'] :
    pct >= 80   ? ['⭐️', 'Great work!'] :
    pct >= 50   ? ['💪', 'Keep going!'] :
                  ['📖', 'More practice needed'];

  elDoneEmoji.textContent   = emoji;
  elDoneHeading.textContent = heading;
  elDoneSub.textContent     = `${pct}% correct · ${total} card${total !== 1 ? 's' : ''}`;
  elDoneHit.textContent     = hits;
  elDoneMiss.textContent    = misses;
  elBtnMissed.style.display = misses > 0 ? '' : 'none';
  document.getElementById('btn-undo-last').style.display = prevState ? '' : 'none';

  showScreen('screen-done');
}

// ── Utilities ──────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── commitAnswer (fly-off animation) ──────────────────────────
function commitAnswer(correct) {
  if (isAnimating) return;
  isAnimating = true;

  // Hide answer buttons immediately on entry
  setAnswerButtonsVisible(false);

  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(correct ? 20 : [10, 40, 10]);
  }

  const dir = correct ? 1 : -1;

  animOverlay.style.transition = 'none';
  animOverlay.className        = 'swipe-overlay ' + (correct ? 'hit' : 'miss');
  animOverlay.textContent      = correct ? 'Got it' : 'Miss';
  animOverlay.style.opacity    = '1';

  animScene.style.willChange  = 'transform, opacity';
  animScene.style.transition = `transform ${ANIM_FLY_MS}ms var(--ease), opacity ${ANIM_FLY_MS}ms ease`;
  animScene.style.transform  = `translate3d(${dir * ANIM_FLY_PX}px,0,0) rotateZ(${dir * ANIM_MAX_TILT}deg)`;
  animScene.style.opacity    = '0';

  setTimeout(() => {
    animOverlay.style.opacity = '0';
    animOverlay.className     = 'swipe-overlay';
    animOverlay.textContent   = '';
    animScene.style.transition  = 'none';
    animScene.style.willChange  = '';
    animScene.style.transform   = '';
    animScene.style.opacity     = '';
    isAnimating = false;
    answer(correct);
  }, ANIM_FLY_MS);
}

// ── Swipe gestures (mobile) ────────────────────────────────────
(function () {
  animScene   = elCard.parentElement;
  animOverlay = document.getElementById('swipe-overlay');

  const scene   = animScene;
  const overlay = animOverlay;

  let startX = 0, startY = 0, dragging = false;

  function resetOverlay(animated) {
    if (animated) {
      overlay.style.transition = 'opacity 200ms ease';
      overlay.style.opacity    = '0';
      setTimeout(() => { overlay.style.transition = ''; overlay.className = 'swipe-overlay'; overlay.textContent = ''; }, 200);
    } else {
      overlay.style.transition = '';
      overlay.style.opacity    = '0';
      overlay.className        = 'swipe-overlay';
      overlay.textContent      = '';
    }
  }

  function resetScene(animated) {
    scene.style.transition = animated ? `transform ${FLIP_MS}ms var(--ease)` : 'none';
    scene.style.transform  = '';
    setTimeout(() => { scene.style.transition = ''; }, animated ? FLIP_MS : 0);
  }

  elCard.addEventListener('touchstart', e => {
    startX   = e.changedTouches[0].clientX;
    startY   = e.changedTouches[0].clientY;
    dragging = false;
  }, { passive: true });

  elCard.addEventListener('touchmove', e => {
    if (!isFlipped) return;
    const dx    = e.changedTouches[0].clientX - startX;
    const dy    = e.changedTouches[0].clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (!dragging && absDx < 8)        return;
    if (!dragging && absDy > absDx)    return;
    dragging = true;
    e.preventDefault();

    const tilt = Math.min(absDx / ANIM_THRESHOLD, 1) * ANIM_MAX_TILT * Math.sign(dx);
    scene.style.transition   = 'none';
    scene.style.transform    = `translateX(${dx}px) rotateZ(${tilt}deg)`;
    overlay.style.transition = 'none';

    const ratio = Math.min(absDx / ANIM_THRESHOLD, 1);
    const isHit = dx > 0;
    overlay.className     = 'swipe-overlay ' + (isHit ? 'hit' : 'miss');
    overlay.textContent   = isHit ? 'Got it' : 'Miss';
    overlay.style.opacity = String(ratio);
  }, { passive: false });

  elCard.addEventListener('touchend', e => {
    if (!isFlipped || !dragging) { dragging = false; resetOverlay(false); return; }
    dragging = false;

    const dx        = e.changedTouches[0].clientX - startX;
    const dy        = e.changedTouches[0].clientY - startY;
    const absDx     = Math.abs(dx);
    const absDy     = Math.abs(dy);
    const committed = absDx >= ANIM_THRESHOLD && absDx > absDy * 1.5;

    if (committed) {
      e.preventDefault();
      scene.style.transition = 'none';
      scene.style.transform  = '';
      scene.style.opacity    = '';
      overlay.style.opacity  = '0';
      overlay.className      = 'swipe-overlay';
      overlay.textContent    = '';
      commitAnswer(dx > 0);
    } else {
      resetOverlay(true);
      resetScene(true);
    }
  });
})();

// ── Keyboard shortcuts ─────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!document.getElementById('screen-study').classList.contains('active')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;   // keep browser shortcuts such as Cmd+Left
  // Space and Enter on a focused button (Undo, Exit, Miss, Got it) keep their normal action
  const onControl = e.target.closest && e.target.closest('button, a, input, select, textarea');
  if ((e.code === 'Space' || e.code === 'Enter') && onControl) return;
  if      (e.code === 'Space' || (e.code === 'Enter' && e.target === elCard)) { e.preventDefault(); flipCard(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); if (isFlipped) commitAnswer(true); }
  else if (e.code === 'ArrowLeft')  { e.preventDefault(); if (isFlipped) commitAnswer(false); }
});

// ── Button event listeners ─────────────────────────────────────
document.getElementById('toggle-all-btn').addEventListener('click', toggleAll);
document.getElementById('btn-back-to-load').addEventListener('click', () => showScreen('screen-load'));
document.getElementById('start-btn').addEventListener('click', () => startStudy(null));
document.getElementById('btn-goback').addEventListener('click', goBack);
document.getElementById('btn-exit-study').addEventListener('click', exitStudy);
elCard.addEventListener('click', flipCard);
document.getElementById('btn-hit').addEventListener('click',  () => commitAnswer(true));
document.getElementById('btn-miss').addEventListener('click', () => commitAnswer(false));
document.getElementById('btn-study-again').addEventListener('click',    () => startStudy(selectionDeck.slice()));
// Undo the answer to the last card: back to the study screen, on that card (B16)
document.getElementById('btn-undo-last').addEventListener('click', () => {
  showScreen('screen-study');
  goBack();
  elCard.focus({ preventScroll: true });
});
document.getElementById('btn-missed').addEventListener('click', () => {
  // Resolve missed card IDs back to card objects from lastDeck
  const missedSet = new Set(missedCards);
  startStudy(lastDeck.filter(c => missedSet.has(c._id)));
});
document.getElementById('btn-change-sections').addEventListener('click', () => {
  showScreen('screen-select');
  refreshSaveToggle();
});
document.getElementById('btn-load-new').addEventListener('click',        () => showScreen('screen-load'));

// ── Tap hint text ──────────────────────────────────────────────
document.querySelector('.tap-hint-text').textContent =
  'ontouchstart' in window ? 'Tap to reveal' : 'Click to reveal';

// ── Init ───────────────────────────────────────────────────────
renderDeckList();
