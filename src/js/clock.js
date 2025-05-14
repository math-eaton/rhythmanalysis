// src/js/clockGraph.js
import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const {
    DATA_URL = "/api/audio_logs",
    INNER_R = 200,
    OUTER_R = 240,
  } = config;

  const container = d3.select(`#${containerId}`);
  container.style("display", "flex").style("align-items", "flex-start");

  // ensure a place for filters (hidden until checkbox checked)
  let filterContainer = container.select(".time-filters");
  if (filterContainer.empty()) {
    filterContainer = container
      .insert("div", ":first-child")
      .attr("class", "time-filters")
      .style("margin-bottom", "16px");
  }
  filterContainer.style("display", "none");

  // ensure the legend container exists
  let legendContainer = container.select(".legend");
  if (legendContainer.empty()) {
    legendContainer = container.append("div").attr("class", "legend");
  }
  legendContainer
    .style("overflow-y", "auto")
    .style("max-height", "100vh")
    .style("margin-left", "16px");

  // create a tooltip element
  const tooltip = d3
    .select("body")
    .append("div")
    .attr("class", "tooltip")
    .style("position", "absolute")
    .style("padding", "5px 10px")
    .style("background", "rgba(0, 0, 0, 0.7)")
    .style("color", "#fff")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("pointer-events", "none")
    .style("visibility", "hidden");

  // cache for loaded data
  let dataCache = [];
  let tsMin = Infinity,
      tsMax = -Infinity;

  // Define the time range for the last N hours for default vis
  const inputHours = 4; 
  const nHoursAgo = Math.floor(Date.now() / 1000) - inputHours * 60 * 60;

  // Filter data to include only the most recent six hours
  d3.json(DATA_URL).then((raw) => {
    if (!Array.isArray(raw)) {
      console.error("Unexpected data format: expected an array");
      return;
    }

    dataCache = raw
      .map((d) => {
        const rawTs = +d.ts;
        const offsetSec =
          new Date(rawTs * 1000).getTimezoneOffset() * 60;
        return {
          ts: rawTs + offsetSec,
          class: d.cl,
          cf: +d.cf,
        };
      })
      .filter((d) => d.ts >= nHoursAgo) // Filter for the last six hours
      .sort((a, b) => a.ts - b.ts);

    if (!dataCache.length) {
      console.warn("no data");
      return;
    }

    // determine full range
    tsMin = dataCache[0].ts;
    tsMax = dataCache[dataCache.length - 1].ts;

    // initial full-range draw
    draw();
    window.addEventListener("resize", draw);

    // Adjust the draw function to always use the full range
    function draw() {
      const t0 = tsMin;
      const t1 = tsMax;

      // filter data (or take full cache)
      const data = dataCache.filter((d) => d.ts >= t0 && d.ts <= t1);
      if (!data.length) {
        console.warn("no data in selected range");
        return;
      }

      // SVG sizing
      const w = window.innerWidth * 0.75;
      const h = window.innerHeight;
      const svg = container
        .select("svg")
        .attr("width", w)
        .attr("height", h);
      svg.selectAll("*").remove();
      const cx = w / 2, cy = h / 2;

      // Add a label in the top left corner showing the date of data visualization
      const visualizationDate = new Date(tsMin * 1000).toISOString().split('T')[0]; // Extract YYYY-MM-DD

      const topLeftTextX = 20; // X position for the label
      const topLeftTextY = 20; // Y position for the label

      // Add background rectangle for the label
      const topLeftTextElement = svg.append("text")
        .attr("x", topLeftTextX)
        .attr("y", topLeftTextY)
        .attr("text-anchor", "start")
        .attr("alignment-baseline", "hanging")
        .style("font-size", "10px")
        .style("fill", "#f5f5f5")
        .text(visualizationDate);

      const topLeftBBox = topLeftTextElement.node().getBBox();
      svg.insert("rect", "text")
        .attr("x", topLeftBBox.x - 2) // Add padding
        .attr("y", topLeftBBox.y - 2)
        .attr("width", topLeftBBox.width + 4)
        .attr("height", topLeftBBox.height + 4)
        .style("fill", "black");

      // map [t0…t1] → [–π/2…3π/2]
      const angle = d3
        .scaleLinear()
        .domain([t0, t1])
        .range([-Math.PI / 2, (3 * Math.PI) / 2]);

      // class counts
      const classCounts = d3.rollup(
        data,
        (v) => v.length,
        (d) => d.class
      );
      const classes = Array.from(classCounts.keys()).sort(
        (a, b) => classCounts.get(a) - classCounts.get(b)
      );

      const color = d3.scaleOrdinal(classes, d3.schemeCategory10);
      const ringScale = d3
        .scaleLinear()
        .domain([0, classes.length - 1])
        .range([INNER_R, OUTER_R]);

      // background circle
      svg
        .append("circle")
        .attr("cx", cx)
        .attr("cy", cy)
        .attr("r", OUTER_R)
        .style("fill", "none")
        .style("stroke", "#aaaaaa7a");

      const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

      // draw each class ring and events
      classes.forEach((cls, i) => {
        const radius = ringScale(i);
        g.append("circle")
          .attr("r", radius)
          .style("fill", "none")
          .style("stroke", "#aaaaaa7a");

        g.selectAll(`.line-${i}`)
          .data(data.filter((d) => d.class === cls))
          .join("line")
          .attr("x1", (d) => radius * Math.cos(angle(d.ts)))
          .attr("y1", (d) => radius * Math.sin(angle(d.ts)))
          .attr("x2", (d) => (radius + 10) * Math.cos(angle(d.ts)))
          .attr("y2", (d) => (radius + 10) * Math.sin(angle(d.ts)))
          .attr("stroke", color(cls))
          .attr("stroke-width", 1.5)
          .attr("opacity", (d) => {
            const cfScale = d3.scaleLinear().domain([0, 100]).range([0.1, 1]);
            return cfScale(d.cf || 0);
          })
          .on("mouseover", (event, d) => {
            const tsMs = d.ts * 1000;
            const label = new Date(tsMs).toLocaleString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/New_York",
            });
            tooltip.text(`${d.class}, ${label}`).style("visibility", "visible");
          })
          .on("mousemove", (event) => {
            tooltip
              .style("top", `${event.pageY + 10}px`)
              .style("left", `${event.pageX + 10}px`);
          })
          .on("mouseout", () => tooltip.style("visibility", "hidden"));
      });

      // timestamp labels at 12,3,6,9 o'clock
      const labelPos = [
        { angle: -Math.PI / 2 },
        { angle: 0 },
        { angle: Math.PI / 2 },
        { angle: Math.PI },
      ];
      const invAngle = d3
        .scaleLinear()
        .domain(angle.range())
        .range(angle.domain());

      labelPos.forEach(({ angle: a }) => {
        const tsMs = invAngle(a) * 1000;
        const txt = new Date(tsMs).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/New_York",
        });

        const textX = cx + (OUTER_R + 45) * Math.cos(a);
        const textY = cy + (OUTER_R + 25) * Math.sin(a);

        // Add background rectangle
        const textElement = svg.append("text")
          .attr("x", textX)
          .attr("y", textY)
          .attr("text-anchor", "middle")
          .attr("alignment-baseline", "middle")
          .style("font-size", "10px")
          .style("fill", "#f5f5f5")
          .text(txt);

        const bbox = textElement.node().getBBox();
        svg.insert("rect", "text")
          .attr("x", bbox.x - 2) // Add padding
          .attr("y", bbox.y - 2)
          .attr("width", bbox.width + 4)
          .attr("height", bbox.height + 4)
          .style("fill", "black");
      });

      // legend
      legendContainer.selectAll("*").remove();
      const items = Array.from(classCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map((d) => d[0]);
      const legendItem = legendContainer
        .selectAll(".item")
        .data(items)
        .join("div")
        .attr("class", "item")
        .style("margin-bottom", "4px");
      legendItem
        .append("span")
        .style("display", "inline-block")
        .style("width", "12px")
        .style("height", "12px")
        .style("margin-right", "6px")
        .style("background-color", (d) => color(d));
      legendItem.append("span").text((d) => `${d} (${classCounts.get(d)})`);
    }
  });
}
