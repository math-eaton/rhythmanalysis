import { bin } from "d3";
import { clockGraph } from "./clock.js";

// loading overlay
const loadingOverlay = document.createElement("div");
loadingOverlay.id = "loadingOverlay";
loadingOverlay.innerHTML = '<div id="loadingText">LOADING</div>';
loadingOverlay.style = "";
document.body.appendChild(loadingOverlay);

let initialLoad = true; // Track if this is the first load
let stopAnimation = null;
if (initialLoad) {
  stopAnimation = animateLoadingText();
}

function animateLoadingText() {
  const loadingText = document.getElementById("loadingText");
  let dotCount = 0;

  const interval = setInterval(() => {
    loadingText.textContent = "LOADING" + " .".repeat(dotCount);
    dotCount = (dotCount + 1);
  }, 250);

  // console.log("Loading animation started");

  // stop animation when overlay is hidden
  return () => {
    clearInterval(interval);
    // console.log("Loading animation stopped");
  };
}

// onDataReady callback to hide the overlay and stop the animation
const onDataReady = () => {
  if (initialLoad) {
    setTimeout(() => {
      const overlay = document.getElementById("loadingOverlay");
      if (overlay) {
        overlay.style.display = "none";
      }
      if (stopAnimation) stopAnimation();
      initialLoad = false;
    }, 100); 
  }
};

// Pass the onDataReady callback to the clockGraph function
clockGraph("simpleGraphContainer", { 
  onDataReady, 
  // apiBaseUrl: "http://localhost:3000/api",
  hours: 24,
  offsetHours: 72,
  binSeconds: 30,
  refresh_interval: 300000, // N seconds in ms
  // Diagnostic: log timing for API fetch and D3 processing
  onApiFetchStart: () => { window._apiFetchStart = performance.now(); console.log('[main.js] API fetch started'); },
  onApiFetchEnd: () => { if (window._apiFetchStart) { console.log('[main.js] API fetch duration:', (performance.now() - window._apiFetchStart).toFixed(2), 'ms'); } },
  onD3Start: () => { window._d3Start = performance.now(); console.log('[main.js] D3 processing started'); },
  onD3End: () => { if (window._d3Start) { console.log('[main.js] D3 processing duration:', (performance.now() - window._d3Start).toFixed(2), 'ms'); } },
});

