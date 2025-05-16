import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const inputHours = config.hours || 24; // todo fix for dynamic ranges - only works for 24h rn

  // calculate the most recent local midnight timestamp
  const now = new Date();
  const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  // now.setHours(0, 0, 0, 0); // set to local midnight
  // const midnightLocal = Math.floor(now.getTime() / 1000);
  // Fetch enough data to cover from previous midnight to now (input param + time since midnight)
  const fetchHours = inputHours + secondsSinceMidnight / 3600;

  // Consolidate API endpoints at the top for easier config
  const API_BASE_URL = config.apiBaseUrl || "https://rhythmanalysis.onrender.com/api";
  const DATA_URL = config.dataUrl || `${API_BASE_URL}/audio_logs?hours=${fetchHours}`;
  const CLASS_MAP_API = config.classMapUrl || `${API_BASE_URL}/yamnet_class_map`;

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

  // map yamnet indices from api to human-readable names
  // fetch the mapping json from the API
  d3.json(CLASS_MAP_API).then((mappingData) => {
    const idxToNameMap = {};
    mappingData.forEach((row) => {
      idxToNameMap[row.index] = row.display_name; // use "index" and "display_name" columns
    });

    d3.json(DATA_URL).then((raw) => {
      if (!Array.isArray(raw)) {
        console.error("Unexpected data format: expected an array");
        return;
      }

      dataCache = raw
        .map((d) => {
          const rawTs = +d.ts;
          const offsetSec = new Date(rawTs * 1000).getTimezoneOffset() * 60;
          return {
            ts: rawTs + offsetSec,
            class: d.cl,
            cf: +d.cf,
            name: idxToNameMap[d.cl] || `Unknown (${d.cl})`, // Map idx to name dynamically
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

      // initial full-range draw
      draw();
      window.addEventListener("resize", draw);

      // Adjust the draw function to always use the full range
      function draw() {
        const t0 = tsMin;
        const t1 = tsMax;

        // Calculate responsive inner and outer radii
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025; // 2.5% of the smaller dimension
        const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45; // 45% of the smaller dimension

        // filter data (or take full cache)
        const data = dataCache.filter((d) => d.ts >= t0 && d.ts <= t1);
        if (!data.length) {
          console.warn("no data in selected range");
          return;
        }

        // SVG sizing
        const w = window.innerWidth * 0.85;
        const h = window.innerHeight;
        const svg = container
          .select("svg")
          .attr("width", w)
          .attr("height", h);
        svg.selectAll("*").remove();
        const cx = w / 2, cy = h / 2;

        // Add a label in the top left corner showing the date or date range of data visualization
        const minDateStr = new Date(tsMin * 1000).toDateString();
const maxDateStr = new Date(tsMax * 1000).toDateString();
        const visualizationDate = (minDateStr === maxDateStr)
          ? minDateStr
          : `${minDateStr} - ${maxDateStr}`;

        const topLeftTextX = 20; // X position for the label
        const topLeftTextY = 20; // Y position for the label

        // Add background rectangle for the label
        const topLeftTextElement = svg.append("text")
          .attr("x", topLeftTextX)
          .attr("y", topLeftTextY)
          .attr("text-anchor", "start")
          .attr("dominant-baseline", "middle") // vertical centering
          .style("font-size", "0.75rem") // responsive font size
          .style("fill", "#f5f5f5")
          .text(visualizationDate);

        const topLeftBBox = topLeftTextElement.node().getBBox();
        svg.insert("rect", "text")
          .attr("x", topLeftBBox.x - 2) // Add padding
          .attr("y", topLeftBBox.y - 2)
          .attr("width", topLeftBBox.width + 4)
          .attr("height", topLeftBBox.height + 4)
          .style("fill", "black");

        // Find the timestamp for midnight (00:00) on the earliest date in the data
        const minDate = new Date(tsMin * 1000);
        minDate.setHours(0, 0, 0, 0); // Set to midnight
        const midnightTs = Math.floor(minDate.getTime() / 1000);

        // map [t0…t1] → [–π/2…3π/2], but rotate so that midnight is at –π/2 (top)
        const angle = d3
          .scaleLinear()
          .domain([midnightTs, midnightTs + 24 * 60 * 60])
          .range([-Math.PI / 2, (3 * Math.PI) / 2]);

        // class counts
        const classCounts = d3.rollup(
          data,
          (v) => v.length,
          (d) => d.class
        );
        const sortedClasses = Array.from(classCounts.entries()).sort((a, b) => a[1] - b[1]);

        // drop the bottom N% least-frequently occurring classes
        const cutoffIndex = Math.floor(sortedClasses.length * 0.666);
        const filteredClasses = sortedClasses.slice(cutoffIndex).map(([cls]) => cls);

        const color = d3.scaleOrdinal(filteredClasses, d3.schemeCategory10);

        const ringScale = d3
          .scalePow()
          .exponent(2) // Use an exponent of 2 for exponential scaling
          .domain([0, filteredClasses.length - 1])
          .range([INNER_R, OUTER_R]);

        // background circle
        svg
          .append("circle")
          .attr("cx", cx)
          .attr("cy", cy)
          .attr("r", OUTER_R)
          .style("fill", "none")
          .style("stroke", "#aaaaaa24");

        const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

        function computeOpacity(d, currentDatelineAngle) {
          if (currentDatelineAngle === null) return 1.0;
          const eventAngle = angle(d.ts);
          let delta = (currentDatelineAngle - eventAngle) % (2 * Math.PI);
          if (delta < 0) delta += 2 * Math.PI;
          const norm = delta / (2 * Math.PI * (config.hours || 24) / 24); // [0,1]
          // linear fade from newest to oldest timestamps
          const minOpacity = 0.33;
          const opacity = 1 - (1 - minOpacity) * norm;
          const cfScale = d3.scaleLinear().domain([0, 100]).range([0.1, 1]);
          return opacity * cfScale(d.cf || 0);
        }

        // draw radial at current time
        let dateline = null;
        let currentDatelineAngle = null; // Store the dateline angle for opacity calculation
        function drawDateline() {
          // rm previous dateline if it exists
          if (dateline) dateline.remove();
          // current time in NY
          const localTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const secondsSinceMidnightNY = localTime.getHours() * 3600 + localTime.getMinutes() * 60 + localTime.getSeconds();
          // to tick based on input time range
          const hoursVisible = config.hours || 24;
          const fractionOfRange = secondsSinceMidnightNY / (hoursVisible * 3600);
          // angle: start at -π/2, sweep 2π * (hoursVisible/24) for the visible range
          const angleRange = 2 * Math.PI * (hoursVisible / 24);
          const dateLineAngle = -Math.PI / 2 + fractionOfRange * angleRange;
          currentDatelineAngle = dateLineAngle; // Save for use in opacity calculation
          dateline = svg.append("line")
            .attr("x1", cx + INNER_R * Math.cos(dateLineAngle))
            .attr("y1", cy + INNER_R * Math.sin(dateLineAngle))
            .attr("x2", cx + OUTER_R * Math.cos(dateLineAngle))
            .attr("y2", cy + OUTER_R * Math.sin(dateLineAngle))
            .attr("stroke", "#fff")
            .attr("stroke-width", 0.333);
          // Update opacity of all event lines to match new dateline position
          g.selectAll("line.event-line").attr("opacity", function(d) {
            return computeOpacity(d, currentDatelineAngle);
          });
        }
        drawDateline();
        // tick every N seconds
        const tickInterval = 100000; // db update time - one minute in ms
        if (window._clockDatelineInterval) clearInterval(window._clockDatelineInterval);
        window._clockDatelineInterval = setInterval(() => {
          drawDateline();
        }, tickInterval);

        // draw each class ring
        filteredClasses.forEach((cls, i) => {
          const radius = ringScale(i);
          g.append("circle")
            .attr("r", radius)
            .style("fill", "none")
            .style("stroke", "#aaaaaa24");

          // draw classified events
          let lineBuffer = 1.5;
          g.selectAll(`.line-${i}`)
            .data(data.filter((d) => d.class === cls))
            .join("line")
            .attr("class", `line-${i} event-line`)
            // extend the tickmark beyond the radius with a buffer to make it more visible
            .attr("x1", (d) => (radius - lineBuffer) * Math.cos(angle(d.ts)))
            .attr("y1", (d) => (radius - lineBuffer) * Math.sin(angle(d.ts)))
            .attr("x2", (d) => (radius + lineBuffer) * Math.cos(angle(d.ts)))
            .attr("y2", (d) => (radius + lineBuffer) * Math.sin(angle(d.ts)))
            .attr("stroke", color(cls))
            .attr("stroke-width", 1.5)
            .attr("opacity", (d) => computeOpacity(d, currentDatelineAngle))
            .on("mouseover", (event, d) => {
              const tsMs = d.ts * 1000;
              const label = new Date(tsMs).toLocaleString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "America/New_York",
              });
              tooltip.text(`${d.name}, ${label}`).style("visibility", "visible"); // Use human-readable name
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

        labelPos.forEach(({ angle: a }, idx) => {
          // For 12, 3, 6, 9 o'clock, get the corresponding timestamp in the 24h cycle
          const ts = invAngle(a);
          const tsMs = ts * 1000;
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
            .attr("dominant-baseline", "middle") // vertical centering
            .style("font-size", "0.75rem") // responsive font size
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
          .filter(([cls]) => filteredClasses.includes(cls))
          .sort((a, b) => b[1] - a[1])
          .map(([cls, count]) => ({ name: idxToNameMap[cls] || `Unknown (${cls})`, count, cls })); 

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
          .style("background-color", (d) => color(d.cls)); 

        legendItem.append("span")
          .style("font-size", "0.85rem") // responsive font size
          .text((d) => `${d.name} (${d.count})`); // Display human-readable names in the legend
      }

      // Call the onDataReady callback after the visualization is fully rendered
      if (typeof config.onDataReady === "function") {
        config.onDataReady();
      }
    });
  }).catch((error) => {
    console.error("Failed to load the mapping JSON:", error);
  });
}
