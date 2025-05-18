import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const inputHours = config.hours || 24; // default 24h range
  const now = new Date();
  const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  // Fetch enough data to cover from previous midnight to now (ensure midnight anchor)
  const fetchHours = inputHours + secondsSinceMidnight / 3600;
  console.log(fetchHours)

  // API endpoints and parameters
  const API_BASE_URL = config.apiBaseUrl || "https://rhythmanalysis.onrender.com/api";
  const DATA_URL = config.dataUrl || `${API_BASE_URL}/audio_logs?hours=${fetchHours}`;
  const CLASS_MAP_API = config.classMapUrl || `${API_BASE_URL}/yamnet_class_map`;
  const UPDATE_INTERVAL = config.updateInterval || 1000;  // 15 seconds
  const hoursVisible = config.hours || 24;                 // hours in view (24h static)


  // Set up container and sub-containers
  const container = d3.select(`#${containerId}`);
  container.style("display", "flex").style("align-items", "flex-start");

  let filterContainer = container.select(".time-filters");
  if (filterContainer.empty()) {
    filterContainer = container.insert("div", ":first-child")
      .attr("class", "time-filters")
      .style("margin-bottom", "16px");
  }
  filterContainer.style("display", "none");

  let legendContainer = container.select(".legend");
  if (legendContainer.empty()) {
    legendContainer = container.append("div").attr("class", "legend");
  }
  legendContainer
    .style("overflow-y", "auto")
    .style("max-height", "100vh")
    .style("margin-left", "16px");

  // Tooltip for event hover
  const tooltip = d3.select("body").append("div")
    .attr("class", "tooltip")
    .style("position", "absolute")
    .style("padding", "5px 10px")
    .style("background", "rgba(0, 0, 0, 0.7)")
    .style("color", "#fff")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("pointer-events", "none")
    .style("visibility", "hidden");

  // Data cache and state
  let dataCache = [];
  let tsMin = Infinity, tsMax = -Infinity;
  let lastFetchedRaw = null;
  let updating = false;
  const cfScale = d3.scaleLinear().domain([0, 100]).range([0.1, 1]);  // confidence->opacity scale

  // Fetch class name mapping
  d3.json(CLASS_MAP_API).then((mappingData) => {
    const idxToNameMap = {};
    mappingData.forEach(row => {
      idxToNameMap[row.index] = row.display_name;
    });

    // Initial data fetch
    d3.json(DATA_URL).then((raw) => {
      if (!Array.isArray(raw)) {
        console.error("Unexpected data format: expected an array");
        return;
      }

      dataCache = raw.map(d => {
          const rawTs = +d.ts;
          return {
            origTs: rawTs,
            ts: rawTs, // keep as UTC
            class: d.cl,
            cf: +d.cf,
            name: idxToNameMap[d.cl] || `Unknown (${d.cl})`
          };
        })
        .sort((a, b) => a.ts - b.ts);

      if (!dataCache.length) {
        console.warn("no data");
        return;
      }

      // Set initial time range and state
      tsMin = dataCache[0].ts;
      tsMax = dataCache[dataCache.length - 1].ts;
      lastFetchedRaw = dataCache[dataCache.length - 1].origTs;

      // After updating dataCache and tsMax:
      const windowEnd = tsMax;
      const windowStart = windowEnd - hoursVisible * 3600;
      console.log('[DEBUG] tsMin:', tsMin, 'tsMax:', tsMax, 'windowStart:', windowStart, 'windowEnd:', windowEnd);
      console.log('[DEBUG] dataCache.length (after initial fetch):', dataCache.length);
      dataCache = dataCache.filter(d => d.ts >= windowStart && d.ts <= windowEnd);
      console.log('[DEBUG] dataCache.length (after window filter):', dataCache.length);

      // Initial full-range render
      draw();
      window.addEventListener("resize", draw);

      // Set up periodic updates (15s interval)
      if (window._clockDatelineInterval) clearInterval(window._clockDatelineInterval);
      if (window._clockUpdateInterval) clearInterval(window._clockUpdateInterval);
      window._clockUpdateInterval = setInterval(() => {
        if (updating) return;
        updating = true;
        const nowUTC = Math.floor(Date.now() / 1000);
        // Fetch new records from last fetched timestamp up to current time
        const startTs = lastFetchedRaw + 1;
        const endTs = nowUTC;
        const updateUrl = `${API_BASE_URL}/audio_logs?start=${startTs}&end=${endTs}`;
        d3.json(updateUrl).then(newRaw => {
          if (Array.isArray(newRaw) && newRaw.length) {
            // Process and merge new data
            const newData = newRaw.map(d => {
              const rawTs = +d.ts;
              return {
                origTs: rawTs,
                ts: rawTs, // keep as UTC
                class: d.cl,
                cf: +d.cf,
                name: idxToNameMap[d.cl] || `Unknown (${d.cl})`
              };
            }).sort((a, b) => a.ts - b.ts);
            dataCache = dataCache.concat(newData).sort((a, b) => a.ts - b.ts);
            lastFetchedRaw = newData[newData.length - 1].origTs;
          }
        }).catch(err => {
          console.error("Data update failed:", err);
        }).finally(() => {
          // Prune data older than 24h
          const rangeSec = hoursVisible * 3600;
          const nowUTC = Math.floor(Date.now() / 1000);
          const cutoffTs = nowUTC - rangeSec;
          dataCache = dataCache.filter(d => d.ts >= cutoffTs);
          if (!dataCache.length) {
            tsMin = Infinity;
            tsMax = -Infinity;
          } else {
            tsMin = dataCache[0].ts;
            tsMax = dataCache[dataCache.length - 1].ts;
          }
          // Always call draw for rendering
          draw();
          updating = false;
        });
      }, UPDATE_INTERVAL);

      // Callback when initial data is ready
      if (typeof config.onDataReady === "function") {
        config.onDataReady();
      }

      // -------- Draw function (for initial render & resize) --------
      function draw() {
        // Use the latest data timestamp as the end of the window
        const windowEnd = tsMax;
        const windowStart = windowEnd - hoursVisible * 3600;
        console.log('[DRAW] windowStart:', windowStart, 'windowEnd:', windowEnd);

        // Responsive radii
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025;
        const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45;
        // Filter data for the visible window
        const data = dataCache.filter(d => d.ts >= windowStart && d.ts <= windowEnd);
        if (!data.length) {
          console.warn('[DRAW] no data in selected range');
          return;
        }
        console.log('[DRAW] data.length (filtered for window):', data.length);
        if (data.length > 0) {
          console.log('[DRAW] First event ts:', data[0].ts, 'date:', new Date(data[0].ts * 1000).toISOString());
          console.log('[DRAW] Last event ts:', data[data.length-1].ts, 'date:', new Date(data[data.length-1].ts * 1000).toISOString());
        }
        // Initialize SVG canvas
        const w = viewportWidth * 0.85;
        const h = viewportHeight;
        const svg = container.select("svg").empty()
          ? container.append("svg")
          : container.select("svg");
        svg.attr("width", w).attr("height", h);
        svg.selectAll("*").remove();
        const cx = w / 2, cy = h / 2;

        // Date range label (top-left)
        const minDateStr = new Date(windowStart * 1000).toDateString();
        const maxDateStr = new Date(windowEnd * 1000).toDateString();
        const visualizationDate = (minDateStr === maxDateStr) ? minDateStr : `${minDateStr} - ${maxDateStr}`;
        const topLeftText = svg.append("text")
          .attr("class", "date-range-label")
          .attr("x", 20)
          .attr("y", 20)
          .attr("text-anchor", "start")
          .attr("dominant-baseline", "middle")
          .style("font-size", "0.75rem")
          .style("fill", "#f5f5f5")
          .text(visualizationDate);
        const topLeftBBox = topLeftText.node().getBBox();
        svg.insert("rect", "text")
          .attr("class", "date-range-bg")
          .attr("x", topLeftBBox.x - 2)
          .attr("y", topLeftBBox.y - 2)
          .attr("width", topLeftBBox.width + 4)
          .attr("height", topLeftBBox.height + 4)
          .style("fill", "black");

        // Angle scale for the visible window
        const angle = d3.scaleLinear()
          .domain([windowStart, windowEnd])
          .range([-Math.PI / 2, (3 * Math.PI) / 2]);

        // Determine and filter top N% classes for display (use legend logic)
        const classCounts = d3.rollup(data, v => v.length, d => d.class);
        const sortedClasses = Array.from(classCounts.entries()).sort((a, b) => a[1] - b[1]); // ascending: lowest freq first
        const cutoffIndex = Math.floor(sortedClasses.length * 0.666);
        const filteredClasses = sortedClasses.slice(cutoffIndex).map(([cls]) => cls); // keep top 1/3 by frequency
        const color = d3.scaleOrdinal(filteredClasses, d3.schemeCategory10);
        const ringScale = d3.scalePow().exponent(2)
          .domain([0, filteredClasses.length - 1])
          .range([INNER_R, OUTER_R]);

        // Outer boundary circle
        svg.append("circle")
          .attr("cx", cx)
          .attr("cy", cy)
          .attr("r", OUTER_R)
          .style("fill", "none")
          .style("stroke", "#aaaaaa24");

        const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

        // Opacity helper
        function computeOpacity(d, currentAngle) {
          if (currentAngle == null) return 1.0;
          const eventAngle = angle(d.ts);
          let delta = (currentAngle - eventAngle) % (2 * Math.PI);
          if (delta < 0) delta += 2 * Math.PI;
          const norm = delta / (2 * Math.PI * (hoursVisible / 24));
          const minOpacity = 0.33;
          const baseOpacity = 1 - (1 - minOpacity) * norm;
          return baseOpacity * cfScale(d.cf || 0);
        }

        // Draw current time radial line (dateline)
        const currentDatelineAngle = angle(windowEnd);
        svg.append("line")
          .attr("class", "dateline-line")
          .attr("x1", cx + INNER_R * Math.cos(currentDatelineAngle))
          .attr("y1", cy + INNER_R * Math.sin(currentDatelineAngle))
          .attr("x2", cx + OUTER_R * Math.cos(currentDatelineAngle))
          .attr("y2", cy + OUTER_R * Math.sin(currentDatelineAngle))
          .attr("stroke", "#fff")
          .attr("stroke-width", 0.333);

        // Draw rings and event tick marks for each visible class (use legend order)
        filteredClasses.forEach((cls, i) => {
          const radius = ringScale(i);
          g.append("circle")
            .attr("class", "class-ring")
            .attr("r", radius)
            .style("fill", "none")
            .style("stroke", "#aaaaaa24");

          // Use .join with a key for proper enter/update/exit
          g.selectAll(`.line-${i}`)
            .data(data.filter(d => d.class === cls), d => `${d.class}-${d.ts}`)
            .join(
              enter => enter.append("line")
                .attr("class", `line-${i} event-line`)
                .attr("x1", d => (radius - 1.5) * Math.cos(angle(d.ts)))
                .attr("y1", d => (radius - 1.5) * Math.sin(angle(d.ts)))
                .attr("x2", d => (radius + 1.5) * Math.cos(angle(d.ts)))
                .attr("y2", d => (radius + 1.5) * Math.sin(angle(d.ts)))
                .attr("stroke", color(cls))
                .attr("stroke-width", 1.5)
                .attr("opacity", d => computeOpacity(d, currentDatelineAngle))
                .on("mouseover", (event, d) => {
                  const tsMs = d.ts * 1000;
                  const timeLabel = new Date(tsMs).toUTCString().slice(17, 22); // HH:MM in UTC
                  tooltip.text(`${d.name}, ${timeLabel}`).style("visibility", "visible");
                })
                .on("mousemove", event => {
                  tooltip.style("top", `${event.pageY + 10}px`).style("left", `${event.pageX + 10}px`);
                })
                .on("mouseout", () => tooltip.style("visibility", "hidden")),
              update => update
                .attr("x1", d => (radius - 1.5) * Math.cos(angle(d.ts)))
                .attr("y1", d => (radius - 1.5) * Math.sin(angle(d.ts)))
                .attr("x2", d => (radius + 1.5) * Math.cos(angle(d.ts)))
                .attr("y2", d => (radius + 1.5) * Math.sin(angle(d.ts)))
                .attr("stroke", color(cls))
                .attr("stroke-width", 1.5)
                .attr("opacity", d => computeOpacity(d, currentDatelineAngle)),
              exit => exit.remove()
            );
        });

        // Clock face labels at 12, 3, 6, 9 o'clock
        const labelAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
        const invAngle = d3.scaleLinear().domain(angle.range()).range(angle.domain());
        labelAngles.forEach(a => {
          const ts = invAngle(a);
          const tsMs = ts * 1000;
          const txt = new Date(tsMs).toUTCString().slice(17, 22); // HH:MM in UTC
          const textX = cx + (OUTER_R + 45) * Math.cos(a);
          const textY = cy + (OUTER_R + 25) * Math.sin(a);
          const textElem = svg.append("text")
            .attr("class", "clock-label")
            .attr("x", textX)
            .attr("y", textY)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .style("font-size", "0.75rem")
            .style("fill", "#f5f5f5")
            .text(txt);
          const bbox = textElem.node().getBBox();
          svg.insert("rect", "text")
            .attr("class", "clock-label-bg")
            .attr("x", bbox.x - 2)
            .attr("y", bbox.y - 2)
            .attr("width", bbox.width + 4)
            .attr("height", bbox.height + 4)
            .style("fill", "black");
        });

        // Legend (show filtered class names and counts)
        legendContainer.selectAll("*").remove();
        const legendItems = Array.from(classCounts.entries())
          .filter(([cls]) => filteredClasses.includes(cls))
          .sort((a, b) => b[1] - a[1])
          .map(([cls, count]) => ({ name: idxToNameMap[cls] || `Unknown (${cls})`, count, cls }));
        const itemDiv = legendContainer.selectAll(".item")
          .data(legendItems)
          .join("div")
          .attr("class", "item")
          .style("margin-bottom", "4px");
        itemDiv.append("span")
          .style("display", "inline-block")
          .style("width", "12px")
          .style("height", "12px")
          .style("margin-right", "6px")
          .style("background-color", d => color(d.cls));
        itemDiv.append("span")
          .style("font-size", "0.85rem")
          .text(d => `${d.name} (${d.count})`);
      } // end draw()
    });
  }).catch(error => {
    console.error("Failed to load the mapping JSON:", error);
  });
}
