Pour-over Brew Tracker — Prototype

What this prototype does
- Uses getUserMedia to capture the phone camera stream.
- Hooks into OpenCV.js for frame processing.
- Provides a placeholder for AprilTag detection and seven-seg OCR (SSOCR).
- Computes a region-of-interest (ROI) relative to a detected marker so the ROI follows the kettle spout.
- Computes a flow proxy using frame differencing inside the ROI.
- Integrates the proxy over time and fits it to scale readings to estimate mass (calibration).
- Plots live mass vs time using Chart.js and allows CSV export.

Files
- `index.html` — main UI and library includes.
- `main.js` — app logic, CV pipeline, plotting, export.

Usage notes and assumptions
- You must provide real implementations for:
  - AprilTag/ArUco detection (e.g., apriltag-js build or custom WASM/JS)
  - Seven-segment OCR (SSOCR) for reading digital scale digits
- The default `readSevenSeg` is a placeholder that returns NaN. To use a real scale, replace it with a library that accepts ImageData and returns a numeric value.
- The ROI placement assumes the spout is on one side of the tag. If your kettle orientation differs, tweak `offsetFactor` in `computeROIFromTag`.
- This is a prototype for in-browser testing. For production, consider performance optimizations and using WebAssembly builds of OpenCV, AprilTag, and OCR.

Next improvements
- Replace placeholder OCR with a proper seven-seg reader.
- Add ArUco support if AprilTag is not available.
- Add UI to tune ROI offsets interactively.
- Implement optical flow (Farneback or Lukas-Kanade) for more robust flow proxy.

License: MIT (you can adapt for your project)
