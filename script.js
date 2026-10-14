/**
 * ENCODERLAB - INTERACTIVE ROTARY ENCODER SIMULATOR & EDUCATIONAL SUITE
 * Pure Vanilla JavaScript implementation with Canvas, Web Audio API, and Real-time QEI Engine.
 */

// ============================================================================
// SIMULATOR STATE & VARIABLES
// ============================================================================
const simState = {
  // Physical parameters
  angleRad: 0,           // Current angle in radians [0, 2*PI)
  totalAngleRad: 0,      // Cumulative angle including multiple turns
  ppr: 24,               // Physical slots per revolution (Pulses Per Revolution)
  
  // Decoding
  decodingMode: 'x2',    // 'x1', 'x2', 'x4'
  pulseCount: 0,         // Accumulated pulse counts
  revCount: 0,           // Complete 360 revolutions
  
  // Logical signals [0 or 1]
  channelA: 0,
  channelB: 0,
  channelZ: 0,
  prevChannelA: 0,
  prevChannelB: 0,
  
  // Motion & Motor
  isMotorRunning: false,
  motorRpm: 30,
  motorDirection: 1,     // +1 = CW, -1 = CCW
  currentDirection: 0,   // +1 = CW, -1 = CCW, 0 = Stopped
  lastMovementTime: 0,
  estimatedRpm: 0,
  estimatedHz: 0,
  
  // Drag interaction
  isDragging: false,
  lastDragAngle: 0,
  dragAngularVelocity: 0,
  
  // Sound
  audioEnabled: false,
  audioCtx: null
};

// Oscilloscope buffer (history of samples)
const SCOPE_BUFFER_LEN = 300;
const scopeHistory = {
  a: new Float32Array(SCOPE_BUFFER_LEN),
  b: new Float32Array(SCOPE_BUFFER_LEN),
  z: new Float32Array(SCOPE_BUFFER_LEN)
};

// ============================================================================
// CANVAS SETUP & SCALING (HIGH DPI)
// ============================================================================
const diskCanvas = document.getElementById('encoderDiskCanvas');
const diskCtx = diskCanvas.getContext('2d');

const scopeCanvas = document.getElementById('scopeCanvas');
const scopeCtx = scopeCanvas.getContext('2d');

function setupHighDpiCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}

// Adjust sizes on load and resize
function resizeCanvases() {
  setupHighDpiCanvas(diskCanvas, diskCtx);
  setupHighDpiCanvas(scopeCanvas, scopeCtx);
}

window.addEventListener('resize', resizeCanvases);

// ============================================================================
// WEB AUDIO API CLICK SOUND SYNTHESIZER
// ============================================================================
function initAudio() {
  if (!simState.audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      simState.audioCtx = new AudioContext();
    }
  }
  if (simState.audioCtx && simState.audioCtx.state === 'suspended') {
    simState.audioCtx.resume();
  }
}

function playEncoderClick() {
  if (!simState.audioEnabled || !simState.audioCtx) return;
  try {
    const t = simState.audioCtx.currentTime;
    const osc = simState.audioCtx.createOscillator();
    const gain = simState.audioCtx.createGain();
    
    // Snappy mechanical click sound
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.015);
    
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
    
    osc.connect(gain);
    gain.connect(simState.audioCtx.destination);
    
    osc.start(t);
    osc.stop(t + 0.016);
  } catch (e) {
    // Silently handle audio context restrictions
  }
}

function toggleAudio(enabled) {
  simState.audioEnabled = enabled;
  if (enabled) {
    initAudio();
  }
}

