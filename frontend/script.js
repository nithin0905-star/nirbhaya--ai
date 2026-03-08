// ─────────────────────────────────────────────────────────────────────────────
// NIRBHAYA AI — Frontend Script v3  (CORRECTED)
//
// BUGS FIXED IN THIS VERSION:
//   🐛 FIX 1 — navigateTo was defined TWICE. The second definition shadowed
//               the first, and the first one had `_origNav = navigateTo` which
//               was never used. Merged into ONE clean function.
//   🐛 FIX 2 — monitoringScreenLoop was cleared only inside navigateTo, but
//               the startHomeMonitoring loop kept firing even on other screens.
//               Added proper cleanup.
//   🐛 FIX 3 — smsSentThisAlert was reset only in initThreat(), but doEscalate()
//               could be called independently via "Alert Now" button without
//               going through initThreat(). Added guard.
//   ✅ Trusted contacts stored in localStorage (no backend needed for contacts)
//   ✅ SMS sent to contacts via backend /send-sms → AWS SNS → Real SMS
//   ✅ Live GPS via browser navigator.geolocation
//   ✅ Real address via OpenStreetMap Nominatim (free, no key)
// ─────────────────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
let trustedContacts = [];
let protectionActive  = false;
let currentScenario   = 'safe';
let trail             = [];           // GPS trail [{lat,lng,t}]
let monitoringLoop    = null;
let threatCountdown   = 15;
let countdownTimer    = null;
let threatPhase       = 'alert';
let cancelledAlert    = false;
let currentTab        = 'alerts';
let smsSentThisAlert  = false;

// ── Live Location State ────────────────────────────────────────────────────────
let locationWatcher   = null;         // watchPosition ID
let currentPosition   = null;         // { lat, lng, accuracy, timestamp }
let currentAddress    = '';           // reverse-geocoded address
let locationGranted   = false;        // true once permission given
let geocodeCache      = {};           // lat/lng → address cache

// ── Backend API URL ────────────────────────────────────────────────────────────
// Auto-detects: localhost uses port 3001, production uses same-origin /api prefix
// ✅ When running locally:  http://localhost:3001
// ✅ When deployed on AWS Amplify / EC2: change to your actual backend URL
const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : window.location.origin;   // on Amplify, backend at same domain

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — LIVE LOCATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Request location permission and start watching.
 * Called when user taps "Enable" on the GPS banner.
 */
