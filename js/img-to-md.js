// ── State ──────────────────────────────────────────────────────
// Each entry: { id, key, alt, dataUri, filename, size, type, width, height, note }
const entries = [];
let nextId    = 1;

const VALID_TYPES = ['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'];
const EXT_TYPES   = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

// Entry ids with an invalid key; while not empty, copying is disabled (the output has the old key)
const invalidKeys = new Set();

// Some systems give no MIME type (for example for some SVG files): use the file extension then
function imageType(file) {
  return file.type || EXT_TYPES[file.name.split('.').pop().toLowerCase()] || '';
}
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

// Markdown matches reference labels without regard to capitals, so "Sun" and "sun" are the same key
function allKeys() {
  return entries.map(e => e.key.toLowerCase());
}

function isDuplicateKey(key, excludeId) {
  return entries.some(e => e.id !== excludeId && e.key.toLowerCase() === key.toLowerCase());
}

// The Markdown that shows an image on a card
function snippetFor(entry) {
  return `![${entry.alt || entry.key}][${entry.key}]`;
}

// ── Image processing ───────────────────────────────────────────
// Images become smaller before they go into the deck:
//   - The longest side becomes at most MAX_SIDE px. The panel in the app is at most 540 CSS px
//     wide, so 1200 px stays sharp on screens with 2x pixel density.
//   - A photo (no transparency, many colors) becomes JPEG. Line art and images with
//     transparency stay PNG, because JPEG blurs sharp edges and has no transparency.
//     Safari cannot encode WebP from a canvas, so WebP input becomes PNG or JPEG too.
//   - SVG and GIF stay as they are (SVG scales without loss, a GIF can be animated).
//   - If the result is not smaller than the original file, the original file is kept. Pixel size
//     matters less than byte size: the app scales an image down to the panel width anyway.
const MAX_SIDE        = 1200;
const JPEG_QUALITY    = 0.85;
const PHOTO_MIN_COLORS = 4096;   // more distinct colors than this (in a sample) means "photo"

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The image could not be decoded')); };
    img.src = url;
  });
}

// True if the image has no transparent pixels and many distinct colors (sampled)
function looksLikePhoto(ctx, w, h) {
  const data   = ctx.getImageData(0, 0, w, h).data;
  const step   = Math.max(1, Math.floor((w * h) / 50000)) * 4;   // at most ~50,000 samples
  const colors = new Set();
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] < 255) return false;
    if (colors.size <= PHOTO_MIN_COLORS) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return colors.size > PHOTO_MIN_COLORS;
}

