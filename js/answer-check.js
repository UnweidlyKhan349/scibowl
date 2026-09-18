/* SciBowl Practice - answer checking logic
   Handles Science Bowl grading conventions:
   - "1 and 2" <-> "12" <-> "1, 2"
   - "all" / "all three" <-> "123" (when the question enumerates 1/2/3 items)
   - "3 only" <-> "3"
   - multiple choice: letter (W/X/Y/Z) or full choice text
   - packet ACCEPT / DO NOT ACCEPT alternates
*/
(function (global) {
  function normalize(s) {
    if (s == null) return '';
    return String(s)
      .toUpperCase()
      .replace(/['’‘]/g, "'")
      .replace(/[^A-Z0-9'\s]/g, ' ') // strip punctuation except apostrophe
      .replace(/\s+/g, ' ')
      .trim();
  }

  // How many enumerated items ("1) ...; 2) ...; 3) ...") appear in question text.
  function detectItemCount(questionText) {
    if (!questionText) return null;
    const nums = [...questionText.matchAll(/(?:^|[\s;,:])([1-9])\)/g)].map((m) => parseInt(m[1], 10));
    if (!nums.length) return null;
    const max = Math.max(...nums);
    return max >= 2 && max <= 9 ? max : null;
  }

  // Try to interpret a string as a "list of item numbers" answer, e.g.
  // "1 AND 3", "1, 3", "13", "ALL", "3 ONLY", "NONE" -> canonical sorted-digit string like "13".
  // Returns null if it doesn't look like a list-style answer.
  function canonicalizeList(raw, itemCount) {
    if (!itemCount) return null;
    const up = normalize(raw);
    if (!up) return null;

    if (/^ALL( OF THE ABOVE| THREE| FOUR| FIVE| SIX)?$/.test(up)) {
      return digitsToCanonical(range(1, itemCount));
    }
    if (/^NONE( OF THE ABOVE)?$/.test(up)) {
      return '0';
    }

    // pure compact digit string like "13" or "123" - only treat as a list if every
    // character is a digit between 1 and itemCount (and it's short)
    if (/^[1-9]+$/.test(up.replace(/\s/g, '')) && up.replace(/\s/g, '').length <= itemCount) {
      const compact = up.replace(/\s/g, '');
      const digits = compact.split('').map(Number);
      if (digits.every((d) => d >= 1 && d <= itemCount)) {
        return digitsToCanonical(digits);
      }
    }

    // "1 AND 3", "1, 3", "1 3", "3 ONLY", "2 AND 3 ONLY"
    if (/^[1-9OANDRLY,\s]+$/.test(up.replace(/ONLY/g, '').replace(/AND|OR/g, ''))) {
      const digits = (up.match(/[1-9]/g) || []).map(Number).filter((d) => d <= itemCount);
      if (digits.length) {
        return digitsToCanonical(digits);
      }
    }
    return null;
  }

  function range(a, b) {
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  function digitsToCanonical(digits) {
    return [...new Set(digits)].sort((a, b) => a - b).join('');
  }

  // Core string equality after normalization
  function normEqual(a, b) {
    return normalize(a) === normalize(b);
  }

  // Lenient fallback: one normalized string contains the other (helps with minor
  // wording differences) - only used as a soft signal, never for reject-list checks.
  function fuzzyContains(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 4 && nb.includes(na)) return true;
    if (nb.length >= 4 && na.includes(nb)) return true;
    return false;
  }

  /**
   * Grade a free-typed answer against a question.
   * Returns { correct: true|false, matched: 'main'|'accept'|'fuzzy'|null, rejected: bool }
   */
  function checkAnswer(question, userInput) {
    const raw = (userInput || '').trim();
    if (!raw) return { correct: false, matched: null, rejected: false, empty: true };

    const ans = question.answer;
    const itemCount = detectItemCount(question.question);

    // ---- Multiple choice ----
    if (question.format === 'MC' && question.choices) {
      const upRaw = normalize(raw);
      const letters = ['W', 'X', 'Y', 'Z'];
      // typed just a letter, optionally with trailing ')'
      const letterMatch = upRaw.match(/^([WXYZ])\)?$/);
      if (letterMatch) {
        const correct = ans.letter && letterMatch[1] === ans.letter;
        return { correct: !!correct, matched: correct ? 'main' : null, rejected: false };
      }
      // typed "W) something" or "W something"
      const letterPrefix = raw.trim().match(/^([WXYZwxyz])[)\.:\s-]+(.*)$/);
      const bodyAfterLetter = letterPrefix ? letterPrefix[2] : raw;
      const bodyLetter = letterPrefix ? letterPrefix[1].toUpperCase() : null;
      if (bodyLetter) {
        const correct = ans.letter && bodyLetter === ans.letter;
        return { correct: !!correct, matched: correct ? 'main' : null, rejected: false };
      }
      // typed the full text of a choice
      for (const L of letters) {
        const choiceText = question.choices[L];
        if (!choiceText) continue;
        if (normEqual(bodyAfterLetter, choiceText) || fuzzyContains(bodyAfterLetter, choiceText)) {
          const correct = ans.letter === L;
          return { correct, matched: correct ? 'main' : null, rejected: false };
        }
      }
      // fall through to text-based comparison against the answer text itself
    }

    // ---- Reject list first: an explicit "do not accept" match is always wrong ----
    for (const rej of ans.reject || []) {
      if (normEqual(raw, rej)) {
        return { correct: false, matched: null, rejected: true };
      }
    }

    // ---- List-style answers ("1 and 2", "all", "3 only", ...) ----
    if (itemCount) {
      const userCanon = canonicalizeList(raw, itemCount);
      if (userCanon !== null) {
        const mainCanon = canonicalizeList(ans.text, itemCount);
        if (mainCanon !== null && userCanon === mainCanon) {
          return { correct: true, matched: 'main', rejected: false };
        }
        for (const acc of ans.accept || []) {
          const accCanon = canonicalizeList(acc, itemCount);
          if (accCanon !== null && userCanon === accCanon) {
            return { correct: true, matched: 'accept', rejected: false };
          }
        }
      }
    }

    // ---- Exact normalized match ----
    if (normEqual(raw, ans.text)) {
      return { correct: true, matched: 'main', rejected: false };
    }
    for (const acc of ans.accept || []) {
      if (normEqual(raw, acc)) {
        return { correct: true, matched: 'accept', rejected: false };
      }
    }

    // ---- Lenient fuzzy fallback (flagged distinctly so the UI can hint "close?") ----
    if (fuzzyContains(raw, ans.text)) {
      return { correct: true, matched: 'fuzzy', rejected: false };
    }
    for (const acc of ans.accept || []) {
      if (fuzzyContains(raw, acc)) {
        return { correct: true, matched: 'fuzzy', rejected: false };
      }
    }

    return { correct: false, matched: null, rejected: false };
  }

  global.SBAnswer = {
    normalize,
    detectItemCount,
    canonicalizeList,
    checkAnswer,
  };
})(window);
