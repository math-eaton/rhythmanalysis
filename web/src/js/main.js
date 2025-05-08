// src/js/main.js
import { clockGraph } from "./clock.js";

const config = {
  DATA_URL: "https://rhythmanalysis.onrender.com/api/audio_logs",
  INNER_R: 180,
  OUTER_R: 220,
};

clockGraph("simpleGraphContainer", config);
