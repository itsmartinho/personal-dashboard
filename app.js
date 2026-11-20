import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAE8DdLa9lFI6CapNsMbxxLj5q-qGQFNDI',
  authDomain: 'personal-dashboard-56625.firebaseapp.com',
  projectId: 'personal-dashboard-56625',
  storageBucket: 'personal-dashboard-56625.firebasestorage.app',
  messagingSenderId: '908002978391',
  appId: '1:908002978391:web:658b9ad83a84c30009d112',
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const LEGACY_STORAGE_KEY = 'personal_dashboard_v1';

const DEFAULT_STATE = {
  settings: {
    name: 'Martinho',
    city: 'Lisbon',
    lat: 38.7223,
    lon: -9.1393,
    unit: 'C',
    use24Hour: true,
    accent: 'indigo',
  },
  dailyFocus: {
    text: '',
    done: false,
  },
  tasks: [
    { id: 't1', text: 'Personalize your city & accent color in Settings', done: false, high: true },
    { id: 't2', text: 'Add your favorite quick links', done: false, high: false },
    { id: 't3', text: 'Connect dashboard.mrtnh.com on Spaceship', done: false, high: false },
  ],
  links: [
    { id: 'l1', title: 'GitHub', url: 'https://github.com' },
    { id: 'l2', title: 'Gmail', url: 'https://mail.google.com' },
    { id: 'l3', title: 'Calendar', url: 'https://calendar.google.com' },
    { id: 'l4', title: 'YouTube', url: 'https://youtube.com' },
    { id: 'l5', title: 'Drive', url: 'https://drive.google.com' },
    { id: 'l6', title: 'Firebase', url: 'https://console.firebase.google.com' },
  ],
  notes: '',
};

const QUOTES = [
  'Small daily improvements are the key to staggering long-term results.',
  'Focus on being productive instead of busy. — Tim Ferriss',
  'The secret of getting ahead is getting started. — Mark Twain',
  'Simplicity is the ultimate sophistication. — Leonardo da Vinci',
  'Do something today that your future self will thank you for.',
  'Action is the foundational key to all success. — Pablo Picasso',
  'Done is better than perfect.',
];

const TIMER_PRESETS = {
  focus: { seconds: 25 * 60, label: 'Focus session' },
  short: { seconds: 5 * 60, label: 'Short break' },
  long: { seconds: 15 * 60, label: 'Long break' },
};

const WMO_WEATHER = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Foggy', '🌫️'],
  48: ['Depositing rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Moderate drizzle', '🌦️'],
  55: ['Dense drizzle', '🌧️'],
  61: ['Light rain', '🌦️'],
  63: ['Moderate rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Moderate snow', '❄️'],
  75: ['Heavy snow', '❄️'],
  80: ['Rain showers', '🌦️'],
  81: ['Heavy showers', '🌧️'],
  82: ['Violent showers', '⛈️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm & hail', '⛈️'],
  99: ['Severe thunderstorm', '⛈️'],
};

let currentUser = null;
let unsubscribeDoc = null;
let saveDebounceTimer = null;
let lastLocalSaveAt = 0;
let state = structuredClone(DEFAULT_STATE);
let taskFilter = 'all';
let newTaskHighPriority = false;
let toastTimeout = null;
let lastWeatherCoords = '';
let lastWeatherData = null;

// Timer runtime state
let timerMode = 'focus';
let timerRemaining = TIMER_PRESETS.focus.seconds;
let timerInterval = null;
const RING_CIRCUMFERENCE = 2 * Math.PI * 60;

function mergeState(raw) {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_STATE);
  return {
    settings: { ...DEFAULT_STATE.settings, ...(raw.settings || {}) },
    dailyFocus: { ...DEFAULT_STATE.dailyFocus, ...(raw.dailyFocus || {}) },
    tasks: Array.isArray(raw.tasks) ? raw.tasks : structuredClone(DEFAULT_STATE.tasks),
    links: Array.isArray(raw.links) ? raw.links : structuredClone(DEFAULT_STATE.links),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function setSyncStatus(status, label) {
  const pill = document.getElementById('syncPill');
  const text = document.getElementById('syncLabel');
  const notesInd = document.getElementById('notesSavedIndicator');
  pill.classList.remove('syncing', 'error');
  if (status === 'syncing') pill.classList.add('syncing');
  if (status === 'error') pill.classList.add('error');
  text.textContent = label;
  if (notesInd) notesInd.textContent = label;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2600);
}