// Returns { dataUri, width, height, note } for one file
async function processImage(file) {
  const type = imageType(file);
  let original = await readAsDataURL(file);
  // Without a MIME type, FileReader writes "data:application/octet-stream;..."
  if (!file.type) original = original.replace(/^data:[^;,]*/, 'data:' + type);
  if (type === 'image/svg+xml' || type === 'image/gif') {
    return { dataUri: original, width: null, height: null, note: 'kept as is' };
  }

  const img    = await loadImage(file);
  const scale  = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width  = Math.max(1, Math.round(img.naturalWidth  * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  const photo   = looksLikePhoto(ctx, width, height);
  const outType = photo ? 'image/jpeg' : 'image/png';
  const output  = canvas.toDataURL(outType, JPEG_QUALITY);

  if (output.length >= original.length) {
    return { dataUri: original, width: img.naturalWidth, height: img.naturalHeight, note: 'kept as is (smaller)' };
  }
  const label = photo ? 'JPEG' : 'PNG';
  return { dataUri: output, width, height, note: scale < 1 ? `scaled down, ${label}` : label };
}

// ── File reading ───────────────────────────────────────────────
function readFiles(files) {
  // Filter out unsupported types and duplicates before starting any reads
  const toRead = [];
  const duplicates = [];
  const unsupported = [];
  for (const file of files) {
    if (!VALID_TYPES.includes(imageType(file))) {
      unsupported.push(file.name);
      continue;
    }
    if (entries.some(e => e.filename === file.name)) {
      duplicates.push(file.name);
      continue;
    }
    toRead.push(file);
  }
  // One alert for all rejected files, not one per file
  if (unsupported.length) {
    alert(`${unsupported.length === 1 ? `"${unsupported[0]}" is` : `${unsupported.length} files are`} not a supported image type and ${unsupported.length === 1 ? 'was' : 'were'} skipped. Use PNG, JPEG, WebP, GIF, or SVG.`);
  }
  if (duplicates.length) {
    alert(`${duplicates.length === 1 ? `"${duplicates[0]}" is` : `${duplicates.length} files are`} already added and ${duplicates.length === 1 ? 'was' : 'were'} skipped.`);
  }
  if (!toRead.length) return;

  // Process all files, then add them in the order the user chose them and render once
  Promise.allSettled(toRead.map(processImage)).then(results => {
    results.forEach((r, i) => {
      const file = toRead[i];
      if (r.status === 'rejected') {
        console.error(r.reason);
        alert(`Could not read "${file.name}".`);
        return;
      }
      entries.push({
        id:       nextId++,
        key:      uniqueKey(filenameToKey(file.name)),
        alt:      '',
        dataUri:  r.value.dataUri,
        filename: file.name,
        size:     file.size,
        type:     imageType(file),
        width:    r.value.width,
        height:   r.value.height,
        note:     r.value.note
      });
    });
    renderList();
    renderOutput();
  });
}

function uniqueKey(base) {
  const existing = new Set(allKeys());  // snapshot once — avoid O(n²) allKeys() calls in loop
  let key = base, n = 2;
  while (existing.has(key.toLowerCase())) key = base + '_' + n++;
  return key;
}

// ── Render ─────────────────────────────────────────────────────
function renderList() {
  invalidKeys.clear();   // the rebuilt inputs show the stored (valid) keys
  refreshCopyState();
  const list = document.getElementById('img-list');
  if (!entries.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = entries.map(e => `
    <div class="img-item" data-id="${e.id}">
      <img class="img-thumb" src="${e.dataUri}" alt="">
      <div class="img-body">
        <span class="img-meta" title="${esc(e.filename)}">${esc(e.filename)} · ${formatBytes(e.size)} → ${formatBytes(e.dataUri.length)} in the deck${e.width ? ` · ${e.width}×${e.height}` : ''} · ${esc(e.note)}</span>
        <div class="key-row">
          <span class="key-label">Key</span>
          <input class="key-input" type="text" value="${esc(e.key)}"
                 spellcheck="false" autocomplete="off"
                 data-id="${e.id}" aria-label="Image key name">
        </div>
        <span class="key-warning" id="warn-${e.id}">The key must start with a letter or _, contain only letters, digits, _ or -, and differ from the other keys (capitals do not count).</span>
        <div class="key-row">
          <span class="key-label">Alt</span>
          <input class="alt-input key-input" type="text" value="${esc(e.alt)}"
                 placeholder="Short description of the image"
                 spellcheck="true" autocomplete="off"
                 data-alt-id="${e.id}" aria-label="Image description (alt text)">
        </div>
        <div class="snippet-row">
          <code class="snippet-code" id="snip-${e.id}">${esc(snippetFor(e))}</code>
          <button class="btn-copy-small" data-copy-snip="${e.id}">Copy</button>
        </div>
      </div>
      <button class="btn-remove" data-remove="${e.id}" title="Remove">
        <svg width="13" height="13" aria-hidden="true"><use href="img/icons.svg#icon-exit"/></svg>
      </button>
    </div>
  `).join('');

  // Key input handlers
  list.querySelectorAll('.key-input:not(.alt-input)').forEach(input => {
    input.addEventListener('input', () => {
      const id  = +input.dataset.id;
      const key = input.value.trim();
      const entry = entries.find(e => e.id === id);
      if (!entry) return;

      const warn = document.getElementById(`warn-${id}`);
      const valid = KEY_RE.test(key) && !isDuplicateKey(key, id);

      input.classList.toggle('invalid', !valid);
      if (warn) warn.classList.toggle('visible', !KEY_RE.test(key) || isDuplicateKey(key, id));

      // While the key is invalid, the snippet and the output keep the last valid key:
      // mark them as out of date and disable copying (I3)
      const snip = document.getElementById(`snip-${id}`);
      const copy = document.querySelector(`[data-copy-snip="${id}"]`);
      if (valid) {
        entry.key = key;
        if (snip) snip.textContent = snippetFor(entry);
        invalidKeys.delete(id);
        renderOutput();
      } else {
        invalidKeys.add(id);
      }
      if (snip) snip.classList.toggle('stale', !valid);
      if (copy) copy.disabled = !valid;
      refreshCopyState();
    });
  });

  // Alt text handlers
  list.querySelectorAll('.alt-input').forEach(input => {
    input.addEventListener('input', () => {
      const id    = +input.dataset.altId;
      const entry = entries.find(e => e.id === id);
      if (!entry) return;
      entry.alt = input.value.replace(/[\[\]]/g, '').trim();   // brackets would break the Markdown
      const snip = document.getElementById(`snip-${id}`);
      if (snip) snip.textContent = snippetFor(entry);
    });
  });

  // Remove buttons
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = +btn.dataset.remove;
      const idx = entries.findIndex(e => e.id === id);
      if (idx !== -1) entries.splice(idx, 1);
      invalidKeys.delete(id);
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
      copyText(snippetFor(entry), btn);
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

  // Reference definitions: "[key]: data:..." — one line per image
  pre.textContent     = entries.map(e => `[${e.key}]: ${e.dataUri}`).join('\n');
  const total = entries.reduce((n, e) => n + e.dataUri.length, 0);
  document.getElementById('output-total').textContent =
    `${entries.length} image${entries.length !== 1 ? 's' : ''} · ${formatBytes(total)} in the deck`;
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

// ── Escape helper ──────────────────────────────────────────────
// Escapes text for HTML content and attribute values. js/flashcards.js has the same function.
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// Disable "Copy definitions" and show a note while a key is invalid
function refreshCopyState() {
  const blocked = invalidKeys.size > 0;
  document.getElementById('btn-copy-all').disabled = blocked;
  document.getElementById('output-stale').style.display = blocked ? '' : 'none';
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
