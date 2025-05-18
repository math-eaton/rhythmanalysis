import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const inputHours = config.hours || 24;       // rolling window in hours
  const hoursVisible = inputHours;
  // compute UTC-based start/end for full rolling window
  const nowUTC = Math.floor(Date.now() / 1000);
  const startUTC = nowUTC - hoursVisible * 3600;
  console.log("UTC start:", new Date(startUTC * 1000).toISOString());
  console.log("UTC end:", new Date(nowUTC * 1000).toISOString());

  // API endpoints and parameters
  const API_BASE_URL = config.apiBaseUrl || "https://rhythmanalysis.onrender.com/api";
  // initial fetch: get full last X hours explicitly
  const DATA_URL = config.dataUrl || `${API_BASE_URL}/audio_logs?start=${startUTC}&end=${nowUTC}`;
  const CLASS_MAP_API = config.classMapUrl || `${API_BASE_URL}/yamnet_class_map`;
  const UPDATE_INTERVAL = config.updateInterval || 15000;  // 15 seconds

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
      console.log(
        `[clock] Initial fetch returned ${
          Array.isArray(raw) ? raw.length : 0
        } records (UTC ${new Date(startUTC * 1000).toISOString()} → ${new Date(nowUTC * 1000).toISOString()})`
      );
      if (!Array.isArray(raw)) {
        console.error("Unexpected data format: expected an array");
        return;
      }

      dataCache = raw
        .map(d => {
          const rawTs = Math.floor(+d.ts);    // ← floor once
          return {
            origTs: rawTs,
            ts: rawTs,
            class: d.cl,
            cf: +d.cf,
            name: idxToNameMap[d.cl] || `Unknown (${d.cl})`
          };
        })
        .sort((a, b) => a.ts - b.ts);
      console.log(`[clock] dataCache initialized with ${dataCache.length} records`);

      if (!dataCache.length) {
        console.warn("no data");
        return;
      }

      tsMin = dataCache[0].ts;
      tsMax = dataCache[dataCache.length - 1].ts;
      lastFetchedRaw = dataCache[dataCache.length - 1].origTs;
      console.log(
        `[clock] time range set tsMin=${new Date(tsMin * 1000).toISOString()} tsMax=${new Date(tsMax * 1000).toISOString()}`
      );

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
        // Prune and filter using UTC only
        const cutoffTs = nowUTC - hoursVisible * 3600;
        // Fetch new records from last fetched timestamp up to current time
        const startTs = Math.floor(lastFetchedRaw) + 1;  // ← force integer
        const endTs = nowUTC;
        const updateUrl = `${API_BASE_URL}/audio_logs?start=${startTs}&end=${endTs}`;
        console.log(
          `[clock] Fetching updates from ${new Date(startTs * 1000).toISOString()} → ${new Date(endTs * 1000).toISOString()}`
        );
        console.log(`[clock] update URL: ${updateUrl}`);
        d3.json(updateUrl).then(newRaw => {
          if (Array.isArray(newRaw) && newRaw.length > 0) {
            console.log(`[clock] Received ${newRaw.length} new records`);
            const newData = newRaw
              .map(d => {
                const rawTs = Math.floor(+d.ts);  // ← floor here too
                return {
                  origTs: rawTs,
                  ts: rawTs, // now integer
                  class: d.cl,
                  cf: +d.cf,
                  name: idxToNameMap[d.cl] || `Unknown (${d.cl})`
                };
              })
              .sort((a, b) => a.ts - b.ts);
            dataCache = dataCache.concat(newData).sort((a, b) => a.ts - b.ts);
            lastFetchedRaw = newData.length ? newData[newData.length - 1].origTs : lastFetchedRaw;
            console.log(`[clock] dataCache length after merge: ${dataCache.length}`);
          }
        }).catch(err => {
          console.error("Data update failed:", err);
        }).finally(() => {
          // Prune anything older than now–24h
          dataCache = dataCache.filter(d => d.ts >= nowUTC - hoursVisible * 3600);
          console.log(
            `[clock] dataCache length after prune (cutoff ${new Date(cutoffTs * 1000).toISOString()}): ${
              dataCache.length
            }`
          );

          // Determine classes in full window, sort by freq, then filter top 33%
          const classCounts = d3.rollup(dataCache, v => v.length, d => d.class);
          const allClassesSorted = Array.from(classCounts.entries())
            .sort(([, c1], [, c2]) => c1 - c2)
            .map(([cls]) => cls);
          const cutoffIndex = Math.floor(allClassesSorted.length * 0.666);
          const filteredClasses = allClassesSorted.slice(cutoffIndex);
          console.log(
            `[clock] classCounts size=${classCounts.size}, filteredClasses (${filteredClasses.length}):`,
            filteredClasses
          );

          // Update legend items
          legendContainer.selectAll("*").remove();
          const legendData = Array.from(classCounts.entries())
            .filter(([cls]) => filteredClasses.includes(cls))
            .sort((a, b) => b[1] - a[1])
            .map(([cls, count]) => ({
              cls,
              name: idxToNameMap[cls] || `Unknown (${cls})`,
              count
            }));
          const legendItems = legendContainer.selectAll(".item")
            .data(legendData)
            .join("div")
            .attr("class", "item")
            .style("margin-bottom", "4px");
          legendItems.append("span")
            .style("display", "inline-block")
            .style("width", "12px")
            .style("height", "12px")
            .style("margin-right", "6px")
            .style("background-color", d => d3.schemeCategory10[filteredClasses.indexOf(d.cls) % 10]);
          legendItems.append("span")
            .style("font-size", "0.85rem")
            .text(d => `${d.name} (${d.count})`);

          updating = false;
          // Redraw the visualization with new data
          draw();
        });
      }, UPDATE_INTERVAL);

      // Callback when initial data is ready
      if (typeof config.onDataReady === "function") {
        config.onDataReady();
      }

      // -------- Draw function (for initial render & resize) --------
      function draw() {
        const nowSec = Math.floor(Date.now() / 1000);
        const t0  = nowSec - hoursVisible * 3600;
        const t1  = nowSec;
        // Responsive radii
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025;
        const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45;
        // Filter data for full rolling window
        const data = dataCache.filter(d => d.ts >= t0 && d.ts <= t1);
        // Determine classes for this draw()
        const classCounts = d3.rollup(data, v => v.length, d => d.class);
        const allClassesSorted = Array.from(classCounts.entries())
          .sort(([, c1], [, c2]) => c1 - c2)
          .map(([cls]) => cls);
        const filteredClasses = allClassesSorted.slice(Math.floor(allClassesSorted.length * 0.666));
        console.log(
          `[clock] draw(): rendering ${data.length} records over ${filteredClasses.length} classes`
        );
        if (!data.length) {
          console.warn("no data in selected range");
          return;
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
        const minDateStr = new Date(tsMin * 1000).toDateString();
        const maxDateStr = new Date(tsMax * 1000).toDateString();
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

        // --- NYC midnight calculation for clock face ---
        // Get current date in NYC
        const now = new Date();
        const nycDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        nycDate.setHours(0, 0, 0, 0); // NYC midnight today
        // Get UTC timestamp for NYC midnight
        const nycMidnightUTC = Math.floor(nycDate.getTime() / 1000);
        // Angle scale: NYC midnight at top, 24h window
        const angle = d3.scaleLinear()
          .domain([t0, t1])
          .range([-Math.PI / 2, (3 * Math.PI) / 2]);

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

        // Draw current time radial line
        let currentDatelineAngle = null;
        function drawDateline() {
          svg.select("line.dateline-line")?.remove();
          // compute current time angle (NY timezone for display only)
          const nowUTC = Math.floor(Date.now() / 1000);
          const localTime = new Date(new Date(nowUTC * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const secMidnightNY = localTime.getHours() * 3600 + localTime.getMinutes() * 60 + localTime.getSeconds();
          const fracOfRange = secMidnightNY / (hoursVisible * 3600);
          const angleRange = 2 * Math.PI * (hoursVisible / 24);
          currentDatelineAngle = -Math.PI / 2 + fracOfRange * angleRange;
          svg.append("line")
            .attr("class", "dateline-line")
            .attr("x1", cx + INNER_R * Math.cos(currentDatelineAngle))
            .attr("y1", cy + INNER_R * Math.sin(currentDatelineAngle))
            .attr("x2", cx + OUTER_R * Math.cos(currentDatelineAngle))
            .attr("y2", cy + OUTER_R * Math.sin(currentDatelineAngle))
            .attr("stroke", "#fff")
            .attr("stroke-width", 0.333);
          g.selectAll("line.event-line").attr("opacity", d => computeOpacity(d, currentDatelineAngle));
        }
        drawDateline();
        // (Dateline will be updated via the interval; no separate timer here)

        // Draw rings and tick marks for each filtered class
        filteredClasses.forEach((cls, i) => {
          const radius = ringScale(i);
          g.append("circle")
            .attr("class", "class-ring")
            .attr("r", radius)
            .style("fill", "none")
            .style("stroke", "#aaaaaa24");

          g.selectAll(`.line-${i}`)
            .data(data.filter(d => d.class === cls))
            .join("line")
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
              // Tooltip in NYC time
              const timeLabel = new Date(tsMs).toLocaleString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "America/New_York"
              });
              tooltip.text(`${d.name}, ${timeLabel}`).style("visibility", "visible");
            })
            .on("mousemove", event => {
              tooltip.style("top", `${event.pageY + 10}px`).style("left", `${event.pageX + 10}px`);
            })
            .on("mouseout", () => tooltip.style("visibility", "hidden"));
        });

        // Clock face labels at 12, 3, 6, 9 o'clock
        const labelAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
        const invAngle = d3.scaleLinear().domain(angle.range()).range(angle.domain());
        labelAngles.forEach(a => {
          const ts = invAngle(a);
          const tsMs = ts * 1000;
          // Clock label in NYC time
          const txt = new Date(tsMs).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "America/New_York"
          });
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
