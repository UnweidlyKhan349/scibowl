(function () {
  const QTYPE_LABELS = { tossup: 'Tossup', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };
  const TOSSUP_BUZZ_MS = 4000;
  const BONUS_BUZZ_MS = 20000;
  const ANSWER_MS = 10000;
  const LETTERS = ['W', 'X', 'Y', 'Z'];
  const ROOM_PREFIX = 'sbowl-';
  const TYPING_THROTTLE_MS = 150;
  const CHAT_HISTORY = 60;

  const filterState = { subjects: new Set(), qtypes: new Set(), formats: new Set(), tournament: '', roundRange: null, includeUnlabeled: true };
  let subjectItems, qtypeItems, formatItems, roundSliderApi;

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
      subjects: filterState.subjects,
      roundRange: filterState.roundRange,
      includeUnlabeled: filterState.includeUnlabeled,
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
      opt.value = t.slug; opt.textContent = `${t.name} (${t.count})`;
      tSelect.appendChild(opt);
    });
    tSelect.addEventListener('change', () => { filterState.tournament = tSelect.value; updateMatchCount(); });
    document.getElementById('includeVisual').addEventListener('change', updateMatchCount);
    updateMatchCount();

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
      document.getElementById('includeVisual').checked = false;
      if (roundSliderApi) roundSliderApi.reset();
      document.getElementById('includeUnlabeledRounds').checked = true;
      filterState.includeUnlabeled = true;
      updateMatchCount();
    });

    document.getElementById('createRoomBtn').addEventListener('click', createRoom);
    document.getElementById('joinRoomBtn').addEventListener('click', joinRoom);
  }

  /* ================= SHARED GAME STATE (rendered identically on host & clients) ================= */
  const game = {
    players: [], phase: 'lobby', index: 0, total: 0,
    question: null, buzzedPlayerId: null, lockedOut: new Set(),
    lastGrade: null, log: [], paused: false,
    lastRevealData: null, liveTypingText: '', liveTypingFrom: null,
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
    const roundPart = SBData.roundLabelFor(q);
    document.getElementById('mpMetaStrip').innerHTML = `
      <span class="small-note">${escapeHtml(q.tournament)}${roundPart ? ' · ' + escapeHtml(roundPart) : ''}</span>
      ${q.visual ? '<span class="tag visual-warn">⚠ Visual bonus — image not shown</span>' : ''}
    `;
  }

  function setPill(text, cls) {
    const el = document.getElementById('mpStatusPill');
    el.textContent = text; el.className = 'status-pill ' + (cls || '');
    el.style.display = 'inline-flex';
  }
  function hidePill() {
    document.getElementById('mpStatusPill').style.display = 'none';
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

  function renderLiveTyping() {
    const el = document.getElementById('mpLiveTyping');
    if (!el) return;
    if (game.phase !== 'answering' || !game.liveTypingFrom || game.liveTypingFrom === myState.myId || !game.liveTypingText) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const p = game.players.find((pp) => pp.id === game.liveTypingFrom);
    el.style.display = 'block';
    el.textContent = `${p ? p.name : 'Someone'} is typing: ${game.liveTypingText}`;
  }

  function buildRevealSegments(q) {
    const qDisplay = document.getElementById('mpQDisplay');
    const subjectTag = document.getElementById('mpRevealSubjectTag');
    const formatTag = document.getElementById('mpRevealFormatTag');
    const qtypeTag = document.getElementById('mpRevealQtypeTag');
    subjectTag.className = 'tag subject-' + q.subject;
    formatTag.className = 'tag fmt';
    qtypeTag.className = 'tag qtype-' + q.qtype;
    const segments = [
      { text: labelFor(q.subject).toUpperCase(), el: subjectTag },
      { text: (FORMAT_LABELS[q.format] || q.format).toUpperCase(), el: formatTag },
      { text: (QTYPE_LABELS[q.qtype] || q.qtype).toUpperCase(), el: qtypeTag },
      { text: q.question, el: qDisplay },
    ];
    if (q.choices) {
      LETTERS.forEach((L) => segments.push({ text: q.choices[L] || '', el: document.getElementById('mpChoiceText' + L) }));
    }
    return segments;
  }

  // instant=true renders the full text immediately with no animation (used when a
  // player joins mid-question and has nothing to "catch up" on).
  function startLocalReveal(q, instant, onComplete) {
    if (revealCtl) revealCtl.stop();
    const segments = buildRevealSegments(q);
    if (instant) {
      segments.forEach((s) => { s.el.textContent = s.text; });
      revealCtl = null;
      if (onComplete) onComplete();
      return;
    }
    revealCtl = SBReveal.startReveal(segments, myState.rate, { onComplete });
    if (game.paused) revealCtl.pause();
  }

  function fullRenderFromState() {
    renderPlayerList(document.getElementById('mpPlayerList'));
    renderQuestionLog();
    renderLiveTyping();
    const buzzBtn = document.getElementById('mpBuzzBtn');
    const answerRow = document.getElementById('mpAnswerRow');
    const nextBtn = document.getElementById('mpNextBtn');
    const overrideBtn = document.getElementById('mpOverrideBtn');
    const revealBox = document.getElementById('mpRevealBox');
    const judgeNote = document.getElementById('mpJudgeNote');
    const pauseBtn = document.getElementById('mpPauseBtn');
    const choicesDisplay = document.getElementById('mpChoicesDisplay');

    if (game.question) {
      renderMeta(game.question);
      choicesDisplay.style.display = game.question.choices ? 'grid' : 'none';
    } else {
      choicesDisplay.style.display = 'none';
    }

    revealBox.style.display = 'none';
    document.querySelectorAll('#mpChoicesDisplay .choice-box').forEach((el) => { el.classList.remove('reveal-correct'); el.classList.remove('clickable'); });
    answerRow.style.display = 'none';
    nextBtn.style.display = 'none';
    buzzBtn.style.display = 'none';
    overrideBtn.style.display = 'none';
    judgeNote.style.display = 'none';
    hideTimer();
    hidePill();
    pauseBtn.style.display = myState.role === 'host' ? 'inline-flex' : 'none';
    pauseBtn.textContent = game.paused ? 'Resume (P)' : 'Pause (P)';
    document.getElementById('mpPauseBadge').style.display = game.paused ? 'inline-flex' : 'none';

    const amBuzzed = game.buzzedPlayerId === myState.myId;
    const amLocked = game.lockedOut.has(myState.myId);

    if (game.phase === 'lobby') {
      nextBtn.style.display = 'inline-flex';
      nextBtn.textContent = 'Start (N)';
    } else if (game.phase === 'reading') {
      buzzBtn.style.display = amLocked ? 'none' : 'inline-flex';
    } else if (game.phase === 'buzzwindow') {
      setPill('Buzz in!', 'live');
      buzzBtn.style.display = amLocked ? 'none' : 'inline-flex';
    } else if (game.phase === 'answering') {
      if (amBuzzed) {
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
      nextBtn.style.display = 'inline-flex';
      nextBtn.textContent = 'Next question (N)';
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
    const roundPart = SBData.roundLabelFor(game.question);
    html += `<div class="src-line">${escapeHtml(game.question.tournament)}${roundPart ? ' · ' + escapeHtml(roundPart) : ''}</div>`;
    box.innerHTML = html;
    box.style.display = 'block';
    if (revealCtl && !revealCtl.isDone()) revealCtl.skipToEnd();
    if (game.question.choices && r.letter) {
      const el = document.querySelector(`#mpChoicesDisplay .choice-box[data-letter="${r.letter}"]`);
      if (el) el.classList.add('reveal-correct');
    }
  }

  /* ================= CHAT ================= */
  function renderChatAppend(entry) {
    const log = document.getElementById('mpChatLog');
    if (!log) return;
    const row = document.createElement('div');
    row.className = 'mp-chat-msg' + (entry.from === myState.myId ? ' me' : '');
    row.innerHTML = `<span class="who">${escapeHtml(entry.name)}:</span>${escapeHtml(entry.text)}`;
    log.appendChild(row);
    while (log.children.length > 200) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function sendChat(text) {
    text = (text || '').trim();
    if (!text) return;
    if (myState.role === 'host') {
      hostBroadcastChat('HOST', myState.myName, text);
    } else if (client) {
      client.send({ type: 'chatSend', text });
    }
  }

  /* ================= HOST-ONLY AUTHORITATIVE LOGIC ================= */
  let host = null;
  const hostGame = {
    queue: [], index: -1, phase: 'lobby',
    buzzedConnId: null, buzzedDuringReading: false, anyAttempt: false,
    lockedOutIds: new Set(),
    timer: null, remainingMs: 0, totalMs: 0, timerKind: null, onExpire: null,
    paused: false, lastGrade: null, currentFull: null,
  };
  const hostPlayers = new Map();
  const hostChat = [];

  function createRoom() {
    let pool = getFiltered();
    if (!pool.length) { alert('No questions match your filters.'); return; }
    pool = SBData.shuffle(pool);

    myState.role = 'host';
    myState.myId = 'HOST';
    myState.myName = document.getElementById('hostNameInput').value.trim() || 'Host';
    myState.rate = 1;

    hostGame.queue = pool;
    hostGame.index = -1;
    hostGame.phase = 'lobby';
    game.total = pool.length;
    game.log = [];
    hostPlayers.set('HOST', { id: 'HOST', name: myState.myName, score: 0, connId: 'HOST' });

    host = SBPeer.makeHost({
      onPlayerMessage: handleHostMessage,
      onPlayerConnect: () => {},
      onPlayerDisconnect: (connId) => { hostPlayers.delete(connId); broadcastLobby(); },
      onError: (err) => { console.error('Room error:', err); },
    });

    host.ready.then((id) => {
      enterGameScreen();
      document.getElementById('mpRoomCodeDisplay').textContent = displayRoomCode(id);
      broadcastLobby();
      fullRenderFromState();
    }).catch((err) => {
      alert('Could not start the room (network/signaling issue). Try again.\n' + err);
    });
  }

  function enterGameScreen() {
    document.getElementById('lobbyScreen').style.display = 'none';
    document.getElementById('mpGameScreen').style.display = 'flex';
  }

  function broadcastLobby() {
    game.players = [...hostPlayers.values()].map((p) => ({ id: p.id, name: p.name, score: p.score }));
    renderPlayerList(document.getElementById('mpPlayerList'));
    if (host) host.broadcast({ type: 'lobby', players: game.players, roomCode: host.roomCode });
  }

  function hostBroadcastChat(fromId, name, text) {
    const entry = { from: fromId, name, text: text.slice(0, 300), ts: Date.now() };
    hostChat.push(entry);
    while (hostChat.length > CHAT_HISTORY) hostChat.shift();
    if (host) host.broadcast({ type: 'chat', entry });
    renderChatAppend(entry);
  }

  function sendSyncTo(connId) {
    const full = hostGame.currentFull;
    host.sendTo(connId, {
      type: 'sync',
      index: hostGame.index, total: hostGame.queue.length,
      question: full ? sanitizeQuestion(full) : null,
      phase: hostGame.phase,
      buzzedPlayerId: hostGame.buzzedConnId,
      lockedOut: [...hostGame.lockedOutIds],
      scores: [...hostPlayers.values()].map((p) => ({ id: p.id, score: p.score })),
      log: game.log,
      paused: hostGame.paused,
      rate: myState.rate,
      lastRevealData: hostGame.phase === 'reveal' ? game.lastRevealData : null,
      chat: hostChat.slice(-CHAT_HISTORY),
    });
  }

  function handleHostMessage(connId, msg) {
    if (msg.type === 'join') {
      const isLate = hostGame.phase !== 'lobby' && hostGame.phase !== 'gameover';
      hostPlayers.set(connId, { id: connId, name: (msg.name || 'Player').slice(0, 24), score: 0, connId });
      broadcastLobby();
      if (isLate) sendSyncTo(connId);
      return;
    }
    if (msg.type === 'buzz') { hostHandleBuzz(connId); return; }
    if (msg.type === 'submitAnswer') { hostHandleAnswer(connId, msg.text); return; }
    if (msg.type === 'typing') {
      if (connId !== hostGame.buzzedConnId) return;
      game.liveTypingText = msg.text; game.liveTypingFrom = connId;
      host.broadcast({ type: 'typing', playerId: connId, text: msg.text });
      renderLiveTyping();
      return;
    }
    if (msg.type === 'chatSend') {
      const p = hostPlayers.get(connId);
      hostBroadcastChat(connId, p ? p.name : 'Player', msg.text);
      return;
    }
    if (msg.type === 'next') { if (hostGame.phase === 'reveal' || hostGame.phase === 'lobby') hostNextQuestion(); return; }
  }

  function hostNextQuestion() {
    clearHostTimer();
    hostGame.index++;
    hostGame.buzzedConnId = null;
    hostGame.anyAttempt = false;
    hostGame.lockedOutIds = new Set();
    hostGame.lastGrade = null;
    game.lastRevealData = null;
    game.liveTypingText = ''; game.liveTypingFrom = null;

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

    startLocalReveal(sanitized, false, () => hostStartBuzzWindow());
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
    // Pause (not stop) the reveal — if this buzz is wrong, the rest of the
    // question should keep being revealed for the remaining field.
    if (revealCtl && !revealCtl.isDone()) revealCtl.pause();
    game.liveTypingText = ''; game.liveTypingFrom = null;
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
      return;
    }
    const remaining = [...hostPlayers.keys()].filter((id) => !hostGame.lockedOutIds.has(id));
    hostGame.buzzedConnId = null;
    game.liveTypingText = ''; game.liveTypingFrom = null;
    if (!remaining.length) {
      hostReveal();
      return;
    }
    const canResumeReading = hostGame.buzzedDuringReading && revealCtl && !revealCtl.isDone();
    if (canResumeReading) {
      // CRITICAL FIX: an incorrect buzz mid-reading must not silently end the
      // question — resume revealing the rest of it for whoever's left.
      hostGame.phase = 'reading';
      host.broadcast({ type: 'phase', phase: 'reading', lockedOut: [...hostGame.lockedOutIds] });
      applyPhaseLocal('reading', [...hostGame.lockedOutIds]);
      revealCtl.resume();
    } else {
      hostGame.phase = 'buzzwindow';
      host.broadcast({ type: 'phase', phase: 'buzzwindow', lockedOut: [...hostGame.lockedOutIds] });
      applyPhaseLocal('buzzwindow', [...hostGame.lockedOutIds]);
      const full = hostGame.currentFull;
      const ms = full.qtype === 'bonus' ? BONUS_BUZZ_MS : TOSSUP_BUZZ_MS;
      hostRunTimer(ms, 'buzz', () => hostReveal());
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
      enterGameScreen();
      document.getElementById('mpRoomCodeDisplay').textContent = displayRoomCode(code);
      fullRenderFromState();
    }).catch(() => {
      document.getElementById('joinStatus').textContent = 'Could not connect. Check the room code and try again.';
    });
  }

  function handleClientMessage(msg) {
    if (msg.type === 'lobby') {
      game.players = msg.players;
      renderPlayerList(document.getElementById('mpPlayerList'));
      return;
    }
    if (msg.type === 'sync') {
      // Joined mid-game: catch up instantly instead of sitting on a waiting screen.
      game.index = msg.index; game.total = msg.total; game.question = msg.question;
      game.phase = msg.phase; game.buzzedPlayerId = msg.buzzedPlayerId;
      game.lockedOut = new Set(msg.lockedOut || []);
      game.paused = msg.paused;
      game.log = msg.log || [];
      game.lastRevealData = msg.lastRevealData || null;
      myState.rate = msg.rate || 1;
      const chatLog = document.getElementById('mpChatLog');
      if (chatLog) chatLog.innerHTML = '';
      (msg.chat || []).forEach(renderChatAppend);
      if (msg.scores) {
        msg.scores.forEach((s) => { const pl = game.players.find((p) => p.id === s.id); if (pl) pl.score = s.score; });
      }
      if (game.question) startLocalReveal(game.question, true);
      fullRenderFromState();
      return;
    }
    if (msg.type === 'question') {
      game.index = msg.index; game.total = msg.total; game.question = msg.question;
      game.phase = 'reading'; game.buzzedPlayerId = null; game.lockedOut = new Set();
      game.liveTypingText = ''; game.liveTypingFrom = null;
      myState.rate = msg.rate || 1;
      fullRenderFromState();
      startLocalReveal(msg.question, false);
      return;
    }
    if (msg.type === 'phase') {
      game.phase = msg.phase;
      if (msg.lockedOut) game.lockedOut = new Set(msg.lockedOut);
      game.buzzedPlayerId = null;
      if (msg.phase === 'reading') {
        if (revealCtl && revealCtl.isPaused()) revealCtl.resume();
      } else if (revealCtl && !revealCtl.isDone()) {
        // The reading window is over one way or another — make sure the full
        // text is showing, regardless of any local animation drift (this is
        // also what keeps a backgrounded/throttled tab from looking stuck).
        revealCtl.skipToEnd();
      }
      fullRenderFromState();
      return;
    }
    if (msg.type === 'buzzAccepted') {
      game.buzzedPlayerId = msg.playerId; game.phase = 'answering';
      game.liveTypingText = ''; game.liveTypingFrom = null;
      if (revealCtl && !revealCtl.isDone()) revealCtl.pause();
      fullRenderFromState();
      return;
    }
    if (msg.type === 'typing') {
      game.liveTypingText = msg.text; game.liveTypingFrom = msg.playerId;
      renderLiveTyping();
      return;
    }
    if (msg.type === 'chat') {
      renderChatAppend(msg.entry);
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
    if (game.phase !== 'reveal' && game.phase !== 'lobby') return;
    if (myState.role === 'host') hostNextQuestion();
    else client.send({ type: 'next' });
  }
  function doTogglePause() {
    if (myState.role !== 'host') return;
    hostTogglePause();
  }

  let typingThrottled = false;
  function doTypingInput(text) {
    if (game.phase !== 'answering' || game.buzzedPlayerId !== myState.myId) return;
    if (typingThrottled) return;
    typingThrottled = true;
    setTimeout(() => { typingThrottled = false; }, TYPING_THROTTLE_MS);
    if (myState.role === 'host') {
      game.liveTypingText = text; game.liveTypingFrom = 'HOST';
      host.broadcast({ type: 'typing', playerId: 'HOST', text });
    } else if (client) {
      client.send({ type: 'typing', text });
    }
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
    document.getElementById('mpAnswerInput').addEventListener('input', (e) => doTypingInput(e.target.value));
    document.querySelectorAll('#mpChoicesDisplay .choice-box').forEach((el) => {
      el.addEventListener('click', () => {
        if (!el.classList.contains('clickable')) return;
        doSubmitAnswer(el.dataset.letter);
      });
    });
    document.getElementById('mpEndBtn').addEventListener('click', () => {
      if (confirm('Leave the game?')) location.href = 'multiplayer.html';
    });
    document.getElementById('mpChatSendBtn').addEventListener('click', () => {
      const input = document.getElementById('mpChatInput');
      sendChat(input.value);
      input.value = '';
    });
    document.getElementById('mpChatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const input = document.getElementById('mpChatInput');
        sendChat(input.value);
        input.value = '';
      }
    });
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('mpGameScreen').style.display === 'none') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); doBuzz(); return; }
      if (e.key === 'n' || e.key === 'N') { doNext(); return; }
      if (e.key === 'p' || e.key === 'P') { doTogglePause(); return; }
    });
    // Safety net for the tab-throttling desync bug: when the tab regains
    // focus, force the reveal to catch up to whatever phase we're actually in.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (game.phase !== 'reading' && game.phase !== 'lobby' && revealCtl && !revealCtl.isDone()) {
        revealCtl.skipToEnd();
      }
      fullRenderFromState();
    });
  }

  SBData.load().then(() => {
    initLobby();
    wireGameControls();
  }).catch((err) => {
    document.getElementById('lobbyScreen').innerHTML = '<p>Failed to load question data: ' + err.message + '</p>';
  });
})();
