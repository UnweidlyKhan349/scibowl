/* SciBowl Practice - shared data layer */
(function (global) {
  const SBData = {
    meta: null,
    questions: null,
    _readyPromise: null,
  };

  SBData.load = function () {
    if (SBData._readyPromise) return SBData._readyPromise;
    SBData._readyPromise = Promise.all([
      fetch('data/meta.json').then((r) => r.json()),
      fetch('data/questions.json').then((r) => r.json()),
    ]).then(([meta, qs]) => {
      SBData.meta = meta;
      // expand compact keys into a friendlier shape used throughout the app
      SBData.questions = qs.map((q) => ({
        id: q.i,
        tournament: q.t,
        tSlug: q.ts,
        round: q.r,
        roundLabel: q.rl,
        subject: q.s,
        format: q.f,
        qtype: q.qt,
        num: q.n,
        question: q.q,
        choices: q.c || null,
        visual: !!q.v,
        answer: {
          text: q.a.t,
          letter: q.a.l || null,
          accept: q.a.ac || [],
          reject: q.a.rj || [],
        },
        sourceUrl: q.u,
      }));
      SBData.byId = new Map(SBData.questions.map((q) => [q.id, q]));
      return SBData;
    });
    return SBData._readyPromise;
  };

  /* ---------------- Bookmarks (localStorage) ---------------- */
  const BOOKMARK_KEY = 'sb_bookmarks_v1';

  function readBookmarks() {
    try {
      const raw = localStorage.getItem(BOOKMARK_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
      return new Set();
    }
  }
  function writeBookmarks(set) {
    try {
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify([...set]));
    } catch (e) {
      /* ignore quota errors */
    }
  }

  SBData.bookmarks = {
    getAll() {
      return readBookmarks();
    },
    isBookmarked(id) {
      return readBookmarks().has(id);
    },
    toggle(id) {
      const set = readBookmarks();
      if (set.has(id)) set.delete(id);
      else set.add(id);
      writeBookmarks(set);
      return set.has(id);
    },
    add(id) {
      const set = readBookmarks();
      set.add(id);
      writeBookmarks(set);
    },
    remove(id) {
      const set = readBookmarks();
      set.delete(id);
      writeBookmarks(set);
    },
    clear() {
      writeBookmarks(new Set());
    },
    count() {
      return readBookmarks().size;
    },
  };

  /* ---------------- Filtering ---------------- */
  // opts: { subjects, roundRange:[min,max], includeUnlabeled, tournaments, formats, qtypes, bookmarkedOnly, search, includeVisual }
  // each of subjects/tournaments/formats/qtypes is either null/empty (= all) or a Set/array of allowed values
  SBData.filterQuestions = function (opts) {
    opts = opts || {};
    const subjects = toSetOrNull(opts.subjects);
    const tournaments = toSetOrNull(opts.tournaments);
    const formats = toSetOrNull(opts.formats);
    const qtypes = toSetOrNull(opts.qtypes);
    const bookmarkedOnly = !!opts.bookmarkedOnly;
    const bookmarks = bookmarkedOnly ? readBookmarks() : null;
    const search = (opts.search || '').trim().toLowerCase();
    const includeVisual = opts.includeVisual !== false;
    const roundRange = opts.roundRange || null; // [min, max] inclusive
    const includeUnlabeled = opts.includeUnlabeled !== false;

    let out = SBData.questions.filter((q) => {
      if (subjects && !subjects.has(q.subject)) return false;
      if (roundRange) {
        if (q.round == null) { if (!includeUnlabeled) return false; }
        else if (q.round < roundRange[0] || q.round > roundRange[1]) return false;
      }
      if (tournaments && !tournaments.has(q.tSlug)) return false;
      if (formats && !formats.has(q.format)) return false;
      if (qtypes && !qtypes.has(q.qtype)) return false;
      if (bookmarkedOnly && !bookmarks.has(q.id)) return false;
      if (!includeVisual && q.visual) return false;
      return true;
    });

    if (search) {
      out = out.filter((q) => {
        return (
          q.question.toLowerCase().includes(search) ||
          q.answer.text.toLowerCase().includes(search) ||
          q.tournament.toLowerCase().includes(search)
        );
      });
    }
    return out;
  };

  function toSetOrNull(v) {
    if (!v) return null;
    if (v instanceof Set) return v.size ? v : null;
    if (Array.isArray(v)) return v.length ? new Set(v) : null;
    return null;
  }

  // Packet round labels are messy, inconsistently-formatted filenames scraped
  // straight from the source PDFs ("Ignis_DE1", "Copy of Copy of DE—1",
  // "rround01", ...). Clean one up for display: drop a leading repeat of the
  // tournament name, normalize separators, and space out letter/digit runs
  // ("DE1" -> "DE 1"). Best-effort, not a full per-tournament parser.
  function cleanRoundLabel(tournament, label) {
    if (!label) return null;
    let s = String(label);
    s = s.replace(/^(copy of\s+)+/gi, '');
    (tournament || '').split(/\s+/).filter(Boolean).forEach((tok) => {
      const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('^\\s*' + escaped + '[\\s_.:\\-]*', 'i');
      if (re.test(s)) s = s.replace(re, '');
    });
    s = s.replace(/[_—–]+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return s || null;
  }
  SBData.roundLabelFor = function (q) {
    return cleanRoundLabel(q.tournament, q.roundLabel) || (q.round ? 'Round ' + q.round : null);
  };

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  SBData.shuffle = shuffle;

  /* ---------------- Shared dual-handle round-range slider wiring ---------------- */
  // opts: { minInput, maxInput, fillEl, labelEl, maxRound, onChange(lo, hi) }
  SBData.wireRoundRangeSlider = function (opts) {
    const { minInput, maxInput, fillEl, labelEl, maxRound, onChange } = opts;
    minInput.min = maxInput.min = 1;
    minInput.max = maxInput.max = maxRound;
    minInput.value = 1;
    maxInput.value = maxRound;

    function render() {
      const lo = parseInt(minInput.value, 10);
      const hi = parseInt(maxInput.value, 10);
      const span = Math.max(1, maxRound - 1);
      const pctLo = ((lo - 1) / span) * 100;
      const pctHi = ((hi - 1) / span) * 100;
      if (fillEl) { fillEl.style.left = pctLo + '%'; fillEl.style.width = Math.max(0, pctHi - pctLo) + '%'; }
      if (labelEl) labelEl.textContent = lo === hi ? `Round ${lo}` : `Rounds ${lo}–${hi}`;
      if (onChange) onChange(lo, hi);
    }
    function onMinInput() {
      let lo = parseInt(minInput.value, 10);
      const hi = parseInt(maxInput.value, 10);
      if (lo > hi) { lo = hi; minInput.value = lo; }
      render();
    }
    function onMaxInput() {
      const lo = parseInt(minInput.value, 10);
      let hi = parseInt(maxInput.value, 10);
      if (hi < lo) { hi = lo; maxInput.value = hi; }
      render();
    }
    minInput.addEventListener('input', onMinInput);
    maxInput.addEventListener('input', onMaxInput);
    render();
    return {
      reset() { minInput.value = 1; maxInput.value = maxRound; render(); },
      getRange() { return [parseInt(minInput.value, 10), parseInt(maxInput.value, 10)]; },
    };
  };

  global.SBData = SBData;
})(window);