function applyAccent(accent) {
  if (accent && accent !== 'indigo') {
    document.documentElement.setAttribute('data-accent', accent);
  } else {
    document.documentElement.removeAttribute('data-accent');
  }
}

/* ==================== CLOUD SYNC ==================== */
function saveState({ immediate = false } = {}) {
  if (!currentUser) return;

  setSyncStatus('syncing', 'Syncing...');
  clearTimeout(saveDebounceTimer);

  const persist = async () => {
    if (!currentUser) return;
    lastLocalSaveAt = Date.now();
    try {
      const ref = doc(db, 'dashboards', currentUser.uid);
      await setDoc(
        ref,
        {
          settings: state.settings,
          dailyFocus: state.dailyFocus,
          tasks: state.tasks,
          links: state.links,
          notes: state.notes,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setSyncStatus('synced', 'Synced');
    } catch (err) {
      console.error('Firestore save error:', err);
      setSyncStatus('error', 'Sync error');
      showToast('Could not sync to cloud');
    }
  };

  if (immediate) {
    persist();
  } else {
    saveDebounceTimer = setTimeout(persist, 400);
  }
}

function renderAll({ updateNotesInput = true } = {}) {
  applyAccent(state.settings.accent);
  updateClock();
  renderDailyFocus();
  renderTasks();
  renderLinks();

  const notesArea = document.getElementById('notesArea');
  if (updateNotesInput && document.activeElement !== notesArea) {
    notesArea.value = state.notes;
  }
  updateNotesStats();

  const coordsKey = `${state.settings.lat},${state.settings.lon}`;
  if (coordsKey !== lastWeatherCoords) {
    lastWeatherCoords = coordsKey;
    fetchWeather();
  } else {
    renderWeather();
  }
}

function attachUserSync(user) {
  if (unsubscribeDoc) {
    unsubscribeDoc();
    unsubscribeDoc = null;
  }

  const ref = doc(db, 'dashboards', user.uid);
  setSyncStatus('syncing', 'Loading...');

  unsubscribeDoc = onSnapshot(
    ref,
    async (snap) => {
      if (!snap.exists()) {
        // First-time sign-in: migrate any local preview data if present, else use defaults
        let initial = structuredClone(DEFAULT_STATE);
        try {
          const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
          if (legacyRaw) {
            initial = mergeState(JSON.parse(legacyRaw));
            localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
        } catch {
          // Ignore invalid legacy cache
        }
        state = initial;
        renderAll();
        saveState({ immediate: true });
        return;
      }

      // Skip overwriting active typing if this snapshot echoes our own recent write
      const isFreshLocalEcho = snap.metadata.hasPendingWrites || Date.now() - lastLocalSaveAt < 900;
      const incoming = mergeState(snap.data());
      state = incoming;
      renderAll({ updateNotesInput: !isFreshLocalEcho });
      setSyncStatus('synced', 'Synced');
    },
    (err) => {
      console.error('Firestore listener error:', err);
      setSyncStatus('error', 'Offline');
      showToast('Sync connection interrupted');
    }
  );
}

/* ==================== CLOCK & GREETING ==================== */
function updateClock() {
  const now = new Date();
  const hours24 = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  document.getElementById('dateLabel').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  let greeting = 'Good evening';
  if (hours24 < 5) greeting = 'Good night';
  else if (hours24 < 12) greeting = 'Good morning';
  else if (hours24 < 18) greeting = 'Good afternoon';

  document.getElementById('greetingText').textContent = greeting;
  const name = (state.settings.name || '').trim();
  document.getElementById('greetingName').textContent = name ? `, ${name}` : '';

  const clockTime = document.getElementById('clockTime');
  const clockAmPm = document.getElementById('clockAmPm');
  const formatBtn = document.getElementById('toggleClockFormatBtn');

  if (state.settings.use24Hour) {
    clockTime.textContent = `${String(hours24).padStart(2, '0')}:${minutes}`;
    clockAmPm.textContent = '';
    formatBtn.textContent = '24H';
  } else {
    const hours12 = hours24 % 12 || 12;
    clockTime.textContent = `${String(hours12).padStart(2, '0')}:${minutes}`;
    clockAmPm.textContent = hours24 >= 12 ? 'PM' : 'AM';
    formatBtn.textContent = '12H';
  }

  document.getElementById('clockSeconds').textContent = `:${seconds}`;
}

/* ==================== DAILY FOCUS ==================== */
function renderDailyFocus() {
  const input = document.getElementById('dailyFocusInput');
  const check = document.getElementById('dailyFocusCheck');
  if (document.activeElement !== input) {
    input.value = state.dailyFocus.text;
  }
  check.classList.toggle('checked', state.dailyFocus.done);
  input.classList.toggle('completed', state.dailyFocus.done && Boolean(state.dailyFocus.text.trim()));
}

/* ==================== WEATHER (OPEN-METEO) ==================== */
function formatTemp(celsius) {
  if (typeof celsius !== 'number' || Number.isNaN(celsius)) return '--°';
  if (state.settings.unit === 'F') {
    return `${Math.round((celsius * 9) / 5 + 32)}°`;
  }
  return `${Math.round(celsius)}°`;
}

function renderWeather() {
  document.getElementById('toggleUnitBtn').textContent = `°${state.settings.unit}`;
  document.getElementById('weatherCity').textContent = state.settings.city || 'Unknown location';

  if (!lastWeatherData) return;

  const current = lastWeatherData.current;
  const daily = lastWeatherData.daily;
  const [desc, icon] = WMO_WEATHER[current.weather_code] || ['Clear', '🌤️'];

  document.getElementById('weatherIcon').textContent = icon;
  document.getElementById('weatherTemp').textContent = formatTemp(current.temperature_2m);
  document.getElementById('weatherDesc').textContent = desc;
  document.getElementById('weatherFeels').textContent = formatTemp(current.apparent_temperature);
  document.getElementById('weatherHumidity').textContent = `${Math.round(current.relative_humidity_2m)}%`;
  document.getElementById('weatherWind').textContent = `${Math.round(current.wind_speed_10m)} km/h`;

  if (daily && daily.temperature_2m_max && daily.temperature_2m_min) {
    const hi = formatTemp(daily.temperature_2m_max[0]);
    const lo = formatTemp(daily.temperature_2m_min[0]);
    document.getElementById('weatherStats').textContent = `H: ${hi} · L: ${lo}`;
  }
}

async function fetchWeather() {
  const descEl = document.getElementById('weatherDesc');
  try {
    const { lat, lon } = state.settings;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Weather fetch failed');
    lastWeatherData = await res.json();
    renderWeather();
  } catch {
    descEl.textContent = 'Unable to load weather';
  }
}

async function geocodeCity(cityName) {
  const trimmed = cityName.trim();
  if (!trimmed) return false;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.results || !data.results.length) return false;
    const match = data.results[0];
    state.settings.city = match.country_code ? `${match.name}, ${match.country_code}` : match.name;
    state.settings.lat = match.latitude;
    state.settings.lon = match.longitude;
    lastWeatherCoords = `${state.settings.lat},${state.settings.lon}`;
    saveState({ immediate: true });
    await fetchWeather();
    return true;
  } catch {
    return false;
  }
}

/* ==================== FOCUS TIMER ==================== */
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25, 783.99].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + index * 0.15;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  } catch {
    // Ignore audio errors
  }
}

