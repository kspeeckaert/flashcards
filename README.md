# Flashcards

A flashcard web app. No build step, no install — serve locally and open in a browser.

## Usage

Serve the project locally and open `flashcards.html`:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080/flashcards.html` in any modern browser.

## Card format

Cards are written in Markdown:

```md
# My Japanese Deck

## Chapter 1: Greetings

### こんにちは
hello

### さようなら
goodbye

## Chapter 2: Food & Drink

### 食べる
to eat
```

- `#` — deck name
- `##` — section
- `###` — card front
- Lines below `###` — card back (supports Markdown: bold, italic, code, lists; and LaTeX math)

Math is rendered via KaTeX:
- Inline: `$E = mc^2$`
- Display block: `$$\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}$$`

Cards without an answer are skipped with a warning.

## Images

Images can be embedded in decks as self-contained base64 data — no external files or links required. Both raster images (PNG, JPEG, WebP, GIF) and SVGs are supported.

### Embedding images with img-to-md.html

Open `img-to-md.html` in a browser, drop in your image files, and it will:
- Convert each image to base64
- Let you set a short key name per image
- Output a ready-to-paste YAML frontmatter block
- Provide a copy button for each card snippet

### Deck format with images

Paste the frontmatter block at the very top of your `.md` file, before the deck name:

```md
---
images:
  wave_hand: data:image/png;base64,...
  katakana_chart: data:image/svg+xml;base64,...
---

# My Japanese Deck

## Chapter 1: Greetings

### さようなら
goodbye
<!-- img:wave_hand -->
```

- Images are deduplicated in the frontmatter — each is stored once regardless of how many cards reference it
- Add `<!-- img:key -->` anywhere in a card's answer body to attach that image
- Only one image per card is supported
- The comment is invisible in all standard markdown previewers (VS Code, Obsidian, GitHub)

### How images display

The image appears **below the answer buttons**, outside the card itself. It stays fixed while you flip the card, sized to fit the available width without exceeding the card width or upscaling beyond its natural dimensions.

## Features

- **Saved decks** — toggle "Save this deck" on the select screen to store a deck in the browser (up to 10). Saved decks appear on the home screen and can be deleted by swiping left on mobile or clicking the trash icon on desktop.
- **Section picker** — choose which sections to study before starting.
- **Reverse mode** — swap front and back (answer → question).
- **Shuffle** — cards are shuffled each session.
- **Undo** — step back one card.
- **Retry missed** — after finishing, study only the cards you missed.
- **Images** — attach a base64-embedded image to any card; displayed below the buttons, stable across flips.

## Controls

| Action         | Input                        |
|----------------|------------------------------|
| Flip card      | Click / Tap / Space          |
| Mark correct   | Right arrow / Swipe right    |
| Mark incorrect | Left arrow / Swipe left      |
| Undo           | Undo button (top-left)       |

## Compatibility

Works in Safari, Chrome, and Firefox on desktop and mobile.
