# Family Hub visuals

The animated pictures at the top of Family Hub's Home page. Each one is a single JavaScript file in
`visuals/` that draws on a canvas in the hub's colours, sized to fill whatever box it is shown in. Family Hub shows a different one each
day (`daily.js`: never the same as yesterday's), or one an admin has pinned.

## Trying them

```
npm install
```

then open `index.html` in a browser (the theme buttons at the top check all four colour schemes). For
Weather, copy `place.local.example.js` to `place.local.js` and put your town in it.

## Adding one

1. Make `visuals/your-visual.js`. Wrap it in `(function () { ... })();` so its names do not clash with
   the other files, and end it with:

   ```js
   (window.VISUALS = window.VISUALS || []).push({ id: 'your-visual', name: 'Your visual', draw: yourVisual });
   ```

   Start `draw` with `const view = fitCanvas(cv, frame), c = view.c;` and begin every frame with
   `view.fit()`, then read the size from `view.W` and `view.H` (never `canvas.width`). `fitCanvas`
   (`lib/fit-canvas.js`) keeps the picture sharp on any screen and lets it take any shape: you draw in
   design pixels, at least 800 × 340, with any extra room added to `W` or `H`. `fit()` returns true when
   the size changed, for anything worked out from it.

   `draw(canvas)` starts drawing and keeps going with `requestAnimationFrame` until `canvas.isConnected`
   is false. Optional extras: `modes: [['id', 'Label'], ...]` (draw then returns
   `{ mode(), setMode(id) }`, and the hub shows a switch), and `needs: ['place']` (left out of the daily
   pick until a home town is set).
2. Read colours and the label font from the page every frame, so it follows the hub's scheme and
   accent: `--bg`, `--panel`, `--grid`, `--line`, `--line2`, `--ink`, `--dim`, `--accent`, `--font-label`.
3. Draw one still frame when `matchMedia('(prefers-reduced-motion: reduce)')` matches.
4. Add a `<script>` line for it to `index.html` to try it here. Family Hub needs no list: it loads every
   file in `visuals/`.

Home is `window.HUB_PLACE` (`{ name, lat, lon }`), set by Family Hub from its `.env`. Never write a
real address or town into a file here: this repository is public.

## Libraries

Family Hub provides these, at the same paths as `npm install` puts them, so a visual works the same in
both places:

| Library | Path |
|---|---|
| Astronomy Engine 2.1 | `node_modules/astronomy-engine/astronomy.browser.min.js` (`Astronomy`) |
| d3 7.9 | `node_modules/d3/dist/d3.min.js` (`d3`) |
| topojson-client 3.1 | `node_modules/topojson-client/dist/topojson-client.min.js` (`topojson`) |
| SmilesDrawer 2.4 | `node_modules/smiles-drawer/dist/smiles-drawer.min.js` (`SmilesDrawer`) |
| world-atlas 2.0 | `node_modules/world-atlas/land-110m.json`, `countries-110m.json` |

Another library a visual needs goes in a `lib/` folder here (its `.js` files load before the visuals).
Data from the internet must come from a site that allows it (CORS), like the USGS and Open-Meteo feeds.

## Size and shape

The canvas takes its size from the page's CSS. With `width: 100%; height: auto` it keeps the 800 × 340
shape and grows with the width. Give it a height as well (for example `height: 60vh`) and the
picture follows the shape of the window. Either way it stays sharp.

## How Family Hub picks up changes

Set `VISUALS_REPO=your-name/this-repository` in Family Hub's `.env` (or under Admin, Hub, Connections).
Family Hub checks it every hour and uses the newest `visuals/`, `lib/` and `daily.js` from its default
branch; **Admin → Hub → Appearance → Check for new visuals** checks straight away. The visuals run in a
sealed frame: they can draw and fetch public data, but cannot see anyone's profile, books or settings.