function renderTimer() {
  const mins = String(Math.floor(timerRemaining / 60)).padStart(2, '0');
  const secs = String(timerRemaining % 60).padStart(2, '0');
  const total = TIMER_PRESETS[timerMode].seconds;
  const progress = 1 - timerRemaining / total;

  document.getElementById('timerDisplay').textContent = `${mins}:${secs}`;
  document.getElementById('timerProgress').style.strokeDashoffset = String(RING_CIRCUMFERENCE * progress);
  document.getElementById('timerToggleBtn').textContent = timerInterval ? 'Pause' : 'Start';
  document.getElementById('timerStatus').textContent = timerInterval
    ? TIMER_PRESETS[timerMode].label
    : timerRemaining === total
      ? 'Ready'
      : 'Paused';

  document.title = timerInterval ? `${mins}:${secs} · Personal Dashboard` : 'Personal Dashboard';
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function toggleTimer() {
  if (timerInterval) {
    stopTimer();
    renderTimer();
    return;
  }

  timerInterval = setInterval(() => {
    timerRemaining -= 1;
    if (timerRemaining <= 0) {
      timerRemaining = 0;
      stopTimer();
      renderTimer();
      playChime();
      showToast(`${TIMER_PRESETS[timerMode].label} complete!`);
      return;
    }
    renderTimer();
  }, 1000);

  renderTimer();
}

function setTimerMode(mode) {
  stopTimer();
  timerMode = mode;
  timerRemaining = TIMER_PRESETS[mode].seconds;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  renderTimer();
}

/* ==================== TASKS ==================== */
function renderTasks() {
  const list = document.getElementById('taskList');
  const total = state.tasks.length;
  const completed = state.tasks.filter((t) => t.done).length;
  const remaining = total - completed;

  document.getElementById('taskCountBadge').textContent = `${remaining} left`;
  document.getElementById('taskSummaryText').textContent = `${completed} of ${total} completed`;
  document.getElementById('taskProgressFill').style.width = total ? `${(completed / total) * 100}%` : '0%';
  document.getElementById('clearCompletedBtn').style.visibility = completed ? 'visible' : 'hidden';

  const visibleTasks = state.tasks.filter((t) => {
    if (taskFilter === 'active') return !t.done;
    if (taskFilter === 'done') return t.done;
    return true;
  });

  if (!visibleTasks.length) {
    const msg =
      taskFilter === 'done'
        ? 'No completed tasks yet.'
        : taskFilter === 'active'
          ? 'All caught up! Nothing left to do.'
          : 'No tasks yet. Add one above to get started.';
    list.innerHTML = `<li class="empty-state">${msg}</li>`;
    return;
  }

  list.innerHTML = '';
  visibleTasks.forEach((task) => {
    const li = document.createElement('li');
    li.className = `task-item${task.done ? ' done' : ''}`;

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'task-checkbox';
    checkbox.setAttribute('aria-label', task.done ? 'Mark task incomplete' : 'Mark task complete');
    checkbox.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    checkbox.addEventListener('click', () => {
      task.done = !task.done;
      renderTasks();
      saveState({ immediate: true });
    });

    const span = document.createElement('span');
    span.className = 'task-text';
    span.textContent = task.text;

    li.appendChild(checkbox);
    li.appendChild(span);

    if (task.high && !task.done) {
      const dot = document.createElement('span');
      dot.className = 'task-priority-badge';
      dot.title = 'High priority';
      li.appendChild(dot);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Delete task');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      renderTasks();
      saveState({ immediate: true });
    });

    li.appendChild(del);
    list.appendChild(li);
  });
}

