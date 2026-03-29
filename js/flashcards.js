// ── KaTeX lazy loader ──────────────────────────────────────────
// KaTeX JS (~250 KB) is only injected the first time a card with maths is
// rendered. Subsequent calls are no-ops once the scripts have loaded.
let _katexState = 'idle'; // 'idle' | 'loading' | 'ready'
let _katexQueue = [];     // callbacks waiting for KaTeX to finish loading

function loadKaTeX(cb) {
  if (_katexState === 'ready')   { cb(); return; }
  if (_katexState === 'loading') { _katexQueue.push(cb); return; }
  _katexState = 'loading';
  _katexQueue.push(cb);

  function onReady() {
    _katexState = 'ready';
    _katexQueue.forEach(fn => fn());
    _katexQueue = [];
  }

  // Load katex.min.js first, then auto-render (depends on katex)
  const s1 = document.createElement('script');
  s1.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
  s1.integrity = 'sha384-7zkQWkzuo3B5mTepMUcHkMB5jZaolc2xDwL6VFqjFALcbeS9Ggm/Yr2r3Dy4lfFg';
  s1.crossOrigin = 'anonymous';
  s1.onload = () => {
    const s2 = document.createElement('script');
    s2.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js';
    s2.integrity = 'sha384-43gviWU0YVjaDtb/GhzOouOXtZMP/7XUzwPTstBeZFe/+rCMvRwr4yROQP43s0Xk';
    s2.crossOrigin = 'anonymous';
    s2.onload = onReady;
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}

// ── marked config ──────────────────────────────────────────────
// (called inside DOMContentLoaded — marked is loaded with defer)

// ── State ──────────────────────────────────────────────────────
let parsedDeck        = null;   // { filename, name, sections: [{title, cards:[{_id,front,back,imageKey}]}], images:{} }
let activeDeck        = [];
let lastDeck          = [];
let missedCards       = [];     // stores card._id values (integers), not card objects
let cardIndex         = 0;
let hits              = 0;
let misses            = 0;
let isFlipped         = false;
let isReversed        = false;
let isShuffled        = true;
let isAnimating       = false;
let prevState         = null;
let canGoBack         = false;
let btnShowTimeout    = null;

// Persistence state
let saveEnabled          = false;
let saveBlocked          = false;
let hasSavedCurrentDeck  = false;
let currentRawMarkdown   = '';
let currentFilename      = '';

const FLIP_MS        = 420;
const ANIM_THRESHOLD = 80;
const ANIM_MAX_TILT  = 12;
const ANIM_FLY_PX    = 420;
const ANIM_FLY_MS    = 380;

// Assigned in swipe IIFE
let animScene   = null;
let animOverlay = null;

// ── Helpers ────────────────────────────────────────────────────
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── DOM refs ───────────────────────────────────────────────────
const elCard        = document.getElementById('card');
const elCardFront   = document.getElementById('card-front');
const elCardBack    = document.getElementById('card-back');
const elAnswerBtns  = document.getElementById('answer-btns');
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
const elImagePanel  = document.getElementById('card-image-panel');
const elImage       = document.getElementById('card-image');

// ── Storage ────────────────────────────────────────────────────
const STORAGE_KEY   = 'fc_decks';
const STORAGE_QUOTA = 5 * 1024 * 1024; // 5 MB — only quota enforced

let _storageUsedCache = null;

function getStorageUsed() {
  if (_storageUsedCache !== null) return _storageUsedCache;
  let bytes = 0;
  for (const key in localStorage) {
    if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
      bytes += (key.length + localStorage[key].length) * 2;
    }
  }
  _storageUsedCache = bytes;
  return bytes;
}

function invalidateStorageCache() { _storageUsedCache = null; }

function updateStorageMeter() {
  const meter = document.getElementById('storage-meter');
  if (!meter) return;
  const decks = getDecks();
  if (!decks.length) { meter.style.display = 'none'; return; }
  const pct   = Math.min(100, Math.round(getStorageUsed() / STORAGE_QUOTA * 100));
  const avail = 100 - pct;
  meter.textContent = `${avail}% storage available`;
  meter.classList.toggle('low', avail < 20);
  meter.style.display = '';
}

function getDecks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function setDecks(decks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
    invalidateStorageCache();
  } catch {
    alert('Could not save — your browser may be blocking localStorage or storage is full.');
  }
}

function saveDeck() {
  if (hasSavedCurrentDeck) return;
  const decks = getDecks();
  const totalCards = parsedDeck.sections.reduce((n, s) => n + s.cards.length, 0);
  decks.push({
    id:        Date.now().toString(36) + Math.random().toString(36).slice(2),
    name:      parsedDeck.name,
    raw:       currentRawMarkdown,
    sections:  parsedDeck.sections.length,
    cards:     totalCards,
    createdAt: new Date().toISOString().slice(0, 10)
  });
  setDecks(decks);
  hasSavedCurrentDeck = true;
}

