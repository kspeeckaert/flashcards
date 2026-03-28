# Flashcards

A single-file flashcard web app. No build step, no install, no server required — open `flashcards.html` directly in a browser.

## Usage

Open `flashcards.html` in any modern browser, or serve it locally to avoid `file://` restrictions:

```
python3 -m http.server 8080
```

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

## Features

- **Saved decks** — toggle "Save this deck" on the select screen to store a deck in the browser (up to 10). Saved decks appear on the home screen and can be deleted by swiping left on mobile or clicking the trash icon on desktop.
- **Section picker** — choose which sections to study before starting.
- **Reverse mode** — swap front and back (answer → question).
- **Shuffle** — cards are shuffled each session.
- **Undo** — step back one card.
- **Retry missed** — after finishing, study only the cards you missed.

## Controls

| Action         | Input                        |
|----------------|------------------------------|
| Flip card      | Click / Tap / Space          |
| Mark correct   | Right arrow / Swipe right    |
| Mark incorrect | Left arrow / Swipe left      |
| Undo           | Undo button (top-left)       |

## Compatibility

Works in Safari, Chrome, and Firefox on desktop and mobile.
