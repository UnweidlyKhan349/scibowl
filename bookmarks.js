(function () {
  const QTYPE_LABELS = { tossup: 'Toss-Up', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };

  function labelFor(subjectKey) {
    const found = (SBData.meta.subjects || []).find((s) => s.key === subjectKey);
    return found ? found.label : subjectKey;
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  function renderCard(q) {
    const card = document.createElement('div');
    card.className = 'q-card';

    const meta = document.createElement('div');
    meta.className = 'meta-row';
    meta.innerHTML = `
      <span class="tag subject-${q.subject}">${labelFor(q.subject)}</span>
      <span class="tag qtype-${q.qtype}">${QTYPE_LABELS[q.qtype] || q.qtype}</span>
      <span class="tag fmt">${FORMAT_LABELS[q.format] || q.format}</span>
      <span class="tag round">${q.round ? 'Round ' + q.round : 'Round —'}</span>
      <span class="small-note">${escapeHtml(q.tournament)}${(() => { const rp = SBData.roundLabelFor(q); return rp ? ' · ' + escapeHtml(rp) : ''; })()}</span>
    `;
    card.appendChild(meta);

    const qText = document.createElement('div');
    qText.className = 'q-text';
    qText.textContent = q.question;
    card.appendChild(qText);

    if (q.choices) {
      const ch = document.createElement('div');
      ch.className = 'choices';
      ch.textContent = ['W', 'X', 'Y', 'Z'].map((L) => `${L}) ${q.choices[L]}`).join('   ');
      card.appendChild(ch);
    }

    const answerWrap = document.createElement('div');
    answerWrap.style.display = 'none';
    const aText = document.createElement('div');
    aText.className = 'a-text';
    aText.textContent = 'Answer: ' + q.answer.text + (q.answer.letter ? ` (${q.answer.letter})` : '');
    answerWrap.appendChild(aText);
    card.appendChild(answerWrap);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn small';
    toggleBtn.textContent = 'Show answer';
    toggleBtn.onclick = () => {
      const showing = answerWrap.style.display !== 'none';
      answerWrap.style.display = showing ? 'none' : 'block';
      toggleBtn.textContent = showing ? 'Show answer' : 'Hide answer';
    };
    actions.appendChild(toggleBtn);

    const bmBtn = document.createElement('button');
    bmBtn.className = 'btn small icon-btn active';
    bmBtn.textContent = '★';
    bmBtn.title = 'Unbookmark';
    bmBtn.onclick = () => {
      SBData.bookmarks.remove(q.id);
      card.remove();
      updateCount();
    };
    actions.appendChild(bmBtn);

    card.appendChild(actions);
    return card;
  }

  function updateCount() {
    const n = SBData.bookmarks.count();
    document.getElementById('resultCount').textContent = n
      ? `${n.toLocaleString()} bookmarked question${n === 1 ? '' : 's'}`
      : "You haven't bookmarked any questions yet — star a question in the catalog or during practice to save it here.";
    document.getElementById('practiceBtn').disabled = !n;
  }

  SBData.load().then(() => {
    const ids = SBData.bookmarks.getAll();
    const results = document.getElementById('results');
    results.innerHTML = '';
    const questions = [...ids].map((id) => SBData.byId.get(id)).filter(Boolean);
    if (!questions.length) {
      results.innerHTML = '<div class="empty-state">No bookmarks yet.</div>';
    } else {
      questions.forEach((q) => results.appendChild(renderCard(q)));
    }
    updateCount();
    document.getElementById('practiceBtn').addEventListener('click', () => {
      if (SBData.bookmarks.count()) location.href = 'solo.html?bookmarked=1';
    });
  }).catch((err) => {
    document.getElementById('resultCount').textContent = 'Failed to load question data: ' + err.message;
  });
})();
