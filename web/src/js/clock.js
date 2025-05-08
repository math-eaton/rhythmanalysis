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

  // ensure a place for filter toggle (checkbox)
  let toggleContainer = container.select(".filter-toggle");
  if (toggleContainer.empty()) {
    toggleContainer = container
      .insert("div", ":first-child")
      .attr("class", "filter-toggle")
      .style("margin-bottom", "8px");
    toggleContainer
      .append("input")
      .attr("type", "checkbox")
      .attr("id", "enable-filter");
    toggleContainer
      .append("label")
      .attr("for", "enable-filter")
      .text("Enable time filtering");
  }
  const checkbox = toggleContainer.select("#enable-filter");

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

  // placeholders for the two selects
  const startSelect = filterContainer
    .append("label")
    .text("Start time: ")
    .append("select")
    .attr("id", "start-select");

  const endSelect = filterContainer
    .append("label")
    .style("margin-left", "8px")
    .text("End time: ")
    .append("select")
    .attr("id", "end-select");

  // load data once, then set up checkbox + initial draw
  d3.json(DATA_URL).then((raw) => {
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
      .sort((a, b) => a.ts - b.ts);

    if (!dataCache.length) {
      console.warn("no data");
      return;
    }

    // determine full range
    tsMin = dataCache[0].ts;
    tsMax = dataCache[dataCache.length - 1].ts;

    // prepare 1-hour slots (seconds)
    const hour = 60 * 60;
    const startH = Math.floor(tsMin / hour) * hour;
    const endH = Math.ceil(tsMax / hour) * hour;
    const slots = d3.range(startH, endH + hour, hour);

    // checkbox behavior: show/hide & initialize filters once
    checkbox.on("change", function () {
      const enabled = d3.select(this).property("checked");

      if (enabled) {
        // populate selects only the first time
        if (startSelect.selectAll("option").empty()) {
          slots.forEach((ts) => {
            const label = new Date(ts * 1000).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/New_York",
            });
            startSelect
              .append("option")
              .attr("value", ts)
              .text(label);
            endSelect
              .append("option")
              .attr("value", ts)
              .text(label);
          });
          // default to full rounded range
          startSelect.property("value", startH);
          endSelect.property("value", endH);

          // re-draw when dropdowns change
          startSelect.on("change", draw);
          endSelect.on("change", draw);
        }

        filterContainer.style("display", "block");
      } else {
        filterContainer.style("display", "none");
      }

      draw();
    });

    // initial full-range draw
    draw();
    window.addEventListener("resize", draw);

    // main draw function (respects checkbox)
    function draw() {
      let t0, t1;
      if (checkbox.property("checked")) {
        t0 = +startSelect.property("value");
        t1 = +endSelect.property("value");
        if (t1 <= t0) {
          console.warn("End time must be after start time");
          return;
        }
      } else {
        t0 = tsMin;
        t1 = tsMax;
      }

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
        .style("stroke", "#f0");

      const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

      // draw each class ring and events
      classes.forEach((cls, i) => {
        const radius = ringScale(i);
        g.append("circle")
          .attr("r", radius)
          .style("fill", "none")
          .style("stroke", "#4d4d4d");

        g.selectAll(`.line-${i}`)
          .data(data.filter((d) => d.class === cls))
          .join("line")
          .attr("x1", (d) => radius * Math.cos(angle(d.ts)))
          .attr("y1", (d) => radius * Math.sin(angle(d.ts)))
          .attr("x2", (d) => (radius + 10) * Math.cos(angle(d.ts)))
          .attr("y2", (d) => (radius + 10) * Math.sin(angle(d.ts)))
          .attr("stroke", color(cls))
          .attr("stroke-width", 1)
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
        svg
          .append("text")
          .attr("x", cx + (OUTER_R + 45) * Math.cos(a))
          .attr("y", cy + (OUTER_R + 25) * Math.sin(a))
          .attr("text-anchor", "middle")
          .attr("alignment-baseline", "middle")
          .style("font-size", "10px")
          .style("fill", "#f5f5f5")
          .text(txt);
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
