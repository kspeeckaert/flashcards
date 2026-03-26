# Flashcards App

## Overview
A single-page flashcards web application that:
- Loads flashcards from a Markdown file
- Lets users study via flipping and swiping
- Works locally (file://) and online
- Supports desktop and touch devices

---

## Features

### 📂 File Input
- Upload `.md` file or drag & drop
- Parsed entirely client-side
- No server required

---

### 🧠 Flashcard System

#### Card Structure (Markdown)
```md
# Section title

## Card front
Card back (multi-line supported)
````

* `#` → Section
* `##` → Card front
* Text below → Card back

---

### 🔀 Study Mode

* Cards displayed one at a time
* Tap / click to flip
* Swipe or buttons to mark:

  * ✅ Correct
  * ❌ Incorrect

---

### 🔁 Features

* Shuffle cards
* Reverse cards (front ↔ back)
* Retry incorrect cards
* Single-level undo

---

### ⌨️ Controls

| Action         | Input                 |
| -------------- | --------------------- |
| Flip card      | Click / Tap / Space   |
| Mark correct   | → Arrow / Swipe right |
| Mark incorrect | ← Arrow / Swipe left  |
| Undo           | Button                |

---

### 📊 Progress Tracking

* Progress bar
* Current card index
* Score:

  * Correct (✓)
  * Incorrect (✗)

---

### 📱 Touch Support

* Swipe gestures
* Tap to flip
* Responsive layout

---

### 🎨 UI Features

* Animated card flip
* Swipe animations
* Dynamic text resizing (`fitText`)

---

## Technical Details

### 🧩 Architecture

* Single HTML file
* No build step
* Uses:

  * `marked` (Markdown parsing)
  * `DOMPurify` (sanitization)

---

### ⚙️ Key Components

* `parseMD()` → parses markdown into sections/cards
* `renderCard()` → updates UI
* `commitAnswer()` → handles animations + scoring
* `fitText()` → resizes content to fit card

---

### 🌐 Compatibility

* Safari
* Chrome
* Firefox
* Desktop + mobile

---

### ⚠️ Limitations

* No persistence (data lost on refresh)
* Strict markdown format
* No deck management
* No multi-deck support

---

## Example File

```md
# Greetings

## Hello
こんにちは

## Goodbye
さようなら
```

---

## Summary

A lightweight, offline-capable flashcard tool focused on:

* Simplicity
* Speed
* Minimal dependencies
