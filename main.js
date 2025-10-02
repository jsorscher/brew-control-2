// main.js - Minimal: camera start + seven-seg OCR display
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const startBtn = document.getElementById('startBtn');
const captureBtn = document.getElementById('captureBtn');
const stopBtn = document.getElementById('stopBtn');
const logEl = document.getElementById('log');

let stream = null;
let running = false;
let rafId = null;
let lastOCR = { value: NaN, confidence: 0, t: 0 };

// ROI selection state
let selecting = false;
let roiStart = null;
let roi = null;
let capturedFrame = null;

function log(msg) {
  logEl.textContent = `[${new Date().toISOString()}] ${msg}`;
}

async function start() {
  if (running) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    resizeCanvas();
    running = true;
    startBtn.disabled = true;
    captureBtn.disabled = false;
    stopBtn.disabled = false;
    
    // Set ROI to full frame
    roi = {
      x: 0,
      y: 0,
      w: video.videoWidth,
      h: video.videoHeight
    };
    
    loop();
    log('Camera started - OCR running on full frame');
  } catch (e) {
    log('Camera error: ' + e.message);
  }
}

function stop() {
  if (!running && !selecting && !capturedFrame) return;
  running = false;
  selecting = false;
  startBtn.disabled = false;
  captureBtn.disabled = true;
  stopBtn.disabled = true;
  
  // Reset video display
  video.style.display = 'block';
  overlay.style.backgroundImage = 'none';
  
  // Clear any selections or captures
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (rafId) cancelAnimationFrame(rafId);
  capturedFrame = null;
  roi = null;
  roiStart = null;
  
  // Clear the overlay
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  
  log('Stopped');
}

function resizeCanvas() {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

function captureFrame() {
  // Reset selection state and allow new ROI selection
  selecting = false;
  roiStart = null;
  roi = null;
  log('Click and drag to select ROI');
}

function drawCapturedFrame() {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(capturedFrame, 0, 0);
  video.style.display = 'none';
  overlay.style.backgroundImage = `url(${canvas.toDataURL()})`;
  overlay.style.backgroundColor = '#000';
  overlay.style.backgroundSize = 'contain';
  overlay.style.backgroundPosition = 'center';
  overlay.style.backgroundRepeat = 'no-repeat';
}

function clientToCanvasCoords(clientX, clientY) {
  const rect = overlay.getBoundingClientRect();
  const x = Math.max(0, Math.min(overlay.width, (clientX - rect.left) * (overlay.width / rect.width)));
  const y = Math.max(0, Math.min(overlay.height, (clientY - rect.top) * (overlay.height / rect.height)));
  return { x, y };
}

function drawROI() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  
  // Draw OCR result and confidence
  if (!isNaN(lastOCR.value)) {
    // Background for readability
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(10, 10, 200, 50);
    
    // Draw value
    overlayCtx.fillStyle = lastOCR.confidence > 0.8 ? 'lime' : 'yellow';
    overlayCtx.font = '32px sans-serif';
    overlayCtx.fillText(`${lastOCR.value}g`, 20, 45);
    
    // Draw confidence
    overlayCtx.font = '16px sans-serif';
    overlayCtx.fillText(`${(lastOCR.confidence * 100).toFixed(1)}%`, 140, 45);
  }
}

function getCurrentRect() {
  if (!roiStart) return null;
  const current = { x: overlay._lastX || roiStart.x, y: overlay._lastY || roiStart.y };
  const x = Math.min(roiStart.x, current.x);
  const y = Math.min(roiStart.y, current.y);
  const w = Math.abs(current.x - roiStart.x);
  const h = Math.abs(current.y - roiStart.y);
  return { x, y, w, h };
}