/* ==================== QUICK LINKS ==================== */
function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function renderLinks() {
  const grid = document.getElementById('linksGrid');
  grid.innerHTML = '';

  if (!state.links.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">No quick links yet. Click "+ Add Link" to pin your favorite sites.</div>`;
    return;
  }

  state.links.forEach((link) => {
    const a = document.createElement('a');
    a.className = 'link-tile';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const host = getHostname(link.url);
    const faviconBox = document.createElement('div');
    faviconBox.className = 'link-favicon';

    const img = document.createElement('img');
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => {
      faviconBox.textContent = (link.title[0] || '?').toUpperCase();
    };
    faviconBox.appendChild(img);

    const info = document.createElement('div');
    info.className = 'link-info';
    info.innerHTML = `<div class="link-name"></div><div class="link-host"></div>`;
    info.querySelector('.link-name').textContent = link.title;
    info.querySelector('.link-host').textContent = host;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'link-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Remove ${link.title}`;
    removeBtn.setAttribute('aria-label', `Remove ${link.title}`);
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.links = state.links.filter((l) => l.id !== link.id);
      renderLinks();
      saveState({ immediate: true });
      showToast(`Removed ${link.title}`);
    });

    a.appendChild(faviconBox);
    a.appendChild(info);
    a.appendChild(removeBtn);
    grid.appendChild(a);
  });
}

