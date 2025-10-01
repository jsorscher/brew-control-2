// main.js - Pour-over brew tracker prototype
// Assumptions:
// - OpenCV.js is loaded and exposes `cv`.
// - apriltag-js is available as `AprilTag` or window.AprilTagDetector (replace as necessary).
// - A seven-seg OCR function `readSevenSeg(imageData)` exists (placeholder provided in index.html).
// This prototype focuses on demonstrating the pipeline; replace placeholders with real libs for production.

let video = document.getElementById('video');
let overlay = document.getElementById('overlay');
let overlayCtx = overlay.getContext('2d');
let startBtn = document.getElementById('startBtn');
let stopBtn = document.getElementById('stopBtn');
let calibrateBtn = document.getElementById('calibrateBtn');
let exportBtn = document.getElementById('exportBtn');
let manualScaleInput = document.getElementById('manualScale');
let logEl = document.getElementById('log');
let chartCanvas = document.getElementById('chart');
let fullscreenBtn = document.getElementById('fullscreenBtn');

// State
let stream = null;
let running = false;
let cap = null; // OpenCV VideoCapture
let detector = null; // AprilTag detector
let lastGray = null;
let flowProxyHistory = []; // [{t, proxy}]
let integratedMassHistory = []; // [{t, mass}]
let scaleReads = []; // [{t, mass}]
let smoothProxy = []; // smoothed proxy values
let calibration = { slope: 1, offset: 0 };
let chart = null;

// Parameters
const FPS = 15;
const PROXY_SMOOTH_WINDOW = 5; // moving average window