function deleteDeck(id) {
  if (!confirm('Delete this deck?')) return;
  setDecks(getDecks().filter(d => d.id !== id));
  renderDeckList();
}

// ── Deck library ───────────────────────────────────────────────
const trashSVG = `<svg width="14" height="14" aria-hidden="true"><use href="img/icons.svg#icon-trash"/></svg>`;

function renderDeckList() {
  const decks   = getDecks();
  const library = document.getElementById('deck-library');
  const list    = document.getElementById('deck-list');

  if (!decks.length) { library.style.display = 'none'; return; }

  library.style.display = '';
  list.innerHTML = decks.map(deck => {
    const secLabel  = `${deck.sections} section${deck.sections !== 1 ? 's' : ''}`;
    const cardLabel = `${deck.cards} card${deck.cards !== 1 ? 's' : ''}`;
    return `<div class="deck-item" data-id="${deck.id}">
      <div class="deck-item-inner">
        <div class="deck-item-content">
          <span class="deck-item-name">${esc(deck.name)}</span>
          <span class="deck-item-meta">${secLabel} · ${cardLabel} · ${deck.createdAt}</span>
        </div>
        <button class="deck-delete-btn" title="Delete deck">${trashSVG}</button>
      </div>
      <button class="deck-delete-reveal">Delete</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.deck-item').forEach(item => {
    const id = item.dataset.id;
    item.querySelector('.deck-item-inner').addEventListener('click', () => loadDeckById(id));
    item.querySelector('.deck-delete-btn').addEventListener('click', e => { e.stopPropagation(); deleteDeck(id); });
    item.querySelector('.deck-delete-reveal').addEventListener('click', e => { e.stopPropagation(); deleteDeck(id); });
  });

  initDeckSwipe();
  updateStorageMeter();
}

function loadDeckById(id) {
  const stored = getDecks().find(d => d.id === id);
  if (!stored) return;
  currentRawMarkdown  = stored.raw;
  currentFilename     = stored.name;
  const deck = parseMD(stored.raw, stored.name);
  if (!deck.sections.length) return;
  parsedDeck          = deck;
  hasSavedCurrentDeck = true;  // already persisted — don't re-save
  saveEnabled         = false;
  saveBlocked         = false;
  document.getElementById('save-knob').classList.remove('on');
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
    elImagePanel.style.display = 'none';
    elImage.removeAttribute('src');
  }
}

// ── Toggles (reverse + save) ───────────────────────────────────
document.getElementById('shuffle-toggle').addEventListener('click', () => {
  isShuffled = !isShuffled;
  document.getElementById('shuffle-knob').classList.toggle('on', isShuffled);
});

document.getElementById('reverse-toggle').addEventListener('click', () => {
  isReversed = !isReversed;
  document.getElementById('rev-knob').classList.toggle('on', isReversed);
});

document.getElementById('save-toggle').addEventListener('click', () => {
  if (hasSavedCurrentDeck) return;  // already saved, ignore
  saveEnabled = !saveEnabled;
  document.getElementById('save-knob').classList.toggle('on', saveEnabled);
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
    currentFilename     = file.name;
    hasSavedCurrentDeck = false;
    saveEnabled         = false;
    // Measure actual serialised size of the full entry (not just raw * 2, which ignores JSON overhead)
    const totalCards = parsedDeck.sections.reduce((n, s) => n + s.cards.length, 0);
    const testEntry  = JSON.stringify({
      id: '', name: parsedDeck.name, raw,
      sections: parsedDeck.sections.length, cards: totalCards, createdAt: ''
    });
    saveBlocked = (testEntry.length * 2) > (STORAGE_QUOTA - getStorageUsed());
    document.getElementById('save-knob').classList.remove('on');
    buildSelectScreen();
    showScreen('screen-select');
  };
  reader.onerror = () => alert('Could not read the file. Please try again.');
  reader.readAsText(file);
}

document.addEventListener('DOMContentLoaded', () => {

// ── marked config (deferred until marked.js has loaded) ────────
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

// ── Markdown parser — format: # deck / ## section / ### card ──
//
// Supports YAML frontmatter for image deduplication:
//
//   ---
//   images:
//     key_name: data:image/png;base64,...
//   ---
//
// Reference an image from a card back body with:
//   <!-- img:key_name -->
//
function parseMD(text, filename) {
  // ── 1. Extract YAML frontmatter ──
  const images = {};
  let body = text;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (fmMatch) {
    body = text.slice(fmMatch[0].length);
    const fmBlock = fmMatch[1];
    // Parse `images:` section — each entry is an indented `key: data-uri` line
    const imgBlock = fmBlock.match(/^images:\r?\n((?:[ \t]+\S[^\r\n]*(?:\r?\n|$))*)/m);
    if (imgBlock) {
      for (const line of imgBlock[1].split('\n')) {
        const m = line.match(/^[ \t]+([a-zA-Z_][\w-]*):\s*(.+)/);
        if (m) images[m[1]] = m[2].trim();
      }
    }
  }

  // ── 2. Parse card content ──
  const lines    = body.split('\n');
  const sections = [];
  let deckName   = null;
  let section    = null;
  let card       = null;
  let backBuf    = [];
  let cardImgKey = null;
  let skipped    = 0;
  let deepHd     = 0;  // H4+ headings, silently ignored by the parser

  let cardSeq = 0;

  function saveCard() {
    if (!card) return;
    const back = backBuf.join('\n').trim();
    if (back) {
      // _id is a stable integer identity used for missedCards lookup (avoids reference equality issues)
      section.cards.push({ _id: ++cardSeq, front: card, back, imageKey: cardImgKey });
    } else {
      skipped++;
    }
    card       = null;
    backBuf    = [];
    cardImgKey = null;
  }

  function saveSection() {
    saveCard();
    if (section && section.cards.length) sections.push(section);
    section = null;
  }

  for (const rawLine of lines) {
    const line    = rawLine.trim();
    const hMatch  = line.match(/^(#{1,3}) (.+)/);
    const level   = hMatch ? hMatch[1].length : 0;
    const heading = hMatch ? hMatch[2].trim() : '';

    // Detect H4+ headings the parser cannot use — counted for a post-parse warning
    if (!hMatch && /^#{4,} /.test(line)) { deepHd++; continue; }

    if (level === 1) {
      if (!deckName) deckName = heading;
    } else if (level === 2) {
      saveSection();
      section = { title: heading, cards: [] };
    } else if (level === 3) {
      if (!section) section = { title: 'Cards', cards: [] };
      saveCard();
      card       = heading;
      backBuf    = [];
      cardImgKey = null;
    } else if (card !== null) {
      if (!backBuf.length && !line) continue;  // skip leading blank lines
      // Detect image reference comment — strip from back text, record key
      const imgRef = rawLine.match(/<!--\s*img:([a-zA-Z_][\w-]*)\s*-->/);
      if (imgRef) { cardImgKey = imgRef[1]; continue; }
      backBuf.push(rawLine.trimEnd());
    }
  }

  saveSection();

  if (skipped) {
    alert(`${skipped} card${skipped !== 1 ? 's were' : ' was'} skipped (no answer text).`);
  }
  if (deepHd) {
    alert(`${deepHd} heading${deepHd !== 1 ? 's' : ''} used #### or deeper and were ignored.\n\nOnly # (deck), ## (section), and ### (card front) are supported.`);
  }

  return {
    filename,
    name:     deckName || filename.replace(/\.[^.]+$/, ''),
    sections,
    images
  };
}

// ── Card content rendering ─────────────────────────────────────
function setCardContent(el, text) {
  try {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    fitText(el);
    // Only pay the KaTeX cost (~250 KB JS) when the card actually contains maths
    if (text.includes('$')) {
      loadKaTeX(() => {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false }
          ],
          throwOnError: false
        });
        fitText(el); // re-fit after math renders (glyphs may change dimensions)
      });
    }
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

  // Run the binary search on an off-screen clone so every write/read pair
  // happens on a detached subtree, not the live layout — zero forced reflows
  // on the real element, which stays compositor-friendly during animations.
  const naturalPx = parseFloat(getComputedStyle(el).fontSize);
  const rect      = el.getBoundingClientRect();
  const proxy     = el.cloneNode(true);
  proxy.style.cssText = [
    'position:fixed', 'top:-9999px', 'left:-9999px',
    `width:${rect.width}px`, `height:${h}px`,
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
  // Single write to the live element — no reflow triggered during animation.
  if (hi < Math.floor(naturalPx)) el.style.fontSize = hi + 'px';
}