function captureFrameImageData() {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Track last OCR time to limit processing rate
let lastProcessTime = 0;
const MIN_PROCESS_INTERVAL = 500; // Minimum ms between OCR attempts

async function processROI() {
  if (!roi) return;
  
  // Limit processing rate
  const now = Date.now();
  if (now - lastProcessTime < MIN_PROCESS_INTERVAL) return;
  lastProcessTime = now;
  
  // Get current frame from video
  const canvas = document.createElement('canvas');
  canvas.width = roi.w;
  canvas.height = roi.h;
  const ctx = canvas.getContext('2d');
  
  // Draw the ROI portion of the video
  ctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
  const roiData = ctx.getImageData(0, 0, roi.w, roi.h);
  
  const res = await ssocr(roiData);
  if (res && !isNaN(res.value)) {
    lastOCR = { value: res.value, confidence: res.confidence || 0, t: now/1000 };
    drawROI();
  }
}

function loop() {
  if (!running) return;
  
  // Always show video and draw ROI
  video.style.display = 'block';
  overlay.style.backgroundImage = 'none';
  drawROI();
  
  // If we have an ROI and not currently selecting, process it
  if (roi && !selecting) {
    processROI();
  }
  
  rafId = requestAnimationFrame(loop);
}

// Simple seven-segment OCR (SSOCR)
// Initialize Tesseract worker
const worker = Tesseract.createWorker({
  logger: m => {
    console.log('Tesseract:', m);
    if (m.status === 'recognizing text') {
      log(`OCR progress: ${(m.progress * 100).toFixed(1)}%`);
    }
  }
});

async function initTesseract() {
  log('Loading OCR engine...');
  await worker.load();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  
  // Try different Tesseract configurations
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789.',  // Only allow digits and decimal
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,  // Treat as single line of text
    tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,  // Use LSTM neural network
    lstm_choice_mode: 5,  // More thorough LSTM analysis
    textord_heavy_nr: 1,  // Handle touching characters better
    textord_min_linesize: 2.5,  // Better for small text
    preserve_interword_spaces: 0,  // Don't require spaces between numbers
  });
  
  log('OCR engine ready - using LSTM mode');
  
  // Let's log available PSM modes for reference
  console.log('Available PSM modes:', {
    'SINGLE_LINE': Tesseract.PSM.SINGLE_LINE,
    'SINGLE_WORD': Tesseract.PSM.SINGLE_WORD,
    'SINGLE_CHAR': Tesseract.PSM.SINGLE_CHAR,
    'SINGLE_COLUMN': Tesseract.PSM.SINGLE_COLUMN
  });
}

// Initialize Tesseract when the page loads
initTesseract();

async function ssocr(imageData) {
  try {
    // Create a canvas to process the image
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);

    // Create debug view showing 3 processing stages
    const debugCanvas = document.createElement('canvas');
    debugCanvas.width = imageData.width * 3; // Show 3 stages side by side
    debugCanvas.height = imageData.height;
    debugCanvas.style.position = 'fixed';
    debugCanvas.style.top = '10px';
    debugCanvas.style.right = '10px';
    debugCanvas.style.border = '2px solid red';
    debugCanvas.style.backgroundColor = 'black';
    debugCanvas.style.zIndex = '1000';
    document.body.appendChild(debugCanvas);
    const debugCtx = debugCanvas.getContext('2d');

    // Stage 1: Original
    debugCtx.drawImage(canvas, 0, 0);
    
    // Stage 2: Grayscale + Contrast
    const enhancedImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = enhancedImageData.data;
    
    // Convert to grayscale and increase contrast
    for (let i = 0; i < data.length; i += 4) {
      // Convert to grayscale using proper luminance weights
      const gray = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      // Increase contrast
      const contrast = Math.max(0, Math.min(255, (gray - 128) * 2 + 128));
      data[i] = data[i + 1] = data[i + 2] = contrast;
    }
    
    // Show enhanced version
    debugCtx.putImageData(enhancedImageData, canvas.width, 0);
    
    // Stage 3: Thresholding
    const threshold = 160; // Adjust this value based on your display
    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] > threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = value;
    }
    
    // Show thresholded version
    debugCtx.putImageData(enhancedImageData, canvas.width * 2, 0);
    
    // Add labels
    debugCtx.fillStyle = 'lime';
    debugCtx.font = '12px monospace';
    debugCtx.fillText('Original', 5, 15);
    debugCtx.fillText('Enhanced', canvas.width + 5, 15);
    debugCtx.fillText('Threshold', canvas.width * 2 + 5, 15);
    
    // Put the final processed image back on the main canvas
    ctx.putImageData(enhancedImageData, 0, 0);
    
    // Run OCR with detailed logging
    log('Starting OCR...');
    const result = await worker.recognize(canvas);
    console.log('Full Tesseract result:', result);
    
    const text = result.data.text.trim();
    log(`Raw OCR text: "${text}" (confidence: ${result.data.confidence.toFixed(2)}%)`);
    
    // Log word-level details
    result.data.words?.forEach(word => {
      const { text, confidence, bbox } = word;
      log(`Word: "${text}" (conf: ${confidence.toFixed(2)}%, bbox: ${JSON.stringify(bbox)})`);
    });

    const number = parseFloat(text);
    log(`Parsed number: ${isNaN(number) ? 'NaN' : number}`);
    
    // Auto-remove debug view after 3 seconds
    setTimeout(() => {
      document.body.removeChild(debugCanvas);
    }, 3000);
    
    return {
      value: isNaN(number) ? NaN : number,
      confidence: result.data.confidence / 100,
      rawText: text,
      words: result.data.words
    };
  } catch (e) {
    console.error('OCR error:', e);
    return { value: NaN, confidence: 0, error: e.message };
  }
}

// No ROI selection handlers - using full frame

startBtn.addEventListener('click', start);
captureBtn.addEventListener('click', captureFrame);
stopBtn.addEventListener('click', stop);
window.addEventListener('resize', resizeCanvas);
