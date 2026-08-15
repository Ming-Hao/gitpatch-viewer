# Patch Viewer

`git diff` prints the changes between two commits:

```sh
git diff <commit1> <commit2>
```

`git diff <commit1>..<commit2>` does the same thing, if you prefer that form.

Often you only care about a few files. Put them after `--`:

```sh
git diff <commit1> <commit2> -- package.json src/app.js
```

The `--` tells git that what follows are paths, not revisions. Without it git has to guess, and a path that happens to look like a branch or tag name will be read as one.

Redirect either form and you have a file:

```sh
git diff <commit1> <commit2> -- package.json > output
```

This tool renders that file. The extension does not matter — `.patch`, `.diff`, or none at all. Everything runs in the browser; the patch is never uploaded.

## Usage

Hand it a patch in whichever way is convenient:

- Drop the file anywhere on the page
- Click **Open patch** and pick a file
- Expand **Paste patch text instead** and paste the text

Use **Unified** / **Side by side** in the toolbar to switch views. The theme follows your system setting until you pick one explicitly.

## Development

```sh
npm install
npm run build   # minified bundle + index.html into dist/
npm run dev     # rebuild the bundle on change
npm run deploy  # build, then publish to Cloudflare Workers
```

Run `build` at least once before `dev` — only `build` copies `index.html` into `dist/`.

Deployment is an assets-only Cloudflare Worker serving `dist/`, so there is no server-side code.

## Credits

Huge thanks to [jsdiff](https://github.com/kpdecker/jsdiff), which had already done the hard part.

Reading the unified diff format with all of its quirks, computing line and word level differences, the Myers algorithm underneath — jsdiff handles all of it, and handles it thoroughly. This project calls three of its functions (`parsePatch`, `diffArrays`, `diffWordsWithSpace`) and spends the rest of its time arranging the results into a page.

So if this viewer is useful to you, most of the credit belongs upstream. Please go take a look at [jsdiff](https://github.com/kpdecker/jsdiff) — star it, file an issue, contribute. It deserves the support.