function log(msg) {
  let time = new Date().toISOString();
  logEl.textContent += `\n[${time}] ${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

// Page controls
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
calibrateBtn.addEventListener('click', calibrate);
exportBtn.addEventListener('click', exportCSV);

async function start() {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Access camera
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    log('Camera error: ' + e.message);
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  // Resize overlay to match video
  resizeCanvases();

  // Initialize OpenCV VideoCapture
  cap = new cv.VideoCapture(video);

  // Initialize AprilTag detector if available
  try {
    if (window.AprilTag && window.AprilTag.Detector) {
      detector = new window.AprilTag.Detector();
      log('AprilTag detector initialized');
    } else if (window.apriltag && window.apriltag.detect) {
      detector = window.apriltag; // adapt usage below
      log('AprilTag (alt) detector ready');
    } else {
      log('AprilTag library not found; marker detection will not work until added');
    }
  } catch (e) {
    log('AprilTag init error: ' + e.message);
  }

  // Initialize lastGray and the chart, then start processing
  lastGray = new cv.Mat();
  if (!chart) initializeChart();
  processLoop();
}

function stop() {
  if (!running) return;
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (lastGray) { lastGray.delete(); lastGray = null; }
  if (cap) { cap = null; }
  log('Stopped');
}

// Resize overlay and chart canvases to match video size and devicePixelRatio
function resizeCanvases() {
  if (!video || !video.videoWidth) return;
  let dpr = window.devicePixelRatio || 1;
  // set canvas CSS size to video display size
  overlay.style.width = video.clientWidth + 'px';
  overlay.style.height = video.clientHeight + 'px';
  // set backing store size for crisp drawing
  overlay.width = Math.floor(video.clientWidth * dpr);
  overlay.height = Math.floor(video.clientHeight * dpr);
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// fullscreen toggle for video container
fullscreenBtn && fullscreenBtn.addEventListener('click', () => {
  let container = video.parentElement;
  if (!document.fullscreenElement) container.requestFullscreen?.(); else document.exitFullscreen?.();
});

// handle resize and orientation change
window.addEventListener('resize', () => { setTimeout(resizeCanvases, 120); });
window.addEventListener('orientationchange', () => { setTimeout(resizeCanvases, 200); });

async function processLoop() {
  if (!running) return;
  let t0 = performance.now();

  // Read frame
  let src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
  cap.read(src);

  // Convert to gray
  let gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Detect marker (AprilTag) and compute ROI. The ROI is computed relative to the detected
  // marker corners so it follows the kettle spout regardless of where the tag is placed.
  let tag = detectTag(src, gray);
  let roiRect = null;
  if (tag) {
    roiRect = computeROIFromTag(tag, src.cols, src.rows);
  } else {
    // fallback: ROI center-bottom near video center
    let w = Math.floor(src.cols * 0.12);
    let h = Math.floor(src.rows * 0.2);
    roiRect = { x: Math.floor(src.cols / 2 - w / 2), y: Math.floor(src.rows * 0.4), w, h };
  }

  // Draw overlay: tag corners and ROI
  // Clear using CSS pixel coords (ctx is scaled by DPR)
  overlayCtx.clearRect(0,0,overlay.width,overlay.height);
  overlayCtx.strokeStyle = 'lime';
  overlayCtx.lineWidth = 2;
  if (tag) {
    overlayCtx.beginPath();
    tag.corners.forEach((pt,i) => {
      if (i===0) overlayCtx.moveTo(pt.x, pt.y); else overlayCtx.lineTo(pt.x, pt.y);
      // draw corner
      overlayCtx.fillStyle = 'red'; overlayCtx.fillRect(pt.x-3,pt.y-3,6,6);
    });
    overlayCtx.closePath();
    overlayCtx.stroke();
  }
  // ROI box
  overlayCtx.strokeStyle = 'cyan';
  overlayCtx.strokeRect(roiRect.x, roiRect.y, roiRect.w, roiRect.h);

  // Flow proxy: frame differencing inside ROI. This produces a scalar proportional to
  // the amount of motion in the ROI (useful as a proxy for water flow).
  let proxy = computeFlowProxy(gray, roiRect);

  // Smooth proxy with a short moving average to reduce noise.
  smoothProxy.push(proxy);
  if (smoothProxy.length > PROXY_SMOOTH_WINDOW) smoothProxy.shift();
  let smooth = smoothProxy.reduce((a,b)=>a+b,0)/smoothProxy.length;

  // Timestamp
  let t = Date.now()/1000;
  flowProxyHistory.push({ t, proxy: smooth });

  // Integrate proxy over time to estimate mass (raw units)
  let integrated = integrateProxy(flowProxyHistory);
  // Apply calibration to get grams: mass = slope * integrated + offset
  let mass_g = calibration.slope * integrated + calibration.offset;
  integratedMassHistory.push({ t, mass: mass_g });

  // Scale reading via SSOCR on scale area (assume scale is bottom-right small box) or manual input.
  // The function `readSevenSeg` is a placeholder provided in `index.html` and should be
  // replaced with a real seven-segment OCR implementation.
  let scaleRead = await readScaleIfAvailable(src);
  if (!isNaN(parseFloat(manualScaleInput.value))) {
    let m = parseFloat(manualScaleInput.value);
    scaleReads.push({ t, mass: m });
    log(`Manual scale input ${m} g`);
  } else if (scaleRead && !isNaN(scaleRead.value)) {
    scaleReads.push({ t, mass: scaleRead.value });
    log(`Scale OCR ${scaleRead.value} g (conf ${scaleRead.confidence})`);
  }

  // Update chart
  updateChart();

  // Save for next iteration
  if (lastGray && !lastGray.isDeleted()) lastGray.delete();
  lastGray = gray;
  src.delete();

  // Schedule next frame
  let elapsed = performance.now() - t0;
  let delay = Math.max(0, 1000 / FPS - elapsed);
  setTimeout(() => { if (running) requestAnimationFrame(processLoop); }, delay);
}

// Detect AprilTag in the frame. Returns a tag object with `corners` (array of {x,y}) and pose if available.
function detectTag(srcRGBA, gray) {
  if (!detector) return null;
  try {
    // Convert gray Mat to ImageData for JS detector
    let img = new ImageData(new Uint8ClampedArray(gray.data), gray.cols, gray.rows);
  if (detector.detect) {
      // apriltag-js API expects {data, width, height}
      let detections = detector.detect(img.data, img.width, img.height);
  if (detections && detections.length) {
        // Return first detection
        let d = detections[0];
        // map corners to {x,y}
        let corners = d.corners.map(c => ({ x: c[0], y: c[1] }));
        return { corners, id: d.id, detection: d };
      }
    } else if (window.AprilTag && window.AprilTag.Detector) {
      // Example usage when using module API (adapt as needed)
      let dt = detector.detect(gray.data, gray.cols, gray.rows);
      if (dt && dt.length) {
    let d = dt[0];
    // adapt detectors that return corners as objects
    let corners = d.corners.map(c => (Array.isArray(c) ? ({ x: c[0], y: c[1] }) : ({ x: c.x, y: c.y })));
        return { corners, id: d.id, detection: d };
      }
    }
  } catch (e) {
    log('Tag detect error: ' + e.message);
  }
  return null;
}

// Compute a ROI rectangle positioned relative to the detected tag. The ROI is placed at the spout direction.
// Approach: compute marker center and short axis for orientation, then offset ROI along marker's 'edge' pointing to spout.
function computeROIFromTag(tag, frameW, frameH) {
  // Compute center
  let cx = (tag.corners[0].x + tag.corners[1].x + tag.corners[2].x + tag.corners[3].x)/4;
  let cy = (tag.corners[0].y + tag.corners[1].y + tag.corners[2].y + tag.corners[3].y)/4;

  // Compute vector from corner0 to corner1 as marker local X axis
  let v0 = { x: tag.corners[1].x - tag.corners[0].x, y: tag.corners[1].y - tag.corners[0].y };
  // Normalized
  let mag = Math.hypot(v0.x, v0.y) || 1;
  v0.x /= mag; v0.y /= mag;
  // Perpendicular (approx marker Y axis)
  let vPerp = { x: -v0.y, y: v0.x };

  // Assume spout is roughly offset along the perpendicular direction from marker center;
  // choose ROI center offset = center + vPerp * offsetFactor * markerSize
  let markerSize = mag; // scale factor in pixels
  // offsetFactor controls how far from the marker center the ROI is placed along the
  // perpendicular direction. The sign assumes the spout is on a consistent side of the tag;
  // users can flip sign if orientation differs.
  let offsetFactor = -2.0; // negative to point roughly 'up' from marker; may be adjusted
  let roiCenter = { x: cx + vPerp.x * markerSize * offsetFactor, y: cy + vPerp.y * markerSize * offsetFactor };

  // ROI size relative to marker size
  let w = Math.floor(markerSize * 0.8);
  let h = Math.floor(markerSize * 1.6);

  // Place ROI so its top-left is centered around roiCenter
  let x = Math.max(0, Math.floor(roiCenter.x - w/2));
  let y = Math.max(0, Math.floor(roiCenter.y - h/2));
  // clamp
  if (x + w > frameW) w = frameW - x;
  if (y + h > frameH) h = frameH - y;
  return { x, y, w, h };
}

// Compute flow proxy using simple frame differencing within ROI.
// Returns a single scalar proportional to motion magnitude.
function computeFlowProxy(gray, roi) {
  if (!lastGray || lastGray.cols !== gray.cols || lastGray.rows !== gray.rows) {
    return 0;
  }
  // Crop ROI from current and last
  let r = new cv.Rect(roi.x, roi.y, roi.w, roi.h);
  let cur = gray.roi(r);
  let prev = lastGray.roi(r);
  let diff = new cv.Mat();
  cv.absdiff(cur, prev, diff);
  // Threshold to remove small noise
  let thresh = new cv.Mat();
  cv.threshold(diff, thresh, 25, 255, cv.THRESH_BINARY);
  // Sum non-zero pixels
  let nonZero = cv.countNonZero(thresh);

  // cleanup
  cur.delete(); prev.delete(); diff.delete(); thresh.delete();

  // Normalize by ROI area
  let area = roi.w * roi.h || 1;
  let proxy = nonZero / area; // 0..1
  return proxy;
}

// Simple integration of proxy over time using trapezoidal rule (assumes uniform-ish sampling)
function integrateProxy(history) {
  if (history.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < history.length; i++) {
    let dt = history[i].t - history[i-1].t;
    let avg = (history[i].proxy + history[i-1].proxy)/2;
    total += avg * dt;
  }
  // total is in proxy-seconds (arbitrary units)
  return total;
}

// Placeholder: attempt to read scale digits. Here we sample a region bottom-right and call readSevenSeg.
async function readScaleIfAvailable(src) {
  try {
    // define small box bottom-right (adjustable)
    let w = Math.floor(src.cols * 0.18);
    let h = Math.floor(src.rows * 0.14);
    let x = Math.max(0, src.cols - w - 8);
    let y = Math.max(0, src.rows - h - 8);
    let rect = new cv.Rect(x,y,w,h);
    let roi = src.roi(rect);
    // Convert roi to ImageData for OCR
    let rgba = new Uint8ClampedArray(roi.data);
    let imgData = new ImageData(rgba, roi.cols, roi.rows);
    // Call SSOCR lib (synchronous in our placeholder)
    let res = readSevenSeg(imgData);
    roi.delete();
    if (res && !isNaN(res.value)) return { value: res.value, confidence: res.confidence || 0 };
  } catch (e) {
    log('Scale OCR error: ' + e.message);
  }
  return null;
}

// Update Chart.js plot with integrated mass history and scale readings
function updateChart() {
  if (!chart) initializeChart();
  // Use integratedMassHistory for mass vs time
  let labels = integratedMassHistory.map(p => new Date(p.t*1000).toLocaleTimeString());
  let dataMass = integratedMassHistory.map(p => p.mass);

  chart.data.labels = labels;
  chart.data.datasets[0].data = dataMass;
  // overlay raw proxy (scaled to grams for visualization)
  let proxyScaled = flowProxyHistory.map(p => calibration.slope * integrateProxyUpTo(p.t) + calibration.offset);
  chart.data.datasets[1].data = proxyScaled;
  // scale reads (dots)
  chart.data.datasets[2].data = scaleReads.map(s => ({ x: new Date(s.t*1000).toLocaleTimeString(), y: s.mass }));

  chart.update('none');
}

function integrateProxyUpTo(ts) {
  // integrate history up to timestamp ts
  let sub = flowProxyHistory.filter(h => h.t <= ts);
  return integrateProxy(sub);
}

function initializeChart() {
  chart = new Chart(chartCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Estimated mass (g)', data: [], borderColor: 'blue', fill: false },
        { label: 'Proxy->mass (cal)', data: [], borderColor: 'orange', borderDash: [5,5], fill: false },
        { label: 'Scale reads', data: [], borderColor: 'green', showLine:false, pointRadius:4 }
      ]
    },
    options: {
      animation: false,
      responsive: true,
      scales: {
        x: { display: true },
        y: { display: true }
      }
    }
  });
}

// Calibrate calibration.slope,offset by fitting integrated proxy to scaleReads using least squares
function calibrate() {
  if (scaleReads.length < 2) { log('Need at least 2 scale reads to calibrate'); return; }
  // For each scaleRead, compute integrated proxy up to that time
  let A = [];
  let b = [];
  for (let s of scaleReads) {
    let x = integrateProxyUpTo(s.t); // independent variable
    A.push([x, 1]);
    b.push(s.mass);
  }
  // Solve for [slope, offset] in least squares: (A^T A)^{-1} A^T b
  // Simple 2x2 normal equations
  let sum_x = 0, sum_x2 = 0, sum_y = 0, sum_xy = 0; let n = A.length;
  for (let i=0;i<n;i++){
    let x = A[i][0], y = b[i];
    sum_x += x; sum_x2 += x*x; sum_y += y; sum_xy += x*y;
  }
  let denom = (n*sum_x2 - sum_x*sum_x) || 1e-6;
  let slope = (n*sum_xy - sum_x*sum_y)/denom;
  let offset = (sum_y - slope*sum_x)/n;
  calibration.slope = slope; calibration.offset = offset;
  log(`Calibrated: slope=${slope.toFixed(4)}, offset=${offset.toFixed(3)}`);
}

function exportCSV() {
  // Combine timestamps and values
  let rows = [];
  rows.push(['t_unix','t_iso','proxy','integrated_mass_g','scale_g']);
  let n = Math.max(flowProxyHistory.length, integratedMassHistory.length, scaleReads.length);
  for (let i=0;i<n;i++){
    let fp = flowProxyHistory[i] || {t:'',proxy:''};
    let im = integratedMassHistory[i] || {t:'',mass:''};
    let sr = scaleReads[i] || {t:'',mass:''};
    rows.push([fp.t, fp.t?new Date(fp.t*1000).toISOString():'', fp.proxy, im.mass, sr.mass]);
  }
  let csv = rows.map(r => r.join(',')).join('\n');
  let blob = new Blob([csv], {type:'text/csv'});
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a'); a.href = url; a.download = 'brew_data.csv'; a.click(); URL.revokeObjectURL(url);
}

// Helper called when OpenCV.js is ready
function onOpenCvReady() {
  log('OpenCV.js loaded');
}

// Minimal initial log
log('Ready. Click Start to begin.');

// Mark todo 1 as in-progress then completed
// Use the todo list tool to update statuses accordingly

