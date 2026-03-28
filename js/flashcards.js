// ── marked config ──────────────────────────────────────────────
marked.use({ breaks: true });

// ── State ──────────────────────────────────────────────────────
let parsedDeck        = null;   // { filename, name, sections: [{title, cards:[{front,back,imageKey}]}], images:{} }
let activeDeck        = [];
let lastDeck          = [];
let missedCards       = [];
let cardIndex         = 0;
let hits              = 0;
let misses            = 0;
let isFlipped         = false;
let isReversed        = false;
let isAnimating       = false;
let prevState         = null;
let canGoBack         = false;
let btnShowTimeout    = null;

// Persistence state
let saveEnabled          = false;
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
const STORAGE_KEY = 'fc_decks';
const MAX_DECKS   = 10;

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
  } catch {
    alert('Could not save — your browser may be blocking localStorage or storage is full.');
  }
}

function saveDeck() {
  if (hasSavedCurrentDeck) return;
  const decks = getDecks();
  if (decks.length >= MAX_DECKS) {
    alert(`You can store up to ${MAX_DECKS} decks. Remove one to save a new deck.`);
    return;
  }
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
  document.getElementById('save-knob').classList.remove('on');
  buildSelectScreen();
  showScreen('screen-select');
}

// ── Deck swipe-to-delete (touch) ───────────────────────────────
function initDeckSwipe() {
  const SNAP_PX   = 76;
  const THRESHOLD = 36;

  document.querySelectorAll('.deck-item').forEach(item => {
    const inner = item.querySelector('.deck-item-inner');
    let startX  = 0, startY = 0, dragging = false, revealed = false;

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

      const base   = revealed ? -SNAP_PX : 0;
      const offset = Math.max(-SNAP_PX, Math.min(0, base + dx));
      inner.style.transform = `translateX(${offset}px)`;
    }, { passive: false });

    inner.addEventListener('touchend', e => {
      if (!dragging) return;
      dragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      inner.style.transition = 'transform .25s var(--ease)';

      if ((!revealed && dx < -THRESHOLD) || (revealed && dx < THRESHOLD)) {
        inner.style.transform = `translateX(-${SNAP_PX}px)`;
        revealed = true;
      } else {
        inner.style.transform = '';
        revealed = false;
      }
    });
  });

  // Tap outside to collapse any revealed item
  document.addEventListener('touchstart', e => {
    document.querySelectorAll('.deck-item-inner').forEach(inner => {
      if (!inner.closest('.deck-item').contains(e.target)) {
        inner.style.transition = 'transform .25s var(--ease)';
        inner.style.transform  = '';
      }
    });
  }, { passive: true });
}

// ── Screens ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
  if (id === 'screen-load') renderDeckList();
  // Hide image panel when leaving study screen
  if (id !== 'screen-study') {
    elImagePanel.style.display = 'none';
    elImage.src = '';
  }
}

// ── Toggles (reverse + save) ───────────────────────────────────
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
    document.getElementById('save-knob').classList.remove('on');
    buildSelectScreen();
    showScreen('screen-select');
  };
  reader.onerror = () => alert('Could not read the file. Please try again.');
  reader.readAsText(file);
}

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
  zone.addEventListener('drop',       e => { e.preventDefault(); zone.classList.remove('drag-over'); loadFile(e.dataTransfer.files[0]); });
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
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fmMatch) {
    body = text.slice(fmMatch[0].length);
    const fmBlock = fmMatch[1];
    // Parse `images:` section — each entry is an indented `key: data-uri` line
    const imgBlock = fmBlock.match(/^images:\r?\n((?:[ \t]+\S[^\r\n]*(?:\r?\n|$))*)/m);
    if (imgBlock) {
      for (const line of imgBlock[1].split('\n')) {
        const m = line.match(/^[ \t]+([\w][\w-]*):\s*(.+)/);
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

  function saveCard() {
    if (!card) return;
    const back = backBuf.join('\n').trim();
    if (back) {
      section.cards.push({ front: card, back, imageKey: cardImgKey });
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
      const imgRef = rawLine.match(/<!--\s*img:([\w][\w-]*)\s*-->/);
      if (imgRef) { cardImgKey = imgRef[1]; continue; }
      backBuf.push(rawLine.trimEnd());
    }
  }

  saveSection();

  if (skipped) {
    alert(`${skipped} card${skipped !== 1 ? 's were' : ' was'} skipped (no answer text).`);
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
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  if (typeof renderMathInElement !== 'undefined') {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false }
      ],
      throwOnError: false
    });
  }
  fitText(el);
}

function fitText(el) {
  // Skip aggressive scaling when display math is present — KaTeX manages its own sizing
  if (el.querySelector('.katex-display')) return;
  el.style.fontSize = '';
  let lo = 11;
  let hi = parseFloat(getComputedStyle(el).fontSize);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    el.style.fontSize = mid + 'px';
    if (el.scrollHeight > el.clientHeight) hi = mid - 1;
    else lo = mid + 1;
  }
  el.style.fontSize = hi + 'px';
}

// ── Section select screen ──────────────────────────────────────
const chkSVG = `<svg aria-hidden="true"><use href="img/icons.svg#icon-check"/></svg>`;

function buildSelectScreen() {
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
  document.getElementById('save-toggle').style.display = hasSavedCurrentDeck ? 'none' : '';
}

// ── Study ──────────────────────────────────────────────────────
function startStudy(cardsOverride) {
  if (cardsOverride) {
    activeDeck = shuffle([...cardsOverride]);
  } else {
    const items   = [...document.querySelectorAll('.section-item')];
    const checked = items.filter(i => i.querySelector('input').checked);
    if (!checked.length) return;
    const cards   = checked.flatMap(el => parsedDeck.sections[+el.dataset.idx].cards);
    activeDeck    = shuffle([...cards]);
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
  isFlipped = false;
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
    elImage.src = '';
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

  if (!correct) missedCards.push(activeDeck[cardIndex]);
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
    const idx = missedCards.indexOf(prevState.card);
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

  animScene.style.transition = `transform ${ANIM_FLY_MS}ms var(--ease), opacity ${ANIM_FLY_MS}ms ease`;
  animScene.style.transform  = `translate3d(${dir * ANIM_FLY_PX}px,0,0) rotateZ(${dir * ANIM_MAX_TILT}deg)`;
  animScene.style.opacity    = '0';

  setTimeout(() => {
    animOverlay.style.opacity = '0';
    animOverlay.className     = 'swipe-overlay';
    animOverlay.textContent   = '';
    animScene.style.transition = 'none';
    animScene.style.transform  = '';
    animScene.style.opacity    = '';
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
document.getElementById('btn-missed').addEventListener('click',         () => startStudy(missedCards.slice()));
document.getElementById('btn-change-sections').addEventListener('click', () => showScreen('screen-select'));
document.getElementById('btn-load-new').addEventListener('click',        () => showScreen('screen-load'));

// ── Tap hint text ──────────────────────────────────────────────
document.querySelector('.tap-hint-text').textContent =
  'ontouchstart' in window ? 'Tap to reveal' : 'Click to reveal';

// ── Init ───────────────────────────────────────────────────────
renderDeckList();
