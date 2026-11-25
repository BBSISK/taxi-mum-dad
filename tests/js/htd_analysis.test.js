// node tests/js/htd_analysis.test.js  -- synthetic drive through the Sensor Lab analysis
const assert = require('assert');
const A = require('../../static/lab/htd-analysis.js');

// Speed profile (m/s) per second: gentle start, cruise 13.9 (50 km/h), hard brake at 60 s, kangaroo start at 70 s,
// 18 m/s (65 km/h) from 90-102 s, then a sharp right turn at ~120 s, then stop.
const v = [];
for (let s = 0; s <= 150; s++) {
  let x;
  if (s < 20) x = s * 0.7;
  else if (s < 60) x = 13.9;
  else if (s < 63) x = 13.9 - (s - 59) * 4.2;          // ~ -4.2 m/s2
  else if (s < 70) x = Math.max(0.5, 13.9 - 4 * 4.2);
  else if (s < 74) x = 0.5 + (s - 69) * 3.2;            // ~ +3.2 m/s2
  else if (s < 88) x = 13.9;
  else if (s < 90) x = 13.9 + (s - 87) * 1.4;
  else if (s < 103) x = 18;
  else if (s < 106) x = 18 - (s - 102) * 1.4;
  else if (s < 140) x = 13.9;
  else x = Math.max(0, 13.9 - (s - 139) * 1.5);
  v.push(Math.max(0, x));
}
// Positions: heading north, at 118-122 s swing 90 degrees right (13.9 m/s x 0.39 rad/s ~ 5.4 m/s2 lateral)
let lat = 52.66, lon = -8.63, head = 0;
const gps = [];
for (let s = 0; s <= 150; s++) {
  if (s >= 118 && s < 122) head += 22.5;
  const d = v[s];
  lat += d * Math.cos(head * Math.PI / 180) / 110540;
  lon += d * Math.sin(head * Math.PI / 180) / (111320 * Math.cos(lat * Math.PI / 180));
  gps.push([s * 1000, lat, lon, v[s], v[s] > 1 ? head : null, 5]);
}
// Motion at 20 Hz: phone lying flat (gravity on z); longitudinal on y, lateral on x
const motion = [];
for (let t = 0; t <= 150000; t += 50) {
  const s = Math.min(149, Math.floor(t / 1000));
  const lon_a = v[s + 1] - v[s];
  const lat_a = (t >= 118000 && t < 122000) ? 5.4 : 0;
  motion.push([t, lat_a, lon_a, 0.05 * Math.sin(t / 37), 0, 0, 9.81, 2]);
}
// One phone grab at 100 s: tilt the gravity vector 60 degrees for 3 s
for (const m of motion) if (m[0] >= 100000 && m[0] < 103000) { m[5] = 9.81 * Math.sin(Math.PI / 3); m[6] = 9.81 * Math.cos(Math.PI / 3); }

// Fake Overpass: one long road along the first leg, 50 km/h, named Main Street; the second leg 80 km/h
const geom1 = gps.slice(0, 119).map(p => ({ lat: p[1], lon: p[2] }));
const geom2 = gps.slice(118).map(p => ({ lat: p[1], lon: p[2] }));
const overpass = { elements: [
  { type: 'way', tags: { highway: 'primary', maxspeed: '50', name: 'Main Street' }, geometry: geom1 },
  { type: 'way', tags: { highway: 'secondary', maxspeed: '80', name: 'Ring Road' }, geometry: geom2 },
] };

const trace = { gps, motion, touches: [130000, 149000], vis: [], motionSource: 'acceleration', endedMs: 151000 };
const sum = A.analyse(trace, overpass);
const types = sum.events.map(e => `${e.type}@${Math.round(e.t / 1000)}s/${e.src}`);
console.log('events', types.join(' '));
console.log('handling', sum.handling.map(h => `${Math.round(h.t / 1000)}s ${h.how}`).join(' | '));
console.log('speeding', JSON.stringify(sum.speeding));
console.log('summary', sum.km, 'km', sum.minutes, 'min, limits known', sum.limitKnownPct + '%, over', sum.overPct + '%');
console.log('fun', JSON.stringify(sum.fun));

const brake = sum.events.find(e => e.type === 'brake' && Math.abs(e.t - 61000) < 3000);
assert(brake && brake.src === 'both', 'hard brake found by GPS and motion');
assert(sum.events.some(e => e.type === 'accel' && Math.abs(e.t - 71000) < 3000), 'kangaroo start found');
assert(sum.events.some(e => e.type === 'corner' && Math.abs(e.t - 120000) < 3000), 'sharp corner found');
assert(!sum.events.some(e => e.type === 'brake' && e.t > 135000), 'gentle final stop is not a squirrel stop');
assert(sum.speeding.length === 1 && sum.speeding[0].road === 'Main Street' && sum.speeding[0].limit === 50, 'one Lead Foot Levy on Main Street');
assert(sum.handling.some(h => h.how.includes('tilted')), 'phone grab detected');
assert(sum.handling.some(h => h.how.includes('touched')), 'touch at 130 s counted');
assert(!sum.handling.some(h => Math.abs(h.t - 149000) < 1000), 'touch in the last 5 s (stop button) ignored');
assert(sum.limitKnownPct > 90, 'speed limits matched');
assert.strictEqual(A.parseMaxspeed('50'), 50);
assert.strictEqual(A.parseMaxspeed('30 mph'), 48);
assert.strictEqual(A.parseMaxspeed('IE:urban'), null);
assert(A.overpassQuery(A.routeSample(gps)).startsWith('[out:json]'));
assert(A.routeSample(gps).length < 40, 'route sample is small');
console.log('ALL OK');
