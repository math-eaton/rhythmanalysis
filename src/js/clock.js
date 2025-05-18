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

  // --- Shared draw function for both initial and moving window draws ---
  function draw(data, tsMin, tsMax, config, idxToNameMap, legendContainer, container, tooltip) {
    // Calculate responsive inner and outer radii
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const INNER_R = Math.min(viewportWidth, viewportHeight) * 0.025; // 2.5% of the smaller dimension
    const OUTER_R = Math.min(viewportWidth, viewportHeight) * 0.45; // 45% of the smaller dimension
    const tickStroke = config && config.refresh_interval === 100000 ? 0.5 : 1.25;
    // SVG sizing
    const w = window.innerWidth * 0.85;
    const h = window.innerHeight;
    const svg = container
      .select("svg").empty() ? container.append("svg") : container.select("svg")
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
    const topLeftTextX = 20;
    const topLeftTextY = 20;
    const topLeftTextElement = svg.append("text")
      .attr("x", topLeftTextX)
      .attr("y", topLeftTextY)
      .attr("text-anchor", "start")
      .attr("dominant-baseline", "middle")
      .style("font-size", "0.75rem")
      .style("fill", "#f5f5f5")
      .text(visualizationDate);
    const topLeftBBox = topLeftTextElement.node().getBBox();
    svg.insert("rect", "text")
      .attr("x", topLeftBBox.x - 2)
      .attr("y", topLeftBBox.y - 2)
      .attr("width", topLeftBBox.width + 4)
      .attr("height", topLeftBBox.height + 4)
      .style("fill", "black");
    // Helper: get UTC time-of-day in seconds since midnight
    function getUTCSecondsSinceMidnight(ts) {
      const date = new Date(ts * 1000);
      return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
    }
    const angle = d3
      .scaleLinear()
      .domain([0, config.hours * 3600])
      .range([-Math.PI / 2, (3 * Math.PI) / 2]);
    // class counts
    const classCounts = d3.rollup(
      data,
      (v) => v.length,
      (d) => d.class
    );
    const sortedClasses = Array.from(classCounts.entries()).sort((a, b) => a[1] - b[1]);
    const cutoffIndex = Math.floor(sortedClasses.length * 0.666);
    const filteredClasses = sortedClasses.slice(cutoffIndex).map(([cls]) => cls);
    const color = d3.scaleOrdinal(filteredClasses, d3.schemeCategory10);
    const ringScale = d3
      .scalePow()
      .exponent(2)
      .domain([0, filteredClasses.length - 1])
      .range([INNER_R, OUTER_R]);
    svg
      .append("circle")
      .attr("cx", cx)
      .attr("cy", cy)
      .attr("r", OUTER_R)
      .style("fill", "none")
      .style("stroke", "#aaaaaa24");
    const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);
    // --- Dateline and timer logic ---
    let dateline = null;
    let currentDatelineAngle = null;
    function computeOpacity(d) {
      if (currentDatelineAngle === null) return 1.0;
      const eventAngle = angle(getUTCSecondsSinceMidnight(d.ts));
      let delta = (currentDatelineAngle - eventAngle) % (2 * Math.PI);
      if (delta < 0) delta += 2 * Math.PI;
      const hoursVisible = config.hours || 24;
      const angleRange = 2 * Math.PI * (hoursVisible / 24);
      let norm = delta / angleRange;
      if (norm > 1) norm = 1;
      const minOpacity = 0.33;
      const opacity = 1 - (1 - minOpacity) * norm;
      const cfScale = d3.scaleLinear().domain([0, 100]).range([0.1, 1]);
      return opacity * cfScale(d.cf || 0);
    }
    function updateDatelineAndOpacities() {
      if (dateline) dateline.remove();
      // --- Dateline: use NYC (America/New_York) seconds since midnight ---
      const now = new Date();
      // Convert current time to NYC time
      const nycNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const secondsSinceMidnightNYC = nycNow.getHours() * 3600 + nycNow.getMinutes() * 60 + nycNow.getSeconds();
      const hoursVisible = config.hours || 24;
      const fractionOfRange = secondsSinceMidnightNYC / (hoursVisible * 3600);
      const angleRange = 2 * Math.PI * (hoursVisible / 24);
      const dateLineAngle = -Math.PI / 2 + fractionOfRange * angleRange;
      currentDatelineAngle = dateLineAngle;
      dateline = svg.append("line")
        .attr("x1", cx + INNER_R * Math.cos(dateLineAngle))
        .attr("y1", cy + INNER_R * Math.sin(dateLineAngle))
        .attr("x2", cx + OUTER_R * Math.cos(dateLineAngle))
        .attr("y2", cy + OUTER_R * Math.sin(dateLineAngle))
        .attr("stroke", "#fff")
        .attr("stroke-width", tickStroke);
      g.selectAll("line.event-line").attr("opacity", function(d) {
        return computeOpacity(d);
      });
    }
    // draw each class ring
    filteredClasses.forEach((cls, i) => {
      const radius = ringScale(i);
      g.append("circle")
        .attr("r", radius)
        .style("fill", "none")
        .style("stroke", "#aaaaaa24");
      const strokeWidth = tickStroke;
      let lineBuffer = 2;
      g.selectAll(`.line-${i}`)
        .data(data.filter(d => d.class === cls))
        .join("line")
          .attr("class", `line-${i} event-line`)
          .attr("x1", d => (radius - lineBuffer) * Math.cos(angle(getUTCSecondsSinceMidnight(d.ts))))
          .attr("y1", d => (radius - lineBuffer) * Math.sin(angle(getUTCSecondsSinceMidnight(d.ts))))
          .attr("x2", d => (radius + lineBuffer) * Math.cos(angle(getUTCSecondsSinceMidnight(d.ts))))
          .attr("y2", d => (radius + lineBuffer) * Math.sin(angle(getUTCSecondsSinceMidnight(d.ts))))
          .attr("stroke", color(cls))
          .attr("stroke-width", strokeWidth)
          .on("mouseover", (event, d) => {
            const tsMs = d.ts * 1000;
            const label = new Date(tsMs).toLocaleString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "UTC",
            });
            tooltip.text(`${d.name}, ${label} UTC`).style("visibility", "visible");
          })
          .on("mousemove", (event) => {
            tooltip
              .style("top", `${event.pageY + 10}px`)
              .style("left", `${event.pageX + 10}px`);
          })
          .on("mouseout", () => tooltip.style("visibility", "hidden"));
    });
    // Now that all your event lines exist, give them their initial opacity
    updateDatelineAndOpacities();
    // Set up interval to update dateline and opacities in sync with config.refresh_interval
    const tickInterval = config.refresh_interval || 30000;
    if (window._clockDatelineInterval) clearInterval(window._clockDatelineInterval);
    window._clockDatelineInterval = setInterval(() => {
      updateDatelineAndOpacities();
    }, tickInterval);
    // Fixed time labels at 12am, 6am, 12pm, 6pm
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
      .style("font-size", "0.85rem")
      .text((d) => `${d.name} (${d.count})`);
  }

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

      let binnedData = dataCache;
      if (!config.binSeconds && dataCache.length > 2000) {
        const binMap = new Map();
        dataCache.forEach((d) => {
          const date = new Date(d.ts * 1000);
          const nyc = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const secondsOfDay = nyc.getUTCHours() * 3600 + nyc.getUTCMinutes() * 60 + nyc.getUTCSeconds();
          const bin = Math.floor(secondsOfDay / 30);
          const key = `${d.class}_${bin}`;
          if (!binMap.has(key) || d.cf > binMap.get(key).cf) {
            binMap.set(key, d);
          }
        });
        binnedData = Array.from(binMap.values());
      }

      tsMax = binnedData[binnedData.length - 1].ts;
      tsMin = tsMax - 24 * 3600;

      const filteredData = binnedData.filter((d) => d.ts >= tsMin && d.ts <= tsMax);
      if (!filteredData.length) {
        console.warn("no data in selected range");
        if (typeof config.onD3End === "function") config.onD3End();
        return;
      }

      draw(filteredData, tsMin, tsMax, config, idxToNameMap, legendContainer, container, tooltip);
      if (typeof config.onDataReady === "function") config.onDataReady();
      if (typeof config.onD3End === "function") config.onD3End();
      window.addEventListener("resize", () => draw(filteredData, tsMin, tsMax, config, idxToNameMap, legendContainer, container, tooltip));
    });
  }).catch((error) => {
    console.error("Failed to load the mapping JSON:", error);
  });

  //  MOVING WINDOW LOGIC 
  let windowOffsetSeconds = 0; // Offset in seconds from initial window (increases by 30s every interval)
  const UPDATE_INTERVAL = config.refresh_interval || 30000; // Use config, default to 30s

  function fetchAndDrawWindow() {
    // Calculate offsetHours for the API (in hours, negative means move window forward in time)
    const offsetHours = config.offsetHours ? config.offsetHours : 0;
    // The window offset is in seconds, convert to hours
    const offsetHoursWithWindow = offsetHours - (windowOffsetSeconds / 3600);
    // Build a new config for this fetch
    const fetchConfig = {
      ...config,
      offsetHours: offsetHoursWithWindow,
      // Remove callbacks to avoid recursion
      onApiFetchStart: undefined,
      onApiFetchEnd: undefined,
      onD3Start: undefined,
      onD3End: undefined,
      onDataReady: undefined,
    };
    // Callbacks for diagnostics
    if (typeof config.onApiFetchStart === "function") config.onApiFetchStart();
    d3.json(CLASS_MAP_API).then((mappingData) => {
      const idxToNameMap = {};
      mappingData.forEach((row) => {
        idxToNameMap[row.index] = row.display_name;
      });
      let DATA_URL = fetchConfig.dataUrl || `${API_BASE_URL}/audio_logs`;
      const urlParams = [];
      if (fetchConfig.offsetHours) urlParams.push(`offsetHours=${encodeURIComponent(fetchConfig.offsetHours)}`);
      if (fetchConfig.binSeconds) urlParams.push(`binSeconds=${encodeURIComponent(fetchConfig.binSeconds)}`);
      if (urlParams.length > 0) DATA_URL += `?${urlParams.join("&")}`;
      d3.json(DATA_URL).then((raw) => {
        if (typeof config.onApiFetchEnd === "function") config.onApiFetchEnd();
        if (!raw || !Array.isArray(raw.data)) {
          console.error("Unexpected data format: expected an object with a data array");
          return;
        }
        if (typeof config.onD3Start === "function") config.onD3Start();
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
        let binnedData = dataCache;
        if (!config.binSeconds && dataCache.length > 2000) {
          const binMap = new Map();
          dataCache.forEach((d) => {
            const date = new Date(d.ts * 1000);
            const nyc = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const secondsOfDay = nyc.getUTCHours() * 3600 + nyc.getUTCMinutes() * 60 + nyc.getUTCSeconds();
            const bin = Math.floor(secondsOfDay / 30);
            const key = `${d.class}_${bin}`;
            if (!binMap.has(key) || d.cf > binMap.get(key).cf) {
              binMap.set(key, d);
            }
          });
          binnedData = Array.from(binMap.values());
        }
        tsMax = binnedData[binnedData.length - 1].ts;
        tsMin = tsMax - 24 * 3600;
        const filteredData = binnedData.filter((d) => d.ts >= tsMin && d.ts <= tsMax);
        if (!filteredData.length) {
          console.warn("no data in selected range");
          if (typeof config.onD3End === "function") config.onD3End();
          return;
        }
        draw(filteredData, tsMin, tsMax, config, idxToNameMap, legendContainer, container, tooltip);
        if (typeof config.onD3End === "function") config.onD3End();
        window.addEventListener("resize", () => draw(filteredData, tsMin, tsMax, config, idxToNameMap, legendContainer, container, tooltip));
        if (typeof config.onDataReady === "function") config.onDataReady();
      });
    });
  }

  // Initial fetch and draw
  fetchAndDrawWindow();

  // Set up 30s interval to move window forward and update
  setInterval(() => {
    windowOffsetSeconds += 30;
    fetchAndDrawWindow();
  }, UPDATE_INTERVAL);
}
