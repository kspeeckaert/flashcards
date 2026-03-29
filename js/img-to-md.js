// ── State ──────────────────────────────────────────────────────
// Each entry: { id, key, dataUri, filename, size, type }
const entries = [];
let nextId    = 1;

const VALID_TYPES = ['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'];
const KEY_RE      = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// ── Helpers ────────────────────────────────────────────────────
function filenameToKey(name) {
  return name
    .replace(/\.[^.]+$/, '')           // strip extension
    .replace(/[^a-zA-Z0-9_-]/g, '_')  // invalid chars → underscore
    .replace(/^([^a-zA-Z_])/, '_$1')  // ensure valid start
    .slice(0, 40)
    || 'image';
}

function formatBytes(n) {
  if (n < 1024)       return n + ' B';
  if (n < 1024*1024)  return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}

function allKeys() {
  return entries.map(e => e.key);
}

function isDuplicateKey(key, excludeId) {
  return entries.some(e => e.id !== excludeId && e.key === key);
}

// ── File reading ───────────────────────────────────────────────
function readFiles(files) {
  // Filter out unsupported types and duplicates before starting any reads
  const toRead = [];
  const duplicates = [];
  for (const file of files) {
    if (!VALID_TYPES.includes(file.type)) {
      alert(`"${file.name}" is not a supported image type. Use PNG, JPEG, WebP, GIF, or SVG.`);
      continue;
    }
    if (entries.some(e => e.filename === file.name)) {
      duplicates.push(file.name);
      continue;
    }
    toRead.push(file);
  }
  if (duplicates.length) {
    alert(`${duplicates.length === 1 ? `"${duplicates[0]}" is` : `${duplicates.length} files are`} already added and ${duplicates.length === 1 ? 'was' : 'were'} skipped.`);
  }
  if (!toRead.length) return;

  // Read all files, then render once when the last one completes
  let pending = toRead.length;
  function onDone() {
    if (--pending === 0) { renderList(); renderOutput(); }
  }

  for (const file of toRead) {
    const reader = new FileReader();
    reader.onload = ev => {
      entries.push({
        id:       nextId++,
        key:      uniqueKey(filenameToKey(file.name)),
        dataUri:  ev.target.result,
        filename: file.name,
        size:     file.size,
        type:     file.type
      });
      onDone();
    };
    reader.onerror = () => { alert(`Could not read "${file.name}".`); onDone(); };
    reader.readAsDataURL(file);
  }
}

function uniqueKey(base) {
  const existing = new Set(allKeys());  // snapshot once — avoid O(n²) allKeys() calls in loop
  let key = base, n = 2;
  while (existing.has(key)) key = base + '_' + n++;
  return key;
}

// ── Render ─────────────────────────────────────────────────────
function renderList() {
  const list = document.getElementById('img-list');
  if (!entries.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = entries.map(e => `
    <div class="img-item" data-id="${e.id}">
      <img class="img-thumb" src="${e.dataUri}" alt="">
      <div class="img-body">
        <span class="img-meta">${escHtml(e.filename)} · ${formatBytes(e.size)}</span>
        <div class="key-row">
          <span class="key-label">Key</span>
          <input class="key-input" type="text" value="${escAttr(e.key)}"
                 spellcheck="false" autocomplete="off"
                 data-id="${e.id}" aria-label="Image key name">
        </div>
        <span class="key-warning" id="warn-${e.id}">Key must start with a letter or _ and contain only letters, digits, _ or -</span>
        <div class="snippet-row">
          <code class="snippet-code" id="snip-${e.id}">&lt;!-- img:${escHtml(e.key)} --&gt;</code>
          <button class="btn-copy-small" data-copy-snip="${e.id}">Copy</button>
        </div>
      </div>
      <button class="btn-remove" data-remove="${e.id}" title="Remove">
        <svg width="13" height="13" aria-hidden="true"><use href="img/icons.svg#icon-exit"/></svg>
      </button>
    </div>
  `).join('');

  // Key input handlers
  list.querySelectorAll('.key-input').forEach(input => {
    input.addEventListener('input', () => {
      const id  = +input.dataset.id;
      const key = input.value.trim();
      const entry = entries.find(e => e.id === id);
      if (!entry) return;

      const warn = document.getElementById(`warn-${id}`);
      const valid = KEY_RE.test(key) && !isDuplicateKey(key, id);

      input.classList.toggle('invalid', !valid);
      if (warn) warn.classList.toggle('visible', !KEY_RE.test(key) || isDuplicateKey(key, id));

      if (valid) {
        entry.key = key;
        const snip = document.getElementById(`snip-${id}`);
        if (snip) snip.textContent = `<!-- img:${key} -->`;
        renderOutput();
      }
    });
  });

  // Remove buttons
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = +btn.dataset.remove;
      const idx = entries.findIndex(e => e.id === id);
      if (idx !== -1) entries.splice(idx, 1);
      renderList();
      renderOutput();
    });
  });

  // Snippet copy buttons
  list.querySelectorAll('[data-copy-snip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id    = +btn.dataset.copySnip;
      const entry = entries.find(e => e.id === id);
      if (!entry) return;
      copyText(`<!-- img:${entry.key} -->`, btn);
    });
  });
}

function renderOutput() {
  const panel = document.getElementById('output-panel');
  const pre   = document.getElementById('output-pre');

  if (!entries.length) {
    panel.style.display = 'none';
    return;
  }

  const lines = ['---', 'images:'];
  for (const e of entries) {
    lines.push(`  ${e.key}: ${e.dataUri}`);
  }
  lines.push('---');

  pre.textContent     = lines.join('\n');
  panel.style.display = '';
}

// ── Copy helper ────────────────────────────────────────────────
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    // Target a <span> child when present so SVG siblings are not clobbered
    const labelEl = btn.querySelector('span') || btn;
    const orig = labelEl.textContent;
    labelEl.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      labelEl.textContent = orig;
      btn.classList.remove('copied');
    }, 1800);
  }).catch(() => alert('Could not copy. Please select and copy manually.'));
}

// ── Escape helpers ─────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(s) {
  return s.replace(/"/g,'&quot;');
}

// ── Drop zone ──────────────────────────────────────────────────
(function () {
  const zone = document.getElementById('drop-zone');
  ['dragover','drop'].forEach(e => document.addEventListener(e, ev => ev.preventDefault()));
  zone.addEventListener('dragenter',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragover',   e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave',  e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop',       e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    readFiles([...e.dataTransfer.files]);
  });
})();

// ── File input ─────────────────────────────────────────────────
document.getElementById('btn-choose').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', function () {
  readFiles([...this.files]);
  this.value = '';
});

// ── Copy all ───────────────────────────────────────────────────
document.getElementById('btn-copy-all').addEventListener('click', function () {
  const text = document.getElementById('output-pre').textContent;
  copyText(text, this);
});
