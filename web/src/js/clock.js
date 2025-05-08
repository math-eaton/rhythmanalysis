// src/js/clockGraph.js
import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const {
    DATA_URL = "/api/audio_logs",
    INNER_R = 200,
    OUTER_R = 240,
  } = config;

  const container = d3.select(`#${containerId}`);
  container.style("display", "flex").style("align-items", "center");

  // Ensure the legend container exists
  let legendContainer = container.select(".legend");
  if (legendContainer.empty()) {
    legendContainer = container.append("div").attr("class", "legend");
  }
  legendContainer
    .style("overflow-y", "auto")
    .style("max-height", "100vh")
    .style("margin-left", "16px");

  // Create a tooltip element
  const tooltip = d3
    .select("body")
    .append("div")
    .attr("cl", "tooltip")
    .style("position", "absolute")
    .style("top", "10px")
    .style("left", "10px")
    .style("padding", "5px 10px")
    .style("background", "rgba(0, 0, 0, 0.7)")
    .style("color", "#fff")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("pointer-events", "none")
    .style("visibility", "hidden");

  function render() {
    const w = window.innerWidth * 0.75; // 75% of the viewport width for the SVG
    const h = window.innerHeight; // Full viewport height
    const svg = container
      .select("svg")
      .attr("width", w)
      .attr("height", h);

    svg.selectAll("*").remove();

    const cx = w / 2, cy = h / 2;

    d3.json(DATA_URL).then((raw) => {
      // Parse and sort
      const data = raw
      .map((d) => {
        const rawTs = +d.ts;                    
        const offsetSec = new Date(rawTs * 1000) 
                             .getTimezoneOffset() 
                           * 60;               
        return {
          ts: rawTs + offsetSec,            
          class: d.cl,
          cf: +d.cf
        };
      })
      .sort((a, b) => a.ts - b.ts);
          if (!data.length) {
        console.warn("no data");
        return;
      }

      const t0 = data[0].ts,
      t1 = data[data.length - 1].ts;

      // map [t0…t1] → [–π/2…3π/2]
      const angle = d3.scaleLinear()
      .domain([t0, t1])
      .range([-Math.PI/2, 3*Math.PI/2]);
    
      // Calculate class frequencies
      const classCounts = d3.rollup(
        data,
        (v) => v.length,
        (d) => d.class // Use "class" (mapped from "cl")
      );

      const classes = Array.from(classCounts.entries())
        .sort((a, b) => a[1] - b[1])
        .map((d) => d[0]);

      const color = d3.scaleOrdinal(classes, d3.schemeCategory10);

      const ringScale = d3.scaleLinear()
        .domain([0, classes.length - 1])
        .range([INNER_R, OUTER_R]);

      svg
        .append("circle")
        .attr("cx", cx)
        .attr("cy", cy)
        .attr("r", OUTER_R)
        .style("fill", "none")
        .style("stroke", "#f0");

      const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

      classes.forEach((cls, i) => {
        const radius = ringScale(i);

        g.append("circle")
          .attr("r", radius)
          .style("fill", "none")
          .style("stroke", "#4d4d4d");

        g.selectAll(`line.class-${i}`)
          .data(data.filter((d) => d.class === cls))
          .join("line")
          .attr("x1", (d) => radius * Math.cos(angle(d.ts)))
          .attr("y1", (d) => radius * Math.sin(angle(d.ts)))
          .attr("x2", (d) => (radius + 10) * Math.cos(angle(d.ts)))
          .attr("y2", (d) => (radius + 10) * Math.sin(angle(d.ts)))
          .attr("stroke", color(cls))
          .attr("stroke-width", 1)
          .attr("opacity", (d) => {
            // Scale opacity based on the "cf" attribute
            const cfScale = d3.scaleLinear().domain([0, 100]).range([0.1, 1]);
            return cfScale(d.cf || 0); // Default to 0 if "cf" is undefined
          })        
          .on("mouseover", (event, d) => {
            const ms = d.ts * 1000;
            const timestamp = new Date(ms).toLocaleString("en-US", {
              hour:   "2-digit",
              minute: "2-digit",
              timeZone: "America/New_York"
            });
            tooltip
              .style("visibility", "visible")
              .text(`${d.class}, ${timestamp}`);
          })
                    .on("mousemove", (event) => {
            tooltip
              .style("top", `${event.pageY + 10}px`)
              .style("left", `${event.pageX + 10}px`);
          })
          .on("mouseout", () => {
            tooltip.style("visibility", "hidden");
          });
      });

      // Add timestamp labels at 12, 3, 6, and 9 o'clock positions
      const labelPositions = [
        { angle: -Math.PI / 2, label: "12 o'clock" }, // 12 o'clock
        { angle: 0, label: "3 o'clock" },            // 3 o'clock
        { angle: Math.PI / 2, label: "6 o'clock" },  // 6 o'clock
        { angle: Math.PI, label: "9 o'clock" },      // 9 o'clock
      ];

      // Use the inverse of the angle scale to calculate timestamps
      const inverseAngle = d3.scaleLinear()
        .domain(angle.range()) // [-π/2, 3π/2]
        .range(angle.domain()); // [t0, t1]

        labelPositions.forEach(({ angle: posAngle, label }) => {
            const ms = inverseAngle(posAngle) * 1000;
            const labelTime = new Date(ms).toLocaleString("en-US", {
              hour:   "2-digit",
              minute: "2-digit",
              timeZone: "America/New_York"
            });
                          svg
          .append("text")
          .attr(
            "x",
            cx + (OUTER_R + 45) * Math.cos(posAngle) 
          )
          .attr(
            "y",
            cy + (OUTER_R + 25) * Math.sin(posAngle)
          )
          .attr("text-anchor", "middle")
          .attr("alignment-baseline", "middle")
          .style("font-size", "10px")
          .style("fill", "#f5f5f5")
          .text(labelTime);
        });

      const legendClasses = Array.from(classCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map((d) => d[0]);

      legendContainer.selectAll("*").remove();
      const item = legendContainer
        .selectAll(".item")
        .data(legendClasses)
        .join("div")
        .attr("class", "item")
        .style("margin-bottom", "4px");

      item
        .append("span")
        .style("display", "inline-block")
        .style("width", "12px")
        .style("height", "12px")
        .style("margin-right", "6px")
        .style("background-color", (d) => color(d));

      item.append("span").text((d) => `${d} (${classCounts.get(d)})`);
    });
  }

  render();
  window.addEventListener("resize", render);
}
