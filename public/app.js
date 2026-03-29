// ==================== STATE & CONFIG ====================

// XSS bescherming: escape HTML in dynamische data
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const API_BASE = window.location.origin;
let currentScreen = 'scanner';
let currentFacility = 9; // Default: Maaslakei
let currentFloorplanFacility = 9; // Separate facility state for floorplan
let html5QrCode = null;
let isScanning = false;
let deviceId = generateDeviceId();

// AUDIO / HAPTICS FEEDBACK
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playFeedback(type) {
  // Haptic feedback
  if (navigator.vibrate) {
    if (type === 'success') {
      navigator.vibrate([100]); // Short vibration
    } else {
      navigator.vibrate([200, 100, 200]); // Double vibration
    }
  }

  // Audio feedback
  if (audioCtx) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (type === 'success') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // High pitch (A5)
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.15);
    } else {
      oscillator.type = 'triangle'; // Triangle sounds a bit softer than square but still distinct
      oscillator.frequency.setValueAtTime(220, audioCtx.currentTime); // Low pitch
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.3);
    }
  }
}

// AUTHENTICATION
function getAuthHeaders() {
  const token = localStorage.getItem('auth_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function authFetch(url, options = {}) {
  const headers = { ...getAuthHeaders(), ...options.headers };
  if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('auth_token');
    window.location.href = '/login.html';
    throw new Error('Niet ingelogd');
  }
  return res;
}

function checkAuth() {
  const token = localStorage.getItem('auth_token');
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  const role = localStorage.getItem('user_role');
  const historyBtn = document.querySelector('[data-screen="history"]');
  if (historyBtn) {
    historyBtn.classList.toggle('hidden', role !== 'admin');
  }

  const usersBtn = document.getElementById('nav-users');
  if (usersBtn) {
    usersBtn.classList.toggle('hidden', role !== 'admin');
  }

  return true;
}

// Check for SSO login token in URL (Cascade cross-app SSO)
(function handleSSOLogin() {
  const urlParams = new URLSearchParams(window.location.search);
  const ssoToken = urlParams.get('sso_login');
  if (ssoToken) {
    localStorage.setItem('auth_token', ssoToken);
    const ssoRole = urlParams.get('sso_role');
    const ssoUsername = urlParams.get('sso_username');
    if (ssoRole) localStorage.setItem('user_role', ssoRole);
    if (ssoUsername) localStorage.setItem('username', ssoUsername);
    // Verwijder SSO parameters uit URL
    window.history.replaceState({}, '', '/');
  }
})();

// Run auth check immediately
checkAuth();

// ==================== OFFLINE SYNC (IndexedDB) ====================
let db;
const request = indexedDB.open("QRScannerDB", 1);

request.onupgradeneeded = function (event) {
  db = event.target.result;
  if (!db.objectStoreNames.contains("offline_scans")) {
    db.createObjectStore("offline_scans", { keyPath: "id", autoIncrement: true });
  }
};

request.onsuccess = function (event) {
  db = event.target.result;
  if (navigator.onLine) {
    syncOfflineScans();
  }
};

function saveScanOffline(scanData) {
  if (!db) return;
  const transaction = db.transaction(["offline_scans"], "readwrite");
  const store = transaction.objectStore("offline_scans");
  store.add({
    ...scanData,
    timestamp: new Date().toISOString()
  });

  const offlineBanner = document.getElementById('offline-banner');
  if (offlineBanner) offlineBanner.style.display = 'block';

  showSuccessModal({
    status: 'ok',
    reservation_name: 'Offline Opgeslagen',
    contact_name: 'Wordt gesynchroniseerd',
    persons_entered: scanData.persons_entering,
    total_persons: '?',
    scanned_persons: '?',
    remaining_persons: 0,
    delivery_address: 'Wachten op internetverbinding...',
    tour_status: scanData.tour_leg ? (scanData.tour_leg === 'heen' ? 'Heenreis' : 'Terugreis') : null
  });
}

