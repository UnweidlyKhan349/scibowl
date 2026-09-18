(function () {
  const QTYPE_LABELS = { tossup: 'Toss-Up', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };
  const DIFF_LABELS = { RR: 'Round Robin', DE: 'Double Elim.', Unknown: 'Unlabeled round' };
  const TOSSUP_BUZZ_MS = 4000;
  const BONUS_BUZZ_MS = 20000;
  const ANSWER_MS = 10000;
  const WPM_BASE = 150; // words per minute at rate 1.0, used to estimate reading time

  const filterState = { subjects: new Set(), difficulties: new Set(), qtypes: new Set(), formats: new Set(), tournament: '' };
  let subjectItems, difficultyItems, qtypeItems, formatItems;

  const myState = { role: null, myId: null, myName: '', rate: 1 };

  /* ================= LOBBY SETUP ================= */
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
  function getFiltered() {
    return SBData.filterQuestions({
      subjects: filterState.subjects, difficulties: filterState.difficulties,
      qtypes: filterState.qtypes, formats: filterState.formats,
      tournaments: filterState.tournament ? [filterState.tournament] : null,
    });
  }
  function updateMatchCount() {
    document.getElementById('matchCount').textContent = `${getFiltered().length.toLocaleString()} questions match your filters`;
  }

  function initLobby() {
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
      opt.value = t.slug; opt.textContent = `${t.name} (${t.count})`;
      tSelect.appendChild(opt);
    });
    tSelect.addEventListener('change', () => { filterState.tournament = tSelect.value; updateMatchCount(); });
    updateMatchCount();

    document.getElementById('bmCount').textContent = SBData.bookmarks.count() ? `★ ${SBData.bookmarks.count()} bookmarked` : '';
    document.getElementById('createRoomBtn').addEventListener('click', createRoom);
    document.getElementById('joinRoomBtn').addEventListener('click', joinRoom);
  }

  /* ================= SHARED GAME STATE (rendered identically on host & clients) ================= */
  const game = {
    players: [], // [{id, name, score}]
    phase: 'lobby',
    index: 0,
    total: 0,
    question: null, // sanitized question (no answer) as received/prepared
    buzzedPlayerId: null,
    lockedOut: new Set(),
    lastGrade: null, // {playerId, correct, delta}
  };

  let speechCtl = null;

  function labelFor(subjectKey) {
    const found = (SBData.meta.subjects || []).find((s) => s.key === subjectKey);
    return found ? found.label : subjectKey;
  }
  function escapeHtml(s) {
    const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML;
  }
  function sanitizeQuestion(q) {
    return {
      id: q.id, tournament: q.tournament, roundLabel: q.roundLabel, difficulty: q.difficulty,
      subject: q.subject, format: q.format, qtype: q.qtype, question: q.question,
      choices: q.choices ? { W: q.choices.W, X: q.choices.X, Y: q.choices.Y, Z: q.choices.Z } : null,
    };
  }
  function estimateReadingMs(q) {
    let text = q.question;
    if (q.choices) text += ' ' + ['W', 'X', 'Y', 'Z'].map((L) => q.choices[L]).join(' ');
    const words = text.split(/\s+/).filter(Boolean).length;
    const ms = (words / (WPM_BASE * myState.rate)) * 60000;
    return Math.max(1200, ms) + 500;
  }

  /* ================= RENDERING (host + client share this) ================= */
  function renderPlayerList(container, highlightMe) {
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
      <span class="tag diff-${q.difficulty}">${DIFF_LABELS[q.difficulty] || q.difficulty}</span>
      <span class="small-note">${escapeHtml(q.tournament)}${q.roundLabel ? ' · ' + escapeHtml(q.roundLabel) : ''}</span>
    `;
  }

  function renderQuestion(q) {
    document.getElementById('mpQDisplay').textContent = q.question;
    if (q.choices) {
      const cd = document.getElementById('mpChoicesDisplay');
      cd.style.display = 'grid';
      cd.innerHTML = ['W', 'X', 'Y', 'Z'].map((L) => `<div class="choice-box" data-letter="${L}"><span class="letter">${L})</span>${escapeHtml(q.choices[L])}</div>`).join('');
    } else {
      document.getElementById('mpChoicesDisplay').style.display = 'none';
      document.getElementById('mpChoicesDisplay').innerHTML = '';
    }
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

  function fullRenderFromState() {
    document.getElementById('mpProgress').textContent = `Question ${game.index + 1} of ${game.total}`;
    renderPlayerList(document.getElementById('mpPlayerList'));
    const buzzBtn = document.getElementById('mpBuzzBtn');
    const answerRow = document.getElementById('mpAnswerRow');
    const nextBtn = document.getElementById('mpNextBtn');
    const revealBox = document.getElementById('mpRevealBox');

    if (game.question) { renderMeta(game.question); renderQuestion(game.question); }

    revealBox.style.display = 'none';
    document.querySelectorAll('.choice-box').forEach((el) => el.classList.remove('reveal-correct'));
    answerRow.style.display = 'none';
    nextBtn.style.display = 'none';
    buzzBtn.style.display = 'none';
    hideTimer();
    const judgePanel = document.getElementById('mpJudgePanel');
    if (judgePanel) judgePanel.style.display = 'none';

    const amBuzzed = game.buzzedPlayerId === myState.myId;
    const amLocked = game.lockedOut.has(myState.myId);

    if (game.phase === 'reading') {
      setPill('🔊 Reading question…', 'live');
      buzzBtn.style.display = amLocked ? 'none' : 'inline-flex';
    } else if (game.phase === 'buzzwindow') {
      setPill('⏱ Buzz window — buzz in!', 'live');
      buzzBtn.style.display = amLocked ? 'none' : 'inline-flex';
    } else if (game.phase === 'answering') {
      if (amBuzzed) {
        setPill('✍️ Your turn — type your answer!', 'buzzed');
        answerRow.style.display = 'flex';
        document.getElementById('mpAnswerInput').value = '';
        document.getElementById('mpAnswerInput').focus();
      } else {
        const bp = game.players.find((p) => p.id === game.buzzedPlayerId);
        setPill(`✍️ ${bp ? bp.name : 'Someone'} is answering…`, 'answering');
      }
    } else if (game.phase === 'reveal') {
      setPill('📖 Revealed', 'revealed');
      nextBtn.style.display = 'inline-flex';
      showReveal();
    } else if (game.phase === 'gameover') {
      setPill('🏁 Game over', 'revealed');
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
    if (game.question.choices && r.letter) {
      const el = document.querySelector(`.choice-box[data-letter="${r.letter}"]`);
      if (el) el.classList.add('reveal-correct');
    }
  }

  /* ================= HOST-ONLY AUTHORITATIVE LOGIC ================= */
  let host = null;
  const hostGame = {
    queue: [], index: -1, phase: 'lobby',
    buzzedConnId: null, buzzedDuringReading: false,
    lockedOutIds: new Set(),
    timer: null, remainingMs: 0, totalMs: 0, timerKind: null,
    onExpire: null,
  };
  const hostPlayers = new Map(); // connId -> {id, name, score, connId}

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
      onPlayerConnect: (connId) => { /* wait for 'join' message with name */ },
      onPlayerDisconnect: (connId) => {
        hostPlayers.delete(connId);
        broadcastLobby();
      },
      onError: (err) => { document.getElementById('waitingNote').textContent = 'Connection error: ' + err.type; },
    });

    host.ready.then((id) => {
      document.getElementById('roomCodeDisplay').textContent = id;
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
    if (msg.type === 'overrideRequest') { /* host UI drives override locally, ignore from clients */ return; }
  }

  function startGame() {
    hostGame.index = -1;
    game.total = hostGame.queue.length;
    host.broadcast({ type: 'gameStart', total: game.total });
    document.getElementById('waitingScreen').style.display = 'none';
    document.getElementById('mpGameScreen').style.display = 'block';
    hostNextQuestion();
  }

  function hostNextQuestion() {
    clearHostTimer();
    if (speechCtl) speechCtl.cancel();
    hostGame.index++;
    hostGame.buzzedConnId = null;
    hostGame.lockedOutIds = new Set();
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
    host.broadcast({ type: 'question', index: hostGame.index, total: hostGame.queue.length, question: sanitized });
    applyQuestionLocal(hostGame.index, hostGame.queue.length, sanitized);

    const readMs = estimateReadingMs(sanitized);
    hostRunTimer(readMs, 'reading', () => hostStartBuzzWindow());
  }

  function hostStartBuzzWindow() {
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
    hostGame.phase = 'answering';
    clearHostTimer();
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
    renderJudgePanel(connId, correct);
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
    if (nowCorrect && hostGame.phase !== 'reveal') hostReveal();
    document.getElementById('mpJudgePanel').style.display = 'none';
  }

  function hostReveal() {
    clearHostTimer();
    hostGame.phase = 'reveal';
    const full = hostGame.currentFull;
    const revealData = {
      answerText: full.answer.text, letter: full.answer.letter || null,
      accept: full.answer.accept, reject: full.answer.reject,
    };
    host.broadcast({ type: 'reveal', ...revealData });
    applyRevealLocal(revealData);
  }

  function hostRunTimer(ms, kind, onExpire) {
    clearHostTimer();
    hostGame.totalMs = ms; hostGame.remainingMs = ms; hostGame.timerKind = kind; hostGame.onExpire = onExpire;
    host.broadcast({ type: 'tick', remainingMs: ms, totalMs: ms, kind });
    applyTickLocal(ms, ms, kind);
    hostGame.timer = setInterval(() => {
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
      // throttle broadcast to every 200ms to save bandwidth, but update host UI every tick
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

  /* ---- host applies its own broadcasts to its local render state (host is also a player) ---- */
  function applyQuestionLocal(index, total, sanitized) {
    game.index = index; game.total = total; game.question = sanitized;
    game.phase = 'reading'; game.buzzedPlayerId = null; game.lockedOut = new Set();
    fullRenderFromState();
    speechCtl = SBTTS.speak(SBTTS.questionToSpeech(sanitized), myState.rate, {});
  }
  function applyPhaseLocal(phase, lockedOut) {
    game.phase = phase;
    if (lockedOut) game.lockedOut = new Set(lockedOut);
    game.buzzedPlayerId = null;
    fullRenderFromState();
  }
  function applyBuzzLocal(playerId) {
    game.buzzedPlayerId = playerId; game.phase = 'answering';
    if (speechCtl) speechCtl.cancel();
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

  function renderJudgePanel(playerId, correct) {
    const panel = document.getElementById('mpJudgePanel');
    const p = hostPlayers.get(playerId);
    const g = hostGame.lastGrade;
    panel.style.display = 'block';
    panel.innerHTML = `
      <div class="small-note" style="margin-bottom:8px;">Auto-graded <b>${escapeHtml(p ? p.name : '?')}</b>'s answer "${escapeHtml(g.userText || '(blank)')}" as
        <b style="color:${correct ? 'var(--good)' : 'var(--bad)'}">${correct ? 'CORRECT' : 'INCORRECT'}</b>. Not right? Override it:</div>
      <button class="btn small" id="judgeOverrideBtn">↺ Override this grade</button>
    `;
    document.getElementById('judgeOverrideBtn').onclick = () => {
      hostOverrideLastGrade();
      panel.style.display = 'none';
    };
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
    const code = document.getElementById('joinCodeInput').value.trim();
    const name = document.getElementById('joinNameInput').value.trim() || 'Player';
    if (!code) { document.getElementById('joinStatus').textContent = 'Enter a room code.'; return; }
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
      document.getElementById('roomCodeDisplay').textContent = code;
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
      document.getElementById('waitingScreen').style.display = 'none';
      document.getElementById('mpGameScreen').style.display = 'block';
      return;
    }
    if (msg.type === 'question') {
      game.index = msg.index; game.total = msg.total; game.question = msg.question;
      game.phase = 'reading'; game.buzzedPlayerId = null; game.lockedOut = new Set();
      fullRenderFromState();
      speechCtl = SBTTS.speak(SBTTS.questionToSpeech(msg.question), myState.rate, {});
      return;
    }
    if (msg.type === 'phase') {
      game.phase = msg.phase;
      if (msg.lockedOut) game.lockedOut = new Set(msg.lockedOut);
      game.buzzedPlayerId = null;
      if (speechCtl) speechCtl.cancel();
      fullRenderFromState();
      return;
    }
    if (msg.type === 'buzzAccepted') {
      game.buzzedPlayerId = msg.playerId; game.phase = 'answering';
      if (speechCtl) speechCtl.cancel();
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
      fullRenderFromState();
      return;
    }
    if (msg.type === 'tick') {
      renderTick(msg.remainingMs, msg.totalMs, msg.kind);
      return;
    }
    if (msg.type === 'gameover') {
      applyGameOverLocal(msg.scores);
      return;
    }
  }

  /* ================= SHARED ACTIONS ================= */
  function doBuzz() {
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

  function wireGameControls() {
    document.getElementById('mpBuzzBtn').addEventListener('click', doBuzz);
    document.getElementById('mpNextBtn').addEventListener('click', doNext);
    document.getElementById('mpSubmitBtn').addEventListener('click', () => doSubmitAnswer(document.getElementById('mpAnswerInput').value));
    document.getElementById('mpAnswerInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSubmitAnswer(document.getElementById('mpAnswerInput').value); }
    });
    document.getElementById('mpEndBtn').addEventListener('click', () => {
      if (confirm('Leave the game?')) location.href = 'multiplayer.html';
    });
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('mpGameScreen').style.display === 'none') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); doBuzz(); return; }
      if (e.key === 'n' || e.key === 'N') { doNext(); return; }
    });
  }

  SBData.load().then(() => {
    initLobby();
    wireGameControls();
  }).catch((err) => {
    document.getElementById('lobbyScreen').innerHTML = '<p>Failed to load question data: ' + err.message + '</p>';
  });
})();
