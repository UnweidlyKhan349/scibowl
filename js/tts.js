/* Small speech-synthesis wrapper used by solo & multiplayer practice */
(function (global) {
  const SBTTS = {
    supported: 'speechSynthesis' in window,
    _utter: null,
    _paused: false,
  };

  function pickVoice() {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voices.length) return null;
    const preferred = voices.find((v) => /en-US/i.test(v.lang) && /Google|Natural|Samantha/i.test(v.name));
    return preferred || voices.find((v) => /^en/i.test(v.lang)) || voices[0];
  }

  // Ensure voice list is warmed up (Chrome loads it asynchronously)
  if (SBTTS.supported) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {};
  }

  /**
   * Speak `text` at the given rate (0.5 - 2.5). Calls onEnd() when speech
   * finishes naturally, or onBoundary(charIndex) as words are spoken.
   * Returns a controller with .cancel().
   */
  SBTTS.speak = function (text, rate, { onEnd, onBoundary, onStart } = {}) {
    if (!SBTTS.supported) {
      // No speech synthesis available - resolve immediately so the game can proceed silently.
      if (onStart) onStart();
      setTimeout(() => onEnd && onEnd(), 300);
      return { cancel() {} };
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate || 1;
    utter.pitch = 1;
    const v = pickVoice();
    if (v) utter.voice = v;
    let ended = false;
    utter.onend = () => {
      if (ended) return;
      ended = true;
      onEnd && onEnd();
    };
    utter.onerror = () => {
      if (ended) return;
      ended = true;
      onEnd && onEnd();
    };
    if (onBoundary) {
      utter.onboundary = (e) => onBoundary(e.charIndex);
    }
    SBTTS._utter = utter;
    SBTTS._paused = false;
    if (onStart) onStart();
    window.speechSynthesis.speak(utter);
    return {
      cancel() {
        ended = true;
        window.speechSynthesis.cancel();
      },
    };
  };

  SBTTS.pause = function () {
    if (SBTTS.supported && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      SBTTS._paused = true;
    }
  };
  SBTTS.resume = function () {
    if (SBTTS.supported && SBTTS._paused) {
      window.speechSynthesis.resume();
      SBTTS._paused = false;
    }
  };
  SBTTS.cancel = function () {
    if (SBTTS.supported) window.speechSynthesis.cancel();
  };

  SBTTS.questionToSpeech = function (q) {
    let text = q.question;
    if (q.format === 'MC' && q.choices) {
      text += '. W) ' + q.choices.W + '.  X) ' + q.choices.X + '.  Y) ' + q.choices.Y + '.  Z) ' + q.choices.Z + '.';
    }
    return text;
  };

  global.SBTTS = SBTTS;
})(window);