async function syncOfflineScans() {
  if (!db || !navigator.onLine) return;

  const transaction = db.transaction(["offline_scans"], "readonly");
  const store = transaction.objectStore("offline_scans");
  const req = store.getAll();

  req.onsuccess = async function () {
    const scans = req.result;
    if (scans.length === 0) {
      const banner = document.getElementById('offline-banner');
      if (banner) banner.style.display = 'none';
      return;
    }

    console.log(`Syncing ${scans.length} offline scans...`);
    let syncedCount = 0;

    for (const scan of scans) {
      try {
        const response = await fetch(`${API_BASE}/api/scan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
          },
          body: JSON.stringify({
            reservation_id: scan.reservation_id,
            persons_entering: scan.persons_entering,
            force_allow: true, // Force allow offline scans to prevent blocking them later
            device_id: scan.device_id,
            tour_leg: scan.tour_leg
          })
        });

        if (response.ok) {
          const delTx = db.transaction(["offline_scans"], "readwrite");
          delTx.objectStore("offline_scans").delete(scan.id);
          syncedCount++;
        }
      } catch (err) {
        console.error('Failed to sync offline scan', err);
      }
    }

    // Check if empty now
    const checkTx = db.transaction(["offline_scans"], "readonly");
    const checkReq = checkTx.objectStore("offline_scans").count();
    checkReq.onsuccess = function () {
      if (checkReq.result === 0) {
        const banner = document.getElementById('offline-banner');
        if (banner) banner.style.display = 'none';
      }
    };
  };
}

window.addEventListener('online', syncOfflineScans);
window.addEventListener('offline', () => {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.style.display = 'block';
});

// ==================== HELPERS ====================

function generateDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    id = 'device_' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('deviceId', id);
  }
  return id;
}

function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

function formatTime(timeString) {
  if (!timeString) return '';

  // Als er een T in zit, is het waarschijnlijk een ISO string YYYY-MM-DDTHH:MM:SS
  if (timeString.includes('T')) {
    return timeString.split('T')[1].substring(0, 5);
  }

  // SEM API kan ook "2000" (HHMM) retourneren
  const cleanTime = timeString.replace(/[^\d]/g, '');
  if (/^\d{4}$/.test(cleanTime)) {
    const hours = cleanTime.substring(0, 2);
    const minutes = cleanTime.substring(2, 4);
    return `${hours}:${minutes}`;
  }

  // Anders neem de eerste 5 karakters (HH:MM)
  return timeString.substring(0, 5);
}

function formatDateTime(isoString) {
  const date = new Date(isoString);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatDeliveryInfo(addr) {
  if (!addr) return '';
  let txt = typeof addr === 'string' ? addr : [addr.Name, addr.AddressLine1].filter(Boolean).join(', ');
  if (!txt) return '';

  // Extraheer getallen, sorteer ze van laag naar hoog en format als "1 + 2"
  const numbers = txt.match(/\d+/g);
  if (numbers && numbers.length > 0) {
    const sortedNumbers = numbers.map(Number).sort((a, b) => a - b);
    txt = sortedNumbers.join(' + ');
  }

  return `
    <div class="info-row" style="background: var(--bg-body); padding: 8px; border-radius: 8px; margin-bottom: 8px; justify-content: flex-start; gap: 8px;">
        <span class="info-label">Tafel</span>
        <span class="info-value" style="font-weight: 700; color: var(--brand-accent); font-size: 1.1em;">${escapeHtml(txt)}</span>
    </div>
    `;
}

function formatProductsInfo(products, isCollapsible = false) {
  if (!products || products.length === 0) return '';

  const productsHtml = products.map(p => {
    const hasNotes = p.notes && p.notes.trim() && p.notes.trim() !== '';
    return `
        <div style="margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px;">
                <span>${escapeHtml(p.name)}</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: 700;">${p.quantity}x</span>
                    ${hasNotes ? `<span class="product-notes-toggle" onclick="event.stopPropagation(); this.parentElement.parentElement.nextElementSibling.classList.toggle('hidden'); this.textContent = this.textContent === '+' ? '−' : '+';" style="cursor: pointer; background: var(--brand-accent); color: white; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; font-size: 16px; user-select: none;">+</span>` : ''}
                </div>
            </div>
            ${hasNotes ? `
            <div class="hidden" style="margin-top: 6px; padding: 8px; background: var(--bg-body); border-radius: 4px; font-size: 13px; line-height: 1.4; color: var(--text-secondary); border-left: 3px solid var(--brand-accent);">
                📝 ${escapeHtml(p.notes.trim())}
            </div>
            ` : ''}
        </div>
        `;
  }).join('');

  if (isCollapsible) {
    return `
        <details class="products-collapsible" style="margin-top: 12px;" onclick="event.stopPropagation()">
            <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: var(--brand-accent); display: flex; align-items: center; justify-content: space-between; background: var(--bg-tertiary); padding: 8px 12px; border-radius: 8px;">
                <span>📋 Extra producten (${products.length})</span>
                <span class="toggle-icon">▼</span>
            </summary>
            <div class="warning-box" style="background: var(--bg-secondary); border-color: var(--border-subtle); color: var(--text-primary); margin-top: 4px; padding: 12px; box-shadow: var(--shadow-card);">
                ${productsHtml}
            </div>
        </details>
        `;
  }

  return `
    <div class="warning-box" style="background: var(--bg-primary); border-color: var(--border-subtle); color: var(--text-primary); margin-top: 12px;">
        <div style="font-weight: 700; margin-bottom: 8px; font-size: 14px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 4px; display: flex; align-items: center; gap: 6px;">
            <span>📋 Extra producten</span>
        </div>
        ${productsHtml}
    </div>
    `;
}

// ==================== NAVIGATION ====================

function switchScreen(screenName) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.screen === screenName);
  });

  // Update screens
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });
  document.getElementById(`${screenName}-screen`).classList.add('active');

  currentScreen = screenName;
  window.scrollTo(0, 0);

  // Load data for screen
  if (screenName === 'reservations') {
    loadReservations();
  } else if (screenName === 'history') {
    loadHistory();
  } else if (screenName === 'scanner') {
    initScanner();
  } else if (screenName === 'users') {
    loadUsers();
  } else if (screenName === 'floorplan') {
    loadDepartures();
  }
}

// Setup nav listeners
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    if (item.id === 'logout-btn') return; // Logout has its own handler
    if (item.dataset.screen) {
      switchScreen(item.dataset.screen);
    }
  });
});

// ==================== QR SCANNER ====================

function initScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    alert('Fout: QR Scanner bibliotheek niet geladen. Controleer internetverbinding.');
    return;
  }

  const scannerContainer = document.querySelector('.scanner-container');
  const manualInput = document.getElementById('manual-reservation-id');

  // Check if a camera is available
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      const hasCamera = devices.some(d => d.kind === 'videoinput');

      if (!hasCamera) {
        // No camera — hide scanner, show only manual input
        if (scannerContainer) scannerContainer.style.display = 'none';
        if (manualInput) manualInput.placeholder = 'Voer Reservering ID in';
        return;
      }

      // Camera found — show scanner and start it
      if (scannerContainer) scannerContainer.style.display = '';
      startQrScanner();
    }).catch(() => {
      // Can't enumerate — try starting scanner anyway
      startQrScanner();
    });
  } else {
    // Old browser — try starting scanner anyway
    startQrScanner();
  }
}

function startQrScanner() {
  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("qr-reader");
  }

  html5QrCode.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: { width: 250, height: 250 }
    },
    onScanSuccess,
    onScanError
  ).then(() => {
    isScanning = true;
  }).catch(err => {
    console.error('Scanner start error:', err);
    // Camera failed — hide scanner, show only manual input
    const scannerContainer = document.querySelector('.scanner-container');
    if (scannerContainer) scannerContainer.style.display = 'none';
  });
}

function stopScanner() {
  if (html5QrCode && isScanning) {
    html5QrCode.stop().then(() => {
      isScanning = false;
    }).catch(err => {
      console.error('Scanner stop error:', err);
    });
  }
}

function onScanSuccess(decodedText, decodedResult) {
  // Extract reservation ID from QR code
  // Assuming QR contains just the ID or a URL with ID
  let reservationId = decodedText;

  // If it's a URL, extract ID
  if (decodedText.includes('reservation')) {
    const match = decodedText.match(/reservation[=\/](\d+)/i);
    if (match) {
      reservationId = match[1];
    }
  }

  // Process scan
  processScan(parseInt(reservationId));
}

function onScanError(errorMessage) {
  // Ignore scan errors (happens continuously when no QR in view)
}

// Manual scan button
document.getElementById('manual-scan-btn').addEventListener('click', () => {
  const input = document.getElementById('manual-reservation-id');
  const reservationId = parseInt(input.value);

  if (reservationId) {
    processScan(reservationId);
    input.value = '';
  }
});

// ==================== SCAN PROCESSING ====================

async function processScan(reservationId) {
  try {
    // Fetch full reservation details from SEM API via our backend
    const response = await authFetch(`${API_BASE}/api/reservation/${reservationId}`);

    if (!response.ok) {
      throw new Error('Reservering niet gevonden');
    }

    const reservationData = await response.json();

    // Show overview modal without phone number during scan process
    showReservationOverview(reservationId, reservationData, false);

  } catch (error) {
    if (!navigator.onLine || error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      // Offline fallback! Ask how many people, then submitScan.
      const ans = prompt(`Offline mode voor reservering #${reservationId}.\nHoeveel personen inchecken?`, "1");
      if (ans && !isNaN(ans)) {
        // We pass a dummy forceAllow=true for offline bypass
        submitScan(reservationId, parseInt(ans), true);
      }
      return;
    }
    console.error('Scan processing error:', error);
    showErrorModal(error.message || 'Fout bij ophalen reservering');
  }
}

async function openReservationDetail(reservationId) {
  try {
    // Toon even een lader in de modal? Of gewoon fetch
    const response = await authFetch(`${API_BASE}/api/reservation/${reservationId}`);
    if (!response.ok) throw new Error('Reservering niet gevonden');
    const data = await response.json();
    showReservationOverview(reservationId, data, true); // Hier tonen we wel het telefoonnummer
  } catch (error) {
    console.error('Error opening detail:', error);
    showErrorModal(error.message || 'Fout bij ophalen details');
  }
}

function showReservationOverview(reservationId, data, showPhone = true) {
  const modal = document.getElementById('scan-result-modal');
  const title = document.getElementById('result-title');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  const totalPersons = data.total_persons || 1;
  const scannedPersons = data.scanned_persons || 0;
  const remainingPersons = totalPersons - scannedPersons;

  // Check if reservation is for today
  const today = getCurrentDate();
  const reservationDate = data.reservation_date;
  const isToday = reservationDate === today;
  const isFuture = reservationDate > today;

  // Format date nicely
  const dateObj = new Date(reservationDate + 'T00:00:00');
  const formattedDate = dateObj.toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  title.textContent = `📋 ${data.reservation_name || `Reservering #${reservationId}`}`;

  // Body: show comprehensive info with new styling
  let statusBanner = '';

  if (isFuture) {
    statusBanner = `
        <div class="warning-box" style="background: var(--status-warn-bg); border-color: var(--status-warn); color: var(--status-warn);">
             <div style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
                ⚠️ LET OP: TOEKOMSTIGE DATUM
             </div>
             <div style="margin-top: 4px; color: var(--text-primary);">
                Datum: ${formattedDate}
             </div>
        </div>`;
  } else if (!isToday) {
    statusBanner = `
        <div class="warning-box" style="background: var(--status-deny-bg); border-color: var(--status-deny); color: var(--status-deny);">
             <div style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
                ✕ VERLOPEN DATUM
             </div>
             <div style="margin-top: 4px; color: var(--text-primary);">
                Datum: ${formattedDate}
             </div>
        </div>`;
  } else {
    statusBanner = `
         <div class="info-row" style="background: var(--status-info-bg); border: none; border-radius: 8px; margin-bottom: 16px;">
            <span class="info-label" style="color: var(--status-info);">Datum</span>
            <span class="info-value" style="color: var(--status-info); font-weight: 700;">✓ VANDAAG (${formattedDate})</span>
         </div>
        `;
  }

  body.innerHTML = `
     <div class="result-info">
       ${showPhone ? `
       <div class="info-row" style="background: var(--surface-light); padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; border: 1px dashed var(--brand-accent);">
         <span class="info-label" style="opacity: 0.7;">Reserveringsnummer</span>
         <span class="info-value" style="font-family: monospace; font-size: 1.1em; color: var(--brand-accent); font-weight: bold;">#${reservationId}</span>
       </div>
       ` : ''}
       ${statusBanner}
      
      ${data.start_time ? `
      <div class="info-row">
        <span class="info-label">Tijd</span>
        <span class="info-value">🕐 ${formatTime(data.start_time)} - ${formatTime(data.end_time)}</span>
      </div>
      ` : ''}

      ${formatDeliveryInfo(data.delivery_address)}
      
      <div class="info-row">
        <span class="info-label">Contactpersoon</span>
        <span class="info-value" style="font-weight: 500; display: flex; flex-direction: column; align-items: flex-end;">
            <span>👤 ${escapeHtml(data.contact_name) || '-'}</span>
            ${showPhone && data.contact_phone ? `<a href="tel:${escapeHtml(data.contact_phone)}" style="color: var(--brand-accent); font-size: 14px; text-decoration: none; margin-top: 4px;">📞 ${escapeHtml(data.contact_phone)}</a>` : ''}
        </span>
      </div>

      <div class="info-row">
        <span class="info-label">Aantal personen</span>
        <div style="text-align: right;">
          <div class="info-value" style="font-size: 1.2em; font-weight: bold;">👥 ${totalPersons}</div>
          ${data.child_counts && (data.child_counts.kids > 0 || data.child_counts.babies > 0) ? `
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 2px;">
              ${data.child_counts.kids > 0 ? `<span>🧒 ${data.child_counts.kids} kinderen</span>` : ''}
              ${data.child_counts.kids > 0 && data.child_counts.babies > 0 ? ' • ' : ''}
              ${data.child_counts.babies > 0 ? `<span>👶 ${data.child_counts.babies} (0-3 jr)</span>` : ''}
            </div>
          ` : ''}
        </div>
      </div>

      ${formatProductsInfo(data.products)}
      
      ${data.facilities && data.facilities.length > 0 ? `
      <div class="info-row">
        <span class="info-label">Faciliteiten</span>
        <span class="info-value" style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
          ${data.facilities.map(f => `<span style="display: flex; align-items: center; gap: 4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20l1-5h14l1 5"/><path d="M6 15V9a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><path d="M12 8V5"/></svg> ${f.name}</span>`).join(', ')}
        </span>
      </div>
      ` : ''}
      
      <div class="info-divider"></div>
      
      <div class="info-row">
        <span class="info-label">Huidige status</span>
        <span class="status-badge ${remainingPersons <= 0 ? 'status-success' : 'status-info'}">
           ${scannedPersons} / ${totalPersons} Binnen
        </span>
      </div>
      
      ${data.tour_leg ? `
      <div class="info-row" style="background: var(--status-info-bg); padding: 12px; border-radius: 8px; margin-top: 8px;">
        <span class="info-label" style="color: var(--status-info); display: flex; align-items: center; gap: 4px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20l1-5h14l1 5"/><path d="M6 15V9a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><path d="M12 8V5"/></svg> Tour de Thorn
        </span>
        <span class="info-value" style="color: var(--status-info); font-weight: 700;">${data.tour_leg === 'heen' ? 'Heenreis gescand' : 'Terugreis gescand'}</span>
      </div>
      ` : ''}
      
      ${data.validation_warnings && data.validation_warnings.length > 0 ? `
        <div class="warning-box">
          <div style="font-weight: 700; margin-bottom: 4px;">⚠️ Aandachtspunten:</div>
          ${data.validation_warnings.map(w => `<div>• ${w}</div>`).join('')}
        </div>
      ` : ''}

      ${data.finance && data.finance.open_amount > 0.01 ? `
        <div class="payment-banner" style="background: var(--status-deny-bg); border: 2px solid var(--status-deny); border-radius: 16px; padding: 16px; margin-top: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-weight: 700; color: var(--status-deny); font-size: 14px;">OPENSTAAND BEDRAG</span>
            <span style="font-size: 24px; font-weight: 800; color: var(--status-deny);">&euro;${data.finance.open_amount.toFixed(2)}</span>
          </div>
          <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
            Totaal: &euro;${data.finance.total_price.toFixed(2)} | Betaald: &euro;${data.finance.total_paid.toFixed(2)}
          </div>
          <button class="btn btn-warning" id="settle-from-detail-btn" style="width: 100%;">
            Afrekenen (&euro;${data.finance.open_amount.toFixed(2)})
          </button>
        </div>
      ` : (data.finance && data.finance.is_paid && data.finance.total_price > 0 ? `
        <div style="background: var(--status-ok-bg); border: 1px solid var(--status-ok); border-radius: 12px; padding: 10px 16px; margin-top: 12px; display: flex; align-items: center; justify-content: space-between;">
          <span style="color: var(--status-ok); font-weight: 700; font-size: 14px;">Betaald</span>
          <span style="color: var(--text-secondary); font-size: 13px;">&euro;${data.finance.total_price.toFixed(2)}</span>
        </div>
      ` : '')}

      ${data.internal_notes && data.internal_notes.trim() ? `
        <details class="notes-collapsible" style="margin-top: 12px; background: var(--surface-light); border-radius: 8px; padding: 8px;">
          <summary style="cursor: pointer; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 8px; user-select: none;">
            <span class="toggle-icon" style="font-size: 14px;">▶</span>
            📝 Interne notities
          </summary>
          <div style="margin-top: 8px; padding: 8px; background: var(--bg-body); border-radius: 4px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; color: var(--text-secondary);">
            ${escapeHtml(data.internal_notes.trim())}
          </div>
        </details>
      ` : ''}
    </div>
    
    ${remainingPersons > 0 && isToday ? `
    <div class="persons-input-group">
      <label for="persons-entering">Aantal personen nu:</label>
      <div style="display: flex; align-items: center; gap: 12px;">
          <button class="btn btn-secondary btn-counter" onclick="document.getElementById('persons-entering').stepDown()">-</button>
          <input
            type="number"
            id="persons-entering"
            min="1"
            max="${remainingPersons}"
            value="${remainingPersons}"
          >
          <button class="btn btn-secondary btn-counter" onclick="document.getElementById('persons-entering').stepUp()">+</button>
      </div>
    </div>
    ` : ''}
  `;

  // Check if this is a Tour de Thorn reservation
  const isTourDeThorn = data.reservation_name && data.reservation_name.includes('Tour de Thorn');

  // Footer: action buttons based on status
  if (isTourDeThorn && isToday) {
    // Tour de Thorn: show two buttons for heen/terug
    footer.innerHTML = `
        <div style="display: flex; gap: 12px; margin-bottom: 12px;">
          <button id="scan-heen-btn" class="btn btn-primary" style="flex: 1; padding: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 6px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Heenreis Scannen
          </button>
          <button class="btn btn-primary" id="scan-terug-btn" style="flex: 1;">
            🏠 Terugreis Scannen
          </button>
        </div>
        <button class="btn btn-secondary" id="cancel-scan-btn">
          Annuleer
        </button>
      `;

    document.getElementById('scan-heen-btn').addEventListener('click', () => {
      const personsEntering = parseInt(document.getElementById('persons-entering')?.value || totalPersons);
      submitScan(reservationId, personsEntering, false, 'heen');
    });

    document.getElementById('scan-terug-btn').addEventListener('click', () => {
      const personsEntering = parseInt(document.getElementById('persons-entering')?.value || totalPersons);
      submitScan(reservationId, personsEntering, false, 'terug');
    });

    document.getElementById('cancel-scan-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });
  } else if (remainingPersons > 0 && isToday) {
    footer.innerHTML = `
        <button class="btn btn-primary" id="confirm-scan-btn">
          Start Scan
        </button>
        <button class="btn btn-secondary" id="cancel-scan-btn" style="margin-top: 8px;">
          Annuleer
        </button>
      `;

    document.getElementById('confirm-scan-btn').addEventListener('click', () => {
      const personsEntering = parseInt(document.getElementById('persons-entering').value);
      submitScan(reservationId, personsEntering, false);
    });

    document.getElementById('cancel-scan-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });
  } else if (!isToday || remainingPersons <= 0) {
    // Show override option for wrong date or already scanned (including overcapacity)
    footer.innerHTML = `
        <button class="btn btn-warning" id="force-scan-btn">
          ⚠️ Toch Toelaten (Override)
        </button>
        <button class="btn btn-secondary" id="cancel-scan-btn" style="margin-top: 8px;">
          Annuleer
        </button>
      `;

    document.getElementById('force-scan-btn').addEventListener('click', () => {
      // Show person input for override inside the modal
      showOverrideScanInput(reservationId, totalPersons);
    });

    document.getElementById('cancel-scan-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  // Settle knop event listener (indien aanwezig in de body)
  const settleBtn = document.getElementById('settle-from-detail-btn');
  if (settleBtn) {
    settleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettleModal(reservationId, data).catch(err => {
        console.error('Settle modal error:', err);
        alert('Fout bij openen afrekenscherm: ' + err.message);
      });
    });
  }

  modal.classList.add('active');
}

function showOverrideScanInput(reservationId, totalPersons) {
  const modal = document.getElementById('scan-result-modal');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  // We keep the body largely the same but highlight the override nature
  const existingInfo = body.querySelector('.result-info');

  // Add override warning if not already there
  if (!existingInfo.querySelector('.override-alert')) {
    const warning = document.createElement('div');
    warning.className = 'warning-box override-alert';
    warning.innerHTML = '⚠️ <strong>Override Modus</strong><br>Je gaat personen toelaten buiten de normale regels. Dit wordt gelogd.';
    existingInfo.insertBefore(warning, existingInfo.firstChild);
  }

  // Add input if not present
  if (!body.querySelector('.persons-input-group')) {
    const inputGroup = document.createElement('div');
    inputGroup.className = 'persons-input-group';
    inputGroup.innerHTML = `
          <label for="persons-entering">Aantal te scannen:</label>
          <div style="display: flex; align-items: center; gap: 12px;">
              <button class="btn btn-secondary btn-counter" onclick="document.getElementById('persons-entering').stepDown()">-</button>
              <input
                type="number"
                id="persons-entering"
                min="1"
                max="${totalPersons}"
                value="1"
              >
              <button class="btn btn-secondary btn-counter" onclick="document.getElementById('persons-entering').stepUp()">+</button>
          </div>
        `;
    body.appendChild(inputGroup);
  }

  footer.innerHTML = `
    <button class="btn btn-warning" id="confirm-override-btn">
      ✓ Bevestig Override
    </button>
    <button class="btn btn-secondary" id="cancel-override-btn" style="margin-top: 8px;">
      Annuleer
    </button>
  `;

  document.getElementById('confirm-override-btn').addEventListener('click', () => {
    const personsEntering = parseInt(document.getElementById('persons-entering').value);
    submitScan(reservationId, personsEntering, true);
  });

  document.getElementById('cancel-override-btn').addEventListener('click', () => {
    modal.classList.remove('active');
  });
}

// ==================== AFREKENEN / SETTLE ====================

async function openSettleModal(reservationId, existingData = null) {
  const modal = document.getElementById('scan-result-modal');
  const title = document.getElementById('result-title');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  function showCloseButton() {
    footer.innerHTML = '<button class="btn btn-secondary" onclick="document.getElementById(\'scan-result-modal\').classList.remove(\'active\')">Sluiten</button>';
  }

  // Toon loading
  title.textContent = 'Afrekenen';
  body.innerHTML = '<div class="loading">Laden...</div>';
  showCloseButton();
  modal.classList.add('active');

  try {
  // Altijd vers ophalen voor actuele finance data
  let data;
  try {
    const response = await authFetch(`${API_BASE}/api/reservation/${reservationId}`);
    if (!response.ok) throw new Error('Kan reservering niet ophalen');
    data = await response.json();
  } catch (error) {
    body.innerHTML = `<div class="warning-box">${escapeHtml(error.message)}</div>`;
    showCloseButton();
    return;
  }

  const finance = data.finance;
  if (!finance || finance.open_amount <= 0.01) {
    body.innerHTML = '<div class="warning-box" style="background: var(--status-ok-bg); border-color: var(--status-ok); color: var(--status-ok);">Reservering is al betaald</div>';
    showCloseButton();
    return;
  }

  title.textContent = 'Afrekenen';

  // Producten weergave
  const products = finance.products || [];
  const compulsoryProducts = products.filter(p => p.type !== 'OptionalUnselected' && (p.total_price || 0) > 0);
  const productRows = compulsoryProducts.map(p => `
    <div style="display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; border-bottom: 1px solid var(--border-subtle, #eee);">
      <span>${escapeHtml(p.name)} ${p.quantity > 0 ? '(' + p.quantity + 'x)' : ''}</span>
      <span style="font-weight: 600;">&euro;${(p.total_price || 0).toFixed(2)}</span>
    </div>
  `).join('');

  body.innerHTML = `
    <div class="result-info">
      <div class="info-row">
        <span class="info-label">Reservering</span>
        <span class="info-value">${escapeHtml(data.reservation_name || '#' + reservationId)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Contactpersoon</span>
        <span class="info-value">${escapeHtml(data.contact_name || '-')}</span>
      </div>

      ${compulsoryProducts.length > 0 ? `
      <div style="background: var(--surface-light, #f5f5f5); border-radius: 12px; padding: 12px; margin-top: 8px;">
        <div style="font-weight: 700; margin-bottom: 8px; font-size: 14px;">Producten</div>
        ${productRows}
        <div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: 700; padding-top: 8px; margin-top: 4px; border-top: 2px solid var(--text-primary);">
          <span>Totaal</span>
          <span>&euro;${finance.total_price.toFixed(2)}</span>
        </div>
        ${finance.total_paid > 0.01 ? `
          <div style="display: flex; justify-content: space-between; font-size: 13px; padding-top: 4px; color: var(--status-ok);">
            <span>Al betaald</span>
            <span>- &euro;${finance.total_paid.toFixed(2)}</span>
          </div>
        ` : ''}
      </div>
      ` : ''}

      <div style="background: var(--status-deny-bg); border: 2px solid var(--status-deny); border-radius: 16px; padding: 20px; text-align: center; margin-top: 12px;">
        <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px;">INVOEREN OP TWELVE KASSA</div>
        <div style="font-size: 42px; font-weight: 800; color: var(--status-deny); letter-spacing: -1px;">&euro;${finance.open_amount.toFixed(2)}</div>
      </div>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary" id="confirm-settle-btn" style="width: 100%; font-size: 18px; padding: 16px;">
      Afgerekend op kassa
    </button>
    <button class="btn btn-secondary" id="cancel-settle-btn" style="width: 100%; margin-top: 8px;">
      Annuleer
    </button>
  `;

  // Bevestig betaling
  document.getElementById('confirm-settle-btn').addEventListener('click', async () => {
    const selectedMethod = 'kassa';

    const confirmBtn = document.getElementById('confirm-settle-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Verwerken...';

    try {
      const response = await authFetch(`${API_BASE}/api/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservation_id: reservationId,
          amount: finance.open_amount,
          payment_method: selectedMethod
        })
      });

      const result = await response.json();
      if (result.status === 'ok') {
        playFeedback('success');
        showSettlementSuccess(data, finance.open_amount);
      } else {
        throw new Error(result.message || 'Betaling mislukt');
      }
    } catch (error) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Bevestig Betaling \u20AC${finance.open_amount.toFixed(2)}`;
      // Toon error in modal
      const existingError = body.querySelector('.settle-error');
      if (existingError) existingError.remove();
      const errorDiv = document.createElement('div');
      errorDiv.className = 'warning-box settle-error';
      errorDiv.style.marginTop = '12px';
      errorDiv.textContent = error.message;
      body.querySelector('.result-info').appendChild(errorDiv);
    }
  });

  // Annuleer
  document.getElementById('cancel-settle-btn').addEventListener('click', () => {
    modal.classList.remove('active');
  });

  } catch (err) {
    console.error('openSettleModal error:', err);
    body.innerHTML = `<div class="warning-box">Fout bij openen afrekenscherm: ${escapeHtml(err.message)}</div>`;
    showCloseButton();
  }
}

function showSettlementSuccess(reservationData, amount) {
  const modal = document.getElementById('scan-result-modal');
  const title = document.getElementById('result-title');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  title.innerHTML = '<span style="color: var(--status-ok);">Afgerekend</span>';

  body.innerHTML = `
    <div class="result-info">
      <div class="warning-box" style="background: var(--status-ok-bg); border-color: var(--status-ok); color: var(--status-ok);">
        <div style="font-size: 18px; font-weight: 800;">AFGEREKEND OP KASSA</div>
      </div>
      <div class="info-row">
        <span class="info-label">Bedrag</span>
        <span class="info-value" style="font-size: 20px; font-weight: 800;">&euro;${amount.toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Reservering</span>
        <span class="info-value">${escapeHtml(reservationData.reservation_name || '')}</span>
      </div>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary" id="close-settle-success-btn" style="width: 100%;">OK</button>
  `;

  document.getElementById('close-settle-success-btn').addEventListener('click', () => {
    modal.classList.remove('active');
    if (currentScreen === 'reservations') loadReservations();
  });

  modal.classList.add('active');
}

// ==================== SCAN SUBMISSION ====================

async function submitScan(reservationId, personsEntering, forceAllow = false, tourLeg = null) {
  try {
    const body = {
      reservation_id: reservationId,
      persons_entering: personsEntering,
      force_allow: forceAllow,
      device_id: deviceId
    };

    if (tourLeg) {
      body.tour_leg = tourLeg;
    }

    const response = await authFetch(`${API_BASE}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const result = await response.json();

    if (result.status === 'ok') {
      showSuccessModal(result);
    } else if (result.status === 'denied') {
      showDeniedModal(result, reservationId, personsEntering);
    } else {
      showErrorModal(result.message || 'Onbekende fout');
    }

  } catch (error) {
    if (!navigator.onLine || error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      const body = {
        reservation_id: reservationId,
        persons_entering: personsEntering,
        force_allow: forceAllow,
        device_id: deviceId
      };
      if (tourLeg) body.tour_leg = tourLeg;
      saveScanOffline(body);
    } else {
      console.error('Submit scan error:', error);
      showErrorModal('Fout bij verwerken scan');
    }
  }
}

function showSuccessModal(result) {
  playFeedback('success');

  const modal = document.getElementById('scan-result-modal');
  const title = document.getElementById('result-title');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  // Titel volgens spec
  title.innerHTML = '<span class="text-success">✓ TOEGELATEN</span>';

  // Resultaat banner style
  body.innerHTML = `
    <div class="result-info">
      
      <!-- Status Banner -->
      <div class="warning-box" style="background: var(--status-ok-bg); border-color: var(--status-ok); color: var(--status-ok);">
         <div style="font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 8px;">
            ✓ SCAN OK
         </div>
      </div>

      ${formatDeliveryInfo(result.delivery_address)}
      
      <div class="info-row">
        <span class="info-label">Reservering</span>
        <span class="info-value">${escapeHtml(result.reservation_name)}</span>
      </div>

      <div class="info-row">
        <span class="info-label">Naam</span>
        <span class="info-value">👤 ${escapeHtml(result.contact_name) || '-'}</span>
      </div>
      
      <div class="info-row">
         <span class="info-label">Gescand</span>
         <span class="status-badge status-success">
           ${result.persons_entered} personen binnen
         </span>
      </div>

      ${formatProductsInfo(result.products)}

      ${result.tour_status ? `
      <div class="info-row" style="background: var(--status-info-bg); padding: 12px; border-radius: 8px; margin-top: 12px;">
        <span class="info-label" style="color: var(--status-info);">🚢 Tour de Thorn</span>
        <span class="info-value" style="color: var(--status-info); font-weight: 700;">${result.tour_status}</span>
      </div>
      ` : ''}

      <div class="info-divider"></div>

      <div class="info-row">
        <span class="info-label">Totaal status</span>
        <div style="text-align: right;">
          <div class="info-value">
            ${result.scanned_persons} / ${result.total_persons}
          </div>
          ${result.child_counts && (result.child_counts.kids > 0 || result.child_counts.babies > 0) ? `
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              ${result.child_counts.kids > 0 ? `🧒 ${result.child_counts.kids}` : ''}
              ${result.child_counts.kids > 0 && result.child_counts.babies > 0 ? ' • ' : ''}
              ${result.child_counts.babies > 0 ? `👶 ${result.child_counts.babies} (0-3 jr)` : ''}
            </div>
          ` : ''}
        </div>
      </div>

      ${result.remaining_persons > 0 ? `
        <div class="info-row">
          <span class="info-label">Nog te verwachten</span>
          <span class="info-value" style="font-size: 20px; color: var(--brand-primary);">${result.remaining_persons}</span>
        </div>
      ` : `
        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="status-badge status-success">COMPLEET</span>
        </div>
      `}
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary" id="close-success-btn">
      Volgende Scan
    </button>
  `;

  document.getElementById('close-success-btn').addEventListener('click', () => {
    modal.classList.remove('active');
    // Herstart scanner indien nodig
    if (currentScreen === 'scanner' && html5QrCode && !isScanning) {
      startScanner();
    }
  });

  modal.classList.add('active');
}

function showDeniedModal(result, reservationId, personsEntering) {
  playFeedback('error');

  const modal = document.getElementById('scan-result-modal');
  const title = document.getElementById('result-title');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  title.innerHTML = '<span class="text-error">✕ GEWEIGERD</span>';

  const reasonText = {
    'NOT_PAID': 'Niet volledig betaald',
    'CANCELLED': 'Geannuleerd',
    'TOO_EARLY': 'Te vroeg (datum)',
    'TOO_LATE': 'Verlopen (datum)',
    'ALREADY_SCANNED': 'Reeds gescand',
    'RESERVATION_NOT_FOUND': 'Niet gevonden'
  };

  const reasonLabel = reasonText[result.reason] || result.reason;

  body.innerHTML = `
    <div class="result-info">
      
      <!-- Denied Banner -->
      <div class="warning-box" style="background: var(--status-deny-bg); border-color: var(--status-deny); color: var(--text-primary);">
         <div style="font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 8px; color: var(--status-deny);">
            ✕ NIET TOEGELATEN
         </div>
         <div style="margin-top: 4px; font-weight: 600;">
            Reden: ${reasonLabel}
         </div>
         <div style="font-size: 12px; opacity: 0.7; font-family: monospace; margin-top: 2px;">
            CODE: ${result.reason}
         </div>
      </div>

        ${formatDeliveryInfo(result.delivery_address)}

        <div class="info-row">
          <span class="info-label">Reservering</span>
          <span class="info-value">${escapeHtml(result.reservation_name)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Naam</span>
          <span class="info-value" style="display: flex; flex-direction: column; align-items: flex-end;">
            <span style="display: flex; align-items: center; gap: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              ${escapeHtml(result.contact_name) || '-'}
            </span>
            ${result.child_counts && (result.child_counts.kids > 0 || result.child_counts.babies > 0) ? `
              <span style="font-size: 12px; color: var(--text-secondary); font-weight: normal; margin-top: 2px; display: flex; align-items: center; gap: 4px;">
                ${result.child_counts.kids > 0 ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M3 21v-2a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v2"/></svg> ${result.child_counts.kids}` : ''}
                ${result.child_counts.kids > 0 && result.child_counts.babies > 0 ? ' • ' : ''}
                ${result.child_counts.babies > 0 ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="4"/><path d="M8 21h8"/><path d="M10 21v-4"/><path d="M14 21v-4"/><path d="M6 14s1.5-2 6-2 6 2 6 2"/></svg> ${result.child_counts.babies} (0-3 jr)` : ''}
              </span>
            ` : ''}
          </span>
        </div>

        ${formatProductsInfo(result.products)}

      ${result.reason === 'NOT_PAID' && result.open_amount ? `
      <div style="background: var(--status-deny-bg); border: 2px solid var(--status-deny); border-radius: 16px; padding: 20px; text-align: center; margin-top: 12px;">
        <div style="font-size: 14px; font-weight: 600; color: var(--status-deny); margin-bottom: 4px;">TE BETALEN</div>
        <div style="font-size: 36px; font-weight: 800; color: var(--status-deny);">&euro;${parseFloat(result.open_amount).toFixed(2)}</div>
      </div>
      ` : `
      <div class="info-divider"></div>
      <div class="info-row">
        <span class="info-label">Actie vereist</span>
        <span class="info-value">Weigeren of Override</span>
      </div>
      `}
    </div>
  `;

  if (result.reason === 'NOT_PAID' && result.open_amount) {
    // NOT_PAID: toon Afrekenen + Override + Annuleer
    const openAmount = parseFloat(result.open_amount);
    footer.innerHTML = `
      <button class="btn btn-primary" id="settle-now-btn" style="width: 100%; font-size: 16px;">
        Afrekenen (&euro;${openAmount.toFixed(2)})
      </button>
      <button class="btn btn-warning" id="force-allow-btn" style="width: 100%; margin-top: 8px;">
        Toch Toelaten (Override)
      </button>
      <button class="btn btn-secondary" id="cancel-denied-btn" style="width: 100%; margin-top: 8px;">
        Annuleer
      </button>
    `;

    document.getElementById('settle-now-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openSettleModal(reservationId).catch(err => {
        console.error('Settle modal error:', err);
        alert('Fout bij openen afrekenscherm: ' + err.message);
      });
    });

    document.getElementById('force-allow-btn').addEventListener('click', () => {
      submitScan(reservationId, personsEntering, true);
    });

    document.getElementById('cancel-denied-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });
  } else {
    // Andere redenen: standaard Override + Annuleer
    footer.innerHTML = `
      <button class="btn btn-warning" id="force-allow-btn">
        Toch Toelaten (Override)
      </button>
      <button class="btn btn-secondary" id="cancel-denied-btn" style="margin-top: 8px;">
        Annuleer
      </button>
    `;

    document.getElementById('force-allow-btn').addEventListener('click', () => {
      submitScan(reservationId, personsEntering, true);
    });

    document.getElementById('cancel-denied-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  modal.classList.add('active');
}

function showErrorModal(message) {
  playFeedback('error');

  const modal = document.getElementById('scan-result-modal');
  const title = document.getElementById('result-title');
  const body = document.getElementById('result-body');
  const footer = document.getElementById('result-footer');

  title.textContent = '❌ Fout';
  body.innerHTML = `<p style="color: var(--error);">${escapeHtml(message)}</p>`;
  footer.innerHTML = `
    <button class="btn btn-secondary" id="close-error-btn">Sluiten</button>
  `;

  document.getElementById('close-error-btn').addEventListener('click', () => {
    modal.classList.remove('active');
  });

  modal.classList.add('active');
}

// Close modal button
document.getElementById('close-result-modal').addEventListener('click', () => {
  document.getElementById('scan-result-modal').classList.remove('active');
});

// ==================== RESERVATIONS SCREEN ====================

// Ship toggle
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFacility = parseInt(btn.dataset.facility);
    loadReservations();
  });
});


// Search filter for reservations
const searchInput = document.getElementById('reservation-search');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase().trim();
    const cards = document.querySelectorAll('#reservations-list .reservation-card');
    cards.forEach(card => {
      const text = card.getAttribute('data-search') || '';
      if (text.includes(term)) {
        card.style.display = 'block';
      } else {
        card.style.display = 'none';
      }
    });
  });
}

async function loadReservations() {
  const container = document.getElementById('reservations-list');
  container.innerHTML = '<div class="loading">Laden</div>';

  try {
    const date = getCurrentDate();
    const response = await authFetch(`${API_BASE}/api/reservations?date=${date}&facility=${currentFacility}`);
    const reservations = await response.json();

    // ================== DASHBOARD STATS ==================
    try {
      const statsRes = await authFetch(`${API_BASE}/api/stats?date=${date}&facility=${currentFacility}`);
      const stats = await statsRes.json();

      document.getElementById('stats-expected').textContent = stats.expected;
      document.getElementById('stats-scanned').textContent = stats.scanned;

      const percEl = document.getElementById('stats-percentage-badge');
      percEl.textContent = `${stats.percentage}%`;

      if (stats.percentage >= 100) {
        percEl.style.background = 'var(--status-ok-bg)';
        percEl.style.color = 'var(--status-ok)';
      } else if (stats.percentage > 0) {
        percEl.style.background = 'var(--status-info-bg)';
        percEl.style.color = 'var(--status-info)';
      } else {
        percEl.style.background = 'var(--surface-light)';
        percEl.style.color = 'var(--text-secondary)';
      }
    } catch (err) {
      console.error('Stats error:', err);
    }
    // =====================================================

    if (reservations.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Geen reserveringen gevonden voor vandaag</p>
        </div>
      `;
      return;
    }

    container.innerHTML = reservations.map(r => {
      const scanned = parseInt(r.scanned_persons) || 0;
      const total = parseInt(r.total_persons) || 1;
      const isOverCapacity = scanned > total;

      // Progress is max 100% for the bar width, but color changes if over
      let progress = total > 0 ? (scanned / total) * 100 : 0;
      if (progress > 100) progress = 100;

      let barClass = '';
      if (isOverCapacity) {
        barClass = 'overcapacity'; // Rood voor te veel personen
      } else if (r.scan_status === 'complete') {
        barClass = 'complete'; // Groen voor exact aantal
      }

      // Betaalstatus badge
      const openAmount = parseFloat(r.open_amount) || 0;
      const isPaid = r.is_paid;
      const paymentBadge = (!isPaid && openAmount > 0.01) ? `
              <div style="margin-top: 8px; display: flex; align-items: center; justify-content: space-between;">
                <span class="payment-badge-open">OPEN: &euro;${openAmount.toFixed(2)}</span>
                <button class="btn btn-warning" onclick="event.stopPropagation(); openSettleModal(${r.reservation_id})" style="width: auto; padding: 6px 14px; font-size: 13px;">
                  Afrekenen
                </button>
              </div>
            ` : '';

      // Tour de Thorn indicator
      const tourLegBadge = r.tour_leg ? `
              <div style="margin-top: 8px;">
                <span style="background: var(--status-info-bg); color: var(--status-info); padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20l1-5h14l1 5"/><path d="M6 15V9a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><path d="M12 8V5"/></svg>
                  ${r.tour_leg === 'heen' ? 'Heenreis gescand' : 'Terugreis gescand'}
                </span>
              </div>
            ` : '';

      return `
        <div class="reservation-card status-${r.scan_status}" data-search="${escapeHtml((r.name + ' ' + (r.contact_name || '') + ' ' + r.reservation_id).toLowerCase())}" onclick="openReservationDetail(${r.reservation_id})" style="cursor: pointer;">
          <div class="reservation-header">
            <div>
              <div class="reservation-name">${r.name}</div>
              <div class="reservation-contact" style="font-size: 14px; color: var(--text-secondary); margin-top: 2px; display: flex; align-items: center; gap: 4px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                ${r.contact_name || '-'}
              </div>
              <div class="reservation-time" style="display: flex; align-items: center; gap: 4px; margin-top: 2px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                ${formatTime(r.start_time)} - ${formatTime(r.end_time)}
              </div>
            </div>
            <span class="status-badge status-${(r.scan_status === 'complete' || isOverCapacity) ? 'success' :
          r.scan_status === 'partial' ? 'warning' : 'info'
        }">
              ${scanned} / ${total}
            </span>
          </div>
          
          <div class="reservation-meta">
            <div class="meta-item">
              👥 ${total} personen
              ${r.child_counts && (r.child_counts.kids > 0 || r.child_counts.babies > 0) ? `
                <span style="opacity: 0.7; font-size: 11px; margin-left: 4px;">
                  (${r.child_counts.kids > 0 ? `🧒${r.child_counts.kids}` : ''}${r.child_counts.kids > 0 && r.child_counts.babies > 0 ? '•' : ''}${r.child_counts.babies > 0 ? `👶${r.child_counts.babies}` : ''})
                </span>
              ` : ''}
            </div>
            ${formatDeliveryInfo(r.delivery_address)}
          </div>
          
          ${paymentBadge}
          ${tourLegBadge}

          <div class="progress-bar">
            <div class="progress-fill ${barClass}"
                 style="width: ${progress}%"></div>
          </div>
        </div>
      `;
    }).join('');

  } catch (error) {
    console.error('Load reservations error:', error);
    container.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--error);">Fout bij laden reserveringen</p>
      </div>
    `;
  }
}

// Auto-refresh reservations every 5 minutes when on that screen
setInterval(() => {
  if (currentScreen === 'reservations') {
    loadReservations();
  }
}, 300000); // 5 minutes

// Manual refresh button listener
const refreshBtn = document.getElementById('refresh-reservations-btn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('refreshing');
    const originalText = refreshBtn.innerHTML;
    refreshBtn.innerHTML = '🔄 Verversen...';

    await loadReservations();

    setTimeout(() => {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('refreshing');
      refreshBtn.innerHTML = originalText;
    }, 500);
  });
}

// ==================== FLOORPLAN SCREEN ====================

// Floorplan ship toggle
document.querySelectorAll('[data-floorplan-facility]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-floorplan-facility]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFloorplanFacility = parseInt(btn.dataset.floorplanFacility);
    loadDepartures();
  });
});

// Departure select change
const departureSelect = document.getElementById('departure-select');
if (departureSelect) {
  departureSelect.addEventListener('change', () => {
    const departureId = departureSelect.value;
    if (departureId) {
      loadFloorplan(departureId);
    } else {
      showFloorplanPlaceholder();
    }
  });
}

async function loadDepartures() {
  const select = document.getElementById('departure-select');
  if (!select) return;

  select.innerHTML = '<option value="">Laden...</option>';
  select.disabled = true;

  try {
    const response = await authFetch(`${API_BASE}/api/departures?date=${getCurrentDate()}&facility=${currentFloorplanFacility}`);
    const departures = await response.json();

    if (departures.length === 0) {
      select.innerHTML = '<option value="">Geen vertrekken vandaag</option>';
      showFloorplanPlaceholder('Geen vertrekken gevonden voor vandaag');
      return;
    }

    select.innerHTML = '<option value="">Selecteer een vertrek...</option>' +
      departures.map(d => {
        const time = formatTime(d.start_time);
        const endTime = formatTime(d.end_time);
        return `<option value="${d.reservation_id}">${d.name} (${time} - ${endTime})</option>`;
      }).join('');

    // Auto-select if only one departure
    if (departures.length === 1) {
      select.value = departures[0].reservation_id;
      loadFloorplan(departures[0].reservation_id);
    } else {
      showFloorplanPlaceholder();
    }

  } catch (error) {
    console.error('Load departures error:', error);
    select.innerHTML = '<option value="">Fout bij laden vertrekken</option>';
    showFloorplanError('Kan vertrekken niet laden');
  } finally {
    select.disabled = false;
  }
}

async function loadFloorplan(departureId) {
  const container = document.getElementById('floorplan-container');
  if (!container) return;

  // Show loading
  container.innerHTML = `
        <div class="floorplan-loading">
            <div class="spinner"></div>
            <p>Plattegrond laden...</p>
        </div>
    `;

  try {
    // Request temporary embed token from server (API key stays server-side)
    const tokenRes = await authFetch(`${API_BASE}/api/floorplan-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departureId, date: getCurrentDate() })
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      throw new Error(err.message || 'Token aanvraag mislukt');
    }

    const { url: embedUrl } = await tokenRes.json();

    // Append scanApi param for scan status coloring
    const scanApiUrl = encodeURIComponent(`${API_BASE}/api/scan-statuses?date=${getCurrentDate()}`);
    const separator = embedUrl.includes('?') ? '&' : '?';
    const fullUrl = `${embedUrl}${separator}scanApi=${scanApiUrl}`;

    container.innerHTML = `<iframe src="${fullUrl}" allow="fullscreen" loading="lazy"></iframe>`;

  } catch (error) {
    console.error('Load floorplan error:', error);
    showFloorplanError(error.message || 'Kan plattegrond niet laden');
  }
}

function showFloorplanPlaceholder(message) {
  const container = document.getElementById('floorplan-container');
  if (!container) return;

  container.innerHTML = `
        <div class="floorplan-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 48px; height: 48px; opacity: 0.3;">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 3v18" />
            </svg>
            <p>${message || 'Selecteer een vertrek om de plattegrond te bekijken'}</p>
        </div>
    `;
}

function showFloorplanError(message) {
  const container = document.getElementById('floorplan-container');
  if (!container) return;

  container.innerHTML = `
        <div class="floorplan-error">
            <span style="font-size: 32px;">⚠️</span>
            <p>${message}</p>
        </div>
    `;
}

// ==================== HISTORY SCREEN ====================

async function loadHistory() {
  const container = document.getElementById('history-list');
  container.innerHTML = '<div class="loading">Laden</div>';

  try {
    const role = localStorage.getItem('user_role');
    if (role !== 'admin') return;

    const response = await authFetch(`${API_BASE}/api/history`);
    const history = await response.json();

    if (history.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Nog geen scans vandaag</p>
        </div>
      `;
      return;
    }

    container.innerHTML = history.map(h => `
      <div class="history-card">
        <div class="history-header">
          <div class="history-detail-item">
            <span class="history-time">${formatDateTime(h.timestamp)}</span>
            <span class="status-badge status-info" style="font-size: 10px; padding: 2px 6px;">ID: ${h.reservation_id}</span>
          </div>
          <div class="history-detail-item">
            ${h.forced ? '<span class="status-badge status-error">OVERRIDE</span>' : ''}
            <button class="btn btn-secondary btn-sm" data-action="delete-scan" data-id="${h.id}" style="padding: 2px 8px; font-size: 12px; color: #d32f2f; background: #ffebee; border-color: #ffcdd2;">Wis</button>
          </div>
        </div>
        <div class="history-name">${h.reservation_name || 'Reservering'}</div>
        <div class="history-contact">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${h.contact_name || '-'}
        </div>
        <div class="history-details">
          <span class="history-detail-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <strong>${h.persons_entered}</strong> personen
          </span>
          <span class="history-detail-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            ${h.device_id.replace('device_', '')}
          </span>
        </div>
      </div>
    `).join('');

  } catch (error) {
    console.error('Load history error:', error);
    container.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--error);">Fout bij laden geschiedenis</p>
      </div>
    `;
  }
}

async function deleteScan(id) {
  if (!confirm('Weet je zeker dat je deze scan wilt terugdraaien? Het aantal ingecheckte personen wordt verminderd.')) {
    return;
  }

  try {
    const response = await authFetch(`${API_BASE}/api/history/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Undo mislukt');
    }

    loadHistory();
  } catch (err) {
    console.error('Fout bij undo:', err);
    alert('Fout bij undo scan: ' + err.message);
  }
}

// Export CSV handler
const exportCsvBtn = document.getElementById('export-csv-btn');
if (exportCsvBtn) {
  exportCsvBtn.addEventListener('click', async () => {
    const originalText = exportCsvBtn.innerHTML;
    exportCsvBtn.innerHTML = '⏳ Bezig...';
    exportCsvBtn.disabled = true;

    try {
      const response = await authFetch(`${API_BASE}/api/history/export`);
      const blob = await response.blob();

      // Create an invisible link to trigger download
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      const dateStr = new Date().toISOString().split('T')[0];
      a.download = `qr - scans - ${dateStr}.csv`;
      document.body.appendChild(a);
      a.click();

      // Cleanup
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('CSV Export mislukt:', err);
      alert('Kan CSV niet exporteren: ' + err.message);
    } finally {
      exportCsvBtn.innerHTML = originalText;
      exportCsvBtn.disabled = false;
    }
  });
}

// ==================== USERS SCREEN ====================

async function loadUsers() {
  const container = document.getElementById('users-list');
  container.innerHTML = '<div class="loading">Laden...</div>';

  try {
    const response = await authFetch(`${API_BASE}/api/users`);
    const users = await response.json();

    container.innerHTML = users.map(u => `
      <div class="user-card">
        <div>
          <div style="font-weight: 700; font-size: 16px;">${u.username}</div>
          ${u.email ? `<div style="font-size: 13px; color: var(--text-secondary); margin-top: 2px;">${u.email}</div>` : ''}
          <div class="status-badge ${u.role === 'admin' ? 'status-info' : 'status-success'}" style="margin-top: 4px;">
            ${u.role === 'admin' ? 'Beheerder' : 'Medewerker'}
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          ${u.email ? `
            <button class="btn btn-secondary" data-action="resend-invite" data-id="${u.id}" data-email="${u.email}" class="btn-sm" title="Uitnodiging opnieuw versturen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
          ` : ''}
          <button class="btn btn-secondary" data-action="edit-user" data-id="${u.id}" data-username="${u.username}" data-role="${u.role}" data-email="${u.email || ''}" class="btn-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${u.username !== localStorage.getItem('username') ? `
            <button class="btn btn-secondary" data-action="delete-user" data-id="${u.id}" style="padding: 8px 12px; width: auto; color: var(--status-deny); border-color: var(--status-deny-bg);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          ` : ''}
        </div>
      </div>
    `).join('');

  } catch (e) {
    console.error('Error loading users:', e);
    container.innerHTML = '<div class="error">Fout bij laden gebruikers</div>';
  }
}

let editingUserId = null;

function editUser(id, username, role, email) {
  editingUserId = id;
  const modal = document.getElementById('add-user-modal');
  const modalTitle = modal.querySelector('.modal-header h2');
  const usernameInput = modal.querySelector('input[name="username"]');
  const emailInput = modal.querySelector('input[name="email"]');
  const roleSelect = modal.querySelector('select[name="role"]');
  const submitBtn = modal.querySelector('button[type="submit"]');

  modalTitle.textContent = 'Gebruiker Bewerken';
  usernameInput.value = username;
  usernameInput.disabled = true;
  emailInput.value = email || '';
  emailInput.required = false;
  roleSelect.value = role;
  submitBtn.textContent = 'Opslaan';

  modal.classList.add('active');
}

function resetUserModal() {
  editingUserId = null;
  const modal = document.getElementById('add-user-modal');
  const modalTitle = modal.querySelector('.modal-header h2');
  const usernameInput = modal.querySelector('input[name="username"]');
  const emailInput = modal.querySelector('input[name="email"]');
  const submitBtn = modal.querySelector('button[type="submit"]');

  modalTitle.textContent = 'Gebruiker Toevoegen';
  usernameInput.disabled = false;
  emailInput.required = true;
  submitBtn.textContent = 'Uitnodigen';
}

async function deleteUser(id) {
  if (!confirm('Weet je zeker dat je deze gebruiker wilt verwijderen?')) return;

  try {
    await authFetch(`${API_BASE}/api/users/${id}`, { method: 'DELETE' });
    loadUsers();
  } catch (e) {
    alert('Fout bij verwijderen: ' + e.message);
  }
}

async function resendInvite(id, email) {
  if (!confirm(`Uitnodiging opnieuw versturen naar ${email}?`)) return;

  try {
    const res = await authFetch(`${API_BASE}/api/users/${id}/resend-invite`, { method: 'POST' });
    const result = await res.json();
    if (res.ok) {
      alert(result.message || 'Uitnodiging verstuurd!');
    } else {
      throw new Error(result.error || 'Fout bij versturen');
    }
  } catch (e) {
    alert('Fout: ' + e.message);
  }
}

// ==================== EVENT DELEGATION ====================
// Users list: edit & delete
const usersListEl = document.getElementById('users-list');
if (usersListEl) {
  usersListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id = parseInt(btn.dataset.id);

    if (action === 'edit-user') {
      editUser(id, btn.dataset.username, btn.dataset.role, btn.dataset.email);
    } else if (action === 'delete-user') {
      deleteUser(id);
    } else if (action === 'resend-invite') {
      resendInvite(id, btn.dataset.email);
    }
  });
}

// History list: delete scan
const historyListEl = document.getElementById('history-list');
if (historyListEl) {
  historyListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="delete-scan"]');
    if (!btn) return;
    deleteScan(parseInt(btn.dataset.id));
  });
}

// User Modal Logic
const addUserModal = document.getElementById('add-user-modal');
const openAddUserBtn = document.getElementById('open-add-user-btn');
const closeAddUserBtn = document.getElementById('close-add-user-modal');
const addUserForm = document.getElementById('add-user-form');

if (openAddUserBtn) openAddUserBtn.onclick = () => {
  resetUserModal();
  addUserModal.classList.add('active');
};
if (closeAddUserBtn) closeAddUserBtn.onclick = () => {
  resetUserModal();
  addUserModal.classList.remove('active');
};

if (addUserForm) addUserForm.onsubmit = async (e) => {
  e.preventDefault();
  const errorDiv = document.getElementById('add-user-error');
  errorDiv.style.display = 'none';

  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData.entries());

  try {
    let res;
    if (editingUserId) {
      // Update existing user
      const updateData = { role: data.role, email: data.email };
      res = await authFetch(`${API_BASE}/api/users/${editingUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });
    } else {
      // Create new user — invite via email
      res = await authFetch(`${API_BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: data.username, email: data.email, role: data.role })
      });
    }

    const result = await res.json();
    if (res.ok) {
      addUserModal.classList.remove('active');
      e.target.reset();
      resetUserModal();
      loadUsers();
      if (result.message) alert(result.message);
    } else {
      throw new Error(result.error || 'Fout bij opslaan');
    }
  } catch (e) {
    errorDiv.textContent = e.message;
    errorDiv.style.display = 'block';
  }
};

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', () => {
  // Initialize scanner on load
  initScanner();

  // Set current date
  const dateStr = new Date().toLocaleDateString('nl-NL', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  document.getElementById('reservations-date').textContent = dateStr;

  // Set floorplan date
  const floorplanDateEl = document.getElementById('floorplan-date');
  if (floorplanDateEl) floorplanDateEl.textContent = dateStr;

  // Custom Logout Modal
  function confirmLogout() {
    const modal = document.getElementById('scan-result-modal');
    const title = document.getElementById('result-title');
    const body = document.getElementById('result-body');
    const footer = document.getElementById('result-footer');

    if (!modal) return; // Safety check

    title.innerHTML = 'Uitloggen';
    body.innerHTML = '<div class="result-info" style="margin-bottom: 24px;"><p>Weet je zeker dat je wilt uitloggen?</p></div>';

    footer.innerHTML = `
      <button class="btn btn-primary" id="do-logout-btn">
        Uitloggen
      </button>
      <button class="btn btn-secondary" id="cancel-logout-btn" style="margin-top: 8px;">
        Annuleren
      </button>
    `;

    // Handlers (using onclick to avoid stacking listeners)
    setTimeout(() => {
      const doBtn = document.getElementById('do-logout-btn');
      const cancelBtn = document.getElementById('cancel-logout-btn');

      if (doBtn) doBtn.onclick = () => {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_role');
        localStorage.removeItem('username');
        window.location.href = '/login.html';
      };

      if (cancelBtn) cancelBtn.onclick = () => {
        modal.classList.remove('active');
      };
    }, 50);

    modal.classList.add('active');
  }

  // Logout Button Handler
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      confirmLogout();
    });
  }

});

// Stop scanner when leaving scanner screen
window.addEventListener('beforeunload', () => {
  stopScanner();
});
