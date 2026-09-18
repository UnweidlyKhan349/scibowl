(function () {
  const QTYPE_LABELS = { tossup: 'Toss-Up', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };
  const DIFF_LABELS = { RR: 'Round Robin', DE: 'Double Elim.', Unknown: 'Unlabeled round' };
  const TOSSUP_BUZZ_MS = 4000;
  const BONUS_BUZZ_MS = 20000;
  const ANSWER_MS = 10000;

  const filterState = {
    subjects: new Set(),
    difficulties: new Set(),
    qtypes: new Set(),
    formats: new Set(),
    tournament: '',
    bookmarkedOnly: false,
  };

  const session = {
    queue: [],
    index: -1,
    score: 0,
    correct: 0,
    incorrect: 0,
    skipped: 0,
  };

  const runtime = {
    phase: null, // 'reading' | 'buzzwindow' | 'answering' | 'revealed'
    speechCtl: null,
    timer: null,
    remainingMs: 0,
    totalMs: 0,
    paused: false,
    buzzedDuringReading: false,
    graded: null, // {correct, matched} after grading
    manuallyOverridden: false,
  };

  let subjectItems, difficultyItems, qtypeItems, formatItems;

  function buildChips(container, items, key, labelFn) {
    container.innerHTML = '';
    items.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.dataset.subject = item.subjectAttr || '';
      chip.textContent = labelFn(item);
      chip.addEventListener('click', () => {
        if (filterState[key].has(item.value)) filterState[key].delete(item.value);
        else filterState[key].add(item.value);
        chip.classList.toggle('active', filterState[key].has(item.value));
        updateMatchCount();
      });
      container.appendChild(chip);
    });
  }

  function updateMatchCount() {
    const matches = getFiltered();
    document.getElementById('matchCount').textContent = `${matches.length.toLocaleString()} questions match your filters`;
  }

  function getFiltered() {
    return SBData.filterQuestions({
      subjects: filterState.subjects,
      difficulties: filterState.difficulties,
      qtypes: filterState.qtypes,
      formats: filterState.formats,
      tournaments: filterState.tournament ? [filterState.tournament] : null,
      bookmarkedOnly: filterState.bookmarkedOnly,
    });
  }

  function initSetup() {
    subjectItems = SBData.meta.subjects.map((s) => ({ value: s.key, label: s.label, subjectAttr: s.key }));
    buildChips(document.getElementById('subjectChips'), subjectItems, 'subjects', (i) => i.label);
    difficultyItems = SBData.meta.difficulties.map((d) => ({ value: d, label: DIFF_LABELS[d] || d }));
    buildChips(document.getElementById('difficultyChips'), difficultyItems, 'difficulties', (i) => i.label);
    qtypeItems = SBData.meta.qtypes.map((q) => ({ value: q, label: QTYPE_LABELS[q] || q }));
    buildChips(document.getElementById('qtypeChips'), qtypeItems, 'qtypes', (i) => i.label);
    formatItems = SBData.meta.formats.map((f) => ({ value: f, label: FORMAT_LABELS[f] || f }));
    buildChips(document.getElementById('formatChips'), formatItems, 'formats', (i) => i.label);

    const tSelect = document.getElementById('tournamentSelect');
    SBData.meta.tournaments.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.slug;
      opt.textContent = `${t.name} (${t.count})`;
      tSelect.appendChild(opt);
    });
    tSelect.addEventListener('change', () => { filterState.tournament = tSelect.value; updateMatchCount(); });

    document.getElementById('bookmarkedOnly').addEventListener('change', (e) => {
      filterState.bookmarkedOnly = e.target.checked;
      updateMatchCount();
    });

    const rateSlider = document.getElementById('rateSlider');
    const savedRate = parseFloat(localStorage.getItem('sb_rate') || '1');
    rateSlider.value = savedRate;
    document.getElementById('rateValue').textContent = savedRate.toFixed(1) + '×';
    rateSlider.addEventListener('input', () => {
      document.getElementById('rateValue').textContent = parseFloat(rateSlider.value).toFixed(1) + '×';
      localStorage.setItem('sb_rate', rateSlider.value);
    });

    if (!SBTTS.supported) document.getElementById('ttsWarning').style.display = 'block';

    document.getElementById('startBtn').addEventListener('click', startSession);
    document.getElementById('bmCount').textContent = SBData.bookmarks.count() ? `★ ${SBData.bookmarks.count()} bookmarked` : '';

    updateMatchCount();
  }

  function startSession() {
    let pool = getFiltered();
    if (!pool.length) {
      alert('No questions match your filters. Widen your filters and try again.');
      return;
    }
    const order = document.getElementById('orderMode').value;
    if (order === 'shuffle') pool = SBData.shuffle(pool);
    const limit = parseInt(document.getElementById('sessionLength').value, 10);
    pool = pool.slice(0, limit);

    session.queue = pool;
    session.index = -1;
    session.score = 0;
    session.correct = 0;
    session.incorrect = 0;
    session.skipped = 0;

    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('summaryScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';

    nextQuestion();
  }

  function currentQuestion() {
    return session.queue[session.index];
  }

  function updateScoreBar() {
    const el = document.getElementById('scoreDisplay');
    el.textContent = (session.score > 0 ? '+' : '') + session.score;
    el.className = 'score ' + (session.score > 0 ? 'pos' : session.score < 0 ? 'neg' : '');
    document.getElementById('progressDisplay').textContent =
      `Question ${session.index + 1} of ${session.queue.length} · ${session.correct} correct · ${session.incorrect} incorrect · ${session.skipped} skipped`;
  }

  function renderMetaStrip(q) {
    const el = document.getElementById('metaStrip');
    el.innerHTML = `
      <span class="tag subject-${q.subject}">${labelFor(q.subject)}</span>
      <span class="tag qtype-${q.qtype}">${QTYPE_LABELS[q.qtype] || q.qtype}</span>
      <span class="tag fmt">${FORMAT_LABELS[q.format] || q.format}</span>
      <span class="tag diff-${q.difficulty}">${DIFF_LABELS[q.difficulty] || q.difficulty}</span>
      <span class="small-note">${escapeHtml(q.tournament)}${q.roundLabel ? ' · ' + escapeHtml(q.roundLabel) : ''}</span>
    `;
  }

  function labelFor(subjectKey) {
    const found = (SBData.meta.subjects || []).find((s) => s.key === subjectKey);
    return found ? found.label : subjectKey;
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  function setStatusPill(text, cls) {
    const pill = document.getElementById('statusPill');
    pill.textContent = text;
    pill.className = 'status-pill ' + (cls || '');
  }

  function nextQuestion() {
    clearTimerUI();
    runtime.buzzedDuringReading = false;
    runtime.graded = null;
    runtime.manuallyOverridden = false;
    document.getElementById('revealBox').style.display = 'none';
    document.getElementById('answerRow').style.display = 'none';
    document.getElementById('answerInput').value = '';
    document.getElementById('overrideBtn').style.display = 'none';
    document.getElementById('nextBtn').style.display = 'none';
    document.getElementById('buzzBtn').style.display = 'inline-flex';
    document.getElementById('skipBtn').style.display = 'inline-flex';

    session.index++;
    if (session.index >= session.queue.length) {
      showSummary();
      return;
    }
    updateScoreBar();
    const q = currentQuestion();
    renderMetaStrip(q);
    updateBookmarkBtn(q);

    document.getElementById('qDisplay').textContent = q.question;

    if (q.choices) {
      const cd = document.getElementById('choicesDisplay');
      cd.style.display = 'grid';
      cd.innerHTML = ['W', 'X', 'Y', 'Z'].map((L) =>
        `<div class="choice-box" data-letter="${L}"><span class="letter">${L})</span>${escapeHtml(q.choices[L])}</div>`
      ).join('');
    } else {
      document.getElementById('choicesDisplay').style.display = 'none';
      document.getElementById('choicesDisplay').innerHTML = '';
    }

    startReading(q);
  }

  function startReading(q) {
    runtime.phase = 'reading';
    setStatusPill('🔊 Reading question…', 'live');
    const rate = parseFloat(document.getElementById('rateSlider').value) || 1;
    const text = SBTTS.questionToSpeech(q);
    runtime.speechCtl = SBTTS.speak(text, rate, {
      onEnd: () => {
        if (runtime.phase === 'reading') startBuzzWindow(q);
      },
    });
  }

  function startBuzzWindow(q) {
    runtime.phase = 'buzzwindow';
    setStatusPill('⏱ Buzz window — buzz in now!', 'live');
    const ms = q.qtype === 'bonus' ? BONUS_BUZZ_MS : TOSSUP_BUZZ_MS;
    runTimer(ms, 'buzz', () => {
      // timed out without buzzing: no attempt, no penalty
      resolveQuestion({ attempted: false, correct: false, buzzedDuringReading: false, timedOut: true });
    });
  }

  function buzzIn() {
    if (runtime.phase !== 'reading' && runtime.phase !== 'buzzwindow') return;
    runtime.buzzedDuringReading = runtime.phase === 'reading';
    if (runtime.speechCtl) runtime.speechCtl.cancel();
    clearTimerUI();
    runtime.phase = 'answering';
    setStatusPill('✍️ Answer now — you have 10s', 'buzzed');
    document.getElementById('buzzBtn').style.display = 'none';
    document.getElementById('answerRow').style.display = 'flex';
    const input = document.getElementById('answerInput');
    input.value = '';
    input.focus();
    runTimer(ANSWER_MS, 'answer', () => {
      submitAnswer(''); // timeout = blank submission
    });
  }

  function submitAnswer(text) {
    if (runtime.phase !== 'answering') return;
    clearTimerUI();
    const q = currentQuestion();
    const result = text.trim() ? SBAnswer.checkAnswer(q, text) : { correct: false, matched: null, rejected: false, empty: true };
    resolveQuestion({
      attempted: true,
      correct: result.correct,
      buzzedDuringReading: runtime.buzzedDuringReading,
      userText: text,
      matched: result.matched,
    });
  }

  function resolveQuestion(outcome) {
    runtime.phase = 'revealed';
    document.getElementById('answerRow').style.display = 'none';
    document.getElementById('buzzBtn').style.display = 'none';
    document.getElementById('skipBtn').style.display = 'none';

    let delta = 0;
    let pillText, pillCls;
    if (!outcome.attempted) {
      pillText = '⌛ Time expired — no attempt'; pillCls = 'revealed';
    } else if (outcome.correct) {
      delta = 4; session.correct++;
      pillText = '✅ Correct! +4'; pillCls = 'correct';
    } else {
      delta = outcome.buzzedDuringReading ? -4 : 0;
      session.incorrect++;
      pillText = outcome.buzzedDuringReading ? '❌ Incorrect (buzzed early) ' + delta : '❌ Incorrect (+0)';
      pillCls = 'incorrect';
    }
    session.score += delta;
    runtime.graded = { ...outcome, delta };
    updateScoreBar();
    setStatusPill(pillText, pillCls);
    showReveal();
    document.getElementById('overrideBtn').style.display = 'inline-flex';
    document.getElementById('nextBtn').style.display = 'inline-flex';
  }

  function showReveal() {
    const q = currentQuestion();
    const box = document.getElementById('revealBox');
    let html = `<div class="ans-line">Answer: ${escapeHtml(q.answer.text)}${q.answer.letter ? ' (' + q.answer.letter + ')' : ''}</div>`;
    if (q.answer.accept.length) html += `<div class="alt-line">Also accept: ${escapeHtml(q.answer.accept.join('; '))}</div>`;
    if (q.answer.reject.length) html += `<div class="alt-line">Do not accept: ${escapeHtml(q.answer.reject.join('; '))}</div>`;
    if (runtime.graded && runtime.graded.userText !== undefined) {
      html += `<div class="alt-line">You answered: “${escapeHtml(runtime.graded.userText || '(blank)')}”</div>`;
    }
    html += `<div class="src-line">${escapeHtml(q.tournament)}${q.roundLabel ? ' · ' + escapeHtml(q.roundLabel) : ''} · <a href="${q.sourceUrl}" target="_blank" rel="noopener">source packet</a></div>`;
    box.innerHTML = html;
    box.style.display = 'block';

    if (q.choices && q.answer.letter) {
      const el = document.querySelector(`.choice-box[data-letter="${q.answer.letter}"]`);
      if (el) el.classList.add('reveal-correct');
    }
  }

  function skipQuestion() {
    if (runtime.phase === 'revealed') return;
    if (runtime.speechCtl) runtime.speechCtl.cancel();
    clearTimerUI();
    session.skipped++;
    resolveQuestion({ attempted: false, correct: false, buzzedDuringReading: false, skipped: true });
    setStatusPill('⏭ Skipped', 'revealed');
  }

  function overrideGrading() {
    if (!runtime.graded) return;
    // flip correctness and adjust score
    const wasCorrect = runtime.graded.correct === true;
    const nowCorrect = !wasCorrect;
    // undo previous delta & counts
    session.score -= runtime.graded.delta;
    if (runtime.graded.attempted) {
      if (wasCorrect) session.correct--; else session.incorrect--;
    }
    let delta = 0;
    if (nowCorrect) {
      delta = 4; session.correct++;
    } else {
      delta = runtime.graded.buzzedDuringReading ? -4 : 0;
      session.incorrect++;
    }
    runtime.graded.correct = nowCorrect;
    runtime.graded.attempted = true;
    runtime.graded.delta = delta;
    session.score += delta;
    runtime.manuallyOverridden = true;
    updateScoreBar();
    setStatusPill(nowCorrect ? '✅ Marked correct (override) ' + (delta>=0?'+':'') + delta : '❌ Marked incorrect (override) ' + delta, nowCorrect ? 'correct' : 'incorrect');
  }

  function updateBookmarkBtn(q) {
    const btn = document.getElementById('bookmarkBtn');
    btn.textContent = SBData.bookmarks.isBookmarked(q.id) ? '★ Bookmarked (B)' : '☆ Bookmark (B)';
  }
  function toggleBookmark() {
    const q = currentQuestion();
    if (!q) return;
    const now = SBData.bookmarks.toggle(q.id);
    updateBookmarkBtn(q);
    document.getElementById('bmCount').textContent = SBData.bookmarks.count() ? `★ ${SBData.bookmarks.count()} bookmarked` : '';
  }

  /* ---------------- timer plumbing ---------------- */
  function runTimer(ms, kind, onExpire) {
    runtime.totalMs = ms;
    runtime.remainingMs = ms;
    runtime.timerKind = kind;
    runtime.onExpire = onExpire;
    document.getElementById('timerRow').style.display = 'flex';
    const fill = document.getElementById('timerFill');
    fill.className = 'timer-bar-fill' + (kind === 'answer' ? ' answer' : '');
    tickTimerUI();
    clearInterval(runtime.timer);
    runtime.timer = setInterval(() => {
      if (runtime.paused) return;
      runtime.remainingMs -= 100;
      if (runtime.remainingMs <= 0) {
        runtime.remainingMs = 0;
        tickTimerUI();
        clearInterval(runtime.timer);
        runtime.timer = null;
        const fn = runtime.onExpire;
        runtime.onExpire = null;
        if (fn) fn();
        return;
      }
      tickTimerUI();
    }, 100);
  }
  function tickTimerUI() {
    const pct = Math.max(0, (runtime.remainingMs / runtime.totalMs) * 100);
    document.getElementById('timerFill').style.width = pct + '%';
    document.getElementById('timerLabel').textContent = (runtime.remainingMs / 1000).toFixed(1) + 's';
  }
  function clearTimerUI() {
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.timer = null;
    runtime.onExpire = null;
    document.getElementById('timerRow').style.display = 'none';
  }

  /* ---------------- pause ---------------- */
  function togglePause() {
    if (runtime.paused) resumeGame(); else pauseGame();
  }
  function pauseGame() {
    if (runtime.paused) return;
    if (runtime.phase === 'revealed' || !session.queue.length || session.index >= session.queue.length) return;
    runtime.paused = true;
    if (runtime.phase === 'reading') SBTTS.pause();
    document.getElementById('pauseOverlay').style.display = 'flex';
  }
  function resumeGame() {
    if (!runtime.paused) return;
    runtime.paused = false;
    if (runtime.phase === 'reading') SBTTS.resume();
    document.getElementById('pauseOverlay').style.display = 'none';
  }

  function showSummary() {
    document.getElementById('gameScreen').style.display = 'none';
    document.getElementById('summaryScreen').style.display = 'block';
    const el = document.getElementById('summaryStats');
    const attempted = session.correct + session.incorrect;
    const acc = attempted ? Math.round((session.correct / attempted) * 100) : 0;
    el.innerHTML = `
      <div class="summary-stat"><div class="n">${session.score}</div><div class="l">Score</div></div>
      <div class="summary-stat"><div class="n">${session.correct}</div><div class="l">Correct</div></div>
      <div class="summary-stat"><div class="n">${session.incorrect}</div><div class="l">Incorrect</div></div>
      <div class="summary-stat"><div class="n">${session.skipped}</div><div class="l">Skipped</div></div>
      <div class="summary-stat"><div class="n">${acc}%</div><div class="l">Accuracy</div></div>
    `;
  }

  function endSession() {
    if (runtime.speechCtl) runtime.speechCtl.cancel();
    clearTimerUI();
    showSummary();
  }

  /* ---------------- wiring ---------------- */
  function wireEvents() {
    document.getElementById('buzzBtn').addEventListener('click', buzzIn);
    document.getElementById('skipBtn').addEventListener('click', skipQuestion);
    document.getElementById('bookmarkBtn').addEventListener('click', toggleBookmark);
    document.getElementById('overrideBtn').addEventListener('click', overrideGrading);
    document.getElementById('nextBtn').addEventListener('click', nextQuestion);
    document.getElementById('pauseBtn').addEventListener('click', togglePause);
    document.getElementById('resumeBtn').addEventListener('click', resumeGame);
    document.getElementById('endSessionBtn').addEventListener('click', endSession);
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      document.getElementById('summaryScreen').style.display = 'none';
      document.getElementById('setupScreen').style.display = 'block';
      updateMatchCount();
    });
    document.getElementById('submitAnswerBtn').addEventListener('click', () => {
      submitAnswer(document.getElementById('answerInput').value);
    });
    document.getElementById('answerInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAnswer(document.getElementById('answerInput').value);
      }
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (document.getElementById('gameScreen').style.display === 'none') return;

      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        if (!runtime.paused) buzzIn();
        return;
      }
      if (typing) return; // let the rest fall through to native input behavior

      if (e.key === 'p' || e.key === 'P') { togglePause(); return; }
      if (runtime.paused) return;
      if (e.key === 'n' || e.key === 'N') { if (runtime.phase === 'revealed') nextQuestion(); return; }
      if (e.key === 's' || e.key === 'S') { skipQuestion(); return; }
      if (e.key === 'b' || e.key === 'B') { toggleBookmark(); return; }
      if (e.key === 'q' || e.key === 'Q') { if (runtime.phase === 'revealed') overrideGrading(); return; }
    });
  }

  SBData.load().then(() => {
    initSetup();
    wireEvents();
  }).catch((err) => {
    document.getElementById('setupScreen').innerHTML = '<p>Failed to load question data: ' + err.message + '</p>';
  });
})();
