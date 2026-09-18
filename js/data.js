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
        difficulty: q.d,
        subject: q.s,
        format: q.f,
        qtype: q.qt,
        num: q.n,
        question: q.q,
        choices: q.c || null,
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
  // opts: { subjects, difficulties, tournaments, formats, qtypes, bookmarkedOnly, search }
  // each of subjects/difficulties/tournaments/formats/qtypes is either null/empty (= all) or a Set/array of allowed values
  SBData.filterQuestions = function (opts) {
    opts = opts || {};
    const subjects = toSetOrNull(opts.subjects);
    const difficulties = toSetOrNull(opts.difficulties);
    const tournaments = toSetOrNull(opts.tournaments);
    const formats = toSetOrNull(opts.formats);
    const qtypes = toSetOrNull(opts.qtypes);
    const bookmarkedOnly = !!opts.bookmarkedOnly;
    const bookmarks = bookmarkedOnly ? readBookmarks() : null;
    const search = (opts.search || '').trim().toLowerCase();

    let out = SBData.questions.filter((q) => {
      if (subjects && !subjects.has(q.subject)) return false;
      if (difficulties && !difficulties.has(q.difficulty)) return false;
      if (tournaments && !tournaments.has(q.tSlug)) return false;
      if (formats && !formats.has(q.format)) return false;
      if (qtypes && !qtypes.has(q.qtype)) return false;
      if (bookmarkedOnly && !bookmarks.has(q.id)) return false;
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

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  SBData.shuffle = shuffle;

  global.SBData = SBData;
})(window);
