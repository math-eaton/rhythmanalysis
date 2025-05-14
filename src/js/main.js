import { clockGraph } from "./clock.js";

// loading overlay
const loadingOverlay = document.createElement("div");
loadingOverlay.id = "loadingOverlay";
loadingOverlay.innerHTML = '<div id="loadingText">LOADING</div>';
loadingOverlay.style = "";
document.body.appendChild(loadingOverlay);

function animateLoadingText() {
  const loadingText = document.getElementById("loadingText");
  let dotCount = 0;

  const interval = setInterval(() => {
    loadingText.textContent = "LOADING" + ".".repeat(dotCount);
    dotCount++;
  }, 250);

  console.log("Loading animation started");

  // stop animation when overlay is hidden
  return () => {
    clearInterval(interval);
    console.log("Loading animation stopped");
  };
}

const stopAnimation = animateLoadingText();

// onDataReady callback to hide the overlay and stop the animation
const onDataReady = () => {
  setTimeout(() => {
    const overlay = document.getElementById("loadingOverlay");
    if (overlay) {
      overlay.style.display = "none";
    }
    stopAnimation();
  }, 100); 
};

// Pass the onDataReady callback to the clockGraph function
clockGraph("simpleGraphContainer", { onDataReady });
