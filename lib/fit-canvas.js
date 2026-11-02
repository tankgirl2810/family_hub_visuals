// Keeps a visual's canvas sharp at any size and shape.
//
// A canvas has its own pixel grid (canvas.width × canvas.height). When the page shows it bigger than
// that grid, or on a high-DPI screen, the browser stretches the pixels and the picture goes soft. This
// matches the grid to the real screen pixels the canvas covers, every frame, and sets the drawing scale
// so a visual can keep drawing in "design pixels":
//
//   const view = fitCanvas(cv, frame);   // frame: the visual's draw function, for redraws after a resize
//   function frame(t) { view.fit(); const W = view.W, H = view.H; ... }
//
// The design size is 800 × 340 at the smallest: the canvas is scaled to fit that box, and any extra
// room from a wider or taller shape is added to W or H. So text keeps its size relative to the picture,
// and the layout spreads out to fill the shape it's given. fit() returns true when W or H changed, so a
// visual can redo anything it worked out from the size.
(function () {
  const BASE_W = 800, BASE_H = 340;

  window.fitCanvas = function (cv, redraw) {
    const c = cv.getContext('2d');
    const view = { c, W: BASE_W, H: BASE_H, k: 1, fit };
    let lastFrame = 0, resized = false;

    function fit() {
      lastFrame = performance.now();
      const dpr = window.devicePixelRatio || 1, box = cv.getBoundingClientRect();
      // a canvas with no CSS size takes its size from its pixel grid; growing the grid would then grow it
      // on screen too, for ever. Spot that just after a resize and pin its size in CSS instead.
      if (resized && dpr !== 1 && box.width === cv.width && box.height === cv.height) {
        cv.style.width = cv.width / dpr + 'px'; cv.style.height = cv.height / dpr + 'px';
        resized = false; return fit();
      }
      resized = false;
      let changed = false;
      if (box.width > 0 && box.height > 0) {   // not on screen (hidden, or not laid out yet): keep the last size
        const pw = Math.round(box.width * dpr), ph = Math.round(box.height * dpr);
        // a pixel either way is rounding, and chasing it can make a canvas with height: auto creep
        if (Math.abs(pw - cv.width) > 1 || Math.abs(ph - cv.height) > 1) { cv.width = pw; cv.height = ph; resized = true; }
        const s = Math.min(box.width / BASE_W, box.height / BASE_H), W = box.width / s, H = box.height / s;
        changed = W !== view.W || H !== view.H;
        view.W = W; view.H = H;
      }
      view.k = cv.width / view.W;   // screen pixels per design pixel
      c.setTransform(cv.width / view.W, 0, 0, cv.height / view.H, 0, 0);
      return changed;
    }

    // a visual that has stopped animating (reduced motion, or a still picture) draws once more after a
    // resize; one that is still animating picks the new size up on its next frame by itself
    if (redraw && window.ResizeObserver) {
      new ResizeObserver(() => requestAnimationFrame(t => {
        if (cv.isConnected && performance.now() - lastFrame > 100) redraw(t);
      })).observe(cv);
    }

    fit();
    return view;
  };
})();
