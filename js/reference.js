/* Silent Sign - "Show letters to the signer".
 *
 * The hearing participant types a reply; it is shown as the ISL alphabet
 * photos from the project's own dataset, letter by letter, so the signer can
 * read it. Letters without a dataset photo (H, J, Y) are shown as text with a
 * clear "no photo" note instead of a guessed sign.
 */
(function () {
  "use strict";

  var PHOTOS = "ABCDEFGIKLMNOPQRSTUVWXZ".split("");
  var LETTER_MS = 1400;
  var SPACE_MS = 700;

  var $ = function (id) { return document.getElementById(id); };
  var form = $("ref-form"), input = $("ref-input"), out = $("ref-output"), note = $("ref-note");
  var playBtn = $("ref-play"), viewer = $("ref-viewer"), viewerImg = $("ref-viewer-img"),
      viewerLetter = $("ref-viewer-letter"), viewerPos = $("ref-viewer-pos");
  if (!form) return;

  var cards = [];          // [{letter, el}] in reading order, spaces as null
  var playTimer = null;

  function render(text) {
    stop();
    out.innerHTML = "";
    cards = [];
    var clean = text.toUpperCase();
    var skipped = /[^A-Z\s]/.test(clean);
    var words = clean.replace(/[^A-Z\s]/g, "").split(/\s+/).filter(Boolean);
    var missing = {};

    words.forEach(function (word, wi) {
      var group = document.createElement("li");
      group.className = "ref-word";
      group.setAttribute("aria-label", "Word " + (wi + 1) + ": " + word);
      var list = document.createElement("ol");
      word.split("").forEach(function (letter) {
        var li = document.createElement("li");
        li.className = "ref-card";
        var has = PHOTOS.indexOf(letter) !== -1;
        if (has) {
          var img = document.createElement("img");
          img.src = "assets/letters/" + letter + ".jpg";
          img.alt = "ISL sign for " + letter;
          img.width = 112; img.height = 112;
          li.appendChild(img);
        } else {
          li.classList.add("ref-missing");
          var ph = document.createElement("span");
          ph.className = "ref-missing-box";
          ph.textContent = "No photo";
          ph.setAttribute("aria-label", "No photo for " + letter);
          li.appendChild(ph);
          missing[letter] = true;
        }
        var cap = document.createElement("b");
        cap.textContent = letter;
        cap.setAttribute("aria-hidden", "true");
        li.appendChild(cap);
        list.appendChild(li);
        cards.push({ letter: letter, el: li, has: has });
      });
      group.appendChild(list);
      out.appendChild(group);
      cards.push(null);
    });
    if (cards.length) cards.pop();

    var notes = [];
    var m = Object.keys(missing);
    if (m.length) notes.push(m.join(", ") + (m.length === 1 ? " has" : " have") +
      " no photo in the dataset, so " + (m.length === 1 ? "it is" : "they are") + " shown as text only.");
    if (skipped) notes.push("Numbers and punctuation are left out.");
    if (!words.length && text.trim()) notes.push("Type letters A to Z to see their signs.");
    note.textContent = notes.join(" ");
    playBtn.disabled = !cards.length;
    out.hidden = !cards.length;
  }

  function highlight(i) {
    cards.forEach(function (c, j) { if (c) c.el.classList.toggle("ref-current", j === i); });
  }

  function step(i) {
    if (i >= cards.length) { stop(); return; }
    var c = cards[i];
    var letters = cards.filter(Boolean).length;
    var n = cards.slice(0, i + 1).filter(Boolean).length;
    if (!c) {
      viewer.dataset.space = "true";
      viewerLetter.textContent = "";
      viewerPos.textContent = "Next word";
      highlight(-1);
      playTimer = setTimeout(function () { step(i + 1); }, SPACE_MS);
      return;
    }
    viewer.dataset.space = "false";
    viewer.dataset.missing = c.has ? "false" : "true";
    if (c.has) { viewerImg.src = "assets/letters/" + c.letter + ".jpg"; viewerImg.alt = "ISL sign for " + c.letter; }
    else { viewerImg.removeAttribute("src"); viewerImg.alt = ""; }
    viewerLetter.textContent = c.letter;
    viewerPos.textContent = "Letter " + n + " of " + letters;
    highlight(i);
    playTimer = setTimeout(function () { step(i + 1); }, LETTER_MS);
  }

  function play() {
    if (!cards.length) return;
    stop();
    viewer.hidden = false;
    playBtn.textContent = "Stop";
    playBtn.setAttribute("aria-pressed", "true");
    step(0);
  }

  function stop() {
    clearTimeout(playTimer);
    playTimer = null;
    viewer.hidden = true;
    highlight(-1);
    playBtn.textContent = "Play one at a time";
    playBtn.setAttribute("aria-pressed", "false");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    render(input.value);
  });
  input.addEventListener("input", function () {
    if (!input.value.trim()) render("");
  });
  playBtn.addEventListener("click", function () { if (playTimer) stop(); else play(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && playTimer) stop();
  });

  render("");

  window.SilentSignReference = {
    showLetter: function (letter) {
      input.value = letter;
      render(letter);
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
})();
