// src/js/main.js
import { clockGraph } from "./clock.js";

const config = {
  DATA_URL: "https://rhythmanalysis.onrender.com/api/audio_logs",
  INNER_R: 25,
  OUTER_R: 350,
};

clockGraph("simpleGraphContainer", config);
