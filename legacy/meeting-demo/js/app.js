(function(){
  "use strict";

  /* ============ GESTURE VOCABULARY ============
     finger order: [thumb, index, middle, ring, pinky] -> true = extended
  ============================================= */
  const VOCAB = [
    { id:"hello",   label:"Hello",     fingers:[false,true,true,true,true],   speak:"Hello",            words:["hello","hi","hey"] },
    { id:"yes",     label:"Yes",       fingers:[true,false,false,false,false],speak:"Yes",              words:["yes","yeah","yep"] },
    { id:"no",      label:"No / Stop", fingers:[false,false,false,false,false],speak:"No",              words:["no","stop","nope"] },
    { id:"thanks",  label:"Thank You", fingers:[false,true,true,false,false], speak:"Thank you",        words:["thanks","thank you","thankyou"] },
    { id:"help",    label:"Help",      fingers:[false,true,false,false,false],speak:"I need help",      words:["help","assist"] },
    { id:"love",    label:"Love You",  fingers:[true,true,false,false,true],  speak:"I love you",       words:["love","love you","i love you"] },
  ];

  /* ============ SVG HAND ICON GENERATOR ============ */
  function handSVG(fingers, color){
    color = color || "var(--caption-yellow)";
    const defs = [
      {x:34, base:14, ext:34, rot:-18},
      {x:52, base:20, ext:46, rot:0},
      {x:66, base:22, ext:50, rot:0},
      {x:80, base:20, ext:44, rot:0},
      {x:93, base:16, ext:36, rot:10},
    ];
    let lines = "";
    defs.forEach((d,i)=>{
      const ext = fingers[i];
      const len = ext ? d.ext : d.base;
      const y2 = 78 - len;
      lines += `<line x1="${d.x}" y1="78" x2="${d.x}" y2="${y2}" stroke="${color}" stroke-width="9" stroke-linecap="round" transform="rotate(${d.rot} ${d.x} 78)" opacity="${ext?1:0.42}"/>`;
    });
    return `<svg viewBox="0 0 126 100" xmlns="http://www.w3.org/2000/svg">
      <rect x="22" y="60" width="86" height="34" rx="16" fill="none" stroke="${color}" stroke-width="9" opacity="0.85"/>
      ${lines}
    </svg>`;
  }

  /* ============ BUILD VOCAB STRIP ============ */
  const vocabGrid = document.getElementById("vocabGrid");
  VOCAB.forEach(v=>{
    const card = document.createElement("div");
    card.className = "vocab-card";
    card.innerHTML = handSVG(v.fingers, "#FFC857") + `<span>${v.label}</span>`;
    card.title = "Simulate this gesture";
    card.addEventListener("click", ()=> handleGestureResult(v, 0.97, true));
    vocabGrid.appendChild(card);
  });

  /* ============ STATE ============ */
  let accessOn = false;
  let modelReady = false;
  let handModel = null;
  let sessionStart = Date.now();
  let recognizedCount = 0, totalAttempts = 0;
  let lastGestureId = null, stableFrames = 0;
  const STABLE_FRAMES_NEEDED = 8;
  let currentFlagCandidate = null;
  let flagQueue = [];

  // LISTENER PREFERENCE STATE — separate from global accessibility/session
  // state on purpose (see section 10 of the spec this was built against):
  // this only controls HOW the listener receives communication, never
  // WHETHER sign detection / translation itself runs.
  let listenerMode = "normal"; // "normal" | "deaf" | "mute" | "deaf-mute"

  // GLOBAL SESSION STATE — the single shared caption log. Both the
  // Session Captions ticker and the Hearing panel's Live Captions box
  // render FROM this same array; neither keeps its own separate copy.
  let captionLog = [];

  const els = {
    toggle: document.getElementById("accessToggle"),
    onair: document.getElementById("onairBadge"),
    confMeter: document.getElementById("confMeter"),
    confVal: document.getElementById("confVal"),
    signerRec: document.getElementById("signerRec"),
    signerSub: document.getElementById("signerSub"),
    flagBtn: document.getElementById("flagBtn"),
    tickerBody: document.getElementById("tickerBody"),
    tickerClock: document.getElementById("tickerClock"),
    latVal: document.getElementById("latVal"),
    fpsVal: document.getElementById("fpsVal"),
    accVal: document.getElementById("accVal"),
    signerModelTag: document.getElementById("signerModelTag"),
    videoPlaceholder: document.getElementById("videoPlaceholder"),
    avatarStage: document.getElementById("avatarStage"),
    micBtn: document.getElementById("micBtn"),
    micLabel: document.getElementById("micLabel"),
    asrTag: document.getElementById("asrTag"),
    transcript: document.getElementById("transcript"),
    reviewList: document.getElementById("reviewList"),
    reviewCount: document.getElementById("reviewCount"),
    reviewEmpty: document.getElementById("reviewEmpty"),
    signerPanel: document.getElementById("signerPanel"),
    hearingPanel: document.getElementById("hearingPanel"),
    typeInput: document.getElementById("typeInput"),
    typeSendBtn: document.getElementById("typeSendBtn"),
    spellBuffer: document.getElementById("spellBuffer"),
    spellBufferText: document.getElementById("spellBufferText"),
    spellBackspace: document.getElementById("spellBackspace"),
    spellClear: document.getElementById("spellClear"),
    spellSend: document.getElementById("spellSend"),
    letterGrid: document.getElementById("letterGrid"),
    listenerModeSelect: document.getElementById("listenerModeSelect"),
    modeBadge: document.getElementById("modeBadge"),
    audioIndicator: document.getElementById("audioIndicator"),
    liveCaptionsBody: document.getElementById("liveCaptionsBody"),
    liveCaptionsEmpty: document.getElementById("liveCaptionsEmpty"),
    liveDot: document.getElementById("liveDot"),
    islModelTag: document.getElementById("islModelTag"),
    islLetterBig: document.getElementById("islLetterBig"),
    islLetterConf: document.getElementById("islLetterConf"),
    islBuffer: document.getElementById("islBuffer"),
    islBufferText: document.getElementById("islBufferText"),
    islBackspace: document.getElementById("islBackspace"),
    islClear: document.getElementById("islClear"),
    islSend: document.getElementById("islSend"),
  };

  function fmtClock(){
    const s = Math.floor((Date.now()-sessionStart)/1000);
    const m = String(Math.floor(s/60)).padStart(2,"0");
    const ss = String(s%60).padStart(2,"0");
    return `${m}:${ss}`;
  }
  setInterval(()=>{ els.tickerClock.textContent = fmtClock(); }, 1000);

  function addCaption(who, text, warn){
    if(!text || !String(text).trim()) return; // empty-caption guard (spec section 19)

    // Duplicate-caption guard: skip only if it's an exact repeat of the
    // immediately previous line (protects against any accidental double
    // firing, e.g. a stray extra event), without blocking a signer who
    // legitimately repeats the same sign twice in a row much later.
    const prev = captionLog[captionLog.length - 1];
    if(prev && prev.who === who && prev.text === text && (Date.now() - prev.at) < 400) return;

    const entry = { who, text: String(text), warn: !!warn, at: Date.now(), clock: fmtClock() };
    captionLog.push(entry);

    renderTickerLine(entry);   // existing Session Captions history (unchanged behavior)
    renderLiveCaptions();      // NEW: Live Captions box inside the Hearing panel — same data
  }

  function renderTickerLine(entry){
    const line = document.createElement("div");
    line.className = "cc-line" + (entry.warn ? " warn" : "");
    line.innerHTML = `<span class="ts">${entry.clock}</span><span class="who">${entry.who}:</span> <span class="txt">${entry.text}</span>`;
    els.tickerBody.appendChild(line);
    els.tickerBody.scrollTop = els.tickerBody.scrollHeight;
  }

  // Live Captions shows what the SIGNER is currently communicating (per
  // the panel's purpose: "this is what the signer is currently saying"),
  // pulled from the same captionLog — not a separate/fake state.
  function renderLiveCaptions(){
    const relevant = captionLog.filter(e => e.who === "SIGNER" || e.who === "AVATAR");
    if(relevant.length === 0){
      els.liveCaptionsEmpty.style.display = "block";
      els.liveCaptionsBody.querySelectorAll(".live-caption-line").forEach(n=>n.remove());
      return;
    }
    els.liveCaptionsEmpty.style.display = "none";
    const last4 = relevant.slice(-4);
    els.liveCaptionsBody.querySelectorAll(".live-caption-line").forEach(n=>n.remove());
    last4.forEach((entry, idx)=>{
      const line = document.createElement("div");
      const isLatest = idx === last4.length - 1;
      line.className = "live-caption-line" + (isLatest ? " latest" : "");
      line.innerHTML = `<span class="who">${entry.who}:</span> ${entry.text}`;
      els.liveCaptionsBody.appendChild(line);
    });
    els.liveCaptionsBody.scrollTop = els.liveCaptionsBody.scrollHeight;
    els.liveDot.classList.add("active");
    clearTimeout(renderLiveCaptions._t);
    renderLiveCaptions._t = setTimeout(()=> els.liveDot.classList.remove("active"), 1500);
  }

  function speak(text){
    try{
      if(!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    }catch(e){}
  }

  /* ============ LISTENER MODE ============
     Controls ONLY how the listener receives communication (audio on/off).
     Must never gate sign detection, translation, or caption delivery —
     those keep running identically in every mode (spec section 4).
  ============================================= */
  function isAudioAllowed(){
    return listenerMode === "normal" || listenerMode === "deaf";
  }

  function updateListenerModeUI(){
    const labels = { "normal":"NORMAL", "deaf":"DEAF", "mute":"MUTE", "deaf-mute":"DEAF + MUTE" };
    els.modeBadge.textContent = labels[listenerMode];
    els.modeBadge.className = "mode-badge " + listenerMode;
    const audioOn = isAudioAllowed();
    els.audioIndicator.textContent = audioOn ? "🔊" : "🔇";
    els.audioIndicator.classList.toggle("muted", !audioOn);
    els.audioIndicator.title = audioOn ? "Audio output on" : "Audio output muted for this listener mode";
  }

  els.listenerModeSelect.addEventListener("change", (e)=>{
    listenerMode = e.target.value;
    updateListenerModeUI();
    // Switching modes never touches captionLog, sign detection, or the
    // camera/model — only how output is delivered from here on.
    if(!isAudioAllowed()){
      try{ window.speechSynthesis && window.speechSynthesis.cancel(); }catch(e){} // no audio loops on switch
    }
  });
  updateListenerModeUI();

  /* ============ ACCESSIBILITY MODE (Host control) ============ */
  function applyAccessibilityState(){
    document.body.classList.toggle("off", !accessOn);
    els.onair.textContent = accessOn ? "● ON AIR" : "OFF AIR";
    els.onair.classList.toggle("live", accessOn);
    els.signerPanel.classList.toggle("disabled", !accessOn);
    els.hearingPanel.classList.toggle("disabled", !accessOn);
  }
  applyAccessibilityState(); // BUGFIX: apply on initial load too, not just on toggle change —
                             // otherwise panels look interactive/active before the host has
                             // ever turned Accessibility Mode on (spec section 7/18).

  els.toggle.addEventListener("change", (e)=>{
    accessOn = e.target.checked;
    applyAccessibilityState();
    if(accessOn){
      addCaption("SYSTEM", "Silent Sign Accessibility Mode enabled by host — translation active for all participants.");
      initCamera();
      initModel();
    } else {
      addCaption("SYSTEM", "Accessibility Mode turned off by host.");
    }
  });

  /* ============ CAMERA + HAND TRACKING ============ */
  const video = document.getElementById("webcam");
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");
  let cameraReady = false;

  async function initCamera(){
    if(cameraReady) return;
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ width:480, height:360 }, audio:false });
      video.srcObject = stream;
      await video.play();
      cameraReady = true;
      els.videoPlaceholder.style.display = "none";
      overlay.width = video.videoWidth || 480;
      overlay.height = video.videoHeight || 360;
    }catch(err){
      els.videoPlaceholder.innerHTML = `Camera unavailable (<b>${err.name}</b>).<br>Use <b>Simulate</b> below — it drives the exact same pipeline.`;
    }
  }

  async function initModel(){
    if(modelReady) return;
    els.signerModelTag.textContent = "model: loading…";
    try{
      await new Promise(r=>setTimeout(r,50));
      if(typeof handpose === "undefined" || typeof tf === "undefined") throw new Error("lib not loaded");
      await tf.setBackend('webgl').catch(()=>tf.setBackend('cpu'));
      handModel = await handpose.load();
      modelReady = true;
      els.signerModelTag.textContent = "model: ready (client-side, rule-based classifier)";
      requestAnimationFrame(detectLoop);
    }catch(err){
      els.signerModelTag.textContent = "model: unavailable — simulate mode";
      addCaption("SYSTEM", "Hand-tracking model could not load (network-restricted or CDN blocked). Vocabulary cards and text/spelling input remain fully functional.", true);
    }
  }

  function fingerExtended(lm, tipIdx, pipIdx, wristIdx){
    const d = (a,b)=>Math.hypot(lm[a][0]-lm[b][0], lm[a][1]-lm[b][1]);
    return d(tipIdx,wristIdx) > d(pipIdx,wristIdx) * 1.18;
  }

  function classify(landmarks){
    const f = [
      fingerExtended(landmarks, 4, 2, 0),
      fingerExtended(landmarks, 8, 6, 0),
      fingerExtended(landmarks, 12, 10, 0),
      fingerExtended(landmarks, 16, 14, 0),
      fingerExtended(landmarks, 20, 18, 0),
    ];
    let best = null, bestScore = -1;
    VOCAB.forEach(v=>{
      let score = 0;
      for(let i=0;i<5;i++) if(v.fingers[i]===f[i]) score++;
      if(score > bestScore){ bestScore = score; best = v; }
    });
    const confidence = bestScore/5;
    return { match: confidence>=1 ? best : (confidence>=0.8?best:null), confidence, fingers:f };
  }

  let lastFrameTime = performance.now();
  async function detectLoop(){
    if(!accessOn){ requestAnimationFrame(detectLoop); return; }
    if(!cameraReady || !modelReady){ requestAnimationFrame(detectLoop); return; }
    const t0 = performance.now();
    try{
      const preds = await handModel.estimateHands(video);
      octx.clearRect(0,0,overlay.width,overlay.height);
      if(preds.length>0){
        const lm = preds[0].landmarks;
        drawSkeleton(lm);
        const { match, confidence } = classify(lm);
        updateConfidence(confidence);
        if(match){
          if(match.id === lastGestureId){ stableFrames++; } else { stableFrames = 0; lastGestureId = match.id; }
          if(stableFrames === STABLE_FRAMES_NEEDED){
            handleGestureResult(match, confidence, false);
          }
        } else {
          stableFrames = 0; lastGestureId = null;
          if(confidence < 0.6){ showUnrecognized(); }
        }
      } else {
        updateConfidence(0);
      }
    }catch(e){}
    const dt = performance.now()-t0;
    els.latVal.textContent = Math.round(dt)+"ms";
    const fps = Math.round(1000/(performance.now()-lastFrameTime));
    els.fpsVal.textContent = isFinite(fps)?fps:"—";
    lastFrameTime = performance.now();
    requestAnimationFrame(detectLoop);
  }

  function drawSkeleton(lm){
    octx.fillStyle = "#FFC857";
    octx.strokeStyle = "rgba(255,200,87,0.55)";
    octx.lineWidth = 2;
    const conns = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];
    conns.forEach(([a,b])=>{
      octx.beginPath();
      octx.moveTo(lm[a][0], lm[a][1]);
      octx.lineTo(lm[b][0], lm[b][1]);
      octx.stroke();
    });
    lm.forEach(p=>{
      octx.beginPath();
      octx.arc(p[0],p[1],3,0,Math.PI*2);
      octx.fill();
    });
  }

  function updateConfidence(c){
    const pct = Math.round(c*100);
    els.confMeter.style.width = pct+"%";
    els.confVal.textContent = pct+"%";
  }

  function showUnrecognized(){
    els.signerRec.textContent = "gesture not recognized";
    els.signerRec.className = "rec unrec";
    els.signerSub.textContent = "Please repeat clearly in frame — no guessed translation is shown to other participants.";
    els.flagBtn.style.display = "none";
  }

  function handleGestureResult(vocabItem, confidence, simulated){
    totalAttempts++; recognizedCount++;
    updateConfidence(confidence);
    els.signerRec.textContent = vocabItem.label;
    els.signerRec.className = "rec";
    els.signerSub.textContent = simulated ? "Simulated gesture — recognized instantly." : `Recognized in-frame · confidence ${Math.round(confidence*100)}%`;
    els.flagBtn.style.display = "inline-block";
    currentFlagCandidate = { id: Date.now(), text: vocabItem.label };
    addCaption("SIGNER", vocabItem.speak);
    if(isAudioAllowed()) speak(vocabItem.speak); // gated by Listener Mode, never by detection itself
    els.accVal.textContent = Math.round((recognizedCount/totalAttempts)*100)+"%";
    stableFrames = 0; lastGestureId = null;
  }

  els.flagBtn.addEventListener("click", ()=>{
    if(!currentFlagCandidate) return;
    flagQueue.push(currentFlagCandidate);
    renderQueue();
    addCaption("SYSTEM", `Translation "${currentFlagCandidate.text}" flagged for reviewer.`, true);
    els.flagBtn.style.display = "none";
    currentFlagCandidate = null;
  });

  function renderQueue(){
    els.reviewList.innerHTML = "";
    if(flagQueue.length===0){
      els.reviewEmpty.style.display = "block";
      els.reviewCount.style.display = "none";
      return;
    }
    els.reviewEmpty.style.display = "none";
    els.reviewCount.style.display = "inline-block";
    els.reviewCount.textContent = flagQueue.length;
    flagQueue.forEach(item=>{
      const row = document.createElement("div");
      row.className = "review-item";
      row.innerHTML = `<span>"${item.text}" — flagged during live session</span>`;
      const btn = document.createElement("button");
      btn.textContent = "Approve correction";
      btn.addEventListener("click", ()=>{
        flagQueue = flagQueue.filter(f=>f.id!==item.id);
        addCaption("REVIEWER", `Correction for "${item.text}" approved and added to training dataset.`);
        renderQueue();
      });
      row.appendChild(btn);
      els.reviewList.appendChild(row);
    });
  }
  renderQueue();

  /* ============ AVATAR STAGE (default) ============ */
  function renderAvatar(vocabItem){
    els.avatarStage.innerHTML = handSVG(vocabItem ? vocabItem.fingers : [false,false,false,false,false], "#39D98A") +
      `<div class="avatar-caption">${vocabItem ? vocabItem.label : "avatar idle"}</div>`;
  }
  renderAvatar(null);

  /* ============ SPEECH-TO-SIGN (Hearing participant) ============ */
  let recognizing = false;
  let recognizer = null;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function matchVocabFromText(text){
    const t = text.toLowerCase();
    return VOCAB.find(v => v.words.some(w => t.includes(w))) || null;
  }

  // Shared handler for ANY way the hearing participant produces text —
  // speaking, typing, or spelling — so all three behave identically.
  function sendHearingText(text, sourceLabel){
    if(!text || !text.trim()) return;
    if(!accessOn){ addCaption("SYSTEM","Enable Accessibility Mode first.", true); return; }
    const match = matchVocabFromText(text);
    els.transcript.innerHTML = `<b>"${text}"</b>`;
    if(match){
      renderAvatar(match);
      addCaption(sourceLabel, text.trim());
      addCaption("AVATAR", `signs → ${match.label}`);
    } else {
      // No vocabulary match — still shown as a plain caption for the
      // signer (this is the literal "typed sentence becomes a caption"
      // behaviour), just without a matching avatar animation.
      renderAvatar(null);
      addCaption(sourceLabel, text.trim());
    }
    // Note: intentionally NOT speaking the hearing participant's own text
    // back to them — that's not part of the signer→listener audio path
    // Listener Mode governs (see isAudioAllowed() usage in
    // handleGestureResult), and would just be duplicate/pointless audio.
  }

  els.micBtn.addEventListener("click", ()=>{
    if(!accessOn){ addCaption("SYSTEM","Enable Accessibility Mode first.", true); return; }
    if(!SpeechRec){
      addCaption("SYSTEM","Speech recognition isn't available in this browser — try Chrome, or use the type/spell box below instead.", true);
      return;
    }
    if(recognizing){ recognizer.stop(); return; }
    recognizer = new SpeechRec();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = "en-US";
    recognizer.onstart = ()=>{
      recognizing = true;
      els.micBtn.classList.add("on"); els.micLabel.textContent = "Listening… (tap to stop)";
      els.asrTag.textContent = "ASR: live";
    };
    recognizer.onend = ()=>{
      recognizing = false;
      els.micBtn.classList.remove("on"); els.micLabel.textContent = "Start speaking";
      els.asrTag.textContent = "ASR: idle";
    };
    recognizer.onerror = (e)=>{
      addCaption("SYSTEM", "Microphone unavailable ("+e.error+"). Try the type/spell box below instead.", true);
    };
    recognizer.onresult = (event)=>{
      let text = "";
      for(let i=event.resultIndex;i<event.results.length;i++) text += event.results[i][0].transcript;
      if(event.results[event.results.length-1].isFinal){
        sendHearingText(text, "HEARING");
      } else {
        els.transcript.innerHTML = `<b>"${text}"</b> <span style="opacity:.5">…</span>`;
      }
    };
    try{ recognizer.start(); }catch(e){}
  });

  /* ============ NEW: TYPE A SENTENCE ============ */
  function submitTyped(){
    const text = els.typeInput.value;
    if(!text.trim()) return;
    sendHearingText(text, "HEARING (typed)");
    els.typeInput.value = "";
  }
  els.typeSendBtn.addEventListener("click", submitTyped);
  els.typeInput.addEventListener("keydown", (e)=>{ if(e.key === "Enter") submitTyped(); });

  /* ============ NEW: SPELL IT OUT (letter board) ============
     Deliberately plain text letters, not invented "ASL handshape" icons —
     fabricating sign-language reference images that might be wrong would
     actively teach incorrect signs, which is worse than a plain letter
     board. For a real ASL fingerspelling chart, link out to a proper
     reference (e.g. lifeprint.com/asl101/fingerspelling) instead of
     reproducing someone else's copyrighted chart here.
  ============================================================= */
  let spellBuffer = "";
  function renderSpellBuffer(){
    els.spellBufferText.textContent = spellBuffer.length ? spellBuffer : "\u00A0";
  }
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(letter=>{
    const btn = document.createElement("button");
    btn.className = "letter-btn";
    btn.innerHTML = `<span class="hand">🤟</span><span class="ltr">${letter}</span>`;
    btn.title = `Add "${letter}"`;
    btn.addEventListener("click", ()=>{
      spellBuffer += letter;
      renderSpellBuffer();
    });
    els.letterGrid.appendChild(btn);
  });
  // Space + a couple of common punctuation helpers, appended after A-Z
  [[" ","SPACE"], ["'","'"], ["?","?"]].forEach(([ch,label])=>{
    const btn = document.createElement("button");
    btn.className = "letter-btn";
    btn.innerHTML = `<span class="hand">${ch === " " ? "␣" : ch}</span><span class="ltr">${label}</span>`;
    btn.addEventListener("click", ()=>{ spellBuffer += ch; renderSpellBuffer(); });
    els.letterGrid.appendChild(btn);
  });

  els.spellBackspace.addEventListener("click", ()=>{
    spellBuffer = spellBuffer.slice(0, -1);
    renderSpellBuffer();
  });
  els.spellClear.addEventListener("click", ()=>{
    spellBuffer = "";
    renderSpellBuffer();
  });
  els.spellSend.addEventListener("click", ()=>{
    if(!spellBuffer.trim()) return;
    sendHearingText(spellBuffer, "HEARING (spelled)");
    spellBuffer = "";
    renderSpellBuffer();
  });
  renderSpellBuffer();

  /* ============ INIT ============ */
  addCaption("SYSTEM", "Session started. Toggle Accessibility Mode above to begin.");

  /* ============ NEW: ISL LETTER RECOGNITION (live, beside video) ============
     Loads the CNN trained by training/train_isl_model.py on the Indian
     Sign Language dataset, if it's been trained and dropped into
     model/isl_model_tfjs/. Runs continuously (not gated by the same
     "hold stable for N frames" logic as the word-gesture pipeline) so it
     feels genuinely live, per the "translated live, next to the video"
     request. Falls back to a clear "not trained yet" state — never fakes
     a prediction — if the model files aren't present.
  ================================================================= */
  let islModel = null;
  let islClassNames = [];
  let islImgSize = [128, 128];
  let islBuffer = "";
  let islLoopTimer = null;

  function renderIslBuffer(){
    els.islBufferText.textContent = islBuffer.length ? islBuffer : "\u00A0";
  }
  renderIslBuffer();

  async function loadIslModel(){
    try{
      if(typeof tf === "undefined") throw new Error("tf.js not loaded");
      const res = await fetch("model/isl_model_tfjs/class_names.json");
      if(!res.ok) throw new Error("class_names.json not found");
      const meta = await res.json();
      islClassNames = meta.classes;
      islImgSize = meta.img_size || [128, 128];
      islModel = await tf.loadLayersModel("model/isl_model_tfjs/model.json");
      els.islModelTag.textContent = `model: ready (${islClassNames.length} classes, ${Math.round((meta.val_accuracy||0)*1000)/10}% val acc)`;
      startIslLoop();
    }catch(err){
      // Honest fallback — this is the expected state until the real
      // Kaggle dataset has actually been trained on (see training/README.md).
      els.islModelTag.textContent = "model: not trained yet";
      els.islLetterBig.textContent = "—";
      els.islLetterConf.textContent = "train it — see training/README.md";
    }
  }

  function startIslLoop(){
    if(islLoopTimer) return;
    islLoopTimer = setInterval(async ()=>{
      if(!accessOn || !cameraReady || !islModel || !video.videoWidth) return;
      try{
        const pred = tf.tidy(()=>{
          const img = tf.browser.fromPixels(video)
            .resizeBilinear([islImgSize[0], islImgSize[1]])
            .expandDims(0)
            .toFloat();
          const out = islModel.predict(img);
          return out.dataSync();
        });
        let best = 0;
        for(let i=1;i<pred.length;i++) if(pred[i] > pred[best]) best = i;
        const confidence = pred[best];
        const letter = islClassNames[best];
        els.islLetterBig.textContent = letter;
        els.islLetterConf.textContent = `${Math.round(confidence*100)}% confidence`;
      }catch(e){ /* skip this frame silently */ }
    }, 400); // live but throttled — no need to run every animation frame
  }

  els.islBackspace.addEventListener("click", ()=>{ islBuffer = islBuffer.slice(0,-1); renderIslBuffer(); });
  els.islClear.addEventListener("click", ()=>{ islBuffer = ""; renderIslBuffer(); });
  els.islLetterBig.addEventListener("click", ()=>{
    // click the big live letter to append it to the buffer, same idea as
    // the hearing-side spelling board but fed by the real model's output
    const l = els.islLetterBig.textContent;
    if(l && l !== "—"){ islBuffer += l; renderIslBuffer(); }
  });
  els.islSend.addEventListener("click", ()=>{
    if(!islBuffer.trim()) return;
    if(!accessOn){ addCaption("SYSTEM","Enable Accessibility Mode first.", true); return; }
    addCaption("SIGNER", islBuffer);
    if(isAudioAllowed()) speak(islBuffer);
    islBuffer = "";
    renderIslBuffer();
  });

  loadIslModel();
})();
