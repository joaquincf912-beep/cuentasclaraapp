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
    const isOnline      = ref(navigator.onLine);
    const showIosBanner = ref(false);
    const installPrompt = ref(null);

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
      // CASCADE: Try multiple sources in order
      const sources = [
        {
          name: 'DolarVzla BCV Realtime',
          url: 'https://rates.dolarvzla.com/bcv/current.json',
          extract: (data) => ({ rate: data?.current?.usd, date: data?.current?.date })
        },
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

      let fetched = false;
      for (const source of sources) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(source.url, { signal: controller.signal });
          clearTimeout(timeoutId);
          const data = await res.json();
          const result = source.extract(data);

          if (result && result.rate) {
            // VALIDATION 1: Range check (500-2000 Bs/$)
            if (result.rate < 500 || result.rate > 2000) {
              console.warn(`Rate out of range from ${source.name}: ${result.rate}`);
              continue;
            }

            // VALIDATION 2: Date freshness (max 7 days old for weekends/holidays)
            if (result.date) {
              const rateDate = new Date(result.date);
              const now = new Date();
              const daysDiff = (now - rateDate) / (1000 * 60 * 60 * 24);
              if (daysDiff > 7) {
                console.warn(`Rate from ${source.name} is ${Math.floor(daysDiff)} days old`);
                // Still use it if we have nothing better, but flag it
              }
              rateLastUpdated.value = result.date;
            }

            rates.value.bcv = result.rate;
            saveRates();
            showToast('Tasa BCV actualizada', 'success');
            fetched = true;
            break;
          }
        } catch (e) {
          console.warn(`Failed to fetch from ${source.name}:`, e.message);
        }
      }

      // If all sources failed, check localStorage age
      if (!fetched) {
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
      } else {
        retryCount.value = 0;
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
      if (!video.videoWidth) return;

      ocrProcessing.value = true;
      const canvas = ocrCanvas.value;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Crop area (70% width, 25% height) from center of video frame
      const cw = Math.floor(video.videoWidth * 0.70);
      const ch = Math.floor(video.videoHeight * 0.25);
      const sx = Math.floor((video.videoWidth - cw) / 2);
      const sy = Math.floor((video.videoHeight - ch) / 2);

      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);

      // Grayscale conversion
      const img = ctx.getImageData(0, 0, cw, ch);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        let g = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        d[i] = d[i+1] = d[i+2] = g;
      }
      ctx.putImageData(img, 0, 0);

      try {
        const worker = await initWorker();
        if (!worker) { ocrProcessing.value = false; return; }

        const { data: { text } } = await worker.recognize(canvas);
        const cleanText = (text || '').trim();
        console.log('Detected Text:', cleanText);

        // Regex that parses: Symbol ($, Bs, bs, BS) + optional spaces + Number (e.g. 12.50, Bs.500)
        // Or Number + optional spaces + Symbol
        const match = cleanText.match(/(?:([$]|Bs|bs|BS)\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s*([$]|Bs|bs|BS))?/i);
        
        if (match && match[2]) {
          const rawPrice = match[2].replace(',', '.');
          const p = parseFloat(rawPrice);
          if (!isNaN(p) && p > 0 && p < 100000) {
            price.value = p;

            // Detect Currency
            const detectedSymbol = (match[1] || match[3] || '').toLowerCase();
            if (detectedSymbol.includes('$')) {
              currency.value = 'USD';
            } else if (detectedSymbol.includes('b')) {
              currency.value = 'VES';
            }

            if (navigator.vibrate) navigator.vibrate(150);
            showToast(`Detectado: ${currency.value === 'USD' ? '$' : 'Bs.'} ${numFmt.format(p)}`, 'success');
            logAction('scan', p, currency.value);
            stopScanner();
          }
        }
      } catch (e) {
        console.warn('OCR error', e);
      }
      ocrProcessing.value = false;
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

      // Icons
      nextTick(() => { if (window.lucide) lucide.createIcons(); });
    });

    // Re-render Lucide icons on any reactive change
    watch(
      [rates, editingRate, price, currency, keypadVisible, cart, scannerActive, ocrProcessing, showIosBanner, showStats],
      () => nextTick(() => { if (window.lucide) lucide.createIcons(); }),
      { deep: true }
    );

    /* ── Return ────────────────────────────────────── */
    return {
      // state
      isOnline, showIosBanner, rates, editingRate, rateEditVal,
      price, currency, displayPrice, keypadVisible, kpBuffer, cart,
      scannerActive, ocrProcessing, showStats, statsData,
      rateLastUpdated, rateAge, cameraPermissionGranted,
      // computed
      convBcv, totalUSD, totalVES,
      // methods
      fmtRate, fmtPrice, fmtConvertedItem,
      startRateEdit, saveRateEdit,
      toggleCurrency, openKeypad, cancelKeypad, kpPress, kpDelete, kpConfirm,
      addItem, changeQty, removeItem, clearCart,
      toggleScanner, handleTitleTap, fetchStats,
      // refs
      videoEl, ocrCanvas, toastContainer, rateInput
    };
  }
}).mount('#app');
