// @ts-nocheck
import * as d3 from "d3";

// config
const WINDOW_MINUTES       = 120;
const CONFIDENCE_THRESHOLD = 40;
const JSON_PATH            = "classifications_yamnet.json";
const MAX_MARKER_RADIUS    = 5;    // px (so area ∝ confidence)
const JITTER_RADIAL_FACTOR = 0.4;  // fraction of one ring's thickness
const JITTER_ANG_SEC       = 0.5;  // seconds worth of angular jitter

const container = d3.select("#polar-graph").node();

function render() {
  const w = container.clientWidth;
  const h = w; // keep it square
  const margin = 50; // Add margin for titles and legends
  const graphSize = Math.min(w, h) - margin * 2; // Shrink graph to fit margins

  d3.select("#clock")
    .attr("width", w)
    .attr("height", h);

  const svg = d3.select("#clock");
  svg.selectAll("*").remove(); 

  const centerX = w / 2;
  const centerY = h / 2;
  const outerR = graphSize / 2 * 0.9;
  const innerR = outerR * 0.25;

  const angleScale = d3.scaleLinear()
    .domain([0, WINDOW_MINUTES * 60])
    .range([-Math.PI / 2, Math.PI * 1.5]); // start at 12 noon and proceed clockwise

  const radiusScale = d3.scaleSqrt()
    .domain([0, 100])
    .range([0, MAX_MARKER_RADIUS]);

  // import json
  d3.json(JSON_PATH).then(data => {
    // sort by timestamp + pick timespan
    data.sort((a, b) => a.ts - b.ts);
    const startTs = data[0].ts,
          endTs   = startTs + WINDOW_MINUTES * 60;

    // filter by included time & cf threshold
    const events = data.filter(d =>
      d.ts >= startTs &&
      d.ts <  endTs  &&
      d.cf >  CONFIDENCE_THRESHOLD
    );
    if (!events.length) {
      console.warn("No events in that window!");
      return;
    }

    // give each class a ring in orbit
    const classes = Array.from(new Set(events.map(d => d.cl))).sort();
    const ringScale = d3.scaleLinear()
      .domain([0, classes.length - 1])
      .range([outerR, innerR]);
    const ringPx      = Math.abs(outerR - innerR) / classes.length,
          jitterR_px  = ringPx * JITTER_RADIAL_FACTOR,
          maxJitterA  = (JITTER_ANG_SEC / (WINDOW_MINUTES * 60)) * 2 * Math.PI;

    // segments per class
    const segmentsByClass = {};
    classes.forEach(cl => {
      const evs = events
        .filter(d => d.cl === cl)
        .sort((a, b) => a.ts - b.ts);

      const segs = [];
      if (evs.length) {
        let segStart = evs[0].ts;
        let segEnd   = evs[0].ts + 1;  // assume 1 s duration

        evs.forEach((d, i) => {
          if (i === 0) return;
          const gap = d.ts - evs[i - 1].ts;
          if (gap <= 1.1) {
            // continues the same segment
            segEnd = d.ts + 1;
          } else {
            // close old segment, start new
            segs.push({ start: segStart, end: segEnd });
            segStart = d.ts;
            segEnd   = d.ts + 1;
          }
        });

        // push the last one
        segs.push({ start: segStart, end: segEnd });
      }

      segmentsByClass[cl] = segs;
    });

    // arc thickness = 80% of one ring’s width
    const barThickness = ringPx * 0.8;

    // color ramp
    const colorScale = d3.scaleOrdinal()
      .domain(classes)
      .range(d3.schemeTableau10);

    // draw ring bg for each class
    svg.append("g")
      .attr("transform", `translate(${centerX},${centerY})`)
      .selectAll("circle")
      .data(classes)
      .join("circle")
        .attr("r", (_, i) => ringScale(i))
        .style("stroke", "#999")
        .style("stroke-opacity", 0.2)
        .style("fill", "none");

    // 5 min ticks
    const ticks = d3.range(0, WINDOW_MINUTES+1, 5);
    const tickG = svg.append("g")
      .attr("transform", `translate(${centerX},${centerY})`);

    // tickG.selectAll("line")
    //   .data(ticks)
    //   .join("line")
    //     .attr("x1", d => outerR * Math.cos(angleScale(d*60)))
    //     .attr("y1", d => outerR * Math.sin(angleScale(d*60)))
    //     .attr("x2", d => (outerR + 10) * Math.cos(angleScale(d*60)))
    //     .attr("y2", d => (outerR + 10) * Math.sin(angleScale(d*60)))
    //     .style("stroke", "#666");

    tickG.selectAll("text")
      .data(ticks)
      .join("text")
        .attr("class","tick-label")
        .attr("x", d => (outerR + 20) * Math.cos(angleScale(d*60)))
        .attr("y", d => (outerR + 20) * Math.sin(angleScale(d*60)))
        .text(d => d === WINDOW_MINUTES ? "" : `${d} min`);

    // arcs
    const barsG = svg.append("g")
      .attr("transform", `translate(${centerX},${centerY})`);

    classes.forEach((cl, i) => {
      const innerBarR = ringScale(i) - barThickness / 2;
      const outerBarR = ringScale(i) + barThickness / 2;

      // arc generator for this ring
      const arc = d3.arc()
        .innerRadius(innerBarR)
        .outerRadius(outerBarR)
        .startAngle(d => angleScale(d.start - startTs))
        .endAngle(d => angleScale(d.end - startTs));

      barsG
        .selectAll(`path.bar-${i}`)
        .data(segmentsByClass[cl])
        .join("path")
          .attr("class", `bar-${i}`)
          .attr("d", arc)
          .style("fill", colorScale(cl))
          .style("fill-opacity", 1)
          .style("stroke", colorScale(cl))
          .style("stroke-width", 1);
    });

    // draw legend
    const legendDiv = d3.select("#legend");
    legendDiv.style("margin-top", `${margin}px`);

    classes.forEach(cl => {
      const row = legendDiv
        .append("div")
        .attr("class", "item");
    
      row.append("div")
         .attr("class", "swatch")
         .style("background-color", colorScale(cl));
    
      row.append("span")
         .text(cl);
    });
    
    // main title
    svg.append("text")
      .attr("x", centerX)
      .attr("y", margin / 2)
      .attr("text-anchor", "middle")
      .style("font-size", "14px")
      .style("fill", "grey")
      .attr("x", centerX)
      .attr("dy", "1.2em") 
      .style("fill", "grey")
      .text(
        `${new Date(startTs*1000).toLocaleString()} - ` +
        `${new Date(endTs*1000).toLocaleString()}`
      );
    });

}

// init
render();

// rerender if window resizes
window.addEventListener("resize", render);