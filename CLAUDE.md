# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Single-file flashcard web app (`flashcards.html`). No build step, no dependencies to install, no server required — open directly in a browser via `file://` or any HTTP server.

A companion tool `img-to-md.html` converts images to base64 and generates the frontmatter block needed for image-enabled decks.

## Development

Open `flashcards.html` in a browser. No build or install step.

To serve locally (e.g. to avoid `file://` restrictions):
```
python3 -m http.server 8080
```

## Architecture

The entire app lives in one file: `flashcards.html`. It contains inline CSS and a single `<script>` block. External dependencies (`marked`, `DOMPurify`, `KaTeX`) are loaded from CDNs.

### Screens

Four `<div class="screen">` elements are shown/hidden via `showScreen(id)`:
- `screen-load` — file upload / saved deck library
- `screen-select` — section picker and study options
- `screen-study` — active card study session
- `screen-done` — results and replay options

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

- `parseMD(text, filename)` — parses markdown into `{ name, sections: [{title, cards:[{front, back, imageKey}]}], images: {key: dataURI} }`; strips YAML frontmatter before card parsing
- `setCardContent(id, text)` — renders markdown into a card face via `marked` + `DOMPurify` + `renderMathInElement()`, then calls `fitText()`
- `fitText(el)` — binary-search font-size to fit card content without overflow; skips scaling when a KaTeX display block is present
- `renderCard()` — updates the DOM for the current card, including showing/hiding the image panel
- `commitAnswer(hit)` — records the answer, triggers swipe/fly animation, advances to next card
- `showScreen(id)` — switches the active screen; clears image panel when leaving study screen

### State

All state is module-level variables (`activeDeck`, `cardIndex`, `hits`, `misses`, `isFlipped`, `isReversed`, `prevState`, etc.). There is no framework.

### Persistence

Decks are saved to `localStorage` under the key `fc_decks` (max 10). Each entry stores the raw markdown (including frontmatter with embedded images), deck metadata, and a generated ID. Session state (score, position) is not persisted.

### Card content constraint

Card content must always be fully visible without scrolling. `fitText()` shrinks the font to make content fit within the fixed card height. When adding features that render into card faces, ensure the result still fits completely — do not allow vertical overflow or scrolling inside a card, nor clip the content.

### Image panel layout

The image panel (`#card-image-panel`) sits **below** `.answer-btns` in the DOM, outside the card flip mechanism. Key constraints:
- The answer buttons use `opacity` only for their show/hide transition (no `translateY`) so they always occupy their layout space — this prevents the image from shifting when the card is flipped
- The image is never shown inside the card faces
- `max-width: 100%` with `height: auto` preserves aspect ratio and prevents upscaling beyond natural size
- The panel is cleared (`display: none`, `src = ''`) when navigating away from the study screen

### Versioning

The version string in the `.version` footer element follows `v<major>.<minor>.<YYYYMMDD>` — update it when making changes.
