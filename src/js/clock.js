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
  let DATA_URL = config.dataUrl || `${API_BASE_URL}/audio_logs`;
  const urlParams = [];
  if (config.offsetHours) {
    urlParams.push(`offsetHours=${encodeURIComponent(config.offsetHours)}`);
  }
  if (config.binSeconds) {
    urlParams.push(`binSeconds=${encodeURIComponent(config.binSeconds)}`);
  }
  if (urlParams.length > 0) {
    DATA_URL += `?${urlParams.join("&")}`;
  }
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

    if (typeof config.onApiFetchStart === "function") config.onApiFetchStart();
    d3.json(DATA_URL).then((raw) => {
      if (typeof config.onApiFetchEnd === "function") config.onApiFetchEnd();
      if (!raw || !Array.isArray(raw.data)) {
        console.error("Unexpected data format: expected an object with a data array");
        return;
      }

      if (typeof config.onD3Start === "function") config.onD3Start();
      // DEBUG: log first object to inspect available fields
      if (raw.data.length > 0) {
        console.log('[clock.js] First API object:', raw.data[0]);
      }
      dataCache = raw.data
        .map((d) => ({
          ts: d.ts !== undefined ? +d.ts : (d.raw_ts !== undefined ? +d.raw_ts : NaN),
          class: d.c1_idx,
          cf: +d.c1_cf,
          name: idxToNameMap[d.c1_idx] || `Unknown (${d.c1_idx})`,
        }))
        .sort((a, b) => a.ts - b.ts);

      if (!dataCache.length) {
        console.warn("no data");
        if (typeof config.onD3End === "function") config.onD3End();
        return;
      }

      // BINNING: above event threshold, bin by class and 30 seconds (1 event per class per 30s)
      // If server-side binning is used, no need to bin again client-side
      let binnedData = dataCache;
      if (!config.binSeconds && dataCache.length > 2000) {
        // Bin by class and 30-second interval (NYC time)
        const binMap = new Map();
        dataCache.forEach((d) => {
          const date = new Date(d.ts * 1000);
          const nyc = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const secondsOfDay = nyc.getHours() * 3600 + nyc.getMinutes() * 60 + nyc.getSeconds();
          const bin = Math.floor(secondsOfDay / 30); // 30-second bins
          const key = `${d.class}_${bin}`;
          // Keep the event with the highest confidence for this class/bin
          if (!binMap.has(key) || d.cf > binMap.get(key).cf) {
            binMap.set(key, d);
          }
        });
        binnedData = Array.from(binMap.values());
      }

      // Always use a 24-hour window ending at the latest timestamp
      tsMax = binnedData[binnedData.length - 1].ts;
      tsMin = tsMax - 24 * 3600;

      // initial full-range draw
      if (typeof config.onD3Start === "function") config.onD3Start(); // mark D3 start for draw
      draw();
      if (typeof config.onD3End === "function") config.onD3End();
      window.addEventListener("resize", draw);

      // Adjust the draw function to always use the 24-hour window
      function draw() {
        const t0 = tsMin;
        const t1 = tsMax;

        // Calculate responsive inner and outer radii
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025; // 2.5% of the smaller dimension
        const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45; // 45% of the smaller dimension

        // filter data to 24h window
        console.log('[clock.js] binnedData.length:', binnedData.length);
        if (binnedData.length) {
          const tsVals = binnedData.map(d => d.ts);
          console.log('[clock.js] binnedData ts min:', Math.min(...tsVals), 'max:', Math.max(...tsVals));
          console.log('[clock.js] filter window t0:', t0, 't1:', t1);
        }
        const data = binnedData.filter((d) => d.ts >= t0 && d.ts <= t1);
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
        const minDateStr = new Date(t0 * 1000).toDateString();
        const maxDateStr = new Date(t1 * 1000).toDateString();
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

        // --- NEW: Fixed time-of-day anchors for the clock ---
        // Helper: get NYC time-of-day in seconds since midnight
        function getNYCSecondsSinceMidnight(ts) {
          const date = new Date(ts * 1000);
          const nyc = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          return nyc.getHours() * 3600 + nyc.getMinutes() * 60 + nyc.getSeconds();
        }

        // Angle: 0 seconds (midnight) at -π/2, 6am at 0, 12pm at π/2, 6pm at π, back to midnight at 3π/2
        const angle = d3
          .scaleLinear()
          .domain([0, 24 * 3600])
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
          const eventAngle = angle(getNYCSecondsSinceMidnight(d.ts));
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
            // Use NYC time-of-day for angle
            .attr("x1", (d) => (radius - lineBuffer) * Math.cos(angle(getNYCSecondsSinceMidnight(d.ts))))
            .attr("y1", (d) => (radius - lineBuffer) * Math.sin(angle(getNYCSecondsSinceMidnight(d.ts))))
            .attr("x2", (d) => (radius + lineBuffer) * Math.cos(angle(getNYCSecondsSinceMidnight(d.ts))))
            .attr("y2", (d) => (radius + lineBuffer) * Math.sin(angle(getNYCSecondsSinceMidnight(d.ts))))
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
              tooltip.text(`${d.name}, ${label}`).style("visibility", "visible");
            })
            .on("mousemove", (event) => {
              tooltip
                .style("top", `${event.pageY + 10}px`)
                .style("left", `${event.pageX + 10}px`);
            })
            .on("mouseout", () => tooltip.style("visibility", "hidden"));
        });

        // --- NEW: Fixed time labels at 12am, 6am, 12pm, 6pm ---
        const labelTimes = [
          { label: "12:00 AM", seconds: 0, angle: -Math.PI / 2 },
          { label: "6:00 AM", seconds: 6 * 3600, angle: 0 },
          { label: "12:00 PM", seconds: 12 * 3600, angle: Math.PI / 2 },
          { label: "6:00 PM", seconds: 18 * 3600, angle: Math.PI },
        ];
        labelTimes.forEach(({ label, angle: a }) => {
          const textX = cx + (OUTER_R + 45) * Math.cos(a);
          const textY = cy + (OUTER_R + 25) * Math.sin(a);
          const textElement = svg.append("text")
            .attr("x", textX)
            .attr("y", textY)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .style("font-size", "0.75rem")
            .style("fill", "#f5f5f5")
            .text(label);
          const bbox = textElement.node().getBBox();
          svg.insert("rect", "text")
            .attr("x", bbox.x - 2)
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
