// src/js/main.js
import { clockGraph } from "./clock.js";

const config = {
  // if your API is hosted elsewhere:
  // DATA_URL: "https://your-domain.com/api/audio_logs",
  INNER_R: 180,
  OUTER_R: 220,
};

clockGraph("simpleGraphContainer", config);
