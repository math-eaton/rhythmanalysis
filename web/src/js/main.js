import { simpleGraph } from "./simpleGraph.js";

// Configuration for the graph
const config = {
  TIMESPAN: 120, // in mins
  CONFIDENCE_THRESHOLD: 40,
  JSON_PATH: "classifications_yamnet.json",
  MAX_MARKER_RADIUS: 5,
  JITTER_RADIAL_FACTOR: 0.4,
  JITTER_ANG_SEC: 0.5,
};

// Draw the graph in the container with ID "simpleGraphContainer"
simpleGraph("simpleGraphContainer", config);