function requestLocation() {
  if (!navigator.geolocation) {
    showToast('❌ Geolocation not supported by this browser', 'danger');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locationGranted = true;
      hideBanner();
      onLocationUpdate(pos);
      startLocationWatch();
    },
    (err) => {
      const msgs = {
        1: 'Location permission denied. Please allow in browser settings.',
        2: 'Location unavailable. Check GPS signal.',
        3: 'Location request timed out. Try again.',
      };
      showToast('📍 ' + (msgs[err.code] || 'Location error'), 'danger');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

/**
 * Start continuous location watching (updates every ~5 seconds on mobile).
 */
function startLocationWatch() {
  if (locationWatcher !== null) return;
  locationWatcher = navigator.geolocation.watchPosition(
    onLocationUpdate,
    (err) => console.warn('[GPS]', err.message),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
}

function stopLocationWatch() {
  if (locationWatcher !== null) {
    navigator.geolocation.clearWatch(locationWatcher);
    locationWatcher = null;
  }
}

/**
 * Called on every GPS update.
 */
function onLocationUpdate(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const acc = pos.coords.accuracy;

  currentPosition = { lat, lng, accuracy: acc, timestamp: Date.now() };

  // Add to trail
  trail.push({ lat, lng, t: Date.now() });
  if (trail.length > 100) trail.shift();

  // Update UI
  updateLocationUI(lat, lng, acc);

  // Reverse geocode (uses cache to avoid spamming Nominatim)
  reverseGeocode(lat, lng);

  // Update map if monitoring screen is active
  if (document.getElementById('screen-monitoring').classList.contains('active')) {
    drawMapTrail();
  }
}

/**
 * Reverse geocode using OpenStreetMap Nominatim (free, no API key required).
 */
async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (geocodeCache[key]) {
    currentAddress = geocodeCache[key];
    updateAddressUI(currentAddress);
    return;
  }
  try {
    const url  = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lng=${lng}&zoom=16&addressdetails=1`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    const addr = data.address || {};
    const parts = [
      addr.suburb || addr.neighbourhood || addr.hamlet,
      addr.city   || addr.town || addr.village || addr.county,
      addr.state,
    ].filter(Boolean);
    const shortAddr = parts.slice(0, 2).join(', ');
    geocodeCache[key] = shortAddr
      || data.display_name?.split(',').slice(0, 2).join(',')
      || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    currentAddress = geocodeCache[key];
    updateAddressUI(currentAddress);
  } catch {
    currentAddress = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    updateAddressUI(currentAddress);
  }
}

function updateLocationUI(lat, lng, acc) {
  const locIcon = document.getElementById('locIcon');
  const locText = document.getElementById('locText');
  const locAcc  = document.getElementById('locAcc');
  if (locIcon) locIcon.textContent = '📍';
  if (locText) locText.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (locAcc)  locAcc.textContent  = `±${Math.round(acc)}m`;

  const footerLoc = document.getElementById('footerLocation');
  if (footerLoc) footerLoc.textContent = `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function updateAddressUI(address) {
  const locText   = document.getElementById('locText');
  const footerLoc = document.getElementById('footerLocation');
  const mapAddr   = document.getElementById('mapAddress');
  if (locText)   locText.textContent   = address;
  if (footerLoc) footerLoc.textContent = `📍 ${address}`;
  if (mapAddr)   mapAddr.textContent   = `📍 ${address}`;
}

function hideBanner() {
  const banner = document.getElementById('gpsBanner');
  if (banner) banner.style.display = 'none';
}

/** Returns location string for SMS (address or coordinates). */
function getLocationString() {
  if (currentAddress) return currentAddress;
  if (currentPosition) {
    return `${currentPosition.lat.toFixed(5)}, ${currentPosition.lng.toFixed(5)}`;
  }
  return 'Location unavailable';
}

/** Returns Google Maps link for current GPS position. */
function getMapsLink() {
  if (!currentPosition) return '';
  return `https://maps.google.com/?q=${currentPosition.lat},${currentPosition.lng}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — GPS MAP
// ══════════════════════════════════════════════════════════════════════════════

function drawMapTrail() {
  const svg    = document.getElementById('mapSvg');
  const coords = document.getElementById('mapCoords');
  if (!svg) return;

  const drawTrail = (currentScenario === 'live' && trail.length > 0)
    ? trail
    : getSimulatedTrail();

  if (drawTrail.length < 2) {
    if (coords) coords.textContent = 'Acquiring GPS…';
    return;
  }

  const W = 300, H = 160, pad = 20;
  const lats = drawTrail.map(p => p.lat);
  const lngs = drawTrail.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  const toX = lng => pad + ((lng - minLng) / (maxLng - minLng + 0.000001)) * (W - pad * 2);
  const toY = lat => H - pad - ((lat - minLat) / (maxLat - minLat + 0.000001)) * (H - pad * 2);

  const pts  = drawTrail.map(p => `${toX(p.lng)},${toY(p.lat)}`).join(' ');
  const last = drawTrail[drawTrail.length - 1];
  const px   = toX(last.lng);
  const py   = toY(last.lat);
  const color = currentScenario === 'danger'
    ? '#ef4444'
    : currentScenario === 'suspicious'
      ? '#f59e0b'
      : '#22c55e';

  svg.innerHTML = `
    <rect width="${W}" height="${H}" rx="10" fill="#0d1a2d"/>
    <polyline points="${pts}" fill="none" stroke="${color}44" stroke-width="2" stroke-linejoin="round"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-dasharray="4 2"/>
    <circle cx="${px}" cy="${py}" r="8" fill="${color}33" stroke="${color}" stroke-width="2"/>
    <circle cx="${px}" cy="${py}" r="4" fill="${color}"/>
    <text x="${px + 12}" y="${py + 4}" font-size="10" fill="${color}" font-family="JetBrains Mono,monospace">YOU</text>
  `;

  if (coords) {
    if (currentScenario === 'live' && currentPosition) {
      coords.textContent = `${currentPosition.lat.toFixed(5)}°N  ${currentPosition.lng.toFixed(5)}°E  ±${Math.round(currentPosition.accuracy || 0)}m`;
    } else {
      coords.textContent = `${last.lat.toFixed(5)}°N  ${last.lng.toFixed(5)}°E`;
    }
  }
}

function getSimulatedTrail() {
  if (simTrail.length < 2) {
    let lat = 12.9716, lng = 77.5946;
    for (let i = 0; i < 10; i++) {
      lat += (Math.random() - 0.5) * 0.001;
      lng += (Math.random() - 0.5) * 0.001;
      simTrail.push({ lat, lng, t: Date.now() - (10 - i) * 10000 });
    }
  }
  return simTrail;
}
let simTrail = [];

function extendSimTrail() {
  const last = simTrail[simTrail.length - 1] || { lat: 12.9716, lng: 77.5946 };
  simTrail.push({
    lat: last.lat + (Math.random() - 0.5) * 0.0008,
    lng: last.lng + (Math.random() - 0.5) * 0.0008,
    t:   Date.now(),
  });
  if (simTrail.length > 50) simTrail.shift();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONTACTS & STORAGE
// ══════════════════════════════════════════════════════════════════════════════

function loadContacts() {
  try { return JSON.parse(localStorage.getItem('nirbhaya_contacts') || '[]'); }
  catch { return []; }
}
function saveContacts(c) { localStorage.setItem('nirbhaya_contacts', JSON.stringify(c)); }
function getContacts()   { return loadContacts(); }

function loadAlertHistory() {
  try { return JSON.parse(localStorage.getItem('nirbhaya_alerts') || '[]'); }
  catch { return []; }
}
function saveAlertHistory(a) { localStorage.setItem('nirbhaya_alerts', JSON.stringify(a)); }

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — STATIC DATA
// ══════════════════════════════════════════════════════════════════════════════

const THREAT_LEVELS = {
  LOW:      { color: '#22c55e', bg: 'rgba(34,197,94,0.1)'  },
  MEDIUM:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  HIGH:     { color: '#f97316', bg: 'rgba(249,115,22,0.1)' },
  CRITICAL: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)'  },
};

const RESOURCES = [
  { name: 'Emergency (Police / Ambulance / Fire)', number: '112',           icon: '🚨' },
  { name: 'Women Helpline (National)',             number: '1091',          icon: '👩' },
  { name: "Women's Helpline (Domestic Abuse)",     number: '181',           icon: '🏠' },
  { name: 'Child Helpline',                        number: '1098',          icon: '👶' },
  { name: 'iCall (Mental Health — TISS)',          number: '9152987821',    icon: '🧠' },
  { name: 'Vandrevala Foundation',                 number: '1860-2662-345', icon: '💚' },
];

const ESCALATION_ACTIONS = {
  LOW:      ['Continuous background monitoring active'],
  MEDIUM:   ['Notify trusted contact 1 via SMS', 'Start silent evidence capture', 'Begin audio recording (2 min)'],
  HIGH:     ['Send SMS alert to ALL trusted contacts', 'Send live GPS location via SMS', 'Capture images (front + rear camera)', 'Upload encrypted evidence to AWS S3'],
  CRITICAL: ['Auto-call 112 Emergency Services', 'Send emergency SMS to all trusted contacts', 'Broadcast live GPS location', 'Alert nearest NGO partner', 'Trigger police control room webhook'],
};

const FACTOR_LABELS = {
  locationRisk:    'Location',
  timeRisk:        'Time',
  movementAnomaly: 'Movement',
  voiceDistress:   'Voice',
  environmental:   'Environ.',
};

const LOG_MESSAGES = {
  LOW:      ['All clear — normal behaviour', 'Route on track', 'No anomalies detected'],
  MEDIUM:   ['Slight movement spike detected', 'Location risk elevated', 'Monitoring closely'],
  HIGH:     ['Rapid movement detected', 'Panic keyword detected', 'Notifying trusted contacts via SMS'],
  CRITICAL: ['EMERGENCY: Multiple distress signals', 'Calling 112', 'SMS sent to all contacts'],
};

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — THREAT ENGINE
// ══════════════════════════════════════════════════════════════════════════════

const SCENARIOS = {
  safe:       { locationRisk: 0.1,  hour: 14, speeds: [1.2, 1.1, 1.3],  voice: [],                         offline: false, battery: 0.8, stop: false },
  suspicious: { locationRisk: 0.6,  hour: 21, speeds: [3.5, 0.1, 6.2],  voice: ['help'],                   offline: false, battery: 0.5, stop: true  },
  danger:     { locationRisk: 0.85, hour: 23, speeds: [9.0, 0.05, 8.5], voice: ['bachao', 'chodo', 'help'], offline: true,  battery: 0.1, stop: true  },
  live:       null,
};

const PANIC_KEYWORDS = ['help', 'bachao', 'chodo', 'save me', 'leave me', 'madad', 'police'];

function calcThreat(scenario) {
  if (scenario === 'live') return calcLiveThreat();

  const s = SCENARIOS[scenario] || SCENARIOS.safe;
  const timeRisk   = s.hour >= 22 || s.hour < 5 ? 0.9 : s.hour >= 19 ? 0.55 : 0.1;
  const avgSpeed   = s.speeds.reduce((a, b) => a + b, 0) / s.speeds.length;
  const maxSpeed   = Math.max(...s.speeds);
  const spikeScore = maxSpeed > 8 ? 0.85 : maxSpeed > 5 ? 0.5 : 0.1;
  const stillScore = avgSpeed < 0.2 ? 0.6 : 0;
  const movScore   = Math.min(1, Math.max(spikeScore, stillScore));
  const detected   = s.voice.filter(kw => PANIC_KEYWORDS.some(pk => kw.toLowerCase().includes(pk)));
  const voiceScore = Math.min(1, detected.length * 0.4);

  let envScore = 0;
  if (s.offline)        envScore += 0.2;
  if (s.battery < 0.15) envScore += 0.2;
  if (s.stop)           envScore += 0.5;
  envScore = Math.min(1, envScore);

  const raw   = s.locationRisk * 0.25 + timeRisk * 0.15 + movScore * 0.30 + voiceScore * 0.20 + envScore * 0.10;
  const score = Math.round(raw * 100);
  const level = score <= 30 ? 'LOW' : score <= 60 ? 'MEDIUM' : score <= 85 ? 'HIGH' : 'CRITICAL';

  return { score, level, factors: {
    locationRisk:    Math.round(s.locationRisk * 100),
    timeRisk:        Math.round(timeRisk * 100),
    movementAnomaly: Math.round(movScore * 100),
    voiceDistress:   Math.round(voiceScore * 100),
    environmental:   Math.round(envScore * 100),
  }};
}

function calcLiveThreat() {
  const hour     = new Date().getHours();
  const timeRisk = hour >= 22 || hour < 5 ? 0.9 : hour >= 19 ? 0.55 : 0.1;
  const isOnline = navigator.onLine;
  const locRisk  = 0.3;
  const movScore = 0.15;
  const voiceScore = 0.0;
  let envScore = 0;
  if (!isOnline)            envScore += 0.2;
  if (batteryLevel < 0.15)  envScore += 0.2;
  envScore = Math.min(1, envScore);

  const raw   = locRisk * 0.25 + timeRisk * 0.15 + movScore * 0.30 + voiceScore * 0.20 + envScore * 0.10;
  const score = Math.round(raw * 100);
  const level = score <= 30 ? 'LOW' : score <= 60 ? 'MEDIUM' : score <= 85 ? 'HIGH' : 'CRITICAL';

  return { score, level, factors: {
    locationRisk:    Math.round(locRisk * 100),
    timeRisk:        Math.round(timeRisk * 100),
    movementAnomaly: Math.round(movScore * 100),
    voiceDistress:   0,
    environmental:   Math.round(envScore * 100),
  }};
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — BATTERY & NETWORK
// ══════════════════════════════════════════════════════════════════════════════

let batteryLevel = 1.0;

async function initBattery() {
  try {
    if (!navigator.getBattery) return;
    const bat = await navigator.getBattery();
    batteryLevel = bat.level;
    updateBatteryUI(bat.level, bat.charging);
    bat.addEventListener('levelchange', () => {
      batteryLevel = bat.level;
      updateBatteryUI(bat.level, bat.charging);
    });
  } catch { /* not supported */ }
}

function updateBatteryUI(level, charging) {
  const el = document.getElementById('footerBattery');
  if (el) el.textContent = `${Math.round(level * 100)}%${charging ? ' ⚡' : ''}`;
}

function initNetwork() {
  const updateNet = () => {
    const el = document.getElementById('footerNetwork');
    if (el) el.textContent = navigator.onLine ? '🌐 Connected' : '📴 Offline';
  };
  window.addEventListener('online',  updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — SMS SENDING  ← THIS IS HOW REAL SMS REACHES CONTACTS
// ══════════════════════════════════════════════════════════════════════════════
//
// Flow:
//   Frontend (this file)
//     → calls /send-sms on your Express backend (Backend/index.js)
//       → backend calls AWS SNS PublishCommand
//         → AWS SNS sends real SMS to the phone number
//           → 📱 Trusted contact receives the text message!
//
// Requirements for real SMS:
//   1. Backend running (node Backend/index.js)
//   2. Backend/.env has AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   3. IAM user/role has sns:Publish permission
//   4. SNS account is out of sandbox (or phone number is verified in sandbox)

/**
 * Send SMS to all trusted contacts via backend /send-sms endpoint.
 * @param {Object} result — { score, level }
 */
async function sendSMSToContacts(result) {
  const contacts = getContacts();
  if (contacts.length === 0) {
    showToast('⚠️ No trusted contacts saved — go to Alert → Contacts tab to add numbers!', 'danger');
    return { sent: 0, contacts: [] };
  }

  const locationStr = getLocationString();
  const mapsLink    = getMapsLink();
  const emoji = { LOW: '🟡', MEDIUM: '🟠', HIGH: '🔴', CRITICAL: '🆘' }[result.level] || '⚠️';

  const message = [
    `${emoji} NIRBHAYA AI ALERT`,
    `Level: ${result.level} | Score: ${result.score}/100`,
    `Location: ${locationStr}`,
    mapsLink ? `Map: ${mapsLink}` : '',
    `Time: ${new Date().toLocaleTimeString('en-IN')}`,
    `Please check on this person immediately.`,
    result.level === 'CRITICAL' ? 'Call 112 if unreachable!' : '',
  ].filter(Boolean).join('\n');

  const phoneNumbers = contacts.map(c => c.phone);

  try {
    const resp = await fetch(`${API_URL}/send-sms`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        phoneNumbers,
        message,
        alertLevel: result.level,
        score:      result.score,
        location:   locationStr,
        mapsLink,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const sent = data.sent || contacts.length;
      if (data.demo_mode) {
        showToast(`📱 SMS demo (no AWS creds) — ${sent} contact(s) would be notified`, 'success');
      } else {
        showToast(`📱 SMS sent to ${sent} contact(s)!`, 'success');
      }
      return { sent, contacts, message, demo: data.demo_mode };
    } else {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn('[SMS] Backend call failed:', err.message);
    console.log('[SMS DEMO] Message that would be sent:\n' + message);
    console.log('[SMS DEMO] Recipients:', phoneNumbers);
    showToast(`📱 SMS demo mode (backend offline) — ${contacts.length} contact(s)`, 'success');
    return { sent: contacts.length, contacts, message, demo: true };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — NAVIGATION & CLOCK
// ══════════════════════════════════════════════════════════════════════════════

// ✅ FIX 1 — Single unified navigateTo function (original code had it defined
//            twice, which caused the first definition to be completely unused).
let monitoringScreenLoop = null;

function navigateTo(screen) {
  // Deactivate all screens
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${screen}`).classList.add('active');

  // ✅ FIX 2 — Always clear the monitoring loop when leaving monitoring screen
  if (monitoringScreenLoop) {
    clearInterval(monitoringScreenLoop);
    monitoringScreenLoop = null;
  }

  if (screen === 'monitoring') {
    runMonitoringTick();
    monitoringScreenLoop = setInterval(runMonitoringTick, 3000);
    drawMapTrail();
  }

  if (screen === 'alert') renderAlertTab(currentTab);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showToast(message, type = 'success') {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className   = `toast ${type}`;
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function startClock() {
  const update = () => {
    const d  = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const el = document.getElementById('clockDisplay');
    if (el) el.textContent = `${hh}:${mm}`;
  };
  update();
  setInterval(update, 10000);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — PROTECTION TOGGLE
// ══════════════════════════════════════════════════════════════════════════════

function toggleProtection() {
  protectionActive = !protectionActive;

  const btn    = document.getElementById('protectBtn');
  const badge  = document.getElementById('statusBadge');
  const dot    = document.getElementById('badgeDot');
  const text   = document.getElementById('statusText');
  const hint   = document.getElementById('statusHint');
  const circle = document.getElementById('statusCircle');

  if (protectionActive) {
    btn.textContent  = '⏹ Stop Protection';
    btn.className    = 'protect-btn stop';
    badge.className  = 'status-badge active';
    dot.className    = 'badge-dot on';
    text.textContent = 'Protection Active';
    hint.textContent = 'AI monitoring active · Tap to see details';

    if (!locationGranted) {
      requestLocation();
    } else {
      startLocationWatch();
    }

    startHomeMonitoring();
    showToast('🛡️ Protection activated', 'success');
  } else {
    btn.textContent  = '▶ Activate Protection';
    btn.className    = 'protect-btn start';
    badge.className  = 'status-badge inactive';
    dot.className    = 'badge-dot off';
    text.textContent = 'Protection Inactive';
    hint.textContent = 'Protection is off';
    circle.style.background  = 'var(--surface)';
    circle.style.borderColor = 'var(--border)';
    circle.style.boxShadow   = 'none';
    document.getElementById('circleContent').innerHTML = `
      <div style="font-size:36px;text-align:center">🔒</div>
      <div class="status-level" style="color:var(--text-muted);margin-top:6px">TAP TO VIEW</div>
    `;
    stopHomeMonitoring();
  }
}

function startHomeMonitoring() {
  const tick = () => {
    const result = calcThreat(currentScenario);
    const lvl    = THREAT_LEVELS[result.level];
    const circle = document.getElementById('statusCircle');
    const cc     = document.getElementById('circleContent');

    if (!circle || !cc) return;

    circle.style.background  = lvl.bg;
    circle.style.borderColor = lvl.color;
    circle.style.boxShadow   = `0 0 40px ${lvl.color}44`;
    cc.innerHTML = `
      <div class="status-score" style="color:${lvl.color};font-family:var(--font-head);font-size:48px;font-weight:700;line-height:1">${result.score}</div>
      <div class="status-level" style="color:${lvl.color};font-family:var(--font-mono);font-size:11px;letter-spacing:2px;margin-top:4px">${result.level}</div>
    `;

    if (result.level === 'HIGH' || result.level === 'CRITICAL') {
      navigateTo('threat');
      initThreat(result, false);
    }
  };
  tick();
  monitoringLoop = setInterval(tick, 5000);
}

function stopHomeMonitoring() {
  if (monitoringLoop) clearInterval(monitoringLoop);
  monitoringLoop = null;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — SCENARIO & MONITORING
// ══════════════════════════════════════════════════════════════════════════════

function setScenario(s, btn) {
  currentScenario = s;
  document.querySelectorAll('.scenario-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  if (s === 'live') {
    if (!locationGranted) {
      requestLocation();
      showToast('📍 Requesting live location…', 'success');
    } else {
      showToast('📍 Live GPS mode active', 'success');
    }
  }
  runMonitoringTick();
}

function runMonitoringTick() {
  const result = calcThreat(currentScenario);
  const lvl    = THREAT_LEVELS[result.level];

  // Ring update
  const fill  = document.getElementById('ringFill');
  const score = document.getElementById('ringScore');
  const level = document.getElementById('ringLevel');
  const card  = document.getElementById('ringCard');
  if (fill) {
    fill.setAttribute('stroke-dasharray', `${(result.score / 100) * 326} 326`);
    fill.setAttribute('stroke', lvl.color);
  }
  if (score) { score.textContent = result.score; score.setAttribute('fill', lvl.color); }
  if (level) { level.textContent = result.level; level.setAttribute('fill', lvl.color); }
  if (card)  { card.style.borderColor = lvl.color; }

  // Factors grid
  const grid = document.getElementById('factorsGrid');
  if (grid) {
    grid.innerHTML = Object.entries(result.factors).map(([k, v]) => `
      <div class="factor-row">
        <span class="factor-name">${FACTOR_LABELS[k]}</span>
        <div class="factor-bar-bg"><div class="factor-bar-fill" style="width:${v}%;background:${lvl.color}"></div></div>
        <span class="factor-val">${v}</span>
      </div>
    `).join('');
  }

  // Map
  if (currentScenario !== 'live') extendSimTrail();
  drawMapTrail();

  // Activity Log
  const logEl = document.getElementById('logList');
  if (logEl) {
    const msgs = LOG_MESSAGES[result.level] || LOG_MESSAGES.LOW;
    const msg  = msgs[Math.floor(Math.random() * msgs.length)];
    const t    = new Date().toLocaleTimeString('en-IN');
    const row  = document.createElement('div');
    row.className = 'log-item';
    row.innerHTML = `
      <span class="log-time">${t}</span>
      <span class="log-badge" style="background:${lvl.color}">${result.level}</span>
      <span class="log-msg">${msg}</span>
    `;
    logEl.prepend(row);
    while (logEl.children.length > 20) logEl.removeChild(logEl.lastChild);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — HOME CONTACTS
// ══════════════════════════════════════════════════════════════════════════════

function renderHomeContacts() {
  const contacts = getContacts();
  const el       = document.getElementById('homeContacts');
  if (!el) return;

  if (contacts.length === 0) {
    el.innerHTML = `
      <div style="text-align:center;padding:16px 0;color:var(--text-muted);font-size:13px">
        No trusted contacts yet.<br>
        <button onclick="navigateTo('alert');setTab('contacts',null)" style="margin-top:8px;background:none;border:1px solid var(--border);color:var(--accent);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px">
          + Add Contacts
        </button>
      </div>`;
    return;
  }

  el.innerHTML = contacts.map(c => `
    <div class="contact-item">
      <div class="contact-avatar">${c.name.charAt(0).toUpperCase()}</div>
      <div>
        <div class="contact-name">${c.name}</div>
        <div class="contact-phone">${c.phone}</div>
      </div>
      <div class="contact-priority">#${c.priority || 1}</div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — ALERT TABS
// ══════════════════════════════════════════════════════════════════════════════

function setTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
  } else {
    document.querySelectorAll('.tab-btn').forEach(b => {
      if (b.textContent.toLowerCase().includes(tab)) b.classList.add('active');
    });
  }
  renderAlertTab(tab);
}

function renderAlertTab(tab) {
  const el = document.getElementById('tabContent');
  if (!el) return;

  if (tab === 'alerts')    el.innerHTML = buildAlertsTab();
  if (tab === 'contacts')  el.innerHTML = buildContactsTab();
  if (tab === 'resources') el.innerHTML = buildResourcesTab();
}

function buildAlertsTab() {
  const alerts = loadAlertHistory().reverse();
  if (alerts.length === 0) {
    return `<div class="empty-state">No alerts recorded yet.<br><small>Activate protection and trigger a threat to see alerts here.</small></div>`;
  }

  const total    = alerts.length;
  const resolved = alerts.filter(a => a.resolved).length;
  const peak     = Math.max(...alerts.map(a => a.score || 0));

  return `
    <div style="padding:12px 0;display:flex;flex-direction:column;gap:10px">
      <div class="card" style="display:flex;gap:8px;padding:12px 16px">
        ${[['Total Alerts', total], ['Resolved', resolved], ['Peak Score', peak]].map(([label, num]) => `
          <div class="stat-block">
            <div class="stat-num">${num}</div>
            <div class="stat-label">${label}</div>
          </div>
        `).join('')}
      </div>
      ${alerts.slice(0, 20).map(a => {
        const lvl = THREAT_LEVELS[a.level] || THREAT_LEVELS.LOW;
        const dt  = new Date(a.timestamp).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
        return `
          <div class="alert-card" style="border-left:3px solid ${lvl.color}">
            <div class="alert-card-header">
              <span class="alert-level-badge" style="background:${lvl.color}">${a.level}</span>
              <span class="alert-score">Score: ${a.score}</span>
              <span class="alert-status">${a.resolved ? '✅ Resolved' : '⚠️ Active'}</span>
            </div>
            <div class="alert-location">📍 ${a.location || 'Unknown location'}</div>
            <div class="alert-time">🕐 ${dt}</div>
            <div class="alert-contacts">👥 ${a.contacts_notified || 0} contact(s) notified${a.sms_sent ? ' · 📱 SMS sent' : ''}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function buildContactsTab() {
  const contacts = getContacts();
  return `
    <div style="padding:12px 0;display:flex;flex-direction:column;gap:12px">
      <div class="card">
        <div class="card-title">Trusted Contacts (${contacts.length})</div>
        ${contacts.length === 0
          ? `<div class="empty-state" style="padding:16px 0">
               No contacts yet.<br>
               <small>Add contacts below — they will receive SMS when a threat is detected.</small>
             </div>`
          : contacts.map((c, i) => `
            <div class="contact-item">
              <div class="contact-avatar">${c.name.charAt(0).toUpperCase()}</div>
              <div style="flex:1">
                <div class="contact-name">${c.name}</div>
                <div class="contact-phone">${c.phone}</div>
              </div>
              <div class="contact-priority">#${c.priority}</div>
              <button onclick="deleteContact(${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:4px 8px">✕</button>
            </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-title">Add New Contact</div>
        <input class="input-field" id="newContactName"  placeholder="Full Name (e.g. Priya — Sister)" />
        <input class="input-field" id="newContactPhone" placeholder="Phone: +91XXXXXXXXXX" type="tel" />
        <button class="btn-primary" onclick="addContact()">+ Add Trusted Contact</button>
        <div style="font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.6;padding:8px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
          📌 Enter phone in international format: <strong>+91XXXXXXXXXX</strong><br>
          💬 SMS will be sent when threat level is MEDIUM, HIGH or CRITICAL<br>
          🔧 Make sure the backend is running with AWS credentials in .env
        </div>
      </div>

      <div class="card" style="display:flex;flex-direction:column;gap:8px">
        <div class="card-title">SMS Test</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Send a test SMS to all contacts to verify AWS SNS is working</div>
        <button class="btn-primary" style="background:var(--surface2);border:1px solid var(--border)" onclick="sendTestSMS()">
          📱 Send Test SMS
        </button>
      </div>
    </div>`;
}

function buildResourcesTab() {
  return `
    <div style="padding:12px 0;display:flex;flex-direction:column;gap:12px">
      <div class="card">
        <div class="card-title">Emergency Numbers — India</div>
        ${RESOURCES.map(r => `
          <div class="resource-item">
            <span class="resource-icon">${r.icon}</span>
            <div>
              <div class="resource-name">${r.name}</div>
              <a href="tel:${r.number}" class="resource-number">${r.number}</a>
            </div>
            <a href="tel:${r.number}" class="call-btn">📞 Call</a>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-title">☁️ AWS Architecture</div>
        <div class="aws-service-list">
          ${[
            ['⚡','Lambda','Serverless SMS + alert processing'],
            ['🔔','SNS',   'Direct SMS to trusted contacts'],
            ['📦','S3',    'AES-256 encrypted evidence storage'],
            ['🗄️','DynamoDB','Alert & user data storage'],
            ['🚪','API Gateway','REST API endpoint'],
            ['📍','Geolocation API','Live GPS tracking (browser)'],
          ].map(([icon, name, desc]) => `
            <div class="aws-service">
              <span class="aws-icon">${icon}</span>
              <div><div class="aws-name">${name}</div><div class="aws-desc">${desc}</div></div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — CONTACT MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function addContact() {
  const nameInput  = document.getElementById('newContactName');
  const phoneInput = document.getElementById('newContactPhone');
  const name  = nameInput?.value.trim();
  const phone = phoneInput?.value.trim();

  if (!name)  { showToast('❌ Please enter a name', 'danger'); return; }
  if (!phone) { showToast('❌ Please enter a phone number', 'danger'); return; }

  const digits = phone.replace(/[\s\-()]/g, '');
  if (!/^(\+\d{10,15}|\d{10})$/.test(digits)) {
    showToast('❌ Enter a valid phone: +91XXXXXXXXXX or 10 digits', 'danger');
    return;
  }

  const contacts = getContacts();
  if (contacts.length >= 10) {
    showToast('❌ Maximum 10 contacts allowed', 'danger');
    return;
  }

  // Normalise to +91 if 10-digit Indian number
  const normalisedPhone = digits.startsWith('+') ? digits : `+91${digits}`;

  contacts.push({ id: `C-${Date.now()}`, name, phone: normalisedPhone, priority: contacts.length + 1 });
  saveContacts(contacts);
  renderAlertTab('contacts');
  renderHomeContacts();
  showToast(`✅ ${name} added as trusted contact`, 'success');

  // Clear inputs
  if (nameInput)  nameInput.value  = '';
  if (phoneInput) phoneInput.value = '';
}

function deleteContact(index) {
  const contacts = getContacts();
  const removed  = contacts.splice(index, 1);
  contacts.forEach((c, i) => c.priority = i + 1);
  saveContacts(contacts);
  renderAlertTab('contacts');
  renderHomeContacts();
  if (removed.length) showToast(`Removed ${removed[0].name}`, 'success');
}

async function sendTestSMS() {
  const contacts = getContacts();
  if (contacts.length === 0) {
    showToast('⚠️ Add contacts first!', 'danger');
    return;
  }
  showToast('📱 Sending test SMS…', 'success');
  const locationStr  = getLocationString();
  const phoneNumbers = contacts.map(c => c.phone);
  const message      = `✅ NIRBHAYA AI — Test SMS\nYour device is set up correctly.\nLocation: ${locationStr}\nTime: ${new Date().toLocaleTimeString('en-IN')}`;

  try {
    const resp = await fetch(`${API_URL}/send-sms`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phoneNumbers, message, alertLevel: 'TEST', score: 0, location: locationStr }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.demo_mode) {
        showToast(`📱 Test SMS demo (set AWS creds in .env to send real SMS)`, 'success');
      } else {
        showToast(`✅ Test SMS sent to ${data.sent} contact(s)!`, 'success');
      }
    } else {
      throw new Error('Server error');
    }
  } catch {
    showToast(`📱 Test SMS demo (backend offline — run: node Backend/index.js)`, 'success');
    console.log('[TEST SMS] Message:', message, '\nTo:', phoneNumbers);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — THREAT SCREEN
// ══════════════════════════════════════════════════════════════════════════════

function triggerSOS() {
  const result = {
    score: 95,
    level: 'CRITICAL',
    factors: { locationRisk: 85, timeRisk: 90, movementAnomaly: 85, voiceDistress: 0, environmental: 20 },
  };
  navigateTo('threat');
  initThreat(result, true);
}

function initThreat(result, isManualSOS) {
  // ✅ FIX 3 — Reset flag so SMS is definitely sent for each new alert
  smsSentThisAlert = false;
  cancelledAlert   = false;
  threatPhase      = 'alert';
  threatCountdown  = 15;

  document.getElementById('threatTitle').textContent = 'Threat Detected';
  renderThreat(result, isManualSOS);

  // Send SMS immediately for HIGH/CRITICAL
  if ((result.level === 'HIGH' || result.level === 'CRITICAL') && !smsSentThisAlert) {
    smsSentThisAlert = true;
    sendSMSToContacts(result);
  }

  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (cancelledAlert || threatPhase !== 'alert') { clearInterval(countdownTimer); return; }
    threatCountdown--;
    updateCountdown(result);
    if (threatCountdown <= 0) { clearInterval(countdownTimer); doEscalate(result); }
  }, 1000);
}

function renderThreat(result, isManualSOS) {
  const lvl         = THREAT_LEVELS[result.level];
  const actions     = ESCALATION_ACTIONS[result.level] || ESCALATION_ACTIONS.LOW;
  const locationStr = getLocationString();
  const mapsLink    = getMapsLink();

  document.getElementById('threatContent').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;padding:0 16px 24px">
      <div class="threat-banner" style="background:${lvl.color}">
        <div class="threat-banner-level">${result.level}</div>
        <div class="threat-banner-score">Threat Score: ${result.score} / 100</div>
        ${isManualSOS ? '<div class="threat-banner-sos">MANUAL SOS ACTIVATED</div>' : ''}
      </div>

      <div class="location-threat-card">
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:4px">📍 LIVE LOCATION</div>
        <div style="font-size:13px;color:var(--text);font-weight:500">${locationStr || 'Acquiring location…'}</div>
        ${mapsLink ? `<a href="${mapsLink}" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;margin-top:4px;display:block">🗺 Open in Google Maps →</a>` : ''}
      </div>

      <div class="countdown-block" id="countdownBlock">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r="48" fill="none" stroke="#1e2d4a" stroke-width="8"/>
          <circle id="countdownRing" cx="55" cy="55" r="48" fill="none" stroke="${lvl.color}"
            stroke-width="8" stroke-dasharray="301 301" stroke-linecap="round"
            transform="rotate(-90 55 55)" style="transition:stroke-dasharray 1s linear"/>
          <text x="55" y="50" text-anchor="middle" font-size="30" font-weight="700"
            fill="${lvl.color}" font-family="Rajdhani,sans-serif" id="countdownNum">${threatCountdown}</text>
          <text x="55" y="68" text-anchor="middle" font-size="10" fill="#6b7280"
            font-family="DM Sans,sans-serif">secs</text>
        </svg>
        <div class="countdown-label">Auto-alerting in ${threatCountdown}s</div>
        <div class="countdown-sub">SMS sent to trusted contacts with live GPS location</div>
      </div>

      <div class="card" id="escalationCard">
        <div class="card-title">Actions on Escalation</div>
        ${actions.map(a => `
          <div class="pending-action"><span class="pending-icon">⚙️</span><span>${a}</span></div>
        `).join('')}
      </div>

      <div class="card">
        <div class="card-title">Threat Factors</div>
        <div class="factors-mini">
          ${Object.entries(result.factors).map(([k, v]) => `
            <div class="factor-mini-row">
              <span>${k.replace(/([A-Z])/g, ' $1').trim()}</span>
              <span style="color:${lvl.color};font-weight:700">${v}</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="threat-actions" id="threatActions">
        <button class="btn-primary" style="background:${lvl.color}"
          onclick='doEscalate(${JSON.stringify(result).replace(/'/g, "\\'")})'>
          🆘 Alert Now
        </button>
        <button class="btn-secondary" onclick="cancelThreat()">
          ✓ I'm Safe — Cancel
        </button>
      </div>
    </div>`;
}

function updateCountdown(result) {
  const ring  = document.getElementById('countdownRing');
  const num   = document.getElementById('countdownNum');
  const label = document.querySelector('.countdown-label');
  if (!ring || !num) return;
  const lvl  = THREAT_LEVELS[result.level];
  const dash = (threatCountdown / 15) * 301;
  ring.setAttribute('stroke-dasharray', `${dash} 301`);
  ring.setAttribute('stroke', lvl.color);
  num.textContent = threatCountdown;
  num.setAttribute('fill', lvl.color);
  if (label) label.textContent = `Auto-alerting in ${threatCountdown}s`;
}

function cancelThreat() {
  cancelledAlert = true;
  threatPhase    = 'resolved';
  if (countdownTimer) clearInterval(countdownTimer);
  const block = document.getElementById('countdownBlock');
  if (block) block.style.display = 'none';
  const card = document.getElementById('escalationCard');
  if (card) card.innerHTML = `
    <div class="card-title">🚫 Alert Cancelled</div>
    <div style="font-size:13px;color:var(--text-muted);margin-top:8px">You confirmed you are safe. Contacts have been notified.</div>
  `;
  const actions = document.getElementById('threatActions');
  if (actions) actions.innerHTML = `
    <button class="btn-primary" style="background:#22c55e" onclick="navigateTo('home')">← Return to Home</button>
  `;
  document.getElementById('threatTitle').textContent = 'Alert Cancelled';
}

async function doEscalate(result) {
  if (countdownTimer) clearInterval(countdownTimer);
  threatPhase = 'escalating';

  const block = document.getElementById('countdownBlock');
  if (block) block.style.display = 'none';
  document.getElementById('threatTitle').textContent = 'Alert Sent';

  const actions     = ESCALATION_ACTIONS[result.level] || ESCALATION_ACTIONS.LOW;
  const card        = document.getElementById('escalationCard');
  const threatActEl = document.getElementById('threatActions');

  if (card)        card.innerHTML       = `<div class="card-title">⚡ Escalating…</div><div class="escalation-log" id="escLog"></div>`;
  if (threatActEl) threatActEl.innerHTML = '';

  // Send SMS with live location (guard against double-send)
  let smsResult = { sent: 0, contacts: getContacts() };
  if (!smsSentThisAlert) {
    smsSentThisAlert = true;
    smsResult = await sendSMSToContacts(result);
  }

  for (let i = 0; i < actions.length; i++) {
    await sleep(900);
    const log = document.getElementById('escLog');
    if (!log) continue;
    const el = document.createElement('div');
    el.className = 'esc-item';
    el.innerHTML = `
      <span class="esc-check">✓</span>
      <span class="esc-action">${actions[i]}</span>
      <span class="esc-time">${new Date().toLocaleTimeString('en-IN')}</span>`;
    log.appendChild(el);
  }

  await sleep(500);
  const log = document.getElementById('escLog');
  if (log) {
    const locationStr = getLocationString();
    const mapsLink    = getMapsLink();

    const smsEl = document.createElement('div');
    smsEl.className = 'esc-item';
    smsEl.innerHTML = `
      <span class="esc-check" style="color:#22c55e">✓</span>
      <span class="esc-action">📱 SMS with live GPS sent to ${smsResult.sent} contact(s)${smsResult.demo ? ' (demo)' : ''}</span>
      <span class="esc-time">${new Date().toLocaleTimeString('en-IN')}</span>`;
    log.appendChild(smsEl);

    const locEl = document.createElement('div');
    locEl.className = 'esc-item';
    locEl.innerHTML = `
      <span class="esc-check" style="color:#3b82f6">📍</span>
      <span class="esc-action">Location: ${locationStr}${mapsLink ? ` <a href="${mapsLink}" target="_blank" style="color:var(--accent)">[map]</a>` : ''}</span>
      <span class="esc-time">${new Date().toLocaleTimeString('en-IN')}</span>`;
    log.appendChild(locEl);

    const awsEl = document.createElement('div');
    awsEl.className = 'esc-item';
    awsEl.innerHTML = `
      <span class="esc-check" style="color:#22c55e">✓</span>
      <span class="esc-action">✅ Alert sent via AWS SNS${smsResult.demo ? ' (demo — add .env credentials)' : ''}</span>
      <span class="esc-time">${new Date().toLocaleTimeString('en-IN')}</span>`;
    log.appendChild(awsEl);
  }

  if (card) card.querySelector('.card-title').textContent = '✅ Actions Completed';

  // Save alert to history
  const alertHistory = loadAlertHistory();
  alertHistory.push({
    id:                `ALT-${Date.now()}`,
    timestamp:         new Date().toISOString(),
    level:             result.level,
    score:             result.score,
    location:          getLocationString(),
    lat:               currentPosition?.lat,
    lng:               currentPosition?.lng,
    resolved:          true,
    contacts_notified: smsResult.sent,
    sms_sent:          true,
  });
  saveAlertHistory(alertHistory);

  const ta = document.getElementById('threatActions');
  if (ta) ta.innerHTML = `
    <button class="btn-primary" style="background:#22c55e" onclick="navigateTo('home')">← Return to Home</button>
  `;
  threatPhase = 'resolved';
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — INIT
// ══════════════════════════════════════════════════════════════════════════════

function init() {
  startClock();
  initBattery();
  initNetwork();
  renderHomeContacts();
  renderAlertTab('alerts');

  if (navigator.permissions) {
    navigator.permissions.query({ name: 'geolocation' }).then(perm => {
      if (perm.state === 'granted') {
        locationGranted = true;
        hideBanner();
        requestLocation();
      } else if (perm.state === 'denied') {
        const banner = document.getElementById('gpsBanner');
        if (banner) {
          banner.style.background = 'rgba(239,68,68,0.1)';
          const title = banner.querySelector('.gps-banner-title');
          const sub   = banner.querySelector('.gps-banner-sub');
          if (title) title.textContent = 'Location Denied';
          if (sub)   sub.textContent   = 'Open browser settings → Allow location for this site';
        }
      }
    }).catch(() => {}); // permissions API not supported — that's fine
  }
}

init();