// ── Section select screen ──────────────────────────────────────
const chkSVG = `<svg aria-hidden="true"><use href="img/icons.svg#icon-check"/></svg>`;

function buildSelectScreen() {
  // Reset shuffle to on every time a deck is (re-)loaded from the main screen
  isShuffled = true;
  document.getElementById('shuffle-knob').classList.add('on');

  document.getElementById('deck-name').textContent = parsedDeck.name;
  const list = document.getElementById('section-list');
  list.innerHTML = parsedDeck.sections.map((sec, i) =>
    `<label class="section-item checked" data-idx="${i}">
      <input type="checkbox" checked>
      <div class="chk">${chkSVG}</div>
      <div class="sec-label">
        <div class="name">${esc(sec.title)}</div>
        <div class="count">${sec.cards.length} card${sec.cards.length !== 1 ? 's' : ''}</div>
      </div>
    </label>`
  ).join('');

  list.querySelectorAll('.section-item').forEach(el =>
    el.addEventListener('click', () => toggleItem(el))
  );

  refreshCount();
  refreshSaveToggle();
}

function toggleItem(el) {
  const cb  = el.querySelector('input');
  cb.checked = !cb.checked;
  el.classList.toggle('checked', cb.checked);
  refreshCount();
}

function toggleAll() {
  const items  = [...document.querySelectorAll('.section-item')];
  const allOn  = items.every(i => i.querySelector('input').checked);
  items.forEach(el => {
    el.querySelector('input').checked = !allOn;
    el.classList.toggle('checked', !allOn);
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
  if (hasSavedCurrentDeck) { toggle.style.display = 'none'; return; }
  toggle.style.display = '';
  toggle.classList.toggle('disabled', saveBlocked);
  toggle.querySelector('.toggle-hint').textContent =
    saveBlocked ? '(not enough storage)' : '(stored in browser)';
  if (saveBlocked) {
    saveEnabled = false;
    document.getElementById('save-knob').classList.remove('on');
  }
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
    activeDeck    = isShuffled ? shuffle([...cards]) : [...cards];
  }

  if (!activeDeck.length) return;

  // Save deck to localStorage if toggled on and not yet saved
  if (saveEnabled && !hasSavedCurrentDeck) saveDeck();

  lastDeck    = [...activeDeck];
  missedCards = [];
  cardIndex   = 0;
  hits        = 0;
  misses      = 0;
  prevState   = null;
  canGoBack   = false;

  showScreen('screen-study');
  refreshBackBtn();
  renderCard();
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

  const front = isReversed ? currentCard.back  : currentCard.front;
  const back  = isReversed ? currentCard.front : currentCard.back;

  setCardContent(elCardFront, front);

  const wasFlipped = elCard.classList.contains('flipped');

  if (btnShowTimeout) { clearTimeout(btnShowTimeout); btnShowTimeout = null; }
  elCard.classList.remove('flipped');
  isFlipped = false;  // always show the new card face-up, including after undo — intentional
  elAnswerBtns.classList.remove('visible');

  // Defer back content to avoid a flash during the flip-back transition
  if (wasFlipped) {
    setTimeout(() => setCardContent(elCardBack, back), FLIP_MS);
  } else {
    setCardContent(elCardBack, back);
  }

  // ── Image panel ──
  const imgKey = currentCard.imageKey;
  const imgSrc = imgKey && parsedDeck.images ? parsedDeck.images[imgKey] : null;
  if (imgSrc) {
    elImage.src = imgSrc;
    elImagePanel.style.display = '';
  } else {
    elImage.removeAttribute('src');
    elImagePanel.style.display = 'none';
  }
}

function flipCard() {
  isFlipped = !isFlipped;
  elCard.classList.toggle('flipped', isFlipped);
  if (isFlipped) {
    btnShowTimeout = setTimeout(() => { btnShowTimeout = null; elAnswerBtns.classList.add('visible'); }, 250);
  } else {
    if (btnShowTimeout) { clearTimeout(btnShowTimeout); btnShowTimeout = null; }
    elAnswerBtns.classList.remove('visible');
  }
}

function answer(correct) {
  prevState = { card: activeDeck[cardIndex], correct, hits, misses, cardIndex };
  canGoBack = true;
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
  canGoBack = false;
  refreshBackBtn();
  renderCard();
}

function refreshBackBtn() {
  elBtnGoBack.style.display = canGoBack ? '' : 'none';
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
  elAnswerBtns.classList.remove('visible');

  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(correct ? 20 : [10, 40, 10]);
  }

  if (!animScene) {
    isAnimating = false;
    return answer(correct);
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
  if      (e.code === 'Space')      { e.preventDefault(); flipCard(); }
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
document.getElementById('btn-study-again').addEventListener('click',    () => startStudy(lastDeck.slice()));
document.getElementById('btn-missed').addEventListener('click', () => {
  // Resolve missed card IDs back to card objects from lastDeck
  const missedSet = new Set(missedCards);
  startStudy(lastDeck.filter(c => missedSet.has(c._id)));
});
document.getElementById('btn-change-sections').addEventListener('click', () => showScreen('screen-select'));
document.getElementById('btn-load-new').addEventListener('click',        () => showScreen('screen-load'));

// ── Tap hint text ──────────────────────────────────────────────
document.querySelector('.tap-hint-text').textContent =
  'ontouchstart' in window ? 'Tap to reveal' : 'Click to reveal';

// ── Init ───────────────────────────────────────────────────────
renderDeckList();

}); // DOMContentLoaded