// ============================================================================
// QUADRATURE LOGIC & SIGNAL COMPUTATION
// ============================================================================
function updateEncoderSignals() {
  // Angular slot period in radians
  const slotPeriod = (2 * Math.PI) / simState.ppr;
  
  // Channel A: Base slotted track
  // Modulo of total angle within slot period
  const angleMod = ((simState.angleRad % slotPeriod) + slotPeriod) % slotPeriod;
  const newA = (angleMod < slotPeriod / 2) ? 1 : 0;
  
  // Channel B: Shifted by 90 electrical degrees (which is 1/4 of slot period)
  const shiftB = slotPeriod / 4;
  const angleModB = (((simState.angleRad + shiftB) % slotPeriod) + slotPeriod) % slotPeriod;
  const newB = (angleModB < slotPeriod / 2) ? 1 : 0;
  
  // Channel Z (Index Pulse): Single slot near 0 radians (angle width ~ 0.5 * slotPeriod)
  const zAngleWidth = slotPeriod * 0.45;
  const normAngle = ((simState.angleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const newZ = (normAngle < zAngleWidth || normAngle > (2 * Math.PI - zAngleWidth * 0.1)) ? 1 : 0;

  // QEI Direction and Transition Detection
  detectQuadratureTransition(newA, newB);

  // Update states
  simState.channelA = newA;
  simState.channelB = newB;
  simState.channelZ = newZ;
}

function detectQuadratureTransition(newA, newB) {
  const prevA = simState.prevChannelA;
  const prevB = simState.prevChannelB;

  if (newA === prevA && newB === prevB) {
    return; // No state change
  }

  // Direction State Matrix (Lookup)
  // States: 00 (0), 10 (2), 11 (3), 01 (1)
  const prevState = (prevA << 1) | prevB;
  const currState = (newA << 1) | newB;

  let dir = 0;
  // Clockwise transitions: 00->10 (0->2), 10->11 (2->3), 11->01 (3->1), 01->00 (1->0)
  if (
    (prevState === 0 && currState === 2) ||
    (prevState === 2 && currState === 3) ||
    (prevState === 3 && currState === 1) ||
    (prevState === 1 && currState === 0)
  ) {
    dir = 1; // CW
  }
  // Counter-Clockwise transitions: 00->01 (0->1), 01->11 (1->3), 11->10 (3->2), 10->00 (2->0)
  else if (
    (prevState === 0 && currState === 1) ||
    (prevState === 1 && currState === 3) ||
    (prevState === 3 && currState === 2) ||
    (prevState === 2 && currState === 0)
  ) {
    dir = -1; // CCW
  }

  if (dir !== 0) {
    simState.currentDirection = dir;
    simState.lastMovementTime = performance.now();

    // Pulse Counting based on Decoding Mode
    let shouldCount = false;
    if (simState.decodingMode === 'x4') {
      // Counts every single edge transition on A and B
      shouldCount = true;
    } else if (simState.decodingMode === 'x2') {
      // Counts rising and falling edges of Channel A only
      if (newA !== prevA) shouldCount = true;
    } else { // 'x1'
      // Counts only rising edges of Channel A
      if (prevA === 0 && newA === 1) shouldCount = true;
    }

    if (shouldCount) {
      simState.pulseCount += dir;
      playEncoderClick();
    }
  }

  simState.prevChannelA = newA;
  simState.prevChannelB = newB;
}

// ============================================================================
// RENDERING: ENCODER DISK CANVAS
// ============================================================================
function drawEncoderDisk() {
  const rect = diskCanvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const cx = width / 2;
  const cy = height / 2;
  const outerRadius = Math.min(cx, cy) - 18;

  diskCtx.clearRect(0, 0, width, height);

  // 1. Draw Stationary Outer Housing / Bezel
  diskCtx.save();
  diskCtx.beginPath();
  diskCtx.arc(cx, cy, outerRadius + 8, 0, 2 * Math.PI);
  diskCtx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
  diskCtx.lineWidth = 2;
  diskCtx.stroke();

  // Subtle outer ticks (stator graduation)
  for (let deg = 0; deg < 360; deg += 15) {
    const rad = (deg * Math.PI) / 180;
    const isMajor = deg % 45 === 0;
    const tickLen = isMajor ? 10 : 5;
    const r1 = outerRadius + 2;
    const r2 = outerRadius + 2 + tickLen;
    diskCtx.beginPath();
    diskCtx.moveTo(cx + Math.cos(rad) * r1, cy + Math.sin(rad) * r1);
    diskCtx.lineTo(cx + Math.cos(rad) * r2, cy + Math.sin(rad) * r2);
    diskCtx.strokeStyle = isMajor ? 'rgba(0, 240, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)';
    diskCtx.lineWidth = isMajor ? 1.5 : 1;
    diskCtx.stroke();
  }
  diskCtx.restore();

  // 2. Rotate Canvas to draw the Rotor (Disk)
  diskCtx.save();
  diskCtx.translate(cx, cy);
  diskCtx.rotate(simState.angleRad);

  // Disk Base (Glass / Smoked Chrome background)
  const diskGrad = diskCtx.createRadialGradient(0, 0, 20, 0, 0, outerRadius);
  diskGrad.addColorStop(0, '#1c2742');
  diskGrad.addColorStop(0.7, '#0d1424');
  diskGrad.addColorStop(1, '#080c16');
  diskCtx.fillStyle = diskGrad;
  diskCtx.beginPath();
  diskCtx.arc(0, 0, outerRadius, 0, 2 * Math.PI);
  diskCtx.fill();

  // 3. Draw Track A (Outer track: Slots)
  const rTrackA_Out = outerRadius - 10;
  const rTrackA_In = outerRadius - 38;
  const slotCount = simState.ppr;
  const slotAngle = (2 * Math.PI) / slotCount;

  for (let i = 0; i < slotCount; i++) {
    const startA = i * slotAngle;
    const endA = startA + slotAngle * 0.5; // 50% duty cycle

    diskCtx.beginPath();
    diskCtx.arc(0, 0, rTrackA_Out, startA, endA);
    diskCtx.arc(0, 0, rTrackA_In, endA, startA, true);
    diskCtx.closePath();
    diskCtx.fillStyle = 'rgba(0, 240, 255, 0.85)';
    diskCtx.shadowColor = 'rgba(0, 240, 255, 0.4)';
    diskCtx.shadowBlur = 6;
    diskCtx.fill();
    diskCtx.shadowBlur = 0;
  }

  // 4. Draw Track B (Inner track: Slots shifted by 90 deg electrical = 0.25 slot pitch)
  const rTrackB_Out = rTrackA_In - 8;
  const rTrackB_In = rTrackB_Out - 24;
  const shiftAngleB = slotAngle * 0.25;

  for (let i = 0; i < slotCount; i++) {
    const startB = i * slotAngle + shiftAngleB;
    const endB = startB + slotAngle * 0.5;

    diskCtx.beginPath();
    diskCtx.arc(0, 0, rTrackB_Out, startB, endB);
    diskCtx.arc(0, 0, rTrackB_In, endB, startB, true);
    diskCtx.closePath();
    diskCtx.fillStyle = 'rgba(0, 255, 136, 0.85)';
    diskCtx.shadowColor = 'rgba(0, 255, 136, 0.4)';
    diskCtx.shadowBlur = 6;
    diskCtx.fill();
    diskCtx.shadowBlur = 0;
  }

  // 5. Draw Track Z (Single Index Slot)
  const rTrackZ_Out = rTrackB_In - 8;
  const rTrackZ_In = rTrackZ_Out - 20;
  const zWidth = slotAngle * 0.45;

  diskCtx.beginPath();
  diskCtx.arc(0, 0, rTrackZ_Out, -zWidth / 2, zWidth / 2);
  diskCtx.arc(0, 0, rTrackZ_In, zWidth / 2, -zWidth / 2, true);
  diskCtx.closePath();
  diskCtx.fillStyle = 'rgba(255, 183, 3, 0.95)';
  diskCtx.shadowColor = 'rgba(255, 183, 3, 0.6)';
  diskCtx.shadowBlur = 8;
  diskCtx.fill();
  diskCtx.shadowBlur = 0;

  // 6. Draw Center Hub & Rotor Shaft
  const hubRadius = rTrackZ_In - 12;
  const hubGrad = diskCtx.createRadialGradient(0, 0, 0, 0, 0, hubRadius);
  hubGrad.addColorStop(0, '#475569');
  hubGrad.addColorStop(0.7, '#1e293b');
  hubGrad.addColorStop(1, '#0f172a');
  diskCtx.fillStyle = hubGrad;
  diskCtx.beginPath();
  diskCtx.arc(0, 0, hubRadius, 0, 2 * Math.PI);
  diskCtx.fill();
  diskCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  diskCtx.lineWidth = 2;
  diskCtx.stroke();

  // Reference Keyway / Arrow on hub
  diskCtx.beginPath();
  diskCtx.moveTo(0, -hubRadius + 6);
  diskCtx.lineTo(6, -hubRadius + 18);
  diskCtx.lineTo(-6, -hubRadius + 18);
  diskCtx.closePath();
  diskCtx.fillStyle = 'var(--ch-a)';
  diskCtx.fill();

  // Screws on hub
  for (let s = 0; s < 4; s++) {
    const sRad = (s * Math.PI) / 2 + Math.PI / 4;
    const sx = Math.cos(sRad) * (hubRadius * 0.6);
    const sy = Math.sin(sRad) * (hubRadius * 0.6);
    diskCtx.beginPath();
    diskCtx.arc(sx, sy, 3, 0, 2 * Math.PI);
    diskCtx.fillStyle = '#334155';
    diskCtx.fill();
  }

  // Shaft Center
  diskCtx.beginPath();
  diskCtx.arc(0, 0, 10, 0, 2 * Math.PI);
  diskCtx.fillStyle = '#090d16';
  diskCtx.fill();
  diskCtx.strokeStyle = '#38bdf8';
  diskCtx.lineWidth = 1.5;
  diskCtx.stroke();

  diskCtx.restore(); // Restore unrotated orientation

  // 7. Stationary Optical Reader Head (Fixed at 12 o'clock / Top position)
  drawOpticalHead(cx, cy, outerRadius);
}

function drawOpticalHead(cx, cy, outerRadius) {
  // Sensor head positioned at top (angle = -Math.PI / 2)
  const headWidth = 38;
  const headHeight = 90;
  const headX = cx - headWidth / 2;
  const headY = cy - outerRadius - 4;

  diskCtx.save();
  // Housing of reader
  diskCtx.fillStyle = 'rgba(15, 23, 42, 0.95)';
  diskCtx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
  diskCtx.lineWidth = 1.5;
  diskCtx.beginPath();
  diskCtx.roundRect(headX, headY, headWidth, headHeight, 6);
  diskCtx.fill();
  diskCtx.stroke();

  // LEDs / Photodiodes indicators on the reader head
  // Sensor A light
  const aY = headY + 16;
  diskCtx.beginPath();
  diskCtx.arc(cx, aY, 4, 0, 2 * Math.PI);
  diskCtx.fillStyle = simState.channelA ? '#00f0ff' : '#1e293b';
  diskCtx.fill();
  if (simState.channelA) {
    diskCtx.shadowColor = '#00f0ff';
    diskCtx.shadowBlur = 10;
    diskCtx.stroke();
    diskCtx.shadowBlur = 0;
  }

  // Sensor B light
  const bY = headY + 44;
  diskCtx.beginPath();
  diskCtx.arc(cx, bY, 4, 0, 2 * Math.PI);
  diskCtx.fillStyle = simState.channelB ? '#00ff88' : '#1e293b';
  diskCtx.fill();
  if (simState.channelB) {
    diskCtx.shadowColor = '#00ff88';
    diskCtx.shadowBlur = 10;
    diskCtx.stroke();
    diskCtx.shadowBlur = 0;
  }

  // Sensor Z light
  const zY = headY + 70;
  diskCtx.beginPath();
  diskCtx.arc(cx, zY, 4, 0, 2 * Math.PI);
  diskCtx.fillStyle = simState.channelZ ? '#ffaa00' : '#1e293b';
  diskCtx.fill();
  if (simState.channelZ) {
    diskCtx.shadowColor = '#ffaa00';
    diskCtx.shadowBlur = 10;
    diskCtx.stroke();
    diskCtx.shadowBlur = 0;
  }

  // Label
  diskCtx.fillStyle = '#64748b';
  diskCtx.font = '9px "JetBrains Mono", monospace';
  diskCtx.textAlign = 'center';
  diskCtx.fillText('SENSOR', cx, headY - 4);

  diskCtx.restore();
}

// ============================================================================
// RENDERING: OSCILLOSCOPE CANVAS (ROLLING WAVEFORMS)
// ============================================================================
function updateScopeBuffer() {
  // Shift buffer elements to the left
  for (let i = 0; i < SCOPE_BUFFER_LEN - 1; i++) {
    scopeHistory.a[i] = scopeHistory.a[i + 1];
    scopeHistory.b[i] = scopeHistory.b[i + 1];
    scopeHistory.z[i] = scopeHistory.z[i + 1];
  }
  // Push latest logic state to the end
  scopeHistory.a[SCOPE_BUFFER_LEN - 1] = simState.channelA;
  scopeHistory.b[SCOPE_BUFFER_LEN - 1] = simState.channelB;
  scopeHistory.z[SCOPE_BUFFER_LEN - 1] = simState.channelZ;
}

function drawOscilloscope() {
  const rect = scopeCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  scopeCtx.clearRect(0, 0, w, h);

  // Base oscilloscope background
  scopeCtx.fillStyle = '#040711';
  scopeCtx.fillRect(0, 0, w, h);

  // Heights for 3 channels
  const rowHeight = h / 3;
  const waveAmp = rowHeight * 0.55;

  const dx = w / (SCOPE_BUFFER_LEN - 1);

  // Helper function to draw digital square trace
  function drawDigitalTrace(data, baselineY, strokeColor, glowColor) {
    scopeCtx.save();
    scopeCtx.beginPath();
    
    for (let i = 0; i < SCOPE_BUFFER_LEN; i++) {
      const x = i * dx;
      const y = baselineY - (data[i] * waveAmp);
      
      if (i === 0) {
        scopeCtx.moveTo(x, y);
      } else {
        const prevY = baselineY - (data[i - 1] * waveAmp);
        if (prevY !== y) {
          // Sharp vertical transition
          scopeCtx.lineTo(x, prevY);
        }
        scopeCtx.lineTo(x, y);
      }
    }

    scopeCtx.strokeStyle = strokeColor;
    scopeCtx.lineWidth = 2.2;
    scopeCtx.lineCap = 'round';
    scopeCtx.lineJoin = 'miter';
    scopeCtx.shadowColor = glowColor;
    scopeCtx.shadowBlur = 8;
    scopeCtx.stroke();
    scopeCtx.restore();
  }

  // Draw 0V baseline dashed lines
  scopeCtx.save();
  scopeCtx.setLineDash([4, 4]);
  scopeCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  scopeCtx.lineWidth = 1;

  const yBaseA = rowHeight * 0.85;
  const yBaseB = rowHeight * 1.85;
  const yBaseZ = rowHeight * 2.85;

  scopeCtx.beginPath();
  scopeCtx.moveTo(0, yBaseA); scopeCtx.lineTo(w, yBaseA);
  scopeCtx.moveTo(0, yBaseB); scopeCtx.lineTo(w, yBaseB);
  scopeCtx.moveTo(0, yBaseZ); scopeCtx.lineTo(w, yBaseZ);
  scopeCtx.stroke();
  scopeCtx.restore();

  // Draw Channels
  drawDigitalTrace(scopeHistory.a, yBaseA, '#00f0ff', 'rgba(0, 240, 255, 0.6)');
  drawDigitalTrace(scopeHistory.b, yBaseB, '#00ff88', 'rgba(0, 255, 136, 0.6)');
  drawDigitalTrace(scopeHistory.z, yBaseZ, '#ffb703', 'rgba(255, 183, 3, 0.6)');

  // Draw real-time trigger cursor at the right edge
  scopeCtx.fillStyle = '#00f0ff';
  scopeCtx.beginPath();
  scopeCtx.moveTo(w - 6, yBaseA - (simState.channelA * waveAmp) - 4);
  scopeCtx.lineTo(w, yBaseA - (simState.channelA * waveAmp));
  scopeCtx.lineTo(w - 6, yBaseA - (simState.channelA * waveAmp) + 4);
  scopeCtx.fill();
}

// ============================================================================
// UI & TELEMETRY UPDATES
// ============================================================================
function updateTelemetryUI() {
  // Degrees: 0.0° to 359.9°
  const deg = ((((simState.angleRad * 180) / Math.PI) % 360) + 360) % 360;
  document.getElementById('telem-angle').textContent = `${deg.toFixed(1)}°`;

  // Revolutions count
  const revs = Math.floor(simState.totalAngleRad / (2 * Math.PI));
  document.getElementById('telem-revs').textContent = `Vueltas: ${revs}`;

  // Pulse count
  document.getElementById('telem-pulses').textContent = simState.pulseCount.toLocaleString();

  // Direction and movement status
  const now = performance.now();
  const dirEl = document.getElementById('telem-dir');
  const dirSubEl = document.getElementById('telem-dir-sub');

  if (now - simState.lastMovementTime > 250 && !simState.isMotorRunning) {
    simState.currentDirection = 0;
    dirEl.innerHTML = `<span class="idle-text">DETENIDO</span>`;
    dirSubEl.textContent = `Frecuencia: 0.0 Hz`;
  } else {
    if (simState.currentDirection === 1) {
      dirEl.innerHTML = `<span class="cw-text">HORARIO (CW ↻)</span>`;
    } else if (simState.currentDirection === -1) {
      dirEl.innerHTML = `<span class="ccw-text">ANTIHORARIO (CCW ↺)</span>`;
    }

    // Estimate Hz: PPR * (RPM / 60)
    const effectiveRpm = simState.isMotorRunning ? simState.motorRpm : Math.abs(simState.estimatedRpm);
    const hz = (simState.ppr * effectiveRpm) / 60;
    dirSubEl.textContent = `Frecuencia: ~${hz.toFixed(1)} Hz (${Math.round(effectiveRpm)} RPM)`;
  }

  // Logical Bits Display
  const bitA = document.getElementById('bit-a');
  const bitB = document.getElementById('bit-b');
  const bitZ = document.getElementById('bit-z');

  bitA.querySelector('strong').textContent = simState.channelA;
  bitB.querySelector('strong').textContent = simState.channelB;
  bitZ.querySelector('strong').textContent = simState.channelZ;

  bitA.classList.toggle('high', simState.channelA === 1);
  bitB.classList.toggle('high', simState.channelB === 1);
  bitZ.classList.toggle('high', simState.channelZ === 1);

  // Photodiode live bar
  const sensA = document.getElementById('sensor-indicator-a');
  const sensB = document.getElementById('sensor-indicator-b');
  const sensZ = document.getElementById('sensor-indicator-z');

  sensA.classList.toggle('active-a', simState.channelA === 1);
  document.getElementById('sensor-val-a').textContent = simState.channelA ? 'Paso de luz (5V HIGH)' : 'Bloqueado (0V LOW)';

  sensB.classList.toggle('active-b', simState.channelB === 1);
  document.getElementById('sensor-val-b').textContent = simState.channelB ? 'Paso de luz (5V HIGH)' : 'Bloqueado (0V LOW)';

  sensZ.classList.toggle('active-z', simState.channelZ === 1);
  document.getElementById('sensor-val-z').textContent = simState.channelZ ? 'En muesca INDEX (5V HIGH)' : 'Fuera de muesca (0V LOW)';

  // Phase Quadrant Diagram Active state
  updatePhaseDiagram(simState.channelA, simState.channelB);
}

function updatePhaseDiagram(a, b) {
  const q00 = document.getElementById('quad-00');
  const q10 = document.getElementById('quad-10');
  const q11 = document.getElementById('quad-11');
  const q01 = document.getElementById('quad-01');
  const needle = document.getElementById('phase-needle');
  const caption = document.getElementById('current-state-caption');

  q00.classList.remove('active');
  q10.classList.remove('active');
  q11.classList.remove('active');
  q01.classList.remove('active');

  let stateStr = '';
  let angle = 0;

  if (a === 0 && b === 0) {
    q00.classList.add('active');
    stateStr = 'A=0, B=0 (00)';
    angle = 225;
  } else if (a === 1 && b === 0) {
    q10.classList.add('active');
    stateStr = 'A=1, B=0 (10)';
    angle = 315;
  } else if (a === 1 && b === 1) {
    q11.classList.add('active');
    stateStr = 'A=1, B=1 (11)';
    angle = 45;
  } else {
    q01.classList.add('active');
    stateStr = 'A=0, B=1 (01)';
    angle = 135;
  }

  needle.style.transform = `rotate(${angle}deg)`;
  caption.innerHTML = `Estado actual: <strong>${stateStr}</strong>`;
}

// ============================================================================
// SIMULATION LOOP
// ============================================================================
let lastFrameTime = performance.now();

function simulationLoop(currentTime) {
  const dt = (currentTime - lastFrameTime) / 1000; // in seconds
  lastFrameTime = currentTime;

  // 1. Motor Auto-rotation
  if (simState.isMotorRunning) {
    // motorRpm -> rad/s = RPM * 2*PI / 60
    const angularSpeed = (simState.motorRpm * 2 * Math.PI) / 60;
    const deltaAngle = angularSpeed * dt * simState.motorDirection;

    simState.angleRad = (simState.angleRad + deltaAngle) % (2 * Math.PI);
    simState.totalAngleRad += deltaAngle;
    updateEncoderSignals();
  }
  // 2. Drag Inertia after release
  else if (!simState.isDragging && Math.abs(simState.dragAngularVelocity) > 0.005) {
    simState.angleRad = (simState.angleRad + simState.dragAngularVelocity * dt) % (2 * Math.PI);
    simState.totalAngleRad += simState.dragAngularVelocity * dt;
    simState.dragAngularVelocity *= Math.pow(0.05, dt); // friction damping
    updateEncoderSignals();
  }

  // Keep positive angle representation
  if (simState.angleRad < 0) {
    simState.angleRad += 2 * Math.PI;
  }

  // Update buffers & render
  updateScopeBuffer();
  drawEncoderDisk();
  drawOscilloscope();
  updateTelemetryUI();

  requestAnimationFrame(simulationLoop);
}

// ============================================================================
// INTERACTIVE DRAGGING / TOUCH HANDLING
// ============================================================================
const diskWrapper = document.getElementById('disk-container');

function getAngleFromEvent(e) {
  const rect = diskWrapper.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return Math.atan2(clientY - cy, clientX - cx);
}

function startDrag(e) {
  simState.isDragging = true;
  simState.lastDragAngle = getAngleFromEvent(e);
  simState.dragAngularVelocity = 0;
  initAudio();
  
  // Hide drag hint on first drag
  const hint = document.getElementById('drag-hint');
  if (hint) hint.style.opacity = '0';
}

function handleDrag(e) {
  if (!simState.isDragging) return;
  e.preventDefault();

  const currentAngle = getAngleFromEvent(e);
  let deltaAngle = currentAngle - simState.lastDragAngle;

  // Handle -PI to +PI wrapping
  if (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
  if (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;

  simState.angleRad = (simState.angleRad + deltaAngle) % (2 * Math.PI);
  simState.totalAngleRad += deltaAngle;
  simState.dragAngularVelocity = deltaAngle * 60; // Approximate velocity
  simState.lastDragAngle = currentAngle;

  // Estimate RPM from drag velocity
  simState.estimatedRpm = (deltaAngle / 0.016) * (60 / (2 * Math.PI));

  updateEncoderSignals();
}

function endDrag() {
  simState.isDragging = false;
}

diskWrapper.addEventListener('mousedown', startDrag);
window.addEventListener('mousemove', handleDrag);
window.addEventListener('mouseup', endDrag);

diskWrapper.addEventListener('touchstart', startDrag, { passive: false });
window.addEventListener('touchmove', handleDrag, { passive: false });
window.addEventListener('touchend', endDrag);

// ============================================================================
// USER CONTROLS: MOTOR, SPEED, PPR, MULTIPLIER
// ============================================================================
function toggleMotor() {
  initAudio();
  simState.isMotorRunning = !simState.isMotorRunning;
  const motorBtn = document.getElementById('motor-toggle-btn');
  const led = document.getElementById('disk-status-led');

  if (simState.isMotorRunning) {
    motorBtn.classList.add('active');
    motorBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
      <span>Detener Motor</span>
    `;
    led.textContent = 'MOTOR ACTIVO';
    led.classList.add('running');
  } else {
    motorBtn.classList.remove('active');
    motorBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 21 5 3"></polygon></svg>
      <span>Motor Auto-Giro</span>
    `;
    led.textContent = 'INACTIVO';
    led.classList.remove('running');
  }
}

function toggleMotorDirection() {
  simState.motorDirection *= -1;
}

function updateMotorSpeed(val) {
  simState.motorRpm = parseFloat(val);
  document.getElementById('speed-label').textContent = `${val} RPM`;
}

function changePPR(val) {
  simState.ppr = parseInt(val, 10);
  recalcResolution();
}

function resetEncoderCounters() {
  simState.angleRad = 0;
  simState.totalAngleRad = 0;
  simState.pulseCount = 0;
  updateEncoderSignals();
}

function setDecodingMode(mode) {
  simState.decodingMode = mode;
  document.querySelectorAll('.mult-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  recalcResolution();
}

function recalcResolution() {
  let multiplier = 2;
  if (simState.decodingMode === 'x1') multiplier = 1;
  if (simState.decodingMode === 'x4') multiplier = 4;

  const totalCpr = simState.ppr * multiplier;
  const angleRes = (360 / totalCpr).toFixed(2);

  document.getElementById('calc-base-ppr').textContent = `${simState.ppr} PPR`;
  document.getElementById('calc-multiplier').textContent = `x${multiplier}`;
  document.getElementById('calc-total-cpr').textContent = `${totalCpr} Cuentas (CPR)`;
  document.getElementById('calc-angle-res').textContent = `${angleRes}° por cuenta`;
  document.getElementById('telem-cpr-sub').textContent = `Modo ${simState.decodingMode.toUpperCase()} (${totalCpr} CPR)`;
}

// ============================================================================
// GRAY CODE VS NATURAL BINARY DEMO
// ============================================================================
const GRAY_TABLE = [
  { step: 0, bin: "0 0 0", gray: "0 0 0", glitch: "Base cero" },
  { step: 1, bin: "0 0 1", gray: "0 0 1", glitch: "Cambia 1 bit (normal)" },
  { step: 2, bin: "0 1 0", gray: "0 1 1", glitch: "⚠️ En binario: conmutan 2 bits (b0 y b1)" },
  { step: 3, bin: "0 1 1", gray: "0 1 0", glitch: "Cambia 1 bit" },
  { step: 4, bin: "1 0 0", gray: "1 1 0", glitch: "🚨 ¡CRÍTICO! En binario cambian los 3 bits simultáneamente (011 -> 100)" },
  { step: 5, bin: "1 0 1", gray: "1 1 1", glitch: "Cambia 1 bit" },
  { step: 6, bin: "1 1 0", gray: "1 0 1", glitch: "⚠️ En binario: conmutan 2 bits simultáneamente" },
  { step: 7, bin: "1 1 1", gray: "1 0 0", glitch: "Cambia 1 bit" },
];

function updateGrayInteractive(val) {
  const idx = parseInt(val, 10);
  const data = GRAY_TABLE[idx];

  document.getElementById('gray-pos-num').textContent = `Posición: ${idx}`;
  document.getElementById('natural-binary-bits').textContent = data.bin;
  document.getElementById('gray-code-bits').textContent = data.gray;
  document.getElementById('bin-glitch-warning').textContent = data.glitch;
}

// ============================================================================
// RECOMMENDATION WIZARD ENGINE
// ============================================================================
function calculateRecommendation() {
  const motion = document.getElementById('wiz-motion').value;
  const memory = document.getElementById('wiz-memory').value;
  const env = document.getElementById('wiz-env').value;

  const resultBox = document.getElementById('wizard-result');
  const titleEl = document.getElementById('res-title');
  const expEl = document.getElementById('res-explanation');
  const tagsEl = document.getElementById('res-tags');

  resultBox.classList.remove('hidden');

  let title = '';
  let exp = '';
  let tags = [];

  if (motion === 'linear') {
    if (env === 'harsh') {
      title = 'Regla Lineal Magnética Sellada (IP67) con Salida Digital SSI';
      exp = 'Para aplicaciones lineales en entornos con virutas, polvo o refrigerantes, las reglas ópticas pueden ensuciarse rápidamente. Una cinta magnética protegida por fleje de acero inoxidable y cabezal magnetoresistivo resiste fluidos y vibraciones extremas.';
      tags = ['Tecnología Magnética', 'Grado IP67/IP69K', 'Encoder Lineal', 'Protocolo SSI'];
    } else {
      title = 'Encoder Óptico Lineal de Cristal (Escala Lineal de Alta Precisión)';
      exp = 'Ideal para mesas de coordenadas, máquinas CNC de precisión y metrología. La escala de vidrio proporciona exactitud micrométrica (< 1 µm) e inmunidad térmica cuando se mantiene en un entorno limpio.';
      tags = ['Óptico de Vidrio', 'Resolución < 1 µm', 'Line Driver RS-422', 'Salida Diferencial'];
    }
  } else {
    // Rotary
    if (memory === 'critical') {
      if (env === 'harsh') {
        title = 'Encoder Rotativo Absoluto Multivuelta Magnético (EtherCAT / Profinet)';
        exp = 'La combinación perfecta de invulnerabilidad ambiental y memoria de posición permanente. Sin engranajes frágiles de vidrio, conserva la posición exacta de giro y cuenta vueltas completas mediante tecnología Wiegand o batería de respaldo.';
        tags = ['Absoluto Multivuelta', 'Tecnología Magnética', 'Bus Industrial EtherCAT', 'Robusto'];
      } else {
        title = 'Encoder Rotativo Absoluto Óptico Multivuelta (Protocolo BiSS-C / SSI)';
        exp = 'La elección de máxima precisión para articulaciones robóticas y servomotores de alta gama. Su disco óptico multivuelta lee instantáneamente la posición angular tras el encendido sin necesidad de rutinas de calibración ni homing.';
        tags = ['Absoluto Óptico', 'Ultra Alta Resolución (24-bit)', 'Protocolo BiSS-C', 'Cero Errores'];
      }
    } else {
      // Incremental
      if (env === 'harsh') {
        title = 'Encoder Rotativo Incremental Magnético Blindado (Push-Pull / HTL 24V)';
        exp = 'Solución de excelente relación costo-beneficio para motores en plantas industriales agresivas. Su salida a 24V HTL ofrece alto margen de ruido contra perturbaciones de variadores de frecuencia (VFD).';
        tags = ['Incremental Magnético', 'Salida HTL 24V', 'Económico y Fuerte', 'A prueba de Polvo'];
      } else {
        title = 'Encoder Rotativo Incremental Óptico Line Driver (RS-422, A/B/Z)';
        exp = 'El clásico estándar industrial por excelencia. Ideal para lazo cerrado en motores paso a paso y servocontroladores. La transmisión diferencial (A, /A, B, /B, Z, /Z) cancela interferencias en tiradas de cable de hasta 100 metros.';
        tags = ['Óptico Incremental', 'Line Driver RS-422', 'Cuadratura x4', 'Canal Índice Z'];
      }
    }
  }

  titleEl.textContent = title;
  expEl.textContent = exp;

  tagsEl.innerHTML = '';
  tags.forEach(t => {
    const span = document.createElement('span');
    span.className = 'res-tag-item';
    span.textContent = t;
    tagsEl.appendChild(span);
  });

  resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================================
// INTERACTIVE QUIZ ENGINE
// ============================================================================
const QUIZ_DATA = [
  {
    q: "¿Por qué los canales A y B de un encoder incremental están desfasados 90 grados eléctricos?",
    options: [
      "Para duplicar el voltaje de salida a 10V.",
      "Para poder determinar el sentido de giro (horario o antihorario) y multiplicar la resolución.",
      "Para que un canal funcione si el otro se quema.",
      "Para transmitir datos en protocolo serie RS-232."
    ],
    correct: 1,
    explanation: "¡Exacto! El desfase de 90° (cuadratura) permite que un canal se adelante al otro según el sentido físico de giro, facilitando además la multiplicación de pulsos x2 o x4."
  },
  {
    q: "¿Cuál es la función principal del Canal Z (o pulso Índice)?",
    options: [
      "Marcar un pulso único por cada revolución completa de 360° para definir el cero o referencia.",
      "Alimentar de energía a los fototransistores.",
      "Medir la temperatura interna del rodamiento.",
      "Indicar un corto circuito en el cable de señal."
    ],
    correct: 0,
    explanation: "¡Correcto! El pulso Z se emite una sola vez por vuelta y sirve para sincronizar el sistema con el 'Cero Máquina' o punto de referencia absoluto."
  },
  {
    q: "¿Qué ocurre con un encoder incremental cuando se interrumpe la energía eléctrica?",
    options: [
      "Guarda su posición en una memoria flash interna para siempre.",
      "Pierde su posición actual y requiere una rutina de búsqueda de origen (homing) al reiniciar.",
      "Continúa transmitiendo pulsos con energía residual durante días.",
      "Se bloquea mecánicamente el eje con un freno magnético."
    ],
    correct: 1,
    explanation: "¡Así es! Los encoders incrementales solo cuentan pasos relativos. Si la máquina se apaga y el eje se mueve, al reiniciar estará ciega hasta que realice 'homing'."
  },
  {
    q: "¿Por qué los encoders absolutos utilizan Código Gray en lugar de Código Binario Natural en sus discos?",
    options: [
      "Porque el código Gray ocupa menos espacio físico en el disco.",
      "Porque en el código Gray solo cambia un único bit entre números consecutivos, evitando glitches y lecturas erráticas.",
      "Porque el código Gray es más veloz que la velocidad de la luz.",
      "Porque los microcontroladores no entienden binario ordinario."
    ],
    correct: 1,
    explanation: "¡Brillante! En el código binario natural pueden conmutar varios bits a la vez (ej. 3 a 4 cambia 3 bits). Las imperfecciones mecánicas causarían lecturas espurias catastróficas. El código Gray previene esto al cambiar un único bit por paso."
  },
  {
    q: "¿Qué tecnología de sensado es más recomendable para una máquina donde hay mucho aceite, polvo y vibración severa?",
    options: [
      "Encoder Óptico con disco de cristal ultra delgado.",
      "Encoder Magnético con sensor Hall/AMR sellado herméticamente.",
      "Encoder de contacto de carbón abierto.",
      "Encoder óptico sin carcasa protectora."
    ],
    correct: 1,
    explanation: "¡Muy bien! Los encoders magnéticos no tienen componentes ópticos que se ensucien ni discos de cristal que puedan romperse con impactos, ofreciendo protección IP67/IP69K."
  }
];

let quizCurrentIdx = 0;
let quizScore = 0;

function renderQuizQuestion() {
  const qData = QUIZ_DATA[quizCurrentIdx];
  document.getElementById('quiz-current-num').textContent = quizCurrentIdx + 1;
  document.getElementById('quiz-progress-fill').style.width = `${((quizCurrentIdx + 1) / QUIZ_DATA.length) * 100}%`;
  document.getElementById('quiz-q-text').textContent = qData.q;

  const optContainer = document.getElementById('quiz-options');
  optContainer.innerHTML = '';

  const feedbackEl = document.getElementById('quiz-feedback');
  feedbackEl.className = 'quiz-feedback hidden';
  feedbackEl.innerHTML = '';

  const nextBtn = document.getElementById('quiz-next-btn');
  nextBtn.classList.add('hidden');

  qData.options.forEach((optText, i) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-opt-btn';
    btn.textContent = optText;
    btn.onclick = () => selectQuizAnswer(i, btn);
    optContainer.appendChild(btn);
  });
}

function selectQuizAnswer(chosenIdx, chosenBtn) {
  const qData = QUIZ_DATA[quizCurrentIdx];
  const allBtns = document.querySelectorAll('.quiz-opt-btn');
  allBtns.forEach(b => b.disabled = true);

  const feedbackEl = document.getElementById('quiz-feedback');
  feedbackEl.classList.remove('hidden');

  if (chosenIdx === qData.correct) {
    quizScore++;
    chosenBtn.classList.add('correct');
    feedbackEl.className = 'quiz-feedback success';
    feedbackEl.innerHTML = `<strong>¡Respuesta Correcta!</strong> ${qData.explanation}`;
  } else {
    chosenBtn.classList.add('wrong');
    allBtns[qData.correct].classList.add('correct');
    feedbackEl.className = 'quiz-feedback error';
    feedbackEl.innerHTML = `<strong>Incorrecto.</strong> ${qData.explanation}`;
  }

  const nextBtn = document.getElementById('quiz-next-btn');
  nextBtn.classList.remove('hidden');
}

function nextQuizQuestion() {
  quizCurrentIdx++;
  if (quizCurrentIdx < QUIZ_DATA.length) {
    renderQuizQuestion();
  } else {
    // Show Final Score
    document.getElementById('quiz-question-card').classList.add('hidden');
    const finalScoreBox = document.getElementById('quiz-final-score');
    finalScoreBox.classList.remove('hidden');

    document.getElementById('score-circle').textContent = `${quizScore}/${QUIZ_DATA.length}`;
    const titleEl = document.getElementById('score-title');
    const descEl = document.getElementById('score-desc');

    if (quizScore === 5) {
      titleEl.textContent = '¡Maestría Total en Encoders!';
      descEl.textContent = 'Has respondido todas las preguntas a la perfección. Conoces la cuadratura, el código Gray y el diseño de lazo cerrado como un verdadero ingeniero.';
    } else if (quizScore >= 3) {
      titleEl.textContent = '¡Muy Buen Trabajo!';
      descEl.textContent = 'Tienes bases muy sólidas sobre cómo operan los encoders ópticos, magnéticos y sus señales.';
    } else {
      titleEl.textContent = 'Sigue Practicando';
      descEl.textContent = 'Te recomendamos repasar el simulador interactivo y la sección de cuadratura para reforzar los conceptos.';
    }
  }
}

function restartQuiz() {
  quizCurrentIdx = 0;
  quizScore = 0;
  document.getElementById('quiz-final-score').classList.add('hidden');
  document.getElementById('quiz-question-card').classList.remove('hidden');
  renderQuizQuestion();
}

// ============================================================================
// INITIALIZATION ON PAGE LOAD
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  resizeCanvases();
  updateEncoderSignals();
  recalcResolution();
  renderQuizQuestion();
  updateGrayInteractive(3);

  // Initialize oscilloscope with zeroes
  for (let i = 0; i < SCOPE_BUFFER_LEN; i++) {
    scopeHistory.a[i] = 0;
    scopeHistory.b[i] = 0;
    scopeHistory.z[i] = 0;
  }

  // Start continuous animation loop
  requestAnimationFrame(simulationLoop);
});
