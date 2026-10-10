# Flashcards

Flashcards is a web app for studying flashcard decks that you write in Markdown. You can install it on Windows, macOS, iOS, and iPadOS, and it works offline after the first visit. The app is a Progressive Web App (PWA), which is a website that installs like an app.

The app is at <https://kspeeckaert.github.io/flashcards/flashcards.html>.

## Install the app

Open the app address in a browser once while you are online. Then install it:

- Windows: in Microsoft Edge or Google Chrome, click the install icon in the address bar, or open the browser menu and select "Install Flashcards".
- macOS: in Safari, select File > Add to Dock. In Google Chrome, click the install icon in the address bar.
- iPhone and iPad: in Safari, tap the Share button and then tap "Add to Home Screen".

The app opens in its own window. To use the app without a network connection, open it once while you are online. The app then stores all its files on the device.

## Updates

If a new version is available, the app shows the message "A new version is available." with a Reload button. Click Reload to start the new version. The app does not reload on its own, so a study session is not interrupted.

The app looks for a new version each time you open it while you are online.

## Load a deck

1. Click "Choose file…", or drag a `.md` file onto the drop area.
2. Select the sections that you want to study.
3. Set the options: shuffle, reverse (answer becomes question), and save.
4. Click "Study →".

If you turn on "Save this deck", the app keeps the deck in the storage of the browser. Saved decks show on the start screen. To delete a saved deck, swipe it to the left on a touch screen, or click the trash icon on a desktop.

Saved decks stay on one device and in one browser. They do not synchronize. Keep your `.md` files as the original copy.

## Controls

| Action | Input |
|---|---|
| Show the answer | Click or tap the card, or press Space |
| Mark as correct | Press the Right arrow, swipe right, or click "Got it" |
| Mark as incorrect | Press the Left arrow, swipe left, or click "Miss" |
| Undo the last answer | Click "Undo" (top left) |

After the last card, you can study the deck again, study only the cards that you missed, change the sections, or load a different deck.

## Card format

A deck is a Markdown file:

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

The app reads the headings as follows:

- `#`: the name of the deck.
- `##`: the start of a section.
- `###`: the front of a card (the question).
- The lines below a `###` heading: the back of the card (the answer).

The answer supports Markdown, for example bold, italic, code, and lists. If a card has no answer, the app skips it and shows a warning. The app ignores headings with `####` or more and shows a warning.

### Math

The app shows math with KaTeX:

- Inline math: `$E = mc^2$`
- Display math: `$$\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}$$`

### Images

A deck can contain images as base64 data, so the deck stays one file. The app supports PNG, JPEG, WebP, GIF, and SVG.

1. Open the Image → Markdown tool. The start screen of the app has a link to it.
2. Drop your image files on the tool, or click "Choose images…".
3. Set a short key for each image.
4. Copy the frontmatter block, and paste it at the top of your `.md` file, before the `#` line.
5. To show an image with an answer, add `<!-- img:key -->` to the answer.

Example:

```md
---
images:
  wave_hand: data:image/png;base64,...
---

# My Japanese Deck

## Chapter 1: Greetings

### さようなら
goodbye
<!-- img:wave_hand -->
```

The app shows the image below the answer buttons, outside the card. A card can show one image.

## Browser support

The app works in current versions of Safari, Chrome, Edge, and Firefox on desktop computers, phones, and tablets.

## Development

The app has no build step for the code. The HTML, CSS, and JavaScript files run as they are. A small build script only copies the libraries and writes the file list for offline use. The section "Build script" explains it.

### Run the app on your computer

1. Open a terminal in the folder of the repository.
2. Start a web server:

   ```sh
   python3 -m http.server 8080
   ```

3. Open <http://localhost:8080/flashcards.html> in a browser.

On `localhost` and `127.0.0.1`, the app does not start its service worker (the script that stores the files for offline use). Thus your changes show after a normal reload. To test offline use on your computer, open <http://localhost:8080/flashcards.html?sw>.

### Build script

The script `scripts/build.js` does three tasks:

1. It copies the browser libraries (marked, DOMPurify, KaTeX) and the fonts (Lora, DM Sans) from `node_modules/` into `vendor/`.
2. It writes `vendor/fonts/fonts.css` for those fonts.
3. It writes a block into `sw.js`. The block contains the app version, the list of files for offline use, and a hash of their contents.

The app needs `vendor/` because it must work offline. It does not load files from other websites. The service worker needs the file list because it downloads only the files on that list. If a file is missing from the list, the app breaks when the device is offline.

The hash is necessary for updates. Installed apps look for a new version of `sw.js` only. If any file of the app changes, the hash in `sw.js` changes. The installed apps then download the new files.

You need Bun (<https://bun.sh>) to run the script. Node.js also works: `node scripts/build.js`.

Run the build script in these cases:

- After you change, add, or remove a file in `css/`, `js/`, `img/`, or in one of the HTML pages.
- After you change `js/version.js`.
- After you change the version of a library in `package.json`.

If you forget to run it, installed apps do not get your change.

To run the build script:

1. If `node_modules/` does not exist, or if `package.json` changed, run `bun install`.
2. Run `bun run build`.
3. Commit the changes in `vendor/` and `sw.js` together with your own changes.

The command `bun run check` tells you whether the build is up to date. The command changes nothing. If `vendor/` or `sw.js` is out of date, the command shows the files and stops with exit code 1. You can use it in a Git pre-commit hook.

Do not edit `vendor/` or the block between `// BEGIN PRECACHE` and `// END PRECACHE` in `sw.js` by hand. The build script replaces them.

### Update a library

1. Change the version number in `package.json`.
2. Run `bun install`.
3. Run `bun run build`.
4. Test the app, and commit `package.json`, `bun.lock`, `vendor/`, and `sw.js`.

### Version number

The version has the format `<major>.<minor>.<YYYYMMDD>`, for example `1.42.20261010`. Change it in `js/version.js` for each change, and then run `bun run build`. The footer of both pages shows the version.

### App icons

The source of the app icon is `img/icon.svg`. The PNG files in `img/icons/` come from that file. If you change `img/icon.svg`, make the PNG files again, for example with `rsvg-convert` from the `librsvg` package (`brew install librsvg`):

```sh
rsvg-convert -w 192 -h 192 img/icon.svg -o img/icons/icon-192.png
rsvg-convert -w 512 -h 512 img/icon.svg -o img/icons/icon-512.png
rsvg-convert -w 180 -h 180 img/icon.svg -o img/icons/apple-touch-icon.png
```

Then run `bun run build`.

### Files

| Path | Content |
|---|---|
| `flashcards.html` | The app |
| `img-to-md.html` | The Image → Markdown tool |
| `css/`, `js/` | The styles and the code of both pages |
| `js/version.js` | The app version |
| `js/pwa.js` | Service worker registration, update message, version footer |
| `sw.js` | The service worker |
| `manifest.webmanifest` | The name, the icons, and the colors for the installed app |
| `img/` | Icons and images |
| `vendor/` | Libraries and fonts, written by the build script |
| `scripts/build.js` | The build script |
| `sample.md` | An example deck |
