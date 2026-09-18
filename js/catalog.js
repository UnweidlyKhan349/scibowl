(function () {
  const PAGE_SIZE = 40;
  const state = {
    subjects: new Set(),
    difficulties: new Set(),
    qtypes: new Set(),
    formats: new Set(),
    tournament: '',
    bookmarkedOnly: false,
    search: '',
    page: 1,
  };

  const QTYPE_LABELS = { tossup: 'Toss-Up', bonus: 'Bonus' };
  const FORMAT_LABELS = { SA: 'Short Answer', MC: 'Multiple Choice' };
  const DIFF_LABELS = { RR: 'Round Robin', DE: 'Double Elim.', Unknown: 'Unlabeled' };

  function buildChips(container, items, key, labelFn) {
    container.innerHTML = '';
    items.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.dataset.subject = item.subjectAttr || '';
      chip.textContent = labelFn(item);
      chip.addEventListener('click', () => {
        if (state[key].has(item.value)) state[key].delete(item.value);
        else state[key].add(item.value);
        state.page = 1;
        render();
      });
      container.appendChild(chip);
      item._el = chip;
    });
  }

  let subjectItems, difficultyItems, qtypeItems, formatItems;

  function init() {
    SBData.load().then(() => {
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
      tSelect.addEventListener('change', () => {
        state.tournament = tSelect.value;
        state.page = 1;
        render();
      });

      document.getElementById('searchBox').addEventListener('input', debounce((e) => {
        state.search = e.target.value;
        state.page = 1;
        render();
      }, 220));

      document.getElementById('bookmarkedOnly').addEventListener('change', (e) => {
        state.bookmarkedOnly = e.target.checked;
        state.page = 1;
        render();
      });

      document.getElementById('clearFilters').addEventListener('click', () => {
        state.subjects.clear();
        state.difficulties.clear();
        state.qtypes.clear();
        state.formats.clear();
        state.tournament = '';
        state.bookmarkedOnly = false;
        state.search = '';
        state.page = 1;
        document.getElementById('searchBox').value = '';
        document.getElementById('bookmarkedOnly').checked = false;
        document.getElementById('tournamentSelect').value = '';
        render();
      });

      updateBookmarkCount();
      render();
    }).catch((err) => {
      document.getElementById('resultCount').textContent = 'Failed to load question data: ' + err.message;
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function updateBookmarkCount() {
    const n = SBData.bookmarks.count();
    document.getElementById('bmCount').textContent = n ? `★ ${n} bookmarked` : '';
  }

  function syncChipVisuals() {
    [
      [subjectItems, state.subjects],
      [difficultyItems, state.difficulties],
      [qtypeItems, state.qtypes],
      [formatItems, state.formats],
    ].forEach(([items, set]) => {
      items.forEach((i) => i._el.classList.toggle('active', set.has(i.value)));
    });
  }

  function render() {
    syncChipVisuals();
    const filtered = SBData.filterQuestions({
      subjects: state.subjects,
      difficulties: state.difficulties,
      qtypes: state.qtypes,
      formats: state.formats,
      tournaments: state.tournament ? [state.tournament] : null,
      bookmarkedOnly: state.bookmarkedOnly,
      search: state.search,
    });

    document.getElementById('resultCount').textContent =
      `${filtered.length.toLocaleString()} question${filtered.length === 1 ? '' : 's'} match your filters`;

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    const resultsEl = document.getElementById('results');
    resultsEl.innerHTML = '';
    if (!pageItems.length) {
      resultsEl.innerHTML = '<div class="empty-state">No questions match these filters. Try widening your search.</div>';
    } else {
      pageItems.forEach((q) => resultsEl.appendChild(renderCard(q)));
    }

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const el = document.getElementById('pagination');
    el.innerHTML = '';
    if (totalPages <= 1) return;
    const prev = document.createElement('button');
    prev.className = 'btn small';
    prev.textContent = '← Prev';
    prev.disabled = state.page <= 1;
    prev.onclick = () => { state.page--; render(); window.scrollTo({top:0, behavior:'smooth'}); };
    el.appendChild(prev);

    const span = document.createElement('span');
    span.textContent = `Page ${state.page} of ${totalPages}`;
    el.appendChild(span);

    const next = document.createElement('button');
    next.className = 'btn small';
    next.textContent = 'Next →';
    next.disabled = state.page >= totalPages;
    next.onclick = () => { state.page++; render(); window.scrollTo({top:0, behavior:'smooth'}); };
    el.appendChild(next);
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
      <span class="tag diff-${q.difficulty}">${DIFF_LABELS[q.difficulty] || q.difficulty}</span>
      <span class="small-note">${escapeHtml(q.tournament)}${q.roundLabel ? ' · ' + escapeHtml(q.roundLabel) : ''}</span>
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
    if (q.answer.accept.length) {
      const acc = document.createElement('div');
      acc.className = 'small-note';
      acc.textContent = 'Also accept: ' + q.answer.accept.join('; ');
      answerWrap.appendChild(acc);
    }
    if (q.answer.reject.length) {
      const rej = document.createElement('div');
      rej.className = 'small-note';
      rej.textContent = 'Do not accept: ' + q.answer.reject.join('; ');
      answerWrap.appendChild(rej);
    }
    const src = document.createElement('div');
    src.className = 'src';
    src.innerHTML = `Source: <a href="${q.sourceUrl}" target="_blank" rel="noopener">original packet PDF</a>`;
    answerWrap.appendChild(src);
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
    bmBtn.className = 'btn small';
    const isBm = SBData.bookmarks.isBookmarked(q.id);
    bmBtn.textContent = isBm ? '★ Bookmarked' : '☆ Bookmark';
    bmBtn.onclick = () => {
      const nowBm = SBData.bookmarks.toggle(q.id);
      bmBtn.textContent = nowBm ? '★ Bookmarked' : '☆ Bookmark';
      updateBookmarkCount();
      if (state.bookmarkedOnly && !nowBm) render();
    };
    actions.appendChild(bmBtn);

    card.appendChild(actions);
    return card;
  }

  function labelFor(subjectKey) {
    const found = (SBData.meta.subjects || []).find((s) => s.key === subjectKey);
    return found ? found.label : subjectKey;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  init();
})();
