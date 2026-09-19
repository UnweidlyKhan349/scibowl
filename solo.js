(function () {
  const QTYPE_LABELS = { tossup: 'Tossup', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };
  const TOSSUP_BUZZ_MS = 4000;
  const BONUS_BUZZ_MS = 20000;
  const ANSWER_MS = 10000;
  const LETTERS = ['W', 'X', 'Y', 'Z'];

  const filterState = { subjects: new Set(), qtypes: new Set(), formats: new Set(), tournament: '', roundRange: null, includeUnlabeled: true };
  let subjectItems, qtypeItems, formatItems, roundSliderApi;

  function buildChips(container, items, key, labelFn) {
    container.innerHTML = '';
    items.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      if (item.subjectAttr) chip.dataset.subject = item.subjectAttr;
      chip.textContent = labelFn(item);
      chip.addEventListener('click', () => {
        if (filterState[key].has(item.value)) filterState[key].delete(item.value);
        else filterState[key].add(item.value);
        chip.classList.toggle('active', filterState[key].has(item.value));
        updateMatchCount();
      });
      container.appendChild(chip);
      item._el = chip;
    });
  }

  function getFiltered() {
    return SBData.filterQuestions({
      subjects: filterState.subjects,
      roundRange: filterState.roundRange,
      includeUnlabeled: filterState.includeUnlabeled,
      qtypes: filterState.qtypes,
      formats: filterState.formats,
      tournaments: filterState.tournament ? [filterState.tournament] : null,
      bookmarkedOnly: document.getElementById('bookmarkedOnly').checked,
      includeVisual: document.getElementById('includeVisual').checked,
    });
  }

  function updateMatchCount() {
    document.getElementById('matchCount').textContent = `${getFiltered().length.toLocaleString()} questions match your filters`;
  }

  function initSetup() {
    subjectItems = SBData.meta.subjects.map((s) => ({ value: s.key, label: s.label, subjectAttr: s.key }));
    buildChips(document.getElementById('subjectChips'), subjectItems, 'subjects', (i) => i.label);

    const maxRound = Math.max(1, ...(SBData.meta.rounds && SBData.meta.rounds.length ? SBData.meta.rounds : [1]));
    roundSliderApi = SBData.wireRoundRangeSlider({
      minInput: document.getElementById('roundMin'),
      maxInput: document.getElementById('roundMax'),
      fillEl: document.getElementById('roundSliderFill'),
      labelEl: document.getElementById('roundRangeLabel'),
      maxRound,
      onChange: (lo, hi) => { filterState.roundRange = [lo, hi]; updateMatchCount(); },
    });
    document.getElementById('includeUnlabeledRounds').addEventListener('change', (e) => {
      filterState.includeUnlabeled = e.target.checked;
      updateMatchCount();
    });

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

    document.getElementById('bookmarkedOnly').addEventListener('change', updateMatchCount);
    document.getElementById('includeVisual').addEventListener('change', updateMatchCount);

    document.getElementById('selectAllBtn').addEventListener('click', () => {
      subjectItems.forEach((i) => { filterState.subjects.add(i.value); i._el.classList.add('active'); });
      updateMatchCount();
    });
    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
      [[subjectItems, 'subjects'], [qtypeItems, 'qtypes'], [formatItems, 'formats']].forEach(([items, key]) => {
        filterState[key].clear();
        items.forEach((i) => i._el.classList.remove('active'));
      });
      filterState.tournament = '';
      tSelect.value = '';
      document.getElementById('bookmarkedOnly').checked = false;
      document.getElementById('includeVisual').checked = false;
      if (roundSliderApi) roundSliderApi.reset();
      document.getElementById('includeUnlabeledRounds').checked = true;
      filterState.includeUnlabeled = true;
      updateMatchCount();
    });

    const rateSlider = document.getElementById('rateSlider');
    const savedRate = parseFloat(localStorage.getItem('sb_rate') || '1');
    rateSlider.value = isNaN(savedRate) ? 1 : savedRate;
    document.getElementById('rateValue').textContent = parseFloat(rateSlider.value).toFixed(1) + '×';
    rateSlider.addEventListener('input', () => {
      document.getElementById('rateValue').textContent = parseFloat(rateSlider.value).toFixed(1) + '×';
      try { localStorage.setItem('sb_rate', rateSlider.value); } catch (e) {}
    });

    document.getElementById('startBtn').addEventListener('click', startSession);
    updateMatchCount();

    // Arrived from the bookmarks page "Practice these" button — jump straight in.
    if (new URLSearchParams(location.search).get('bookmarked') === '1') {
      document.getElementById('bookmarkedOnly').checked = true;
      if (getFiltered().length) startSession();
    }
  }

  /* ================= GAME STATE ================= */
  const session = {
    queue: [], index: -1,
    correct: 0, incorrect: 0, skipped: 0,
    rate: 1,
    log: [],
  };
  const runtime = {
    phase: 'revealing', // revealing | buzzwindow | answering | reveal | done
    revealCtl: null,
    buzzedDuringReading: false,
    lastOutcome: null,
    timer: null, remainingMs: 0, totalMs: 0, timerKind: null, onExpire: null,
    paused: false,
    pausedTimerRemaining: null,
  };

  function startSession() {
    let pool = getFiltered();
    if (!pool.length) { alert('No questions match your filters.'); return; }
    pool = SBData.shuffle(pool);

    session.queue = pool;
    session.index = -1;
    session.correct = 0; session.incorrect = 0; session.skipped = 0;
    session.rate = parseFloat(document.getElementById('rateSlider').value) || 1;
    session.log = [];

    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    document.getElementById('questionLog').innerHTML = '';
    updateCounters();
    nextQuestion();
  }

  function updateCounters() {
    document.getElementById('correctCount').textContent = session.correct;
    document.getElementById('incorrectCount').textContent = session.incorrect;
    document.getElementById('skippedCount').textContent = session.skipped;
  }

  function currentQ() { return session.queue[session.index]; }

  function nextQuestion() {
    clearRuntimeTimer();
    if (runtime.revealCtl) runtime.revealCtl.stop();
    runtime.paused = false;
    document.getElementById('pauseBadge').style.display = 'none';
    document.getElementById('pauseBtn').textContent = 'Pause (P)';

    session.index++;
    if (session.index >= session.queue.length) {
      showSessionDone();
      return;
    }
    const q = currentQ();
    runtime.phase = 'revealing';
    runtime.buzzedDuringReading = false;
    runtime.lastOutcome = null;

    renderMeta(q);
    hidePill();
    document.getElementById('revealBox').style.display = 'none';
    document.getElementById('answerRow').style.display = 'none';
    document.getElementById('overrideBtn').style.display = 'none';
    hideTimer();
    setNextButtonMode('skip');
    updateBookmarkBtn();
    document.querySelectorAll('#choicesDisplay .choice-box').forEach((el) => {
      el.classList.remove('reveal-correct');
      el.classList.remove('clickable');
    });

    const buzzBtn = document.getElementById('buzzBtn');
    buzzBtn.style.display = 'inline-flex';

    const qDisplay = document.getElementById('qDisplay');
    const subjectTag = document.getElementById('revealSubjectTag');
    const formatTag = document.getElementById('revealFormatTag');
    const qtypeTag = document.getElementById('revealQtypeTag');
    subjectTag.className = 'tag subject-' + q.subject;
    formatTag.className = 'tag fmt';
    qtypeTag.className = 'tag qtype-' + q.qtype;
    const segments = [
      { text: labelFor(q.subject).toUpperCase(), el: subjectTag },
      { text: (FORMAT_LABELS[q.format] || q.format).toUpperCase(), el: formatTag },
      { text: (QTYPE_LABELS[q.qtype] || q.qtype).toUpperCase(), el: qtypeTag },
      { text: q.question, el: qDisplay },
    ];
    const choicesDisplay = document.getElementById('choicesDisplay');
    if (q.choices) {
      choicesDisplay.style.display = 'grid';
      LETTERS.forEach((L) => {
        segments.push({ text: q.choices[L] || '', el: document.getElementById('choiceText' + L) });
      });
    } else {
      choicesDisplay.style.display = 'none';
    }

    runtime.revealCtl = SBReveal.startReveal(segments, session.rate, {
      onComplete: () => { startBuzzWindow(); },
    });
  }

  function startBuzzWindow() {
    if (runtime.phase === 'answering' || runtime.phase === 'reveal') return;
    runtime.phase = 'buzzwindow';
    setPill('Buzz in!', 'live');
    const q = currentQ();
    const ms = q.qtype === 'bonus' ? BONUS_BUZZ_MS : TOSSUP_BUZZ_MS;
    runTimer(ms, 'buzz', () => { resolveQuestion({ attempted: false }); });
  }

  function buzzIn() {
    if (runtime.phase !== 'revealing' && runtime.phase !== 'buzzwindow') return;
    if (runtime.paused) return;
    runtime.buzzedDuringReading = runtime.phase === 'revealing';
    if (runtime.revealCtl) runtime.revealCtl.stop();
    clearRuntimeTimer();
    runtime.phase = 'answering';
    hidePill();
    document.getElementById('buzzBtn').style.display = 'none';
    setNextButtonMode('hidden');
    const answerRow = document.getElementById('answerRow');
    answerRow.style.display = 'flex';
    const input = document.getElementById('answerInput');
    input.value = '';
    input.focus();

    const q = currentQ();
    if (q.format === 'MC' && q.choices) {
      document.querySelectorAll('#choicesDisplay .choice-box').forEach((el) => el.classList.add('clickable'));
    }
    runTimer(ANSWER_MS, 'answer', () => submitAnswer(''));
  }

  function submitAnswer(text) {
    if (runtime.phase !== 'answering') return;
    clearRuntimeTimer();
    const q = currentQ();
    const result = text.trim() ? SBAnswer.checkAnswer(q, text) : { correct: false };
    resolveQuestion({ attempted: true, correct: result.correct });
  }

  function resolveQuestion(outcome) {
    clearRuntimeTimer();
    if (runtime.revealCtl) runtime.revealCtl.skipToEnd();
    runtime.phase = 'reveal';
    runtime.lastOutcome = outcome;

    let category;
    if (!outcome.attempted) { category = 'skipped'; session.skipped++; }
    else if (outcome.correct) { category = 'correct'; session.correct++; }
    else { category = 'incorrect'; session.incorrect++; }
    updateCounters();

    const q = currentQ();
    session.log.push({ id: q.id, subject: q.subject, qtype: q.qtype, category });
    renderQuestionLog();

    setPill(outcome.attempted ? (outcome.correct ? 'Correct' : 'Incorrect') : 'Skipped', outcome.attempted ? (outcome.correct ? 'correct' : 'incorrect') : 'revealed');
    document.getElementById('buzzBtn').style.display = 'none';
    document.getElementById('answerRow').style.display = 'none';
    document.getElementById('overrideBtn').style.display = outcome.attempted ? 'inline-flex' : 'none';
    hideTimer();
    setNextButtonMode('next');
    showReveal();
  }

  function showReveal() {
    const q = currentQ();
    const box = document.getElementById('revealBox');
    let html = `<div class="ans-line">Answer: ${escapeHtml(q.answer.text)}${q.answer.letter ? ' (' + q.answer.letter + ')' : ''}</div>`;
    if (q.answer.accept.length) html += `<div class="alt-line">Also accept: ${escapeHtml(q.answer.accept.join('; '))}</div>`;
    if (q.answer.reject.length) html += `<div class="alt-line">Do not accept: ${escapeHtml(q.answer.reject.join('; '))}</div>`;
    const roundPart = SBData.roundLabelFor(q);
    html += `<div class="src-line">${escapeHtml(q.tournament)}${roundPart ? ' · ' + escapeHtml(roundPart) : ''}</div>`;
    box.innerHTML = html;
    box.style.display = 'block';
    if (q.choices && q.answer.letter) {
      const el = document.querySelector(`.choice-box[data-letter="${q.answer.letter}"]`);
      if (el) el.classList.add('reveal-correct');
    }
    document.querySelectorAll('#choicesDisplay .choice-box').forEach((el) => el.classList.remove('clickable'));
  }

  function skipQuestion() {
    if (runtime.phase !== 'revealing' && runtime.phase !== 'buzzwindow') return;
    resolveQuestion({ attempted: false });
  }

  function overrideGrading() {
    if (runtime.phase !== 'reveal' || !runtime.lastOutcome || !runtime.lastOutcome.attempted) return;
    const wasCorrect = runtime.lastOutcome.correct;
    if (wasCorrect) { session.correct--; session.incorrect++; }
    else { session.incorrect--; session.correct++; }
    runtime.lastOutcome.correct = !wasCorrect;
    updateCounters();
    setPill(runtime.lastOutcome.correct ? 'Correct' : 'Incorrect', runtime.lastOutcome.correct ? 'correct' : 'incorrect');
    if (session.log.length) session.log[session.log.length - 1].category = runtime.lastOutcome.correct ? 'correct' : 'incorrect';
    renderQuestionLog();
  }

  function toggleBookmark() {
    const q = currentQ();
    if (!q) return;
    SBData.bookmarks.toggle(q.id);
    updateBookmarkBtn();
  }
  function updateBookmarkBtn() {
    const q = currentQ();
    const btn = document.getElementById('bookmarkBtn');
    if (!q) return;
    const isBm = SBData.bookmarks.isBookmarked(q.id);
    btn.textContent = isBm ? '★' : '☆';
    btn.classList.toggle('active', isBm);
    btn.title = isBm ? 'Unbookmark (B)' : 'Bookmark (B)';
  }

  function setNextButtonMode(mode) {
    const btn = document.getElementById('nextBtn');
    if (mode === 'skip') { btn.style.display = 'inline-flex'; btn.textContent = 'Skip (N)'; btn.dataset.mode = 'skip'; }
    else if (mode === 'next') { btn.style.display = 'inline-flex'; btn.textContent = 'Next question (N)'; btn.dataset.mode = 'next'; }
    else { btn.style.display = 'none'; btn.dataset.mode = ''; }
  }
  function handleNextButton() {
    const mode = document.getElementById('nextBtn').dataset.mode;
    if (mode === 'skip') skipQuestion();
    else if (mode === 'next') nextQuestion();
  }

  function renderMeta(q) {
    const strip = document.getElementById('metaStrip');
    const roundPart = SBData.roundLabelFor(q);
    strip.innerHTML = `
      <span class="small-note">${escapeHtml(q.tournament)}${roundPart ? ' · ' + escapeHtml(roundPart) : ''}</span>
      ${q.visual ? '<span class="tag visual-warn">⚠ Visual bonus — image not shown</span>' : ''}
    `;
  }

  function setPill(text, cls) {
    const el = document.getElementById('statusPill');
    el.textContent = text;
    el.className = 'status-pill ' + (cls || '');
    el.style.display = 'inline-flex';
  }
  function hidePill() {
    document.getElementById('statusPill').style.display = 'none';
  }

  function runTimer(ms, kind, onExpire) {
    clearRuntimeTimer();
    runtime.totalMs = ms; runtime.remainingMs = ms; runtime.timerKind = kind; runtime.onExpire = onExpire;
    renderTick(ms, ms, kind);
    runtime.timer = setInterval(() => {
      if (runtime.paused) return;
      runtime.remainingMs -= 100;
      if (runtime.remainingMs <= 0) {
        renderTick(0, runtime.totalMs, kind);
        clearInterval(runtime.timer); runtime.timer = null;
        const fn = runtime.onExpire; runtime.onExpire = null;
        if (fn) fn();
        return;
      }
      renderTick(runtime.remainingMs, runtime.totalMs, kind);
    }, 100);
  }
  function clearRuntimeTimer() {
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.timer = null; runtime.onExpire = null;
  }
  function renderTick(remainingMs, totalMs, kind) {
    const row = document.getElementById('timerRow');
    row.style.display = 'flex';
    const fill = document.getElementById('timerFill');
    fill.className = 'timer-bar-fill' + (kind === 'answer' ? ' answer' : '');
    fill.style.width = Math.max(0, (remainingMs / totalMs) * 100) + '%';
    document.getElementById('timerLabel').textContent = (remainingMs / 1000).toFixed(1) + 's';
  }
  function hideTimer() { document.getElementById('timerRow').style.display = 'none'; }

  function togglePause() {
    if (runtime.phase === 'reveal' || runtime.phase === 'done') return;
    runtime.paused = !runtime.paused;
    document.getElementById('pauseBadge').style.display = runtime.paused ? 'inline-flex' : 'none';
    document.getElementById('pauseBtn').textContent = runtime.paused ? 'Resume (P)' : 'Pause (P)';
    if (runtime.revealCtl && runtime.phase === 'revealing') {
      if (runtime.paused) runtime.revealCtl.pause(); else runtime.revealCtl.resume();
    }
    // the setInterval-based countdown timer already checks runtime.paused each tick
  }

  function renderQuestionLog() {
    const el = document.getElementById('questionLog');
    el.innerHTML = '';
    session.log.forEach((entry) => {
      const chip = document.createElement('div');
      chip.className = 'q-log-chip ' + entry.category;
      chip.title = `${labelFor(entry.subject)} · ${QTYPE_LABELS[entry.qtype] || entry.qtype} · ${entry.category}`;
      el.appendChild(chip);
    });
  }

  function showSessionDone() {
    runtime.phase = 'done';
    setPill('Session complete', 'revealed');
    document.getElementById('qDisplay').textContent = '';
    document.getElementById('choicesDisplay').style.display = 'none';
    document.getElementById('buzzBtn').style.display = 'none';
    document.getElementById('answerRow').style.display = 'none';
    document.getElementById('overrideBtn').style.display = 'none';
    hideTimer();
    setNextButtonMode('hidden');
    const box = document.getElementById('revealBox');
    box.innerHTML = `
      <div class="ans-line">You've gone through every question that matched your filters.</div>
      <div class="alt-line">${session.correct} correct · ${session.incorrect} incorrect · ${session.skipped} skipped</div>
      <div style="margin-top:14px; display:flex; gap:10px;">
        <button class="btn primary" id="playAgainBtn">Practice again</button>
        <a class="btn ghost" href="catalog.html">Browse catalog</a>
      </div>
    `;
    box.style.display = 'block';
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      document.getElementById('gameScreen').style.display = 'none';
      document.getElementById('setupScreen').style.display = 'block';
      updateMatchCount();
    });
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

  function wireGameControls() {
    document.getElementById('buzzBtn').addEventListener('click', buzzIn);
    document.getElementById('nextBtn').addEventListener('click', handleNextButton);
    document.getElementById('overrideBtn').addEventListener('click', overrideGrading);
    document.getElementById('bookmarkBtn').addEventListener('click', toggleBookmark);
    document.getElementById('pauseBtn').addEventListener('click', togglePause);
    document.getElementById('submitAnswerBtn').addEventListener('click', () => submitAnswer(document.getElementById('answerInput').value));
    document.getElementById('answerInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitAnswer(document.getElementById('answerInput').value); }
    });
    document.querySelectorAll('#choicesDisplay .choice-box').forEach((el) => {
      el.addEventListener('click', () => {
        if (!el.classList.contains('clickable')) return;
        submitAnswer(el.dataset.letter);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (document.getElementById('gameScreen').style.display === 'none') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); buzzIn(); return; }
      if (e.key === 'n' || e.key === 'N') { handleNextButton(); return; }
      if (e.key === 'q' || e.key === 'Q') { overrideGrading(); return; }
      if (e.key === 'b' || e.key === 'B') { toggleBookmark(); return; }
      if (e.key === 'p' || e.key === 'P') { togglePause(); return; }
    });
  }

  SBData.load().then(() => {
    initSetup();
    wireGameControls();
  }).catch((err) => {
    document.getElementById('setupScreen').innerHTML = '<p>Failed to load question data: ' + err.message + '</p>';
  });
})();
