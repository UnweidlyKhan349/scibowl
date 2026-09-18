(function () {
  const QTYPE_LABELS = { tossup: 'Tossup', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };
  const TOSSUP_BUZZ_MS = 4000;
  const BONUS_BUZZ_MS = 20000;
  const ANSWER_MS = 10000;
  const LETTERS = ['W', 'X', 'Y', 'Z'];
  const ROOM_PREFIX = 'sbowl-';

  const filterState = { subjects: new Set(), rounds: new Set(), qtypes: new Set(), formats: new Set(), tournament: '' };
  let subjectItems, roundItems, qtypeItems, formatItems;

  const myState = { role: null, myId: null, myName: '', rate: 1 };

  /* ================= LOBBY SETUP ================= */
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
      subjects: filterState.subjects, rounds: filterState.rounds,
      qtypes: filterState.qtypes, formats: filterState.formats,
      tournaments: filterState.tournament ? [filterState.tournament] : null,
      includeVisual: document.getElementById('includeVisual').checked,
    });
  }
  function updateMatchCount() {
    document.getElementById('matchCount').textContent = `${getFiltered().length.toLocaleString()} questions match your filters`;
  }

  function initLobby() {
    subjectItems = SBData.meta.subjects.map((s) => ({ value: s.key, label: s.label, subjectAttr: s.key }));
    buildChips(document.getElementById('subjectChips'), subjectItems, 'subjects', (i) => i.label);
    roundItems = (SBData.meta.rounds || []).map((r) => ({ value: r, label: 'Round ' + r }));
    roundItems.push({ value: null, label: 'Unlabeled' });
    buildChips(document.getElementById('roundChips'), roundItems, 'rounds', (i) => i.label);
    qtypeItems = SBData.meta.qtypes.map((q) => ({ value: q, label: QTYPE_LABELS[q] || q }));
    buildChips(document.getElementById('qtypeChips'), qtypeItems, 'qtypes', (i) => i.label);
    formatItems = SBData.meta.formats.map((f) => ({ value: f, label: FORMAT_LABELS[f] || f }));
    buildChips(document.getElementById('formatChips'), formatItems, 'formats', (i) => i.label);

    const tSelect = document.getElementById('tournamentSelect');
    SBData.meta.tournaments.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.slug; opt.textContent = `${t.name} (${t.count})`;
      tSelect.appendChild(opt);
    });
    tSelect.addEventListener('change', () => { filterState.tournament = tSelect.value; updateMatchCount(); });
    document.getElementById('includeVisual').addEventListener('change', updateMatchCount);
    updateMatchCount();

    document.getElementById('selectAllBtn').addEventListener('click', () => {
      [[subjectItems, 'subjects'], [roundItems, 'rounds'], [qtypeItems, 'qtypes'], [formatItems, 'formats']].forEach(([items, key]) => {
        items.forEach((i) => { filterState[key].add(i.value); i._el.classList.add('active'); });
      });
      updateMatchCount();
    });
    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
      [[subjectItems, 'subjects'], [roundItems, 'rounds'], [qtypeItems, 'qtypes'], [formatItems, 'formats']].forEach(([items, key]) => {
        filterState[key].clear();
        items.forEach((i) => i._el.classList.remove('active'));
      });
      filterState.tournament = '';
      tSelect.value = '';
      document.getElementById('includeVisual').checked = false;
      updateMatchCount();
    });

    document.getElementById('bmCount').textContent = SBData.bookmarks.count() ? `★ ${SBData.bookmarks.count()} bookmarked` : '';
    document.getElementById('createRoomBtn').addEventListener('click', createRoom);
    document.getElementById('joinRoomBtn').addEventListener('click', joinRoom);
  }

  /* ================= SHARED GAME STATE (rendered identically on host & clients) ================= */
  const game = {
    players: [], phase: 'lobby', index: 0, total: 0,
    question: null, buzzedPlayerId: null, lockedOut: new Set(),
    lastGrade: null, log: [], paused: false,
  };

  let revealCtl = null;

  function labelFor(subjectKey) {
    const found = (SBData.meta.subjects || []).find((s) => s.key === subjectKey);
    return found ? found.label : subjectKey;
  }
  function escapeHtml(s) {
    const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML;
  }
  function sanitizeQuestion(q) {
    return {
      id: q.id, tournament: q.tournament, roundLabel: q.roundLabel, round: q.round,
      subject: q.subject, format: q.format, qtype: q.qtype, question: q.question,
      visual: q.visual,
      choices: q.choices ? { W: q.choices.W, X: q.choices.X, Y: q.choices.Y, Z: q.choices.Z } : null,
    };
  }
  function displayRoomCode(code) { return code.startsWith(ROOM_PREFIX) ? code.slice(ROOM_PREFIX.length) : code; }

  /* ================= RENDERING (host + client share this) ================= */
  function renderPlayerList(container) {
    container.innerHTML = '';
    game.players.slice().sort((a, b) => b.score - a.score).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'mp-player-row' + (p.id === myState.myId ? ' me' : '') + (p.id === game.buzzedPlayerId ? ' buzzed' : '');
      const lockedBadge = game.lockedOut.has(p.id) ? '<span class="badge">locked out</span>' : (p.id === game.buzzedPlayerId ? '<span class="badge">buzzed!</span>' : '');
      row.innerHTML = `<span class="name">${escapeHtml(p.name)}${p.id === myState.myId ? ' (you)' : ''}</span> ${lockedBadge} <span class="pts">${p.score > 0 ? '+' : ''}${p.score}</span>`;
      container.appendChild(row);
    });
  }

  function renderMeta(q) {
    document.getElementById('mpMetaStrip').innerHTML = `
      <span class="tag subject-${q.subject}">${labelFor(q.subject)}</span>
      <span class="tag qtype-${q.qtype}">${QTYPE_LABELS[q.qtype] || q.qtype}</span>
      <span class="tag fmt">${FORMAT_LABELS[q.format] || q.format}</span>
      <span class="tag round">${q.round ? 'Round ' + q.round : 'Round —'}</span>
      <span class="small-note">${escapeHtml(q.tournament)}${q.roundLabel ? ' · ' + escapeHtml(q.roundLabel) : ''}</span>
      ${q.visual ? '<span class="tag visual-warn">⚠ Visual bonus — image not shown</span>' : ''}
    `;
  }

  function setPill(text, cls) {
    const el = document.getElementById('mpStatusPill');
    el.textContent = text; el.className = 'status-pill ' + (cls || '');
  }

  function renderTick(remainingMs, totalMs, kind) {
    const row = document.getElementById('mpTimerRow');
    row.style.display = 'flex';
    const fill = document.getElementById('mpTimerFill');
    fill.className = 'timer-bar-fill' + (kind === 'answer' ? ' answer' : '');
    fill.style.width = Math.max(0, (remainingMs / totalMs) * 100) + '%';
    document.getElementById('mpTimerLabel').textContent = (remainingMs / 1000).toFixed(1) + 's';
  }
  function hideTimer() { document.getElementById('mpTimerRow').style.display = 'none'; }

  function renderQuestionLog() {
    const el = document.getElementById('mpQuestionLog');
    el.innerHTML = '';
    game.log.forEach((entry) => {
      const chip = document.createElement('div');
      chip.className = 'q-log-chip ' + entry.category;
      chip.title = `${labelFor(entry.subject)} · ${QTYPE_LABELS[entry.qtype] || entry.qtype} · ${entry.category}`;
      el.appendChild(chip);
    });
  }

  function startLocalReveal(q) {
    if (revealCtl) revealCtl.stop();
    const qDisplay = document.getElementById('mpQDisplay');
    const tagLine = `${QTYPE_LABELS[q.qtype] || q.qtype}, ${labelFor(q.subject)}`.toUpperCase();
    const segments = [{ text: tagLine + '\n\n' + q.question, el: qDisplay }];
    if (q.choices) {
      LETTERS.forEach((L) => segments.push({ text: q.choices[L] || '', el: document.getElementById('mpChoiceText' + L) }));
    }
    revealCtl = SBReveal.startReveal(segments, myState.rate, {});
    if (game.paused) revealCtl.pause();
  }

  function fullRenderFromState() {
    document.getElementById('mpProgress').textContent = `Question ${game.index + 1} of ${game.total}`;
    renderPlayerList(document.getElementById('mpPlayerList'));
    renderQuestionLog();
    const buzzBtn = document.getElementById('mpBuzzBtn');
    const answerRow = document.getElementById('mpAnswerRow');
    const nextBtn = document.getElementById('mpNextBtn');
    const overrideBtn = document.getElementById('mpOverrideBtn');
    const revealBox = document.getElementById('mpRevealBox');
    const judgeNote = document.getElementById('mpJudgeNote');
    const pauseBtn = document.getElementById('mpPauseBtn');

    if (game.question) renderMeta(game.question);

    revealBox.style.display = 'none';
    document.querySelectorAll('.choice-box').forEach((el) => { el.classList.remove('reveal-correct'); el.classList.remove('clickable'); });
    answerRow.style.display = 'none';
    nextBtn.style.display = 'none';
    buzzBtn.style.display = 'none';
    overrideBtn.style.display = 'none';
    judgeNote.style.display = 'none';
    hideTimer();
    pauseBtn.style.display = myState.role === 'host' ? 'inline-flex' : 'none';
    pauseBtn.textContent = game.paused ? 'Resume (P)' : 'Pause (P)';
    document.getElementById('mpPauseBadge').style.display = game.paused ? 'inline-flex' : 'none';

    const amBuzzed = game.buzzedPlayerId === myState.myId;
    const amLocked = game.lockedOut.has(myState.myId);

    if (game.phase === 'reading') {
      setPill('Revealing…', 'live');
      buzzBtn.style.display = amLocked ? 'none' : 'inline-flex';
    } else if (game.phase === 'buzzwindow') {
      setPill('Buzz in!', 'live');
      buzzBtn.style.display = amLocked ? 'none' : 'inline-flex';
    } else if (game.phase === 'answering') {
      if (amBuzzed) {
        setPill('Your turn — type your answer!', 'buzzed');
        answerRow.style.display = 'flex';
        document.getElementById('mpAnswerInput').value = '';
        document.getElementById('mpAnswerInput').focus();
        if (game.question && game.question.format === 'MC' && game.question.choices) {
          document.querySelectorAll('#mpChoicesDisplay .choice-box').forEach((el) => el.classList.add('clickable'));
        }
      } else {
        const bp = game.players.find((p) => p.id === game.buzzedPlayerId);
        setPill(`${bp ? bp.name : 'Someone'} is answering…`, 'answering');
      }
    } else if (game.phase === 'reveal') {
      setPill('Revealed', 'revealed');
      nextBtn.style.display = 'inline-flex';
      if (myState.role === 'host' && hostGame.lastGrade) {
        overrideBtn.style.display = 'inline-flex';
        const g = hostGame.lastGrade;
        const p = hostPlayers.get(g.connId);
        judgeNote.style.display = 'block';
        judgeNote.textContent = `Auto-graded ${p ? p.name : '?'}'s answer "${g.userText || '(blank)'}" as ${g.correct ? 'CORRECT' : 'INCORRECT'}.`;
      }
      showReveal();
    } else if (game.phase === 'gameover') {
      setPill('Game over', 'revealed');
    }
  }

  function showReveal() {
    const box = document.getElementById('mpRevealBox');
    const r = game.lastRevealData;
    if (!r) { box.style.display = 'none'; return; }
    let html = `<div class="ans-line">Answer: ${escapeHtml(r.answerText)}${r.letter ? ' (' + r.letter + ')' : ''}</div>`;
    if (r.accept && r.accept.length) html += `<div class="alt-line">Also accept: ${escapeHtml(r.accept.join('; '))}</div>`;
    if (r.reject && r.reject.length) html += `<div class="alt-line">Do not accept: ${escapeHtml(r.reject.join('; '))}</div>`;
    html += `<div class="src-line">${escapeHtml(game.question.tournament)}${game.question.roundLabel ? ' · ' + escapeHtml(game.question.roundLabel) : ''}</div>`;
    box.innerHTML = html;
    box.style.display = 'block';
    if (revealCtl) revealCtl.skipToEnd();
    if (game.question.choices && r.letter) {
      const el = document.querySelector(`.choice-box[data-letter="${r.letter}"]`);
      if (el) el.classList.add('reveal-correct');
    }
  }

  /* ================= HOST-ONLY AUTHORITATIVE LOGIC ================= */
  let host = null;
  const hostGame = {
    queue: [], index: -1, phase: 'lobby',
    buzzedConnId: null, buzzedDuringReading: false, anyAttempt: false,
    lockedOutIds: new Set(),
    timer: null, remainingMs: 0, totalMs: 0, timerKind: null, onExpire: null,
    paused: false,
  };
  const hostPlayers = new Map();

  function createRoom() {
    let pool = getFiltered();
    if (!pool.length) { alert('No questions match your filters.'); return; }
    pool = SBData.shuffle(pool);
    const limit = parseInt(document.getElementById('sessionLength').value, 10);
    pool = pool.slice(0, limit);

    myState.role = 'host';
    myState.myId = 'HOST';
    myState.myName = document.getElementById('hostNameInput').value.trim() || 'Host';
    myState.rate = 1;

    hostGame.queue = pool;
    hostPlayers.set('HOST', { id: 'HOST', name: myState.myName, score: 0, connId: 'HOST' });

    host = SBPeer.makeHost({
      onPlayerMessage: handleHostMessage,
      onPlayerConnect: () => {},
      onPlayerDisconnect: (connId) => { hostPlayers.delete(connId); broadcastLobby(); },
      onError: (err) => { document.getElementById('waitingNote').textContent = 'Connection error: ' + err.type; },
    });

    host.ready.then((id) => {
      document.getElementById('roomCodeDisplay').textContent = displayRoomCode(id);
      showWaitingRoom(true);
      broadcastLobby();
    }).catch((err) => {
      alert('Could not start the room (network/signaling issue). Try again.\n' + err);
    });
  }

  function broadcastLobby() {
    game.players = [...hostPlayers.values()].map((p) => ({ id: p.id, name: p.name, score: p.score }));
    renderPlayerList(document.getElementById('waitingPlayers'));
    if (host) host.broadcast({ type: 'lobby', players: game.players, roomCode: host.roomCode });
  }

  function handleHostMessage(connId, msg) {
    if (msg.type === 'join') {
      hostPlayers.set(connId, { id: connId, name: (msg.name || 'Player').slice(0, 24), score: 0, connId });
      broadcastLobby();
      return;
    }
    if (msg.type === 'buzz') { hostHandleBuzz(connId); return; }
    if (msg.type === 'submitAnswer') { hostHandleAnswer(connId, msg.text); return; }
    if (msg.type === 'next') { if (hostGame.phase === 'reveal') hostNextQuestion(); return; }
  }

  function startGame() {
    hostGame.index = -1;
    game.total = hostGame.queue.length;
    game.log = [];
    host.broadcast({ type: 'gameStart', total: game.total });
    document.getElementById('waitingScreen').style.display = 'none';
    document.getElementById('mpGameScreen').style.display = 'flex';
    hostNextQuestion();
  }

  function hostNextQuestion() {
    clearHostTimer();
    hostGame.index++;
    hostGame.buzzedConnId = null;
    hostGame.anyAttempt = false;
    hostGame.lockedOutIds = new Set();
    hostGame.lastGrade = null;
    game.lastRevealData = null;

    if (hostGame.index >= hostGame.queue.length) {
      hostGame.phase = 'gameover';
      const scores = [...hostPlayers.values()].map((p) => ({ id: p.id, name: p.name, score: p.score }));
      host.broadcast({ type: 'gameover', scores });
      applyGameOverLocal(scores);
      return;
    }
    const full = hostGame.queue[hostGame.index];
    hostGame.currentFull = full;
    const sanitized = sanitizeQuestion(full);
    hostGame.phase = 'reading';
    host.broadcast({ type: 'question', index: hostGame.index, total: hostGame.queue.length, question: sanitized, rate: myState.rate });
    applyQuestionLocal(hostGame.index, hostGame.queue.length, sanitized);

    revealCtl = SBReveal.startReveal(
      [{ text: `${(QTYPE_LABELS[sanitized.qtype] || sanitized.qtype)}, ${labelFor(sanitized.subject)}`.toUpperCase() + '\n\n' + sanitized.question, el: document.getElementById('mpQDisplay') }]
        .concat(sanitized.choices ? LETTERS.map((L) => ({ text: sanitized.choices[L] || '', el: document.getElementById('mpChoiceText' + L) })) : []),
      myState.rate,
      { onComplete: () => hostStartBuzzWindow() }
    );
    if (hostGame.paused && revealCtl) revealCtl.pause();
  }

  function hostStartBuzzWindow() {
    if (hostGame.phase !== 'reading') return;
    hostGame.phase = 'buzzwindow';
    host.broadcast({ type: 'phase', phase: 'buzzwindow' });
    applyPhaseLocal('buzzwindow');
    const full = hostGame.currentFull;
    const ms = full.qtype === 'bonus' ? BONUS_BUZZ_MS : TOSSUP_BUZZ_MS;
    hostRunTimer(ms, 'buzz', () => hostReveal());
  }

  function hostHandleBuzz(connId) {
    if (hostGame.phase !== 'reading' && hostGame.phase !== 'buzzwindow') return;
    if (hostGame.lockedOutIds.has(connId) || hostGame.buzzedConnId) return;
    hostGame.buzzedDuringReading = hostGame.phase === 'reading';
    hostGame.buzzedConnId = connId;
    hostGame.anyAttempt = true;
    hostGame.phase = 'answering';
    clearHostTimer();
    if (revealCtl) revealCtl.stop();
    const p = hostPlayers.get(connId);
    host.broadcast({ type: 'buzzAccepted', playerId: connId, playerName: p ? p.name : '?' });
    applyBuzzLocal(connId);
    hostRunTimer(ANSWER_MS, 'answer', () => hostHandleAnswer(connId, ''));
  }

  function hostHandleAnswer(connId, text) {
    if (hostGame.phase !== 'answering' || connId !== hostGame.buzzedConnId) return;
    clearHostTimer();
    const full = hostGame.currentFull;
    const result = text.trim() ? SBAnswer.checkAnswer(full, text) : { correct: false };
    hostApplyGrade(connId, result.correct, text);
  }

  function hostApplyGrade(connId, correct, userText) {
    const p = hostPlayers.get(connId);
    let delta = 0;
    if (correct) {
      delta = 4; if (p) p.score += 4;
    } else {
      delta = hostGame.buzzedDuringReading ? -4 : 0;
      if (p) p.score += delta;
      hostGame.lockedOutIds.add(connId);
    }
    hostGame.lastGrade = { connId, correct, delta, userText };
    const scores = [...hostPlayers.values()].map((pp) => ({ id: pp.id, score: pp.score }));
    host.broadcast({ type: 'graded', playerId: connId, correct, delta, userText, scores });
    applyGradeLocal(connId, correct, delta, scores);

    if (correct) {
      hostReveal();
    } else {
      const remaining = [...hostPlayers.keys()].filter((id) => !hostGame.lockedOutIds.has(id));
      hostGame.buzzedConnId = null;
      if (!remaining.length) {
        hostReveal();
      } else {
        hostGame.phase = 'buzzwindow';
        host.broadcast({ type: 'phase', phase: 'buzzwindow', lockedOut: [...hostGame.lockedOutIds] });
        applyPhaseLocal('buzzwindow', [...hostGame.lockedOutIds]);
        const full = hostGame.currentFull;
        const ms = full.qtype === 'bonus' ? BONUS_BUZZ_MS : TOSSUP_BUZZ_MS;
        hostRunTimer(ms, 'buzz', () => hostReveal());
      }
    }
  }

  function hostOverrideLastGrade() {
    const g = hostGame.lastGrade;
    if (!g) return;
    const p = hostPlayers.get(g.connId);
    if (p) p.score -= g.delta;
    const nowCorrect = !g.correct;
    let delta = 0;
    if (nowCorrect) {
      delta = 4;
    } else {
      delta = hostGame.buzzedDuringReading ? -4 : 0;
      hostGame.lockedOutIds.add(g.connId);
    }
    if (p) p.score += delta;
    hostGame.lastGrade = { ...g, correct: nowCorrect, delta };
    const scores = [...hostPlayers.values()].map((pp) => ({ id: pp.id, score: pp.score }));
    host.broadcast({ type: 'graded', playerId: g.connId, correct: nowCorrect, delta, userText: g.userText, scores, override: true });
    applyGradeLocal(g.connId, nowCorrect, delta, scores);
    if (game.log.length) game.log[game.log.length - 1].category = nowCorrect ? 'correct' : 'incorrect';
    host.broadcast({ type: 'logUpdate', log: game.log });
    if (nowCorrect && hostGame.phase !== 'reveal') hostReveal();
    fullRenderFromState();
  }

  function hostReveal() {
    clearHostTimer();
    hostGame.phase = 'reveal';
    const full = hostGame.currentFull;
    const revealData = {
      answerText: full.answer.text, letter: full.answer.letter || null,
      accept: full.answer.accept, reject: full.answer.reject,
    };
    const category = hostGame.lastGrade && hostGame.lastGrade.correct ? 'correct' : (hostGame.anyAttempt ? 'incorrect' : 'skipped');
    game.log.push({ id: full.id, subject: full.subject, qtype: full.qtype, category });
    host.broadcast({ type: 'reveal', ...revealData, logEntry: game.log[game.log.length - 1] });
    applyRevealLocal(revealData);
  }

  function hostRunTimer(ms, kind, onExpire) {
    clearHostTimer();
    hostGame.totalMs = ms; hostGame.remainingMs = ms; hostGame.timerKind = kind; hostGame.onExpire = onExpire;
    host.broadcast({ type: 'tick', remainingMs: ms, totalMs: ms, kind });
    applyTickLocal(ms, ms, kind);
    hostGame.timer = setInterval(() => {
      if (hostGame.paused) return;
      hostGame.remainingMs -= 100;
      if (hostGame.remainingMs <= 0) {
        hostGame.remainingMs = 0;
        host.broadcast({ type: 'tick', remainingMs: 0, totalMs: hostGame.totalMs, kind: hostGame.timerKind });
        applyTickLocal(0, hostGame.totalMs, hostGame.timerKind);
        clearInterval(hostGame.timer); hostGame.timer = null;
        const fn = hostGame.onExpire; hostGame.onExpire = null;
        if (fn) fn();
        return;
      }
      applyTickLocal(hostGame.remainingMs, hostGame.totalMs, hostGame.timerKind);
      if (Math.round(hostGame.remainingMs / 100) % 2 === 0) {
        host.broadcast({ type: 'tick', remainingMs: hostGame.remainingMs, totalMs: hostGame.totalMs, kind: hostGame.timerKind });
      }
    }, 100);
  }
  function clearHostTimer() {
    if (hostGame.timer) clearInterval(hostGame.timer);
    hostGame.timer = null; hostGame.onExpire = null;
  }

  function hostTogglePause() {
    if (hostGame.phase === 'lobby' || hostGame.phase === 'gameover') return;
    hostGame.paused = !hostGame.paused;
    game.paused = hostGame.paused;
    host.broadcast({ type: 'pauseState', paused: hostGame.paused });
    if (revealCtl && hostGame.phase === 'reading') {
      if (hostGame.paused) revealCtl.pause(); else revealCtl.resume();
    }
    fullRenderFromState();
  }

  /* ---- host applies its own broadcasts to its local render state (host is also a player) ---- */
  function applyQuestionLocal(index, total, sanitized) {
    game.index = index; game.total = total; game.question = sanitized;
    game.phase = 'reading'; game.buzzedPlayerId = null; game.lockedOut = new Set();
    fullRenderFromState();
  }
  function applyPhaseLocal(phase, lockedOut) {
    game.phase = phase;
    if (lockedOut) game.lockedOut = new Set(lockedOut);
    game.buzzedPlayerId = null;
    fullRenderFromState();
  }
  function applyBuzzLocal(playerId) {
    game.buzzedPlayerId = playerId; game.phase = 'answering';
    fullRenderFromState();
  }
  function applyGradeLocal(playerId, correct, delta, scores) {
    scores.forEach((s) => { const pl = game.players.find((p) => p.id === s.id); if (pl) pl.score = s.score; });
    if (!correct) game.lockedOut.add(playerId);
    renderPlayerList(document.getElementById('mpPlayerList'));
  }
  function applyRevealLocal(revealData) {
    game.phase = 'reveal'; game.lastRevealData = revealData;
    fullRenderFromState();
  }
  function applyTickLocal(remainingMs, totalMs, kind) {
    renderTick(remainingMs, totalMs, kind);
  }
  function applyGameOverLocal(scores) {
    document.getElementById('mpGameScreen').style.display = 'none';
    document.getElementById('mpSummaryScreen').style.display = 'block';
    const el = document.getElementById('mpFinalScores');
    el.innerHTML = '';
    scores.slice().sort((a, b) => b.score - a.score).forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'mp-player-row';
      row.innerHTML = `<span class="name">${i === 0 ? '🏆 ' : ''}${escapeHtml(p.name)}</span><span class="pts">${p.score > 0 ? '+' : ''}${p.score}</span>`;
      el.appendChild(row);
    });
  }

  function showWaitingRoom(isHost) {
    document.getElementById('lobbyScreen').style.display = 'none';
    document.getElementById('waitingScreen').style.display = 'block';
    document.getElementById('hostControls').style.display = isHost ? 'block' : 'none';
    if (isHost) {
      document.getElementById('startGameBtn').onclick = startGame;
      document.getElementById('waitingNote').textContent = 'Share the room code above. Click "Start game" once everyone has joined.';
    } else {
      document.getElementById('waitingNote').textContent = 'Waiting for the host to start the game…';
    }
  }

  /* ================= CLIENT (joiner) LOGIC ================= */
  let client = null;
  function joinRoom() {
    const codeRaw = document.getElementById('joinCodeInput').value.trim();
    const code = codeRaw.startsWith(ROOM_PREFIX) ? codeRaw : ROOM_PREFIX + codeRaw;
    const name = document.getElementById('joinNameInput').value.trim() || 'Player';
    if (!codeRaw) { document.getElementById('joinStatus').textContent = 'Enter a room code.'; return; }
    myState.role = 'client';
    myState.myName = name;
    document.getElementById('joinStatus').textContent = 'Connecting…';

    client = SBPeer.makeClient(code, {
      onHostMessage: handleClientMessage,
      onDisconnect: () => { alert('Disconnected from host.'); location.reload(); },
      onError: (err) => { document.getElementById('joinStatus').textContent = 'Could not connect: ' + err.type; },
    });
    client.ready.then(() => {
      myState.myId = client.peer.id;
      client.send({ type: 'join', name });
      showWaitingRoom(false);
      document.getElementById('roomCodeDisplay').textContent = displayRoomCode(code);
    }).catch(() => {
      document.getElementById('joinStatus').textContent = 'Could not connect. Check the room code and try again.';
    });
  }

  function handleClientMessage(msg) {
    if (msg.type === 'lobby') {
      game.players = msg.players;
      renderPlayerList(document.getElementById('waitingPlayers'));
      return;
    }
    if (msg.type === 'gameStart') {
      game.total = msg.total;
      game.log = [];
      document.getElementById('waitingScreen').style.display = 'none';
      document.getElementById('mpGameScreen').style.display = 'flex';
      return;
    }
    if (msg.type === 'question') {
      game.index = msg.index; game.total = msg.total; game.question = msg.question;
      game.phase = 'reading'; game.buzzedPlayerId = null; game.lockedOut = new Set();
      myState.rate = msg.rate || 1;
      fullRenderFromState();
      startLocalReveal(msg.question);
      return;
    }
    if (msg.type === 'phase') {
      game.phase = msg.phase;
      if (msg.lockedOut) game.lockedOut = new Set(msg.lockedOut);
      game.buzzedPlayerId = null;
      fullRenderFromState();
      return;
    }
    if (msg.type === 'buzzAccepted') {
      game.buzzedPlayerId = msg.playerId; game.phase = 'answering';
      if (revealCtl) revealCtl.stop();
      fullRenderFromState();
      return;
    }
    if (msg.type === 'graded') {
      msg.scores.forEach((s) => { const pl = game.players.find((p) => p.id === s.id); if (pl) pl.score = s.score; });
      if (!msg.correct) game.lockedOut.add(msg.playerId);
      renderPlayerList(document.getElementById('mpPlayerList'));
      return;
    }
    if (msg.type === 'reveal') {
      game.phase = 'reveal'; game.lastRevealData = msg;
      if (msg.logEntry) game.log.push(msg.logEntry);
      fullRenderFromState();
      return;
    }
    if (msg.type === 'logUpdate') {
      game.log = msg.log;
      renderQuestionLog();
      return;
    }
    if (msg.type === 'tick') {
      renderTick(msg.remainingMs, msg.totalMs, msg.kind);
      return;
    }
    if (msg.type === 'pauseState') {
      game.paused = msg.paused;
      if (revealCtl) { if (game.paused) revealCtl.pause(); else revealCtl.resume(); }
      fullRenderFromState();
      return;
    }
    if (msg.type === 'gameover') {
      applyGameOverLocal(msg.scores);
      return;
    }
  }

  /* ================= SHARED ACTIONS ================= */
  function doBuzz() {
    if (game.paused) return;
    if (game.phase !== 'reading' && game.phase !== 'buzzwindow') return;
    if (game.lockedOut.has(myState.myId)) return;
    if (myState.role === 'host') hostHandleBuzz('HOST');
    else client.send({ type: 'buzz' });
  }
  function doSubmitAnswer(text) {
    if (game.phase !== 'answering' || game.buzzedPlayerId !== myState.myId) return;
    if (myState.role === 'host') hostHandleAnswer('HOST', text);
    else client.send({ type: 'submitAnswer', text });
  }
  function doNext() {
    if (game.phase !== 'reveal') return;
    if (myState.role === 'host') hostNextQuestion();
    else client.send({ type: 'next' });
  }
  function doTogglePause() {
    if (myState.role !== 'host') return;
    hostTogglePause();
  }

  function wireGameControls() {
    document.getElementById('mpBuzzBtn').addEventListener('click', doBuzz);
    document.getElementById('mpNextBtn').addEventListener('click', doNext);
    document.getElementById('mpOverrideBtn').addEventListener('click', () => { if (myState.role === 'host') hostOverrideLastGrade(); });
    document.getElementById('mpPauseBtn').addEventListener('click', doTogglePause);
    document.getElementById('mpSubmitBtn').addEventListener('click', () => doSubmitAnswer(document.getElementById('mpAnswerInput').value));
    document.getElementById('mpAnswerInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSubmitAnswer(document.getElementById('mpAnswerInput').value); }
    });
    document.querySelectorAll('#mpChoicesDisplay .choice-box').forEach((el) => {
      el.addEventListener('click', () => {
        if (!el.classList.contains('clickable')) return;
        doSubmitAnswer(el.dataset.letter);
      });
    });
    document.getElementById('mpEndBtn').addEventListener('click', () => {
      if (confirm('Leave the game?')) location.href = 'multiplayer.html';
    });
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('mpGameScreen').style.display === 'none') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); doBuzz(); return; }
      if (e.key === 'n' || e.key === 'N') { doNext(); return; }
      if (e.key === 'p' || e.key === 'P') { doTogglePause(); return; }
    });
  }

  SBData.load().then(() => {
    initLobby();
    wireGameControls();
  }).catch((err) => {
    document.getElementById('lobbyScreen').innerHTML = '<p>Failed to load question data: ' + err.message + '</p>';
  });
})();
