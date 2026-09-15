/* CuentaClara — app.js */
const { createApp, ref, computed, watch, onMounted, nextTick } = Vue;

const DEFAULTS = { bcv: 842.2067 };
const SK = {
  RATES: 'cuentaclara_rates',
  CART:  'cuentaclara_cart',
  PREF:  'cuentaclara_prefrate',
  UUID:  'cuentaclara_uuid'
};

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

createApp({
  setup() {
    /* ── State ─────────────────────────────────────── */
    const isOnline          = ref(navigator.onLine);
    const showIosBanner     = ref(false);
    const installPrompt     = ref(null);
    const showInstallModal  = ref(false);
    const isIosDevice       = computed(() => /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase()));

    // Rates
    const savedRatesData = loadJSON(SK.RATES, { ...DEFAULTS });
    const rates        = ref({ bcv: savedRatesData.bcv || DEFAULTS.bcv });
    const editingRate  = ref(null);
    const rateEditVal  = ref(0);
    const rateLastUpdated = ref(savedRatesData.date || null);
    const retryCount = ref(0);

    // Price input
    const price    = ref(0);
    const currency = ref('USD');

    // Keypad
    const keypadVisible = ref(false);
    const kpBuffer      = ref('');

    // Cart
    const cart = ref(loadJSON(SK.CART, []));

    // UUID
    let userUuid = localStorage.getItem(SK.UUID);
    if (!userUuid) {
      userUuid = generateUUID();
      localStorage.setItem(SK.UUID, userUuid);
    }

    // Analytics / Stats Modal
    const showStats = ref(false);
    const statsData = ref(null);
    const titleTaps = ref(0);

    // Scanner
    const scannerActive = ref(false);
    const ocrProcessing = ref(false);
    const videoEl       = ref(null);
    const ocrCanvas     = ref(null);
    const toastContainer = ref(null);
    const rateInput     = ref(null);
    const cameraPermissionGranted = ref(false);

    let scanTimer     = null;

    /* ── Formatters ────────────────────────────────── */
    const numFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const fmtRate = (n) => {
      if (!n || isNaN(n)) return '0,00';
      return numFmt.format(n);
    };

    const fmtPrice = (n, cur) => {
      const v = numFmt.format(Math.abs(n || 0));
      return cur === 'USD' ? `$ ${v}` : `Bs. ${v}`;
    };

    const displayPrice = computed(() => {
      if (price.value === 0) return '';
      return numFmt.format(price.value);
    });

    /* ── Conversions ───────────────────────────────── */
    const convBcv = computed(() => {
      if (price.value <= 0) return currency.value === 'USD' ? 'Bs. 0,00' : '$ 0,00';
      if (currency.value === 'USD') {
        return 'Bs. ' + numFmt.format(price.value * rates.value.bcv);
      } else {
        return '$ ' + numFmt.format(price.value / rates.value.bcv);
      }
    });

    const fmtConvertedItem = (item) => {
      const rate = rates.value.bcv;
      if (item.cur === 'USD') {
        return 'Bs. ' + numFmt.format(item.price * item.qty * rate);
      } else {
        return '$ ' + numFmt.format((item.price * item.qty) / rate);
      }
    };

    /* ── Totals ────────────────────────────────────── */
    const totalUSD = computed(() => {
      const rate = rates.value.bcv;
      let usd = 0;
      cart.value.forEach(i => {
        if (i.cur === 'USD') usd += i.price * i.qty;
        else usd += (i.price * i.qty) / rate;
      });
      return usd;
    });

    const totalVES = computed(() => {
      const rate = rates.value.bcv;
      let ves = 0;
      cart.value.forEach(i => {
        if (i.cur === 'VES') ves += i.price * i.qty;
        else ves += i.price * i.qty * rate;
      });
      return ves;
    });

    /* ── Toast ─────────────────────────────────────── */
    const showToast = (msg, type = 'info') => {
      const el = document.createElement('div');
      el.className = `toast t-${type}`;
      el.textContent = msg;
      const container = toastContainer.value || document.querySelector('.toast-container');
      if (container) container.appendChild(el);
      requestAnimationFrame(() => el.classList.add('show'));
      setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
      }, 2800);
    };

    /* ── Analytics API ─────────────────────────────── */
    const logVisit = async () => {
      try {
        await fetch('/api/visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: userUuid })
        });
      } catch (e) { console.warn('Failed to log visit', e); }
    };

    const logAction = async (action, p = 0, cur = 'USD') => {
      try {
        await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: userUuid, action, price: p, currency: cur })
        });
      } catch (e) { console.warn('Failed to log action', e); }
    };

    const fetchStats = async () => {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        statsData.value = data;
      } catch (e) { console.warn('Failed to fetch stats', e); }
    };

    const handleTitleTap = () => {
      titleTaps.value++;
      if (titleTaps.value >= 5) {
        titleTaps.value = 0;
        fetchStats();
        showStats.value = true;
      }
    };

    /* ── Rates ─────────────────────────────────────── */
    const saveRates = () => localStorage.setItem(SK.RATES, JSON.stringify({ ...rates.value, timestamp: Date.now(), date: rateLastUpdated.value }));

    const fetchRates = async () => {
      let bestRate = null;
      let bestDate = null;
      let fetched = false;

      // === SOURCE GROUP 1: DolarAPI (direct, has CORS) ===
      const dolarApiSources = [
        {
          name: 'DolarAPI Oficial',
          url: 'https://ve.dolarapi.com/v1/dolares/oficial',
          extract: (data) => ({ rate: data?.promedio, date: data?.fechaActualizacion })
        },
        {
          name: 'DolarAPI Array',
          url: 'https://ve.dolarapi.com/v1/dolares',
          extract: (data) => {
            const oficial = Array.isArray(data) ? data.find(d => d.fuente === 'oficial') : null;
            return oficial ? { rate: oficial.promedio, date: oficial.fechaActualizacion } : null;
          }
        }
      ];

      for (const source of dolarApiSources) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(source.url, { signal: controller.signal });
          clearTimeout(timeoutId);
          const data = await res.json();
          const result = source.extract(data);

          if (result && result.rate && result.rate >= 500 && result.rate <= 2000) {
            bestRate = result.rate;
            bestDate = result.date;
            fetched = true;
            console.log(`[Rate] Got ${result.rate} from ${source.name} (date: ${result.date})`);
            break;
          }
        } catch (e) {
          console.warn(`[Rate] Failed ${source.name}:`, e.message);
        }
      }

      // === SOURCE GROUP 2: DolarVzla via CORS proxies (more up-to-date) ===
      // Only try if we didn't get a rate from today, or if DolarAPI failed
      const todayStr = new Date().toISOString().slice(0, 10);
      const bestDateStr = bestDate ? new Date(bestDate).toISOString().slice(0, 10) : null;
      const needsFresher = !fetched || (bestDateStr && bestDateStr !== todayStr);

      if (needsFresher) {
        const dolarvzlaUrl = 'https://rates.dolarvzla.com/bcv/current.json';
        const corsProxies = [
          (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
          (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
          (u) => u  // Direct attempt (works if same-origin or CORS added later)
        ];

        for (const makeUrl of corsProxies) {
          try {
            const proxyUrl = makeUrl(dolarvzlaUrl);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await res.json();

            if (data?.current?.usd && data.current.usd >= 500 && data.current.usd <= 2000) {
              const vzlaDate = data.current.date; // format: "2026-09-15"
              // Use DolarVzla rate if it's newer than what we have
              if (!bestDate || (vzlaDate && vzlaDate > (bestDateStr || ''))) {
                bestRate = data.current.usd;
                bestDate = vzlaDate;
                fetched = true;
                console.log(`[Rate] Got fresher rate ${data.current.usd} from DolarVzla (date: ${vzlaDate})`);
              }
              break; // Got a valid response, stop trying proxies
            }
          } catch (e) {
            console.warn(`[Rate] DolarVzla proxy failed:`, e.message);
          }
        }
      }

      // === Apply the best rate found ===
      if (fetched && bestRate) {
        rates.value.bcv = bestRate;
        rateLastUpdated.value = bestDate;
        saveRates();
        showToast('Tasa BCV actualizada', 'success');
        retryCount.value = 0;
      } else {
        // All sources failed, check localStorage age
        const saved = loadJSON(SK.RATES, null);
        if (saved && saved.timestamp) {
          const hoursSinceSaved = (Date.now() - saved.timestamp) / (1000 * 60 * 60);
          if (hoursSinceSaved > 48) {
            showToast('Tasa desactualizada. Verifique conexión.', 'danger');
          } else {
            showToast('Usando tasa guardada', 'info');
          }
        }

        // Schedule retry (up to 3 times)
        if (retryCount.value < 3) {
          retryCount.value++;
          setTimeout(fetchRates, 30000);
        }
      }
    };

    const fetchParalelo = async () => {
      try {
        const res = await fetch('https://ve.dolarapi.com/v1/dolares/paralelo');
        const data = await res.json();
        if (data?.promedio && data.promedio > 0) {
          // Cross-validation: paralelo should always be >= oficial
          if (rates.value.bcv > data.promedio * 1.05) {
            console.warn('BCV rate higher than paralelo — possible error');
            showToast('Verificando tasa BCV...', 'info');
          }
        }
      } catch (e) { /* silent */ }
    };

    const rateAge = computed(() => {
      if (!rateLastUpdated.value) return '';
      const date = new Date(rateLastUpdated.value);
      const now = new Date();
      const diffMs = now - date;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      
      if (diffDays === 0) return 'Hoy';
      if (diffDays === 1) return 'Hace 1 día';
      return `Hace ${diffDays} días`;
    });

    const startRateEdit = (type) => {
      editingRate.value = type;
      rateEditVal.value = rates.value[type];
      nextTick(() => { if (rateInput.value) rateInput.value.focus(); });
    };

    const saveRateEdit = (type) => {
      if (rateEditVal.value > 0) {
        rates.value[type] = rateEditVal.value;
        saveRates();
      }
      editingRate.value = null;
    };

    /* ── Currency toggle ──────────────────────────── */
    const toggleCurrency = () => {
      currency.value = currency.value === 'USD' ? 'VES' : 'USD';
    };

    /* ── Keypad ────────────────────────────────────── */
    const openKeypad = () => {
      kpBuffer.value = price.value > 0 ? String(price.value) : '';
      keypadVisible.value = true;
    };
    const cancelKeypad = () => { keypadVisible.value = false; };

    const kpPress = (ch) => {
      if (ch === '.') {
        if (kpBuffer.value.includes('.')) return;
        kpBuffer.value += kpBuffer.value === '' ? '0.' : '.';
        return;
      }
      const raw = kpBuffer.value.replace('.', '');
      if (raw.length >= 8) return;
      const parts = kpBuffer.value.split('.');
      if (parts.length === 2 && parts[1].length >= 2) return;
      kpBuffer.value += ch;
    };

    const kpDelete = () => {
      kpBuffer.value = kpBuffer.value.slice(0, -1);
    };

    const kpConfirm = () => {
      const v = parseFloat(kpBuffer.value);
      price.value = (!isNaN(v) && v > 0) ? v : 0;
      keypadVisible.value = false;
    };

    /* ── Cart ──────────────────────────────────────── */
    const saveCart = () => localStorage.setItem(SK.CART, JSON.stringify(cart.value));

    const addItem = () => {
      if (price.value <= 0) return;
      cart.value.push({
        id: Date.now(),
        price: price.value,
        cur: currency.value,
        qty: 1
      });
      saveCart();
      logAction('add_to_cart', price.value, currency.value);
      showToast('Artículo añadido', 'success');
      price.value = 0;
    };

    const changeQty = (id, delta) => {
      const item = cart.value.find(i => i.id === id);
      if (!item) return;
      item.qty += delta;
      if (item.qty <= 0) { removeItem(id); return; }
      saveCart();
    };

    const removeItem = (id) => {
      cart.value = cart.value.filter(i => i.id !== id);
      saveCart();
    };

    const clearCart = () => {
      if (!confirm('¿Vaciar toda la lista?')) return;
      cart.value = [];
      saveCart();
    };

    /* ── Scanner / OCR ─────────────────────────────── */
    let ocrWorker = null;
    let workerReady = false;
    let cachedStream = null;

    const initWorker = async () => {
      if (workerReady && ocrWorker) return ocrWorker;
      try {
        ocrWorker = await Tesseract.createWorker('eng', 1, {
          workerPath: 'https://unpkg.com/tesseract.js@5.0.3/dist/worker.min.js',
          corePath: 'https://unpkg.com/tesseract.js-core@5.0.0/tesseract-core.wasm.js',
          logger: () => {} // silent in production
        });
        await ocrWorker.setParameters({
          tessedit_char_whitelist: '0123456789.,$Bbs'
        });
        workerReady = true;
      } catch (err) {
        console.error('Tesseract init failed', err);
      }
      return ocrWorker;
    };

    const checkCameraPermission = async () => {
      try {
        const result = await navigator.permissions.query({ name: 'camera' });
        cameraPermissionGranted.value = (result.state === 'granted');
        result.addEventListener('change', () => {
          cameraPermissionGranted.value = (result.state === 'granted');
        });
      } catch (e) {
        // permissions API not supported, that's ok
      }
    };

    const ensureTesseract = () => {
      return new Promise((resolve) => {
        if (typeof Tesseract !== 'undefined') { resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/tesseract.js@5.0.3/dist/tesseract.min.js';
        script.onload = resolve;
        script.onerror = () => resolve(); // don't block
        document.head.appendChild(script);
      });
    };

    const toggleScanner = async () => {
      if (scannerActive.value) { stopScanner(); return; }
      try {
        await ensureTesseract();

        // Don't show 'Iniciando...' if permission already granted
        if (!cameraPermissionGranted.value) {
          showToast('Iniciando lector...', 'info');
        }
        
        // Start camera immediately
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }));

        cachedStream = stream;
        cameraPermissionGranted.value = true;
        scannerActive.value = true;
        
        nextTick(() => {
          if (videoEl.value) {
            videoEl.value.srcObject = stream;
            videoEl.value.play();
            scanTimer = setInterval(ocrFrame, 1000); // Faster: 1 second intervals
          }
        });
      } catch (e) {
        showToast('No se pudo acceder a la cámara', 'danger');
      }
    };

    const stopScanner = () => {
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      if (cachedStream) { cachedStream.getTracks().forEach(t => t.stop()); cachedStream = null; }
      scannerActive.value = false;
      ocrProcessing.value = false;
    };

    const ocrFrame = async () => {
      if (ocrProcessing.value || !videoEl.value || !ocrCanvas.value) return;
      const video = videoEl.value;
      if (!video.videoWidth || video.readyState < 2) return;

      ocrProcessing.value = true;
      const canvas = ocrCanvas.value;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Crop a focused center region (65% width, 22% height)
      const vWidth = video.videoWidth;
      const vHeight = video.videoHeight;
      const cw = Math.floor(vWidth * 0.65);
      const ch = Math.floor(vHeight * 0.22);
      const sx = Math.floor((vWidth - cw) / 2);
      const sy = Math.floor((vHeight - ch) / 2);

      // Downscale to ~350px width for 5x faster OCR recognition speed
      const scale = Math.min(1.0, 350 / cw);
      const targetW = Math.max(1, Math.floor(cw * scale));
      const targetH = Math.max(1, Math.floor(ch * scale));

      canvas.width = targetW;
      canvas.height = targetH;
      ctx.drawImage(video, sx, sy, cw, ch, 0, 0, targetW, targetH);

      // High-contrast binarization & Grayscale for instant digit recognition
      const img = ctx.getImageData(0, 0, targetW, targetH);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        let gray = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        let v = gray > 140 ? 255 : (gray < 75 ? 0 : gray);
        d[i] = d[i+1] = d[i+2] = v;
      }
      ctx.putImageData(img, 0, 0);

      try {
        const worker = await initWorker();
        if (!worker) { ocrProcessing.value = false; return; }

        const { data: { text } } = await worker.recognize(canvas);
        const cleanText = (text || '').replace(/\s+/g, ' ').trim();

        // Advanced regex pattern:
        // Matches "$ 12.50", "12,50", "Bs. 500", "Bs 1.250,50", "500.00$", "Bs500"
        const regex = /(?:([$]|Bs|bs|BS|Bs\.)\s*)?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*([$]|Bs|bs|BS|Bs\.))?/i;
        const match = cleanText.match(regex);
        
        if (match && match[2]) {
          let rawStr = match[2];
          if (rawStr.includes(',') && rawStr.includes('.')) {
            rawStr = rawStr.replace(/\./g, '').replace(',', '.');
          } else if (rawStr.includes(',')) {
            rawStr = rawStr.replace(',', '.');
          }

          const p = parseFloat(rawStr);
          if (!isNaN(p) && p > 0.05 && p < 250000) {
            price.value = p;

            // Detect Currency
            const sym = (match[1] || match[3] || '').toLowerCase();
            if (sym.includes('$')) {
              currency.value = 'USD';
            } else if (sym.includes('b')) {
              currency.value = 'VES';
            }

            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            showToast(`¡Detectado! ${currency.value === 'USD' ? '$' : 'Bs.'} ${numFmt.format(p)}`, 'success');
            logAction('scan', p, currency.value);
            stopScanner();
          }
        }
      } catch (e) {
        console.warn('OCR processing error', e);
      }
      ocrProcessing.value = false;
    };

    /* ── Dynamic Notifications System ──────────────── */
    const notificationsEnabled = ref(typeof Notification !== 'undefined' && Notification.permission === 'granted');

    const NOTIFICATION_MESSAGES = [
      {
        title: "🛒 ¡Ve por tu siguiente compra!",
        body: "Abre CuentaClara y calcula tu cuenta en segundos con la tasa BCV oficial del día."
      },
      {
        title: "💡 Saca tu siguiente cuenta",
        body: "Haz rendir tu dinero: convierte y suma tus compras fácilmente en dólares y bolívares."
      },
      {
        title: "🏷️ Controla tu presupuesto",
        body: "Verifica y escanea los precios en el supermercado antes de llegar a la caja."
      },
      {
        title: "📈 Tasa BCV al día",
        body: "Sincronizada automáticamente para que pagues siempre lo justo."
      }
    ];

    const requestNotificationPermission = async () => {
      if (!('Notification' in window)) {
        showToast('Notificaciones no soportadas en este navegador', 'info');
        return;
      }

      try {
        if (Notification.permission === 'granted') {
          // If already granted, send a fresh test notification
          sendRandomNotification('🔔 Notificaciones Activas', '¡Ve por tu siguiente compra! Te acompañamos en tus compras.');
          showToast('Notificaciones activas', 'info');
          return;
        }

        const permission = await Notification.requestPermission();
        notificationsEnabled.value = (permission === 'granted');
        if (permission === 'granted') {
          showToast('Notificaciones activadas 🔔', 'success');
          sendRandomNotification('🛒 ¡Ve por tu siguiente compra!', 'Saca tu siguiente cuenta con CuentaClara App.');
        } else {
          showToast('Permiso de notificaciones denegado', 'info');
        }
      } catch (e) {
        console.warn('Notification permission error', e);
      }
    };

    const sendRandomNotification = (customTitle, customBody) => {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;

      const msg = NOTIFICATION_MESSAGES[Math.floor(Math.random() * NOTIFICATION_MESSAGES.length)];
      const title = customTitle || msg.title;
      const body = customBody || msg.body;

      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body: body,
            icon: './icon-192.png',
            badge: './icon-192.png',
            vibrate: [200, 100, 200],
            tag: 'cuentaclara-reminder',
            renotify: true,
            data: { url: './' }
          });
        });
      } else {
        try {
          new Notification(title, { body, icon: './icon-192.png' });
        } catch (e) { console.warn(e); }
      }
    };

    const triggerInstall = async () => {
      if (installPrompt.value) {
        try {
          installPrompt.value.prompt();
          const choice = await installPrompt.value.userChoice;
          if (choice && choice.outcome === 'accepted') {
            installPrompt.value = null;
            showToast('App agregada a inicio', 'success');
            return;
          }
        } catch (e) { console.warn('Install prompt error', e); }
      }
      showInstallModal.value = true;
    };

    /* ── Touch Swipe Down Gestures ──────────────────── */
    let touchStartY = 0;
    let touchStartTime = 0;
    let touchDeltaY = 0;
    let activeSheetEl = null;
    let activeOverlayEl = null;

    const onSheetTouchStart = (e) => {
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      touchDeltaY = 0;
      activeSheetEl = e.currentTarget;
      activeOverlayEl = activeSheetEl ? activeSheetEl.closest('.overlay') : null;
      if (activeSheetEl) activeSheetEl.style.transition = 'none';
      if (activeOverlayEl) activeOverlayEl.style.transition = 'none';
    };

    const onSheetTouchMove = (e) => {
      if (!activeSheetEl) return;
      const currentY = e.touches[0].clientY;
      const dy = currentY - touchStartY;
      if (dy > 0) {
        if (e.cancelable) e.preventDefault();
        touchDeltaY = dy;
        activeSheetEl.style.transform = `translateY(${dy}px)`;
        if (activeOverlayEl) {
          const opacity = Math.max(0, 1 - (dy / 300));
          activeOverlayEl.style.opacity = opacity;
        }
      }
    };

    const onSheetTouchEnd = (closeCallback) => {
      if (!activeSheetEl) return;
      const el = activeSheetEl;
      const overlayEl = activeOverlayEl;
      activeSheetEl = null;
      activeOverlayEl = null;
      
      const duration = Date.now() - touchStartTime;
      const velocity = touchDeltaY / (duration || 1);
      
      if (touchDeltaY > 50 || (velocity > 0.35 && touchDeltaY > 15)) {
        el.style.transition = 'transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)';
        el.style.transform = 'translateY(100%)';
        if (overlayEl) {
          overlayEl.style.transition = 'opacity 0.22s ease-out';
          overlayEl.style.opacity = '0';
        }
        setTimeout(() => {
          el.style.transform = '';
          el.style.transition = '';
          if (overlayEl) {
            overlayEl.style.opacity = '';
            overlayEl.style.transition = '';
          }
          if (typeof closeCallback === 'function') closeCallback();
        }, 220);
      } else {
        el.style.transition = 'transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        el.style.transform = 'translateY(0)';
        if (overlayEl) {
          overlayEl.style.transition = 'opacity 0.25s ease-out';
          overlayEl.style.opacity = '1';
        }
        setTimeout(() => {
          el.style.transform = '';
          el.style.transition = '';
          if (overlayEl) {
            overlayEl.style.opacity = '';
            overlayEl.style.transition = '';
          }
        }, 250);
      }
      touchDeltaY = 0;
    };

    /* ── Lifecycle ─────────────────────────────────── */
    onMounted(() => {
      // Network events
      window.addEventListener('online', () => { isOnline.value = true; fetchRates(); });
      window.addEventListener('offline', () => { isOnline.value = false; });

      // PWA install
      window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt.value = e; });

      // iOS detection
      const ua = navigator.userAgent.toLowerCase();
      const isIos = /iphone|ipad|ipod/.test(ua);
      const standalone = navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
      if (isIos && !standalone) showIosBanner.value = true;

      // Fetch rates
      if (isOnline.value) {
        fetchRates().then(() => fetchParalelo());
        logVisit();
      }

      // Pre-warm Tesseract worker after 3 seconds
      setTimeout(() => {
        if (typeof Tesseract !== 'undefined') {
          initWorker();
        }
      }, 3000);

      // Check camera permission
      checkCameraPermission();

      // Service Worker
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW reg fail', e));
      }

      // Auto-request Notification permission ONCE automatically
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'default') {
          setTimeout(() => {
            Notification.requestPermission().then((permission) => {
              notificationsEnabled.value = (permission === 'granted');
              if (permission === 'granted') {
                sendRandomNotification('🛒 ¡Ve por tu siguiente compra!', 'Calcula tus compras al instante con la tasa BCV oficial.');
              }
            }).catch(e => console.warn('Notif request error', e));
          }, 1500);
        } else if (Notification.permission === 'granted') {
          const lastNotif = localStorage.getItem('cuentaclara_last_notif');
          const now = Date.now();
          if (!lastNotif || (now - parseInt(lastNotif, 10)) > 3 * 3600 * 1000) {
            localStorage.setItem('cuentaclara_last_notif', String(now));
            setTimeout(() => {
              sendRandomNotification();
            }, 3000);
          }
        }
      }

      // Icons
      nextTick(() => { if (window.lucide) lucide.createIcons(); });
    });

    // Re-render Lucide icons smartly only on structural UI changes (not on every keypress)
    let iconFrame = null;
    const scheduleIconRender = () => {
      if (iconFrame) cancelAnimationFrame(iconFrame);
      iconFrame = requestAnimationFrame(() => {
        if (window.lucide) lucide.createIcons();
      });
    };

    watch(
      [editingRate, keypadVisible, scannerActive, ocrProcessing, showIosBanner, showStats],
      () => scheduleIconRender()
    );
    watch(
      () => cart.value.length,
      () => scheduleIconRender()
    );

    /* ── Return ────────────────────────────────────── */
    return {
      // state
      isOnline, showIosBanner, rates, editingRate, rateEditVal,
      price, currency, displayPrice, keypadVisible, kpBuffer, cart,
      scannerActive, ocrProcessing, showStats, statsData,
      rateLastUpdated, rateAge, cameraPermissionGranted, isIosDevice,
      notificationsEnabled,
      // computed
      convBcv, totalUSD, totalVES,
      // methods
      fmtRate, fmtPrice, fmtConvertedItem,
      startRateEdit, saveRateEdit,
      toggleCurrency, openKeypad, cancelKeypad, kpPress, kpDelete, kpConfirm,
      addItem, changeQty, removeItem, clearCart,
      toggleScanner, handleTitleTap, fetchStats,
      onSheetTouchStart, onSheetTouchMove, onSheetTouchEnd,
      requestNotificationPermission, sendRandomNotification,
      // refs
      videoEl, ocrCanvas, toastContainer, rateInput
    };
  }
}).mount('#app');
