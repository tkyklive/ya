// ====== Who Is the Lead? — Mac Safari Trackpad Edition ======
// Required files:
//   assets/drum.wav
//   assets/synthesizer.wav
//
// Interaction (Trackpad / Mouse):
// - Drag the CUBE (center) up/down => Reverb SPACE size (room size).
// - Drag anywhere else => Spatial control (distance/width/focus/motion + position).
// - Idle => autopilot drift.
// - Safari-safe (no OffscreenCanvas tricks).

(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas  = $("viz");
  const overlay = $("overlay");
  const startBtn= $("start");
  const statusEl= $("status");
  const debugEl = $("debug");

  function setStatus(s){ if (statusEl) statusEl.textContent = s; }
  function logDebug(msg){ if (debugEl) debugEl.textContent = String(msg || ""); }

  // ---------- Canvas ----------
  const g = canvas.getContext("2d", { alpha: false });

  let W=0, H=0, DPR=1;
  function resize(){
    DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    canvas.width  = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize, { passive:true });
  resize();

  // ---------- Utils ----------
  function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
  function lerp(a,b,t){ return a + (b-a)*t; }
  function easeOut(t){ t=clamp01(t); return 1 - Math.pow(1-t, 3); }

  // ---------- Audio ----------
  let ctx = null;
  let analyser = null;
  let freqData = null;
  let timeData = null;

  let masterIn = null;
  let masterOut = null;
  let reverb = null;

  let stems = []; // [drum, synth]
  let running = false;

  const FILES = [
    { name:"drum", url:"assets/drum.wav" },
    { name:"synth", url:"assets/synthesizer.wav" },
  ];

  async function loadBuffer(url){
    const res = await fetch(url, { cache:"no-cache" });
    if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
    const arr = await res.arrayBuffer();
    return await ctx.decodeAudioData(arr);
  }

  function createMaster(){
    masterIn = ctx.createGain();
    masterIn.gain.value = 0.85;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 5;
    comp.attack.value = 0.006;
    comp.release.value = 0.12;

    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -6;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.003;
    limit.release.value = 0.08;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.86;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);

    masterOut = ctx.createGain();
    masterOut.gain.value = 1.0;

    masterIn.connect(comp);
    comp.connect(limit);
    limit.connect(masterOut);
    masterOut.connect(analyser);
    analyser.connect(ctx.destination);
  }

  // Reverb is a feedback delay network-ish “cheap big room”
  function createReverbBus(){
    const input = ctx.createGain();
    input.gain.value = 1.0;

    const predelay = ctx.createDelay(0.35);
    predelay.delayTime.value = 0.04;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 160;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5200;

    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.0;

    input.connect(predelay);
    predelay.connect(hp);
    hp.connect(lp);

    const times = [0.031, 0.037, 0.041, 0.053];
    const delays = times.map(t => {
      const d = ctx.createDelay(0.25);
      d.delayTime.value = t;
      return d;
    });

    // feedback amounts will be *controlled by cube size*
    const fbs = delays.map(() => {
      const gg = ctx.createGain();
      gg.gain.value = 0.55;
      return gg;
    });

    const loopLPs = delays.map(() => {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 4800;
      f.Q.value = 0.7;
      return f;
    });

    delays.forEach(d => lp.connect(d));
    delays.forEach((d,i) => {
      d.connect(wetGain);

      d.connect(loopLPs[i]);
      loopLPs[i].connect(fbs[i]);
      fbs[i].connect(d);
    });

    const shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf";
    shelf.frequency.value = 6200;
    shelf.gain.value = 2.8;

    wetGain.connect(shelf);
    shelf.connect(masterIn);

    return { input, wetGain, predelay, hp, lp, fbs };
  }

  function buildStem(buffer, basePan){
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const pre = ctx.createGain();
    pre.gain.value = 0.65;

    const focusEQ = ctx.createBiquadFilter();
    focusEQ.type = "peaking";
    focusEQ.Q.value = 1.1;
    focusEQ.gain.value = 11.0;
    focusEQ.frequency.value = 1200;

    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 18000;
    lpf.Q.value = 0.7;

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = basePan;

    const dry = ctx.createGain();
    dry.gain.value = 1.0;

    const send = ctx.createGain();
    send.gain.value = 0.0;

    // width (Haas)
    const sideL = ctx.createGain(); sideL.gain.value = 0.0;
    const sideR = ctx.createGain(); sideR.gain.value = 0.0;

    const panL = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const panR = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panL) panL.pan.value = -1;
    if (panR) panR.pan.value =  1;

    const sideDelay = ctx.createDelay(0.06);
    sideDelay.delayTime.value = 0.001;

    // motion LFO (autopan)
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.12;

    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.0;

    lfo.connect(lfoDepth);
    if (pan) lfoDepth.connect(pan.pan);
    lfo.start();

    // route
    src.connect(pre);
    pre.connect(focusEQ);
    focusEQ.connect(lpf);

    if (pan){
      lpf.connect(pan);
      pan.connect(dry);
    } else {
      lpf.connect(dry);
    }
    dry.connect(masterIn);

    lpf.connect(send);
    send.connect(reverb.input);

    lpf.connect(sideL);
    lpf.connect(sideDelay);
    sideDelay.connect(sideR);

    if (panL){ sideL.connect(panL); panL.connect(masterIn); } else sideL.connect(masterIn);
    if (panR){ sideR.connect(panR); panR.connect(masterIn); } else sideR.connect(masterIn);

    src.start();

    return { src, pre, focusEQ, lpf, pan, dry, send, sideL, sideR, sideDelay, lfo, lfoDepth, basePan };
  }

  // ---------- Analysis helpers ----------
  function bandEnergy(start01, end01){
    const n = freqData.length;
    const a = Math.floor(n * start01);
    const b = Math.max(a + 1, Math.floor(n * end01));
    let sum = 0;
    for (let i = a; i < b; i++) sum += freqData[i];
    return (sum / (b - a)) / 255;
  }
  function waveformRMS(){
    let sum = 0;
    for (let i = 0; i < timeData.length; i++){
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / timeData.length));
  }

  // ---------- Interaction Params ----------
  const params = {
    // spatial (0..1)
    distance: 0.25,
    width:    0.35,
    focus:    0.50,
    motion:   0.30,
    // pointer (-1..1)
    x: 0.0,
    y: 0.0,
    // reverb “space size” controlled by CUBE (0..1)
    space: 0.35,
  };

  let lastTouchMs = 0;

  // Cube interaction state
  let dragMode = "none"; // "cube" | "space"
  let dragStart = null;  // {x,y, space0}
  const cube = {
    // computed each frame:
    cx: 0, cy: 0,
    r:  120, // approx clickable radius
  };

  function getPoint(e){
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function insideCube(px, py){
    const dx = px - cube.cx;
    const dy = py - cube.cy;
    return (dx*dx + dy*dy) <= (cube.r*cube.r);
  }

  function setSpatialFromPointer(px, py){
    const nx = (px / W) * 2 - 1;
    const ny = (py / H) * 2 - 1;

    params.x = nx;
    params.y = ny;

    // spatial map (feel free to tweak later)
    params.distance = clamp01((ny + 1) * 0.5);       // top near -> bottom far
    params.width    = clamp01(Math.abs(nx));          // center narrow -> edges wide
    params.focus    = clamp01((nx + 1) * 0.5);        // left -> right spotlight
    params.motion   = clamp01(0.12 + (1 - params.distance) * 0.88);

    lastTouchMs = performance.now();
  }

  function bindPointer(){
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const p = getPoint(e);

      // choose mode based on whether you grabbed the cube
      if (insideCube(p.x, p.y)){
        dragMode = "cube";
        dragStart = { x:p.x, y:p.y, space0: params.space };
      } else {
        dragMode = "space";
        setSpatialFromPointer(p.x, p.y);
      }
    }, { passive:false });

    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons !== 1) return; // trackpad drag
      e.preventDefault();
      const p = getPoint(e);

      if (dragMode === "cube" && dragStart){
        // drag up => bigger cube => bigger reverb space
        const dy = (dragStart.y - p.y);     // up positive
        const delta = dy / Math.max(240, H*0.45); // normalize
        params.space = clamp01(dragStart.space0 + delta);
        lastTouchMs = performance.now();
      } else {
        setSpatialFromPointer(p.x, p.y);
      }
    }, { passive:false });

    window.addEventListener("pointerup", () => {
      dragMode = "none";
      dragStart = null;
    }, { passive:true });
  }

  // ---------- Apply audio params ----------
  function applyAudio(){
    const d = params.distance;
    const w = params.width;
    const f = params.focus;
    const m = params.motion;
    const s = params.space; // cube -> reverb size

    // ---- Reverb “SPACE SIZE” (cube) ----
    // space affects: wet amount, predelay, tone, and *feedback* (tail length)
    const wet = clamp(0.05 + s * 0.95, 0, 1);
    reverb.wetGain.gain.value = wet;

    reverb.predelay.delayTime.value = 0.01 + s * 0.18;     // 10ms..190ms
    reverb.lp.frequency.value = 7800 - s * 4200;           // bright->darker
    reverb.hp.frequency.value = 120 + s * 240;             // tighten lows a bit

    // feedback -> tail length (keep stable, avoid runaway)
    const fb = 0.28 + s * 0.56; // 0.28..0.84
    for (const gfb of reverb.fbs) gfb.gain.value = fb;

    // master headroom: bigger space often feels louder
    masterIn.gain.value = 0.86 - wet * 0.16;

    // ---- Spatial control (rest of the scene) ----
    const focusHz = 150 + f * 6850;
    const motionRate = 0.06 + m * 1.65;

    stems.forEach((st, idx) => {
      const isDrum  = (idx === 0);
      const isSynth = (idx === 1);

      // distance controls dry/send + dullness
      st.dry.gain.value = Math.max(0.10, 1.0 - d * 0.80);

      // send depends on both distance AND space (room size)
      const sendBase = isDrum ? 1.10 : 1.05;
      st.send.gain.value = clamp01((0.15 + d * 0.95) * (0.35 + s * 0.85) * sendBase);

      st.lpf.frequency.value = 18000 - d * 15800;

      // focus spotlight (synth more sensitive)
      st.focusEQ.frequency.value = focusHz;
      st.focusEQ.gain.value = isSynth ? 15.0 : 9.0;

      // pan = base + pointer X (but stabilized by width)
      if (st.pan){
        const pos = params.x * 0.95;
        const widthBoost = Math.min(1.0, w * 1.25);
        const targetPan = (st.basePan * 0.9) * widthBoost + pos * 0.55;
        st.pan.pan.value = clamp(targetPan, -1, 1);
      }

      // width: Haas sides
      const sideAmt = Math.min(0.95, w * 1.00);
      st.sideL.gain.value = sideAmt * 0.62;
      st.sideR.gain.value = sideAmt * 0.62;
      st.sideDelay.delayTime.value = 0.001 + w * 0.023 + (m * 0.004);

      // motion: autopan
      st.lfo.frequency.value = motionRate;
      st.lfoDepth.gain.value = Math.min(1.0, m * 0.95);
    });
  }

  // ---------- Viz: Rhizomatiks / Aphex-ish + CUBE UI ----------
  let particles = [];
  let flowT = 0;
  let strobe = 0;
  let prevRMS = 0;

  function initParticles(){
    particles = [];
    const N = Math.floor(W * H / 15000);
    for (let i=0; i<N; i++){
      particles.push({
        x: Math.random()*W,
        y: Math.random()*H,
        vx: 0, vy: 0,
        s: 0.6 + Math.random()*1.6,
        a: 0.25 + Math.random()*0.65
      });
    }
  }
  initParticles();
  window.addEventListener("resize", initParticles, { passive:true });

  function drawGrid(bass, high){
    g.save();
    g.globalCompositeOperation = "lighter";

    const lines = 12 + Math.floor(high*18);
    const spacing = Math.max(18, Math.min(52, (W/lines)));
    const wob = (params.motion*18 + bass*22) * (0.12 + strobe*0.9);

    g.lineWidth = 1;
    g.strokeStyle = `rgba(255,255,255,${0.04 + high*0.08})`;

    for (let x = 0; x <= W; x += spacing){
      const xx = x + Math.sin((x*0.02) + flowT*2.0) * wob;
      g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, H); g.stroke();
    }
    for (let y = 0; y <= H; y += spacing){
      const yy = y + Math.cos((y*0.02) + flowT*1.6) * wob;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke();
    }

    const fx = W*0.5 + (params.focus-0.5)*W*0.75;
    g.lineWidth = 2;
    g.strokeStyle = `rgba(255,255,255,${0.06 + high*0.14})`;
    g.beginPath(); g.moveTo(fx, 0); g.lineTo(fx, H); g.stroke();

    g.restore();
  }

  function drawParticles(bass, mid, high, rms){
    g.save();
    g.globalCompositeOperation = "lighter";

    const cx = W*0.5, cy = H*0.5;
    const fx = cx + (params.focus-0.5)*W*0.9;

    const pull  = (0.0008 + mid*0.0025) * (0.4 + params.width);
    const speed = (0.45 + params.motion*2.2 + high*1.4) * (0.6 + strobe*1.4);
    const drift = (params.distance*0.45 + 0.1);

    for (const p of particles){
      const nx = (p.x/W - 0.5);
      const ny = (p.y/H - 0.5);
      const ang = Math.sin(nx*6 + flowT*1.6) + Math.cos(ny*7 - flowT*1.2);
      const a = ang + (bass*2.2 - high*1.6) + (params.motion*1.8);

      p.vx += Math.cos(a) * 0.06 * speed;
      p.vy += Math.sin(a) * 0.06 * speed;

      p.vx += (fx - p.x) * pull;
      p.vy += (cy - p.y) * pull*0.55;

      p.vx *= 0.90; p.vy *= 0.90;
      p.x += p.vx + (Math.random()-0.5)*drift;
      p.y += p.vy + (Math.random()-0.5)*drift;

      if (p.x < -20) p.x = W+20;
      if (p.x > W+20) p.x = -20;
      if (p.y < -20) p.y = H+20;
      if (p.y > H+20) p.y = -20;

      const alpha = (0.05 + p.a*0.16 + high*0.10) * (0.8 + strobe*1.1);
      const size  = p.s * (0.7 + rms*2.2 + bass*1.2);

      g.fillStyle = `rgba(255,255,255,${alpha})`;
      g.fillRect(p.x, p.y, size, size);
    }

    if (high > 0.22 || strobe > 0.25){
      const links = 30 + Math.floor(high*100);
      g.strokeStyle = `rgba(255,255,255,${0.02 + high*0.07 + strobe*0.08})`;
      g.lineWidth = 1;
      for (let i=0; i<links; i++){
        const a = particles[(Math.random()*particles.length)|0];
        const b = particles[(Math.random()*particles.length)|0];
        const dx = a.x - b.x, dy = a.y - b.y;
        const maxD = (80 + params.width*180);
        if (dx*dx + dy*dy < maxD*maxD){
          g.beginPath(); g.moveTo(a.x,a.y); g.lineTo(b.x,b.y); g.stroke();
        }
      }
    }

    g.restore();
  }

  function drawScope(bass, high, rms){
    g.save();
    g.globalCompositeOperation = "lighter";

    const cx = W*0.5, cy = H*0.72;
    const amp = (20 + bass*120 + rms*140) * (0.7 + (1-params.distance)*0.55);
    const sx  = 0.22 + params.width*0.55;
    const rot = (params.motion*0.28 + strobe*0.22) * (Math.sin(flowT*0.7));
    const phase = Math.floor((params.motion*0.35 + high*0.25) * 180);

    g.translate(cx, cy);
    g.rotate(rot);

    g.beginPath();
    const N = timeData.length;
    const step = Math.max(1, Math.floor(N / 900));
    for (let i=0; i<N; i+=step){
      const v1 = (timeData[i] - 128)/128;
      const v2 = (timeData[(i+phase) % N] - 128)/128;
      const x = v1 * (W*sx*0.5);
      const y = v2 * amp;
      if (i===0) g.moveTo(x,y);
      else g.lineTo(x,y);
    }
    g.strokeStyle = `rgba(255,255,255,${0.06 + high*0.10 + strobe*0.14})`;
    g.lineWidth = 1.3 + bass*2.0;
    g.stroke();

    g.restore();
  }

  function drawScanlines(high){
    const lines = 6 + Math.floor(high*16);
    g.save();
    g.globalCompositeOperation = "overlay";
    g.strokeStyle = `rgba(255,255,255,${0.015 + high*0.05})`;
    g.lineWidth = 1;
    for (let i=0; i<lines; i++){
      const y = (i/lines)*H + Math.sin(flowT*2 + i) * (2 + params.motion*6);
      g.beginPath(); g.moveTo(0,y); g.lineTo(W,y); g.stroke();
    }
    g.restore();
  }

  // --- 3D-ish Wireframe Cube (UI) ---
  function projectCube(sizePx, rotY, rotX){
    // simple 3D points for a cube centered at origin
    const s = sizePx;
    const pts = [
      [-1,-1,-1],[ 1,-1,-1],[ 1, 1,-1],[-1, 1,-1],
      [-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1],
    ].map(([x,y,z]) => [x*s, y*s, z*s]);

    // rotate around Y then X
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const cx = Math.cos(rotX), sx = Math.sin(rotX);

    const out = pts.map(([x,y,z]) => {
      // Y
      let x1 = x*cy + z*sy;
      let z1 = -x*sy + z*cy;
      // X
      let y2 = y*cx - z1*sx;
      let z2 = y*sx + z1*cx;
      // perspective
      const p = 520; // focal
      const k = p / (p + z2 + s*2.2);
      return [x1*k, y2*k, z2];
    });

    return out;
  }

  function drawCubeUI(bass, mid, high, rms){
    const t = performance.now() / 1000;

    // base position in center
    const cx = W*0.5;
    const cy = H*0.48;

    // cube size (UI): driven by params.space + audio pumping
    const base = 60 + params.space * 170;
    const pump = (bass*0.35 + rms*0.25) * 60;
    const size = base + pump;

    // store clickable area
    cube.cx = cx;
    cube.cy = cy;
    cube.r  = size * 0.95;

    const rotY = t * (0.35 + params.motion*1.0) + mid*0.9;
    const rotX = 0.7 + Math.sin(t*0.6)*0.2 + high*0.2;

    const pts = projectCube(size, rotY, rotX);

    // edges
    const edges = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7],
    ];

    g.save();
    g.translate(cx, cy);
    g.globalCompositeOperation = "lighter";

    // glow-ish alpha
    const a = 0.10 + high*0.18 + strobe*0.20;

    // outer halo ring to suggest “grab here”
    g.beginPath();
    g.arc(0,0, size*1.05, 0, Math.PI*2);
    g.strokeStyle = `rgba(255,255,255,${0.02 + a*0.35})`;
    g.lineWidth = 1;
    g.stroke();

    // cube lines
    g.strokeStyle = `rgba(255,255,255,${a})`;
    g.lineWidth = 1.6;

    for (const [i,j] of edges){
      const [x1,y1] = pts[i];
      const [x2,y2] = pts[j];
      g.beginPath();
      g.moveTo(x1,y1);
      g.lineTo(x2,y2);
      g.stroke();
    }

    // subtle “space” label without text (tick marks)
    const ticks = 18;
    g.strokeStyle = `rgba(255,255,255,${0.02 + a*0.22})`;
    for (let i=0;i<ticks;i++){
      const ang = (i/ticks)*Math.PI*2 + t*0.12;
      const r1 = size*1.12;
      const r2 = r1 + (i%3===0 ? 10 : 6);
      g.beginPath();
      g.moveTo(Math.cos(ang)*r1, Math.sin(ang)*r1);
      g.lineTo(Math.cos(ang)*r2, Math.sin(ang)*r2);
      g.stroke();
    }

    g.restore();
  }

  // ---------- Main render loop ----------
  function drawFrame(){
    if (!running) return;

    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);

    const bass = bandEnergy(0.00, 0.12);
    const mid  = bandEnergy(0.12, 0.45);
    const high = bandEnergy(0.45, 1.00);
    const rms  = waveformRMS();

    // idle autopilot: spatial drifts + space drifts (slow)
    const now = performance.now();
    const idle = (now - lastTouchMs) > 1400;

    if (idle){
      const t = now / 1000;

      // spatial drift
      const ax = Math.sin(t * (0.22 + high*0.18));
      const ay = Math.cos(t * (0.17 + bass*0.20));
      params.x = lerp(params.x, ax, 0.010);
      params.y = lerp(params.y, ay, 0.009);

      params.distance = clamp01(lerp(params.distance, (params.y + 1)*0.5, 0.010));
      params.width    = clamp01(lerp(params.width, Math.abs(params.x), 0.010));
      params.focus    = clamp01(lerp(params.focus, (params.x + 1)*0.5, 0.010));
      params.motion   = clamp01(lerp(params.motion, 0.14 + (1-params.distance)*0.86, 0.010));

      // space drift (very slow) + audio bias
      const targetSpace = 0.25 + (0.5 + 0.5*Math.sin(t*0.12)) * 0.55 + high*0.10;
      params.space = clamp01(lerp(params.space, targetSpace, 0.004));
    }

    // transient strobe
    flowT += 0.006 + params.motion*0.02 + high*0.01;
    const dRMS = rms - prevRMS;
    prevRMS = rms;
    if (dRMS > 0.035 + bass*0.03) strobe = Math.min(1, strobe + 0.85);
    strobe *= 0.86;

    // apply audio (tight coupling: visual == sound)
    applyAudio();

    // background persistence
    const fade = 0.18 + params.distance*0.28;
    g.fillStyle = `rgba(0,0,0,${fade})`;
    g.fillRect(0,0,W,H);

    if (strobe > 0.02){
      g.fillStyle = `rgba(255,255,255,${strobe*0.12})`;
      g.fillRect(0,0,W,H);
    }

    drawGrid(bass, high);
    drawParticles(bass, mid, high, rms);
    drawScope(bass, high, rms);
    drawScanlines(high);

    // CUBE UI on top (reverb space control)
    drawCubeUI(bass, mid, high, rms);

    requestAnimationFrame(drawFrame);
  }

  // ---------- Start ----------
  async function start(){
    if (running) return;
    running = true;

    try{
      logDebug("");
      setStatus("Loading…");

      ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();

      createMaster();
      reverb = createReverbBus();

      const [drumBuf, synthBuf] = await Promise.all([
        loadBuffer(FILES[0].url),
        loadBuffer(FILES[1].url),
      ]);

      stems = [
        buildStem(drumBuf,  -0.70),
        buildStem(synthBuf,  0.70),
      ];

      bindPointer();
      lastTouchMs = performance.now();

      applyAudio();
      setStatus("Playing — drag the cube for REVERB SPACE");
      overlay.style.display = "none";

      requestAnimationFrame(drawFrame);
    }catch(err){
      console.error(err);
      running = false;
      setStatus("Error");
      logDebug("ERR:\n" + (err?.stack || err?.message || String(err)));
      overlay.style.display = "flex";
    }
  }

  startBtn.addEventListener("click", start);
})();