/* ==================== NOTES ==================== */
function updateNotesStats() {
  const text = state.notes || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById('notesStats').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${text.length} chars`;
}

/* ==================== QUOTES ==================== */
let quoteIndex = new Date().getDate() % QUOTES.length;
function renderQuote() {
  document.getElementById('quoteText').textContent = `“${QUOTES[quoteIndex]}”`;
}

/* ==================== AUTH UI ==================== */
function formatAuthError(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a minute and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your internet connection.';
    default:
      return 'Could not sign in. Please try again.';
  }
}

async function handleSignOut() {
  try {
    if (unsubscribeDoc) {
      unsubscribeDoc();
      unsubscribeDoc = null;
    }
    stopTimer();
    await signOut(auth);
    state = structuredClone(DEFAULT_STATE);
    lastWeatherCoords = '';
    document.getElementById('notesArea').value = '';
    document.getElementById('dailyFocusInput').value = '';
    document.getElementById('settingsModal').close();
    showToast('Signed out');
  } catch {
    showToast('Could not sign out');
  }
}

/* ==================== SETTINGS MODAL ==================== */
function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  document.getElementById('accountEmailLabel').textContent = currentUser?.email || '—';
  document.getElementById('settingNameInput').value = state.settings.name || '';
  document.getElementById('settingCityInput').value = state.settings.city || '';
  document.querySelectorAll('.accent-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.accent === state.settings.accent);
  });
  modal.showModal();
}

/* ==================== INIT ==================== */
function init() {
  updateClock();
  setInterval(updateClock, 1000);
  renderTimer();
  renderQuote();
  setInterval(() => {
    if (currentUser) fetchWeather();
  }, 15 * 60 * 1000);

  // Auth state observer
  const loadingScreen = document.getElementById('authLoadingScreen');
  const authGate = document.getElementById('authGate');
  const appShell = document.getElementById('appShell');

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    loadingScreen.classList.add('hidden');

    if (user) {
      authGate.classList.add('hidden');
      appShell.classList.remove('hidden');
      attachUserSync(user);
    } else {
      if (unsubscribeDoc) {
        unsubscribeDoc();
        unsubscribeDoc = null;
      }
      appShell.classList.add('hidden');
      authGate.classList.remove('hidden');
      document.getElementById('loginPassword').value = '';
    }
  });

  // Login form
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const submitBtn = document.getElementById('loginSubmitBtn');

    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      errorEl.textContent = formatAuthError(err.code);
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
    }
  });

  document.getElementById('signOutBtn').addEventListener('click', handleSignOut);
  document.getElementById('modalSignOutBtn').addEventListener('click', handleSignOut);

  // Notes
  const notesArea = document.getElementById('notesArea');
  notesArea.addEventListener('input', () => {
    state.notes = notesArea.value;
    updateNotesStats();
    saveState();
  });

  document.getElementById('copyNotesBtn').addEventListener('click', async () => {
    if (!state.notes.trim()) return showToast('Nothing to copy yet');
    try {
      await navigator.clipboard.writeText(state.notes);
      showToast('Notes copied to clipboard');
    } catch {
      showToast('Could not copy notes');
    }
  });

  document.getElementById('clearNotesBtn').addEventListener('click', () => {
    if (!state.notes) return;
    if (!confirm('Clear all notes in your scratchpad?')) return;
    state.notes = '';
    notesArea.value = '';
    updateNotesStats();
    saveState({ immediate: true });
    showToast('Scratchpad cleared');
  });

  // Search form + "/" shortcut
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;
    window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank', 'noopener');
    input.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (!currentUser) return;
    const tag = document.activeElement?.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
  });

  // Clock toggle
  document.getElementById('toggleClockFormatBtn').addEventListener('click', () => {
    state.settings.use24Hour = !state.settings.use24Hour;
    updateClock();
    saveState({ immediate: true });
  });

  // Daily focus
  document.getElementById('dailyFocusInput').addEventListener('input', (e) => {
    state.dailyFocus.text = e.target.value;
    if (!state.dailyFocus.text.trim()) state.dailyFocus.done = false;
    renderDailyFocus();
    saveState();
  });

  document.getElementById('dailyFocusCheck').addEventListener('click', () => {
    if (!state.dailyFocus.text.trim()) {
      document.getElementById('dailyFocusInput').focus();
      return;
    }
    state.dailyFocus.done = !state.dailyFocus.done;
    renderDailyFocus();
    saveState({ immediate: true });
  });

  // Weather controls
  document.getElementById('toggleUnitBtn').addEventListener('click', () => {
    state.settings.unit = state.settings.unit === 'C' ? 'F' : 'C';
    renderWeather();
    saveState({ immediate: true });
  });

  document.getElementById('locateWeatherBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      return showToast('Geolocation not supported in this browser');
    }
    showToast('Detecting location...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.settings.lat = pos.coords.latitude;
        state.settings.lon = pos.coords.longitude;
        state.settings.city = 'Current Location';
        lastWeatherCoords = `${state.settings.lat},${state.settings.lon}`;
        saveState({ immediate: true });
        fetchWeather();
        showToast('Weather updated for your location');
      },
      () => showToast('Location access denied — set your city in Settings')
    );
  });

  // Timer controls
  document.getElementById('timerToggleBtn').addEventListener('click', toggleTimer);
  document.getElementById('timerResetBtn').addEventListener('click', () => setTimerMode(timerMode));
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTimerMode(btn.dataset.mode));
  });

  // Tasks controls
  const priorityBtn = document.getElementById('priorityToggleBtn');
  priorityBtn.addEventListener('click', () => {
    newTaskHighPriority = !newTaskHighPriority;
    priorityBtn.classList.toggle('high', newTaskHighPriority);
    priorityBtn.setAttribute('aria-pressed', String(newTaskHighPriority));
  });

  document.getElementById('taskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('taskInput');
    const text = input.value.trim();
    if (!text) return;
    state.tasks.unshift({
      id: `t_${Date.now()}`,
      text,
      done: false,
      high: newTaskHighPriority,
    });
    input.value = '';
    newTaskHighPriority = false;
    priorityBtn.classList.remove('high');
    priorityBtn.setAttribute('aria-pressed', 'false');
    renderTasks();
    saveState({ immediate: true });
  });

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      taskFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderTasks();
    });
  });

  document.getElementById('clearCompletedBtn').addEventListener('click', () => {
    state.tasks = state.tasks.filter((t) => !t.done);
    renderTasks();
    saveState({ immediate: true });
  });

  // Add Link Modal
  const addLinkModal = document.getElementById('addLinkModal');
  document.getElementById('openAddLinkBtn').addEventListener('click', () => {
    document.getElementById('linkTitleInput').value = '';
    document.getElementById('linkUrlInput').value = '';
    addLinkModal.showModal();
  });

  document.getElementById('addLinkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = document.getElementById('linkTitleInput').value.trim();
    const url = normalizeUrl(document.getElementById('linkUrlInput').value);
    if (!title || !url) return;
    state.links.push({ id: `l_${Date.now()}`, title, url });
    renderLinks();
    saveState({ immediate: true });
    addLinkModal.close();
    showToast(`Added ${title}`);
  });

  // Settings Modal
  const settingsModal = document.getElementById('settingsModal');
  let selectedAccent = state.settings.accent;

  document.getElementById('openSettingsBtn').addEventListener('click', () => {
    selectedAccent = state.settings.accent;
    openSettingsModal();
  });

  document.querySelectorAll('.accent-swatch').forEach((swatch) => {
    swatch.addEventListener('click', () => {
      selectedAccent = swatch.dataset.accent;
      document.querySelectorAll('.accent-swatch').forEach((s) => s.classList.toggle('active', s === swatch));
      applyAccent(selectedAccent);
    });
  });

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = document.getElementById('settingNameInput').value.trim();
    const newCity = document.getElementById('settingCityInput').value.trim();

    state.settings.name = newName;
    state.settings.accent = selectedAccent;
    applyAccent(selectedAccent);
    updateClock();
    saveState({ immediate: true });

    if (newCity && newCity.toLowerCase() !== (state.settings.city || '').toLowerCase()) {
      const ok = await geocodeCity(newCity);
      showToast(ok ? `Settings saved · Weather set to ${state.settings.city}` : 'Settings saved (city not found)');
    } else {
      showToast('Settings saved');
    }
    settingsModal.close();
  });

  // Export / Import / Reset
  document.getElementById('exportDataBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'personal-dashboard-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exported');
  });

  document.getElementById('importDataInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        state = mergeState(parsed);
        renderAll();
        saveState({ immediate: true });
        settingsModal.close();
        showToast('Backup restored & synced!');
      } catch {
        showToast('Invalid backup file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('resetDashboardBtn').addEventListener('click', () => {
    if (!confirm('Reset dashboard to default tasks, links, and settings?')) return;
    state = structuredClone(DEFAULT_STATE);
    renderAll();
    saveState({ immediate: true });
    settingsModal.close();
    showToast('Dashboard reset to defaults');
  });

  // Close modal buttons & backdrop click
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dialog = btn.closest('dialog');
      if (dialog === settingsModal) applyAccent(state.settings.accent);
      dialog?.close();
    });
  });

  [addLinkModal, settingsModal].forEach((dialog) => {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        if (dialog === settingsModal) applyAccent(state.settings.accent);
        dialog.close();
      }
    });
  });

  // Quotes
  document.getElementById('nextQuoteBtn').addEventListener('click', () => {
    quoteIndex = (quoteIndex + 1) % QUOTES.length;
    renderQuote();
  });
}

document.addEventListener('DOMContentLoaded', init);
