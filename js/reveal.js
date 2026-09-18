/* SciBowl Practice - shared letter-by-letter reveal engine.
   Replaces text-to-speech: instead of being read aloud, the question
   (and its answer choices) type themselves onto the screen at an
   adjustable speed, and "buzzing before it's fully read" now means
   "buzzing before the reveal finishes". */
(function (global) {
  const BASE_CHARS_PER_SEC = 28; // speed at rate 1.0x

  // segments: [{ text, el, prefixEl? }] - each rendered into el.textContent
  // in sequence. Returns a controller.
  function startReveal(segments, rate, callbacks) {
    callbacks = callbacks || {};
    const cps = Math.max(4, BASE_CHARS_PER_SEC * (rate || 1));
    const msPerChar = 1000 / cps;
    let segIndex = 0;
    let charIndex = 0;
    let paused = false;
    let stopped = false;
    let done = false;
    let timer = null;

    segments.forEach((s) => { s.el.textContent = ''; });

    function currentSegment() { return segments[segIndex]; }

    function finish() {
      done = true;
      segments.forEach((s) => { s.el.textContent = s.text; });
      if (callbacks.onComplete) callbacks.onComplete();
    }

    function tick() {
      if (stopped || done) return;
      if (paused) return;
      const seg = currentSegment();
      if (!seg) { finish(); return; }
      charIndex++;
      seg.el.textContent = seg.text.slice(0, charIndex);
      if (callbacks.onProgress) callbacks.onProgress();
      if (charIndex >= seg.text.length) {
        segIndex++;
        charIndex = 0;
        if (segIndex >= segments.length) {
          finish();
          return;
        }
        if (callbacks.onSegmentStart) callbacks.onSegmentStart(segments[segIndex], segIndex);
      }
      timer = setTimeout(tick, msPerChar);
    }

    if (segments.length && callbacks.onSegmentStart) callbacks.onSegmentStart(segments[0], 0);
    timer = setTimeout(tick, msPerChar);

    return {
      pause() {
        if (done || stopped) return;
        paused = true;
        if (timer) clearTimeout(timer);
      },
      resume() {
        if (done || stopped || !paused) return;
        paused = false;
        timer = setTimeout(tick, msPerChar);
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      skipToEnd() {
        if (done) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        finish();
      },
      isDone() { return done; },
      isPaused() { return paused; },
    };
  }

  global.SBReveal = { startReveal };
})(window);
