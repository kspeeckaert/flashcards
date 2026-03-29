# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A flashcard web app. No build step, no dependencies to install — serve locally with any HTTP server and open in a browser.

A companion tool `img-to-md.html` converts images to base64 and generates the frontmatter block needed for image-enabled decks.

## File structure

```
flashcards.html       Main app — HTML only
css/flashcards.css    All styles
js/flashcards.js      All app logic
img/icons.svg         SVG sprite (UI icons)
img/watermark.svg     Decorative watermark illustration
img-to-md.html        Image-to-base64 helper (standalone)
sample.md             Example deck
```

## Development

Serve locally and open `flashcards.html` in a browser:

```
python3 -m http.server 8080
```

External dependencies (`marked`, `DOMPurify`, `KaTeX`) are loaded from CDNs with `integrity="sha384-…" crossorigin="anonymous"` SRI attributes. If you upgrade a dependency, recompute the hash with `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A` and update the `integrity` attribute in `flashcards.html`.

## Architecture

### Screens

Four `<div class="screen">` elements are shown/hidden via `showScreen(id)`:
- `screen-load` — file upload / saved deck library
- `screen-select` — section picker and study options
- `screen-study` — active card study session
- `screen-done` — results and replay options

### Drag-and-drop

`dragover` and `drop` are suppressed on `document` globally (prevents the browser navigating away on an errant drop). `loadFile` is only called when `screen-load` is the active screen — drops on other screens are silently discarded.

### Markdown format

Cards are parsed by `parseMD()`:
- `#` heading → deck name
- `##` heading → section title
- `###` heading → card front
- Lines following `###` → card back (supports Markdown and LaTeX math)

Math is rendered by KaTeX via `renderMathInElement()` after the marked/DOMPurify pipeline:
- `$...$` → inline math
- `$$...$$` → display (block) math

#### Image support

Decks can embed images using a YAML frontmatter block at the top of the `.md` file:

```md
---
images:
  key_name: data:image/png;base64,...
  another_key: data:image/svg+xml;base64,...
---

# Deck Name
```

Each image is referenced from a card's answer body with an HTML comment:

```md
### Card front
Card back text here
<!-- img:key_name -->
```

Rules:
- The `<!-- img:key -->` comment is stripped from the rendered back text and stored as `card.imageKey`
- Only one image per card is supported
- The image comment is invisible in all standard markdown previewers
- Image keys must start with a letter or underscore and contain only `[a-zA-Z0-9_-]`
- Use `img-to-md.html` to convert image files to base64 and generate the frontmatter block

### Key functions

- `parseMD(text, filename)` — parses markdown into `{ name, sections: [{title, cards:[{_id, front, back, imageKey}]}], images: {key: dataURI} }`; strips YAML frontmatter before card parsing. Each card receives a stable `_id` (integer) assigned during parsing — used for missed-card tracking to avoid reference-equality fragility. `####`+ headings trigger a user-facing warning and are skipped. `###` cards that appear before any `##` section are silently grouped under a synthetic `{ title: 'Cards' }` section — this is intentional to tolerate decks without explicit sections.
- `setCardContent(el, text)` — renders markdown into a card face via `marked` + `DOMPurify` + `renderMathInElement()`, then calls `fitText()`; wrapped in try/catch, falls back to plain text on error
- `fitText(el)` — binary-search font-size to fit card content without overflow. Runs the search on a detached off-screen clone so no forced reflows occur on the live element; applies the result in a single write. KaTeX scales proportionally with inherited `font-size` (`1em`) so no special treatment is needed for display math.
- `renderCard()` — updates the DOM for the current card, including showing/hiding the image panel
- `commitAnswer(hit)` — records the answer, triggers swipe/fly animation, advances to next card
- `showScreen(id)` — switches the active screen; clears image panel when leaving study screen

### State

All state is module-level variables (`activeDeck`, `cardIndex`, `hits`, `misses`, `isFlipped`, `isReversed`, `prevState`, etc.). There is no framework.

`missedCards` stores card `_id` integers (not card objects) to avoid reference-equality fragility across shuffled copies. "Study missed" resolves them back to card objects via a `Set` lookup against `lastDeck`.

`deckSwipeRevealed` is a module-level `Map<deckId, bool>` shared between `initDeckSwipe()` and the global `touchstart` handler so both the DOM transform reset and the logical revealed state stay in sync when the deck list rebuilds.

The undo feature supports a single level of undo only — `prevState` captures the state before the last committed answer, and undoing restores it. This is by design: multi-level undo adds complexity with little practical benefit for a flashcard study flow. Undo always returns the card face-up — intentional.

### Persistence

Decks are saved to `localStorage` under the key `fc_decks` (no hard count cap — storage is bounded by a 5 MB quota). Each entry stores the raw markdown (including frontmatter with embedded images), deck metadata, and a generated ID. Session state (score, position) is not persisted.

### Card content constraint

Card content must always be fully visible without scrolling. `fitText()` shrinks the font to make content fit within the fixed card height. When adding features that render into card faces, ensure the result still fits completely — do not allow vertical overflow or scrolling inside a card, nor clip the content.

### Image panel layout

The image panel (`#card-image-panel`) sits **below** `.answer-btns` in the DOM, outside the card flip mechanism. Key constraints:
- The answer buttons use `opacity` only for their show/hide transition (no `translateY`) so they always occupy their layout space — this prevents the image from shifting when the card is flipped
- The image is never shown inside the card faces
- `max-width: 100%` with `height: auto` preserves aspect ratio and prevents upscaling beyond natural size
- The panel is cleared (`display: none`, `removeAttribute('src')`) when navigating away from the study screen — using `removeAttribute` rather than `src = ''` avoids a spurious request to the page URL

### SVG assets

- `img/icons.svg` — SVG sprite; all UI icons are referenced via `<use href="img/icons.svg#icon-name"/>`
- `img/watermark.svg` — decorative illustration loaded via `<img>` tag; fill colour is baked in as `#1e1c18` since `currentColor` does not propagate through `<img>`

### Versioning

The version string in the `.version` footer element follows `v<major>.<minor>.<YYYYMMDD>` — update it when making changes.

## img-to-md.html

Standalone helper tool — no dependencies. Drop image files → generates base64 YAML frontmatter for deck files.

### Key functions (`js/img-to-md.js`)

- `readFiles(files)` — validates type and deduplicates by filename before reading. Uses a `pending` counter so `renderList()` and `renderOutput()` are called exactly once when all `FileReader` callbacks complete, not once per file.
- `uniqueKey(base)` — derives a collision-free key from a filename; snapshots existing keys into a `Set` once before the loop to avoid repeated array mapping.
- `copyText(text, btn)` — writes to clipboard and toggles a "✓ Copied" state on the button. Targets `btn.querySelector('span') || btn` for the label so SVG children on icon-bearing buttons are not clobbered.
- `renderList()` — rebuilds the image list UI from `entries`; wires key-input, remove, and snippet-copy handlers.
- `renderOutput()` — rebuilds the frontmatter `<pre>` block from `entries`; hides the panel when empty.

### Behaviour notes

- Dropping the same filename twice is detected and skipped with an alert — deduplication is by `filename`, not file content.
- The "Copy frontmatter" button in `img-to-md.html` wraps its label text in a `<span>` so `copyText` can update just the text without touching the adjacent SVG icon.
