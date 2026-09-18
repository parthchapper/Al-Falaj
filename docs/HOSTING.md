# Hosting the console on GitHub Pages

The console in `site/` is a static site: no build step, no bundler, no server,
no API keys, no external requests once the page has loaded. Everything —
orbital mechanics, power model, hyperspectral retrieval, intake scheduler,
3D globe — runs in the browser.

---

## The three-minute version

1. Push this repository to GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. Push to `main`. The included workflow verifies and publishes.
4. Your console is at `https://<user>.github.io/<repo>/`.

That's it. The workflow at `.github/workflows/pages.yml` runs the parity
harness and the headless console check *before* publishing, so a broken build
never reaches the URL.

---

## Without Actions

Pages can also serve a folder directly, but it must be the repository root or
`docs/`, and this site lives in `site/`. Two options:

**Option A — publish a branch (keeps the repo tidy):**

```bash
git subtree push --prefix site origin gh-pages
```
Then set **Settings → Pages → Source: Deploy from a branch → `gh-pages` / root**.

**Option B — rename the folder:**

```bash
git mv site docs
```
Then set **Source: Deploy from a branch → `main` / `/docs`**. Update the paths
in `.github/workflows/*.yml` if you keep using them.

`site/.nojekyll` is already present, which stops Jekyll from stripping files —
keep it in whichever folder you publish.

---

## Local preview

```bash
npm run serve        # http://127.0.0.1:4173
```

Any static server works — `python3 -m http.server 4173 -d site` is equivalent.

It must be served over HTTP, not opened as a `file://` path: the console uses
ES modules and `fetch` for its coastline data, and both are blocked on the
file protocol.

---

## Paths and subdirectories

Every reference in the site is relative (`./vendor/three.module.js`,
`styles/console.css`, `map3d/data/…`), so it works unchanged at a user page
(`user.github.io`), a project page (`user.github.io/repo/`), or any
subdirectory of any other host. There is no base URL to configure.

---

## What gets served

```
site/
  index.html          the console
  app.js              bootstrap and wiring
  .nojekyll           stop Jekyll from eating the underscore-free files
  styles/console.css  the whole design system
  engine/             the mission model, ported from worker/app/
  ui/                 panels: map, spectroscopy, scheduler, log, timeline, tour
  map3d/              the three.js globe module + baked coastline vectors
  vendor/             three.js r170 (MIT), vendored so nothing is fetched
```

Roughly 1.9 MB total, of which three.js is 1.3 MB. It fits comfortably inside
the Pages soft limit of 1 GB and loads in well under a second on a normal
connection.

---

## Verification

```bash
npm run check
```

Runs three things:

| | |
|---|---|
| `tools/dump_reference.py` | regenerates reference outputs from the Python worker |
| `tools/parity-check.mjs` | asserts the browser engine reproduces all 27,694 of them |
| `tools/site-check.mjs` | boots the console in headless Chromium, drives all four segments, exercises every interaction, screenshots each |

The parity harness matters more than it looks. The site runs a JavaScript port
of the Python mission worker, and two implementations of one model drift
silently unless something is watching. It compares the full state at 21 slider
positions — chosen to straddle every mode boundary and every acquisition and
loss of signal — plus the time-warp curve, the loop-closure delta, all three
stations' contact windows, 96 spectral bands, 288 cells of the chlorophyll
field, both plants' 24-hour schedules, the water-security impact model, and the
value-noise hash underneath all of it. That hash is the single easiest thing to
port wrong and the hardest to notice; the loop-closure check is the one that
protects the property the whole timeline is built on.

`tools/solve_phase.py` is the companion: it re-solves the orbit phase constants
and prints the ground-station contact windows. Run it after changing the
segment layout, then paste the two constants into `worker/app/geo.py` and
`site/engine/geo.js`.

The site check needs Chromium:

```bash
npx playwright install chromium
# or, against a browser you already have:
CHROMIUM_PATH=/usr/bin/chromium node tools/site-check.mjs
```

---

## Custom domain

Add a `CNAME` file containing your domain to `site/`, and point a DNS `CNAME`
record at `<user>.github.io`. The workflow uploads the whole folder, so it
will be published with everything else.

---

## Browser requirements

ES modules, import maps, WebGL, `ResizeObserver` — all baseline since 2023.
The console degrades rather than fails: if WebGL is unavailable the 3D globe
is replaced with a notice and every other panel, including the 2D swath map,
keeps working. `localStorage` is wrapped in try/catch so private windows are
fine.
