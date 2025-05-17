import * as d3 from "d3";

export function clockGraph(containerId, config = {}) {
  const inputHours = config.hours || 24; // default 24h range
  const now = new Date();
  const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  // Fetch enough data to cover from previous midnight to now (ensure midnight anchor)
  const fetchHours = inputHours + secondsSinceMidnight / 3600;

  // API endpoints and parameters
  const API_BASE_URL = config.apiBaseUrl || "https://rhythmanalysis.onrender.com/api";
  const DATA_URL = config.dataUrl || `${API_BASE_URL}/audio_logs?hours=${fetchHours}`;
  const CLASS_MAP_API = config.classMapUrl || `${API_BASE_URL}/yamnet_class_map`;
  const UPDATE_INTERVAL = config.updateInterval || 15000;  // 15 seconds
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
          const offsetSec = new Date(rawTs * 1000).getTimezoneOffset() * 60;
          return {
            origTs: rawTs,
            ts: rawTs + offsetSec,
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
        const nowOffsetSec = new Date().getTimezoneOffset() * 60;
        const nowLocalSec = nowUTC + nowOffsetSec;
        // Fetch new records from last fetched timestamp up to current time
        const startTs = lastFetchedRaw + 1;
        const endTs = nowUTC;
        const updateUrl = `${API_BASE_URL}/audio_logs?start=${startTs}&end=${endTs}`;
        d3.json(updateUrl).then(newRaw => {
          if (Array.isArray(newRaw) && newRaw.length) {
            // Process and merge new data
            const newData = newRaw.map(d => {
              const rawTs = +d.ts;
              const offsetSec = new Date(rawTs * 1000).getTimezoneOffset() * 60;
              return {
                origTs: rawTs,
                ts: rawTs + offsetSec,
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
          const cutoffTs = nowLocalSec - rangeSec;
          dataCache = dataCache.filter(d => d.ts >= cutoffTs);
          if (!dataCache.length) {
            tsMin = Infinity;
            tsMax = -Infinity;
          } else {
            tsMin = dataCache[0].ts;
            tsMax = dataCache[dataCache.length - 1].ts;
          }

          // Prepare updated scales and data subsets
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025;
          const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45;
          const w = viewportWidth * 0.85;
          const h = viewportHeight;
          const cx = w / 2, cy = h / 2;
          const minDate = new Date(tsMin * 1000);
          minDate.setHours(0, 0, 0, 0);
          const midnightTs = Math.floor(minDate.getTime() / 1000);
          const angleScale = d3.scaleLinear()
            .domain([midnightTs, midnightTs + hoursVisible * 3600])
            .range([-Math.PI / 2, (3 * Math.PI) / 2]);
          // Determine visible classes (top 33% by frequency in window)
          const classCounts = d3.rollup(dataCache, v => v.length, d => d.class);
          const sortedClasses = Array.from(classCounts.entries()).sort((a, b) => a[1] - b[1]);
          const cutoffIndex = Math.floor(sortedClasses.length * 0.666);
          const filteredClasses = sortedClasses.slice(cutoffIndex).map(([cls]) => cls);
          const colorScale = d3.scaleOrdinal(filteredClasses, d3.schemeCategory10);
          const ringScale = d3.scalePow().exponent(2)
            .domain([0, filteredClasses.length - 1])
            .range([INNER_R, OUTER_R]);

          // Select SVG and main group
          const svg = container.select("svg");
          const g = svg.select("g");

          // Update circular class rings
          g.selectAll("circle.class-ring")
            .data(filteredClasses, d => d)
            .join(
              enter => enter.append("circle")
                .attr("class", "class-ring")
                .style("fill", "none")
                .style("stroke", "#aaaaaa24")
                .attr("r", (_d, i) => ringScale(i)),
              update => update.attr("r", (_d, i) => ringScale(i)),
              exit => exit.remove()
            );

          // Update event tick lines (per visible class events)
          const lineBuffer = 1.5;
          const visibleData = dataCache.filter(d => filteredClasses.includes(d.class));
          g.selectAll("line.event-line")
            .data(visibleData, d => `${d.class}-${d.ts}`)
            .join(
              enter => enter.append("line")
                .attr("class", d => `line-${filteredClasses.indexOf(d.class)} event-line`)
                .attr("x1", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r - lineBuffer) * Math.cos(angleScale(d.ts));
                })
                .attr("y1", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r - lineBuffer) * Math.sin(angleScale(d.ts));
                })
                .attr("x2", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r + lineBuffer) * Math.cos(angleScale(d.ts));
                })
                .attr("y2", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r + lineBuffer) * Math.sin(angleScale(d.ts));
                })
                .attr("stroke", d => colorScale(d.class))
                .attr("stroke-width", 1.5),
              update => update
                .attr("class", d => `line-${filteredClasses.indexOf(d.class)} event-line`)
                .attr("x1", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r - lineBuffer) * Math.cos(angleScale(d.ts));
                })
                .attr("y1", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r - lineBuffer) * Math.sin(angleScale(d.ts));
                })
                .attr("x2", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r + lineBuffer) * Math.cos(angleScale(d.ts));
                })
                .attr("y2", d => {
                  const i = filteredClasses.indexOf(d.class);
                  const r = ringScale(i);
                  return (r + lineBuffer) * Math.sin(angleScale(d.ts));
                })
                .attr("stroke", d => colorScale(d.class))
                .attr("stroke-width", 1.5),
              exit => exit.remove()
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
            .style("background-color", d => colorScale(d.cls));
          legendItems.append("span")
            .style("font-size", "0.85rem")
            .text(d => `${d.name} (${d.count})`);

          // Update top-left date label
          const dateLabel = svg.select("text.date-range-label");
          const visualizationDate = (!dataCache.length)
            ? "No data (last 24h)"
            : (() => {
                const minDateStr = new Date(tsMin * 1000).toDateString();
                const maxDateStr = new Date(tsMax * 1000).toDateString();
                return (minDateStr === maxDateStr) ? minDateStr : `${minDateStr} - ${maxDateStr}`;
              })();
          dateLabel.text(visualizationDate);
          const labelBBox = dateLabel.node().getBBox();
          svg.select("rect.date-range-bg")
            .attr("x", labelBBox.x - 2)
            .attr("y", labelBBox.y - 2)
            .attr("width", labelBBox.width + 4)
            .attr("height", labelBBox.height + 4);

          // Update clock hour labels (12, 3, 6, 9 o'clock positions)
          svg.selectAll(".clock-label, .clock-label-bg").remove();
          const cardinalAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
          const invAngle = d3.scaleLinear().domain(angleScale.range()).range(angleScale.domain());
          cardinalAngles.forEach(a => {
            const tsAtAngle = invAngle(a);
            const tsMs = tsAtAngle * 1000;
            const timeLabel = new Date(tsMs).toLocaleTimeString("en-US", {
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
              .text(timeLabel);
            const tbbox = textElem.node().getBBox();
            svg.insert("rect", "text")
              .attr("class", "clock-label-bg")
              .attr("x", tbbox.x - 2)
              .attr("y", tbbox.y - 2)
              .attr("width", tbbox.width + 4)
              .attr("height", tbbox.height + 4)
              .style("fill", "black");
          });

          // Update current time line (dateline) and event opacities
          svg.selectAll("line.dateline-line").remove();
          const localTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
          const secondsSinceMidnightNY = localTime.getHours() * 3600 + localTime.getMinutes() * 60 + localTime.getSeconds();
          const fractionOfRange = secondsSinceMidnightNY / (hoursVisible * 3600);
          const angleRange = 2 * Math.PI * (hoursVisible / 24);
          const currentAngle = -Math.PI / 2 + fractionOfRange * angleRange;
          svg.append("line")
            .attr("class", "dateline-line")
            .attr("x1", cx + INNER_R * Math.cos(currentAngle))
            .attr("y1", cy + INNER_R * Math.sin(currentAngle))
            .attr("x2", cx + OUTER_R * Math.cos(currentAngle))
            .attr("y2", cy + OUTER_R * Math.sin(currentAngle))
            .attr("stroke", "#fff")
            .attr("stroke-width", 0.333);
          g.selectAll("line.event-line").attr("opacity", d => {
            const eventAngle = angleScale(d.ts);
            let delta = (currentAngle - eventAngle) % (2 * Math.PI);
            if (delta < 0) delta += 2 * Math.PI;
            const norm = delta / (2 * Math.PI * (hoursVisible / 24));
            const minOpacity = 0.33;
            const baseOpacity = 1 - (1 - minOpacity) * norm;
            return baseOpacity * cfScale(d.cf || 0);
          });

          updating = false;
        });
      }, UPDATE_INTERVAL);

      // Callback when initial data is ready
      if (typeof config.onDataReady === "function") {
        config.onDataReady();
      }

      // -------- Draw function (for initial render & resize) --------
      function draw() {
        const t0 = tsMin, t1 = tsMax;
        // Responsive radii
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025;
        const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45;
        // Filter data for full range
        const data = dataCache.filter(d => d.ts >= t0 && d.ts <= t1);
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

        // Time mapping scale (midnight at top of circle)
        const minDate = new Date(tsMin * 1000);
        minDate.setHours(0, 0, 0, 0);
        const midnightTs = Math.floor(minDate.getTime() / 1000);
        const angle = d3.scaleLinear()
          .domain([midnightTs, midnightTs + hoursVisible * 3600])
          .range([-Math.PI / 2, (3 * Math.PI) / 2]);

        // Determine and filter top N% classes for display
        const classCounts = d3.rollup(data, v => v.length, d => d.class);
        const sortedClasses = Array.from(classCounts.entries()).sort((a, b) => a[1] - b[1]);
        const cutoffIndex = Math.floor(sortedClasses.length * 0.666);
        const filteredClasses = sortedClasses.slice(cutoffIndex).map(([cls]) => cls);
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
          // remove previous line if any
          svg.select("line.dateline-line")?.remove();
          // compute current time angle (NY timezone)
          const localTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const secMidnightNY = localTime.getHours() * 3600 + localTime.getMinutes() * 60 + localTime.getSeconds();
          const fracOfRange = secMidnightNY / (hoursVisible * 3600);
          const angleRange = 2 * Math.PI * (hoursVisible / 24);
          currentDatelineAngle = -Math.PI / 2 + fracOfRange * angleRange;
          // draw dateline
          svg.append("line")
            .attr("class", "dateline-line")
            .attr("x1", cx + INNER_R * Math.cos(currentDatelineAngle))
            .attr("y1", cy + INNER_R * Math.sin(currentDatelineAngle))
            .attr("x2", cx + OUTER_R * Math.cos(currentDatelineAngle))
            .attr("y2", cy + OUTER_R * Math.sin(currentDatelineAngle))
            .attr("stroke", "#fff")
            .attr("stroke-width", 0.333);
          // update event line opacities
          g.selectAll("line.event-line").attr("opacity", d => computeOpacity(d, currentDatelineAngle));
        }
        drawDateline();
        // (Dateline will be updated via the interval; no separate timer here)

        // Draw rings and event tick marks for each visible class
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
