/* Silent Sign - word suggestions while spelling.
 *
 * partialWord("I NEED HE") -> "HE"   (the letters after the last space)
 * suggest(words, "HE", 3)  -> ["HE..." most frequent first], never the prefix itself
 *
 * `words` is window.SILENT_SIGN_WORDS (js/words.js), ordered most frequent
 * first, so the first matches are the most likely words.
 * Pure functions, no DOM, so they can be unit-tested in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SilentSignSuggest = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function partialWord(text) {
    var m = /([A-Z]+)$/.exec(text || "");
    return m ? m[1] : "";
  }

  function suggest(words, prefix, limit) {
    limit = limit || 3;
    var out = [];
    if (!prefix || !words) return out;
    for (var i = 0; i < words.length && out.length < limit; i++) {
      var w = words[i];
      if (w.length > prefix.length && w.lastIndexOf(prefix, 0) === 0) out.push(w);
    }
    return out;
  }

  return { partialWord: partialWord, suggest: suggest };
});
