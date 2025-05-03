import * as d3 from "d3";

///////////////////// D3 /////////////////////

const FILE      = "classifications_yamnet.json";
const POLL_MS   = 2_000;             // hit once every 2 s – tune as you like
const RING_SECS = 60;                // circumference == 60 s
const SPAN_MINS = 15;                // keep last 15 min in memory

// canonical “scales” we’ll re-use inside the Three scene
export const angleScale = d3.scaleLinear()
  .domain([0, RING_SECS])
  .range([0, 2 * Math.PI]);

export const colorScale = d3.scaleOrdinal(d3.schemeTableau10);
export const radiusScale = d3.scaleSqrt()  // map confidence → sphere size
  .domain([0, 100])
  .range([0.1, 1.2]);          // Three-space units, not px


let anchorTs = null;      // updated whenever we slide the window
let cache    = [];        // all events we currently show
let listeners = [];

export function onData(cb){ listeners.push(cb); }

async function fetchLoop(){
  const raw = await d3.json(FILE);
  raw.sort((a,b) => a.ts - b.ts);

  if(!anchorTs){ anchorTs = raw.at(-1).ts - SPAN_MINS*60; }

  // trim to sliding window & enrich
  cache = raw.filter(d => d.ts >= anchorTs)
             .map(d => ({
               ...d,
               ring   : Math.floor((d.ts - anchorTs) / RING_SECS),
               theta  : angleScale((d.ts - anchorTs) % RING_SECS),
               color  : colorScale(d.cl),
               size   : radiusScale(d.cf)
             }));

  listeners.forEach(cb => cb(cache));
  setTimeout(fetchLoop, POLL_MS);
}
fetchLoop();

/////////// threejs scene ///////////

import * as THREE from "three";
import { angleScale, onData } from "./dataLayer.js";  // <- previous snippet

const RING_GAP = 2.5;          // distance between rings along -Z
const FADE_Z   = 150;          // when |z| > FADE_Z, recycle
const groups   = new Map();    // ringIndex → THREE.Group
const sphereGeom = new THREE.SphereGeometry(1, 12, 12); // unit size, we’ll scale per-sphere

function buildOrUpdateRing(ringIndex, events){
    let g = groups.get(ringIndex);
    if(!g){
      g = new THREE.Group();
      g.rotation.x = -Math.PI/2;          // tilt exactly like your spirograph
      scene.add(g);
      groups.set(ringIndex, g);
    }
  
    // clear & repopulate (easiest, fine for a few hundred events)
    g.clear();
    events.forEach(evt=>{
      const m = new THREE.Mesh(
        sphereGeom,
        new THREE.MeshBasicMaterial({ color: evt.color, transparent:true, opacity:0.85 })
      );
      m.scale.setScalar(evt.size);
      m.position.set(
        10 * Math.cos(evt.theta),   // a = 10  (you can still let GUI tweak eccentricity)
        0,
        10 * Math.sin(evt.theta)
      );
      g.add(m);
    });
  
    // place the whole ring along -Z
    g.position.z = -ringIndex * RING_GAP;
  }
  
  onData(allEvents=>{
    // bucket by ringIndex
    const byRing = d3.group(allEvents, d=>d.ring);
    byRing.forEach((evs, ring) => buildOrUpdateRing(ring, evs));
  
    // cull old groups
    groups.forEach((g, ring)=>{
      if(ring < allEvents[0].ring - 1){   // 1 ring behind leftmost? cull
        scene.remove(g);
        groups.delete(ring);
      }
    });
  });
  