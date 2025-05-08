// src/js/clockGraph.js
// bare-bones polar “clock” with ticks per event, colored by class
import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const {
    DATA_URL = "/api/audio_logs",
    INNER_R = 200,
    OUTER_R = 240,
  } = config;

  const container = d3.select(`#${containerId}`).node();

  function render() {
    const w = container.clientWidth;
    const h = w;
    const svg = d3.select(`#${containerId} svg`)
      .attr("width", w)
      .attr("height", h);

    svg.selectAll("*").remove();

    const cx = w / 2, cy = h / 2;

    d3.json(DATA_URL).then(raw => {
      // parse and sort
      const data = raw.map(d => ({ ts: +d.ts, class: d.class }))
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
        .range([-Math.PI/2, Math.PI * 3/2]);

      // classes → colors
      const classes = Array.from(new Set(data.map(d => d.class))).sort();
      const color = d3.scaleOrdinal(classes, d3.schemeCategory10);

      // draw an outer circle
      svg.append("circle")
        .attr("cx", cx)
        .attr("cy", cy)
        .attr("r", (INNER_R + OUTER_R) / 2)
        .style("fill", "none")
        .style("stroke", "#ccc");

      // draw ticks
      const g = svg.append("g")
        .attr("transform", `translate(${cx},${cy})`);

      g.selectAll("line")
        .data(data)
        .join("line")
          .attr("x1", d => INNER_R * Math.cos(angle(d.ts)))
          .attr("y1", d => INNER_R * Math.sin(angle(d.ts)))
          .attr("x2", d => OUTER_R * Math.cos(angle(d.ts)))
          .attr("y2", d => OUTER_R * Math.sin(angle(d.ts)))
          .attr("stroke", d => color(d.class))
          .attr("stroke-width", 1);

      // legend
      const legend = d3.select(`#${containerId} .legend`);
      legend.selectAll("*").remove();
      const item = legend.selectAll(".item")
        .data(classes)
        .join("div")
          .attr("class", "item")
          .style("margin-bottom", "4px");

      item.append("span")
          .style("display", "inline-block")
          .style("width", "12px")
          .style("height", "12px")
          .style("margin-right", "6px")
          .style("background-color", d => color(d));

      item.append("span")
          .text(d => d);
    });
  }

  render();
  window.addEventListener("resize", render);
}
