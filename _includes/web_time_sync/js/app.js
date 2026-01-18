import { BleTag } from './ble.js';
import { clamp, fmtTs } from './utils.js';
import { computeDeviceTimeFields, getAccurateClock } from './time.js';

const el = (id) => document.getElementById(id);

const btnConnect = el('btnConnect');
const btnDisconnect = el('btnDisconnect');
const btnSync = el('btnSync');
const tzOffsetInput = el('tzOffset');

const statusPill = el('statusPill');
const timeSourcePill = el('timeSourcePill');
const deviceNameEl = el('deviceName');
const lastFetchEl = el('lastFetch');
const lastSyncEl = el('lastSync');
const logEl = el('log');

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(connected) {
  if (connected) {
    statusPill.textContent = '已连接';
    statusPill.classList.add('ok');
    statusPill.classList.remove('bad');
  } else {
    statusPill.textContent = '未连接';
    statusPill.classList.remove('ok');
    statusPill.classList.remove('bad');
  }
}

function setTimeSource(source) {
  timeSourcePill.textContent = `时间源：${source}`;
}

function defaultTzOffsetHours() {
  // JS getTimezoneOffset() is minutes behind UTC (e.g. China = -480).
  // We want UTC+8 => +8.
  return -new Date().getTimezoneOffset() / 60;
}

// --- Clock management (auto-fetch, invisible to user) ---
let clock = null; // { source, utcNowMs }
let clockRefreshTimer = null;

async function refreshClock() {
  clock = await getAccurateClock();
  setTimeSource(clock.source);
  lastFetchEl.textContent = `${fmtTs(clock.utcNowMs())} (UTC)`;
  log(`获取时间成功：${clock.source}`);
}

async function ensureClockReady() {
  if (!clock) await refreshClock();
}

function scheduleClockRefresh() {
  if (clockRefreshTimer) clearInterval(clockRefreshTimer);
  // Keep accuracy without spamming APIs.
  clockRefreshTimer = setInterval(() => {
    refreshClock().catch(() => {
      // silent; next tick may recover
    });
  }, 5 * 60 * 1000);
}

// --- BLE ---
const tag = new BleTag(() => {
  log('BLE 已断开');
  deviceNameEl.textContent = '-';
  setStatus(false);
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;
  btnSync.disabled = true;
});

async function doConnect() {
  await ensureClockReady();
  const device = await tag.requestAndConnect();
  deviceNameEl.textContent = device.name || '(未命名设备)';
  setStatus(true);
  btnConnect.disabled = true;
  btnDisconnect.disabled = false;
  btnSync.disabled = false;
  log(`已连接：${device.name || device.id}`);

  // Note: Firmware does not expose a "read time" command via this RxTx characteristic.
  // So we cannot compute diff > 30s reliably. We keep sync manual.
}

function doDisconnect() {
  tag.disconnect();
  // disconnect callback will update UI.
}

async function doSync() {
  if (!tag.isConnected) {
    log('未连接，无法同步');
    return;
  }
  await ensureClockReady();

  const tzOffsetHours = clamp(parseFloat(tzOffsetInput.value || '0'), -12, 14);
  const utcNowMs = clock.utcNowMs();
  const fields = computeDeviceTimeFields(utcNowMs, tzOffsetHours);

  log(`同步时间… tz=UTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}`);
  log(`将设置为：${fields.debugLocalString} (设备本地时间)`);

  await tag.setTime(fields);

  lastSyncEl.textContent = `${new Date().toLocaleString()}（源：${clock.source}）`;
  log('同步完成');
}

// --- UI wiring ---
btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  try {
    await doConnect();
  } catch (e) {
    log(`连接失败：${e?.message || e}`);
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  doDisconnect();
});

btnSync.addEventListener('click', async () => {
  btnSync.disabled = true;
  try {
    await doSync();
  } catch (e) {
    log(`同步失败：${e?.message || e}`);
  } finally {
    btnSync.disabled = !tag.isConnected;
  }
});

// Init
(function init() {
  tzOffsetInput.value = String(defaultTzOffsetHours());
  setStatus(false);
  log('就绪。点击“连接 BLE”开始。');

  // Auto-fetch time in background.
  refreshClock().catch(() => {
    setTimeSource('local');
    log('网络时间获取失败，已使用本机时间');
  });
  scheduleClockRefresh();
})();
