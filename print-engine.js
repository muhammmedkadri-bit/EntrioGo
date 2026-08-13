/**
 * Cargobar — Yazdırma Motoru (print-engine.js)
 * ----------------------------------------------
 * Bu modül:
 *   1) "portakal" kütüphanesi ile 100x100mm etiketi doğru yazıcı diline
 *      (varsayılan: TSPL) derler,
 *   2) Derlenen ham komutları yerel Yazdırma Ajanı'na (print-agent) HTTP
 *      ile gönderir.
 *
 * index.html'e şu şekilde eklenir (diğer <script> etiketlerinin YANINA):
 *   <script type="module" src="print-engine.js"></script>
 */

console.log('[PrintEngine] Modül yüklenmeye başladı...');
import { label, tsc } from 'https://esm.sh/portakal';
import { barcodePNG } from 'https://esm.sh/etiket';
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.4.4/+esm';
console.log('[PrintEngine] esm.sh import\'ları tamamlandı:', { label: typeof label, tsc: typeof tsc, barcodePNG: typeof barcodePNG, QRCode: typeof QRCode });

// ─────────────────────────────────────────────────────────
// AYARLAR (localStorage üzerinden kalıcı; Ayarlar ekranından güncellenir)
// ─────────────────────────────────────────────────────────
const LS_KEYS = {
  agentUrl: 'cargobar_agent_url',
  agentToken: 'cargobar_agent_token',
  labelLang: 'cargobar_label_lang' // 'tspl' | 'escpos'
};

function getSetting(key, fallback) {
  return localStorage.getItem(key) || fallback;
}

const Settings = {
  get agentUrl() { return getSetting(LS_KEYS.agentUrl, 'https://192.168.1.156:9198'); },
  set agentUrl(v) { localStorage.setItem(LS_KEYS.agentUrl, v); },
  get agentToken() { return getSetting(LS_KEYS.agentToken, '007419f30b350f3bb329c9ba48bb30e93ae50981744c4737'); },
  set agentToken(v) { localStorage.setItem(LS_KEYS.agentToken, v); },
  get labelLang() { return getSetting(LS_KEYS.labelLang, 'tspl'); },
  set labelLang(v) { localStorage.setItem(LS_KEYS.labelLang, v); }
};

// Millimetreyi Dot cinsine (203 DPI varsayımıyla) çeviren yardımcı fonksiyon
const mm = (v) => Math.round(v * 203 / 25.4);

// ─────────────────────────────────────────────────────────
// GÖRSEL TO MONOCHROME BITMAP DÜNÜŞTÜRÜCÜ
// ─────────────────────────────────────────────────────────
async function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function imageToMonochromeBitmap(imgElement, targetWidth, targetHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(imgElement, 0, 0, targetWidth, targetHeight);
  
  const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imgData.data;
  const bytesPerRow = Math.ceil(targetWidth / 8);
  const buffer = new Uint8Array(bytesPerRow * targetHeight);
  
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const idx = (y * targetWidth + x) * 4;
      const r = data[idx];
      const g = data[idx+1];
      const b = data[idx+2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      
      // Zjiang firmware'i görünüşe göre Mode 0 için standart TSPL (1=Siyah, 0=Beyaz) 
      // mantığını TERS anlıyor (0=Siyah, 1=Beyaz). 
      // Beyaz (arka plan) pikseller için bit=1 gönderiyoruz.
      if (gray >= 180) { // Eşik değeri 128'den 180'e çıkarılarak gri kenarlar siyaha yuvarlanır, metinler kalınlaşır
        const byteIdx = y * bytesPerRow + Math.floor(x / 8);
        const bitIdx = 7 - (x % 8);
        buffer[byteIdx] |= (1 << bitIdx);
      }
    }
  }
  const result = {
    data: buffer,
    width: targetWidth,
    height: targetHeight,
    bytesPerRow: bytesPerRow
  };
  return result;
}

// PNG byte dizisini (barcodePNG/qrcodePNG çıktısı) monochrome bitmap'e çevirir.
// rotateDeg: 0 veya 90 — dikey barkod sütunu için 90 kullanılır.
async function pngBytesToMonochromeBitmap(pngBytes, targetWidthDots, targetHeightDots, rotateDeg = 0) {
  const blob = new Blob([pngBytes], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    const canvas = document.createElement('canvas');
    // 90° döndürülecekse tuval boyutlarını yer değiştir
    const cw = rotateDeg === 90 || rotateDeg === 270 ? targetHeightDots : targetWidthDots;
    const ch = rotateDeg === 90 || rotateDeg === 270 ? targetWidthDots : targetHeightDots;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    if (rotateDeg === 90) {
      ctx.translate(cw, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0, targetWidthDots, targetHeightDots);
    } else {
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    ctx.restore();
    // canvas artık hedef boyutta hazır; mevcut monochrome mantığını burada tekrar kullan
    return imageToMonochromeBitmap(canvas, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────────────────
// AJAN İLETİŞİMİ
// ─────────────────────────────────────────────────────────
async function agentFetch(path, options = {}) {
  const url = Settings.agentUrl.replace(/\/$/, '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000); // 12s hard timeout
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Print-Token': Settings.agentToken,
        ...(options.headers || {})
      }
    });
    const json = await res.json().catch(() => ({ ok: false, error: 'Ajan geçersiz yanıt döndürdü' }));
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `Ajan hatası (HTTP ${res.status})`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Yazdırma ajanı zaman aşımına uğradı (12s). Ajanın çalıştığından emin olun.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function checkAgentHealth() {
  try {
    const url = Settings.agentUrl.replace(/\/$/, '') + '/health';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return false;
    const json = await res.json();
    return !!json.ok;
  } catch {
    return false;
  }
}

async function listPrinters() {
  const json = await agentFetch('/printers');
  return json.printers || [];
}

async function sendRaw(rawString) {
  return agentFetch('/print', {
    method: 'POST',
    body: JSON.stringify({ data: rawString, encoding: 'utf8' })
  });
}

async function sendTest(lang) {
  return agentFetch(`/test/${lang}`, { method: 'POST', body: '{}' });
}

// Basit satır kaydırma (uzun adresler taşmasın diye)
function wrapText(text, maxChars) {
  if (!text) return '';
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > maxChars) {
      lines.push(current.trim());
      current = w;
    } else {
      current += ' ' + w;
    }
  }
  if (current) lines.push(current.trim());
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────
// METİN TO MONOCHROME BITMAP DÖNÜŞTÜRÜCÜ
// ─────────────────────────────────────────────────────────
async function renderTextToMonochromeBitmap(text, options = {}) {
  const { 
    fontSize = 20, 
    fontWeight = 'normal', 
    maxWidthDots = 800, 
    reverse = false, 
    rotation = 0,
    align = 'left' 
  } = options;

  const inputLines = (text || '').split('\n');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontWeight} ${fontSize}px sans-serif`;
  
  const lines = [];
  for (const pLine of inputLines) {
    let currentLine = '';
    const words = pLine.split(' ');
    for (const word of words) {
      const testLine = currentLine + (currentLine ? ' ' : '') + word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidthDots && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  
  const lineHeight = Math.round(fontSize * 1.2);
  const totalHeight = Math.max(lineHeight * lines.length, lineHeight);
  
  let actualMaxWidth = 0;
  for (const l of lines) {
    const w = ctx.measureText(l).width;
    if (w > actualMaxWidth) actualMaxWidth = w;
  }
  
  const paddingX = reverse ? 16 : 0;
  const paddingY = reverse ? 8 : 0;
  
  canvas.width = Math.max(8, Math.ceil(actualMaxWidth + paddingX));
  canvas.height = Math.max(8, Math.ceil(totalHeight + paddingY));
  
  ctx.font = `${fontWeight} ${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  
  ctx.fillStyle = reverse ? 'black' : 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.fillStyle = reverse ? 'white' : 'black';
  const startX = reverse ? paddingX/2 : 0;
  const startY = reverse ? paddingY/2 : 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let xPos = startX;
    if (align === 'center') {
      const w = ctx.measureText(line).width;
      xPos = (canvas.width - w) / 2;
    }
    ctx.fillText(line, xPos, startY + (i * lineHeight));
  }
  
  let finalCanvas = canvas;
  if (rotation === 90 || rotation === 270) {
    finalCanvas = document.createElement('canvas');
    finalCanvas.width = canvas.height;
    finalCanvas.height = canvas.width;
    const fctx = finalCanvas.getContext('2d');
    fctx.fillStyle = 'white';
    fctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    fctx.save();
    if (rotation === 90) {
      fctx.translate(finalCanvas.width, 0);
      fctx.rotate(Math.PI / 2);
    } else {
      fctx.translate(0, finalCanvas.height);
      fctx.rotate(-Math.PI / 2);
    }
    fctx.drawImage(canvas, 0, 0);
    fctx.restore();
  }
  
  return imageToMonochromeBitmap(finalCanvas, finalCanvas.width, finalCanvas.height);
}

// ─────────────────────────────────────────────────────────
// ETİKET TASARIMI (100x100mm)
// ─────────────────────────────────────────────────────────
async function buildLabel(data, customTemplateBase64, copies) {
  const { tkgCode, alici, gonderici, desi } = data;
  let images = [];

  async function addTextBitmap(text, x, y, options, centerPointX = null) {
    if (!text) return;
    const bitmap = await renderTextToMonochromeBitmap(text, options);
    const finalX = centerPointX !== null ? Math.round(centerPointX - bitmap.width / 2) : x;
    images.push({ bitmap, x: finalX, y });
  }

  // 1. ÖZEL ŞABLON AKTİF İSE (Tantex Custom Layout)
  if (customTemplateBase64) {
    try {
      const W = 800, H = 800;
      const mc = document.createElement('canvas');
      mc.width = W; mc.height = H;
      const ctx = mc.getContext('2d');

      // Bütün şablonu 5px aşağı kaydır
      ctx.translate(0, 5);

      const C = {
        BLACK: '#000000',
        WHITE: '#ffffff',
        GRAY:  '#555555',
      };

      function drawText(str, x, y, { size = 22, weight = 'normal', align = 'left', baseline = 'top', color = C.BLACK } = {}) {
        if (!str) return 0;
        ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
        ctx.font = `${weight} ${size}px sans-serif`;
        ctx.fillText(str, x, y);
        return ctx.measureText(str).width;
      }

      function drawWrapped(str, x, y, maxW, size, weight = 'normal', lineH, color = C.BLACK) {
        if (!str) return y;
        ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.font = `${weight} ${size}px sans-serif`;
        const words = str.split(' ');
        let line = '', curY = y;
        for (const word of words) {
          const test = line ? `${line} ${word}` : word;
          if (ctx.measureText(test).width > maxW && line) {
            ctx.fillText(line, x, curY); line = word; curY += lineH;
          } else { line = test; }
        }
        if (line) { ctx.fillText(line, x, curY); curY += lineH; }
        return curY;
      }

      function fitFont(str, maxW, startSize, minSize = 18, weight = 'normal') {
        let size = startSize;
        ctx.font = `${weight} ${size}px sans-serif`;
        while (ctx.measureText(str || '').width > maxW && size > minSize) {
          size -= 2;
          ctx.font = `${weight} ${size}px sans-serif`;
        }
        return size;
      }

      // Draw background image
      const bgImg = await loadImg(customTemplateBase64);
      ctx.drawImage(bgImg, 0, 0, W, H);

      // --- 1. SENDER DETAILS (Eflatun Box: x ~12 to ~472, y ~185 to ~244) ---
      const senderText = [gonderici?.adres, gonderici?.tel].filter(Boolean).join(' - ');
      drawWrapped(senderText, 16, 188, 450, 20, 'normal', 24);

      // --- 2. RECEIVER DETAILS (Kırmızı Box: x ~16 to ~380, y ~328 to ~640) ---
      const recName = alici?.unvan || alici?.ad || '';
      const recNameSize = fitFont(recName, 360, 36, 22, 'bold');
      drawText(recName, 16, 335, { size: recNameSize, weight: 'bold' });
      
      let recY = 335 + recNameSize * 1.3 + 6;
      recY = drawWrapped(alici?.adres || '', 16, recY, 360, 23, 'normal', 28);
      
      if (alici?.tel) {
        drawText(alici.tel, 16, recY + 9, { size: 21 });
      }

      const cityStr = [alici?.ilce, alici?.il].filter(Boolean).join(' / ').toLocaleUpperCase('tr-TR');
      const cityFontSize = fitFont(cityStr, 360, 32, 22, 'bold');
      drawText(cityStr, 16, 570, { size: cityFontSize, weight: 'bold' });

      // --- 3. DIMENSIONS / ÖLÇÜLER (Turkuaz Box: Center x ~516, y ~416 to ~516) — 15px AŞAĞI KAYDIRILDI
      const dims = `${desi?.en || '0'}x${desi?.boy || '0'}x${desi?.yuk || '0'}`;
      drawText(dims, 516, 470, { size: 30, weight: 'bold', align: 'center' });

      // --- 4. WEIGHT / AĞIRLIK (Turuncu Box: Center x ~714, y ~408 to ~470) ---
      const weightVal = String(desi?.kg || '0');
      drawText(weightVal, 714, 435, { size: 32, weight: 'bold', align: 'center' });

      // --- 5. DESI / HACİM (Pembe Box: Center x ~714, y ~524 to ~586) ---
      const desiVal = String(desi?.ucret !== null && desi?.ucret !== undefined ? desi.ucret : '0');
      drawText(desiVal, 714, 550, { size: 32, weight: 'bold', align: 'center' });

      // --- 6. QR CODE (Lacivert Box: x ~64, y ~700, w 80, h 80) — BARKOD HİZASINA DİKEY ORTALANDI
      try {
        const qrCanvas = document.createElement('canvas');
        await QRCode.toCanvas(qrCanvas, 'www.tantex.com.tr', { margin: 0, width: 80 });
        ctx.drawImage(qrCanvas, 64, 700, 80, 80);
        // QR kodun altına küçük adres metni
        drawText('www.tantex.com.tr', 104, 784, { size: 14, align: 'center' });
      } catch (e) {
        console.warn('[PrintEngine] Özel şablon QR kod çizilemedi:', e);
      }

      // --- 7. BARCODE (Yeşil Box: x ~280, y ~705, w ~480, h ~70) — 20px AŞAĞI KAYDIRILDI
      try {
        const bcBytes = barcodePNG(tkgCode || '', { type: 'code128', height: 70, barWidth: 2 });
        const bcBlob  = new Blob([bcBytes], { type: 'image/png' });
        const bcUrl   = URL.createObjectURL(bcBlob);
        const bcImg   = await loadImg(bcUrl);
        URL.revokeObjectURL(bcUrl);
        ctx.drawImage(bcImg, 280, 705, 480, 70);
      } catch (e) {
        console.warn('[PrintEngine] Özel şablon barkod çizilemedi:', e);
      }

      // TKG text under barcode (759 -> 779)
      drawText(tkgCode || '', 520, 779, { size: 21, align: 'center' });

      // Convert to monochrome bitmap
      const masterBitmap = imageToMonochromeBitmap(mc, W, H);
      let lbl = label({ width: 100, height: 100, unit: 'mm', dpi: 203, copies: copies });
      return { lbl, images: [{ bitmap: masterBitmap, x: 0, y: 0 }] };

    } catch (e) {
      console.error('Özel şablon yüklenirken hata oluştu, varsayılan şablona dönülüyor.', e);
    }
  }

  // 2. VARSAYILAN ŞABLON — ENTERPRISE MASTER CANVAS
  // Tüm şablon tek bir 800x800 canvas üzerine çizilir → tek BITMAP komutu
  const W = 800, H = 800;
  const mc = document.createElement('canvas');
  mc.width = W; mc.height = H;
  const ctx = mc.getContext('2d');

  // ── Yardımcılar ────────────────────────────────────────────────
  const C = {
    BLACK: '#000000',
    WHITE: '#ffffff',
    GRAY:  '#555555',
  };

  function fillRect(x, y, w, h, color = C.BLACK) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }
  function strokeRect(x, y, w, h, lw = 2, color = C.BLACK) {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.strokeRect(x + lw/2, y + lw/2, w - lw, h - lw);
  }
  function hline(y, lw = 2, x1 = 0, x2 = W) {
    ctx.strokeStyle = C.BLACK; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  }
  function vline(x, y1, y2, lw = 2) {
    ctx.strokeStyle = C.BLACK; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
  }
  // Canvas'a metin yaz, döndürülen değer: measureText.width
  function drawText(str, x, y, { size = 22, weight = 'normal', align = 'left', baseline = 'top', color = C.BLACK } = {}) {
    if (!str) return 0;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
    ctx.font = `${weight} ${size}px sans-serif`;
    ctx.fillText(str, x, y);
    return ctx.measureText(str).width;
  }
  // Satır kaydıran metin yazar; alt kenar y koordinatını döndürür
  function drawWrapped(str, x, y, maxW, size, weight = 'normal', lineH, color = C.BLACK) {
    if (!str) return y;
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = `${weight} ${size}px sans-serif`;
    const words = str.split(' ');
    let line = '', curY = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, curY); line = word; curY += lineH;
      } else { line = test; }
    }
    if (line) { ctx.fillText(line, x, curY); curY += lineH; }
    return curY;
  }
  // Font boyutunu metnin maxW'ya sığmasına göre otomatik küçültür
  function fitFont(str, maxW, startSize, minSize = 18, weight = 'normal') {
    let size = startSize;
    ctx.font = `${weight} ${size}px sans-serif`;
    while (ctx.measureText(str || '').width > maxW && size > minSize) {
      size -= 2;
      ctx.font = `${weight} ${size}px sans-serif`;
    }
    return size;
  }

  const PAD = 12; // kenar boşluğu (dot)

  // ══ 0. BEYAZ ZEMIN (DIŞ ÇERÇEVE KALDIRILDI) ══════════════════
  fillRect(0, 0, W, H, C.WHITE);

  // ══ 1. HEADER (0 → 118) ══════════════════════════════════════
  // Üstte ince siyah dekoratif şerit (marka hissi)
  fillRect(0, 0, W, 5, C.BLACK);

  // Logo alanı: sol, 5 → 113 (108x108 dot ≈ 13.5mm kare)
  const LOGO_X = 5, LOGO_Y = 5, LOGO_S = 108;
  
  let logoLoaded = false;
  let logoImg = null;
  try {
    const rawCompany = localStorage.getItem('cb_company');
    if (rawCompany) {
      const company = JSON.parse(rawCompany);
      const logoSrc = company?.logo;
      if (logoSrc && logoSrc.startsWith('data:')) {
        logoImg = await loadImg(logoSrc);
        logoLoaded = true;
      }
    }
  } catch (e) {
    console.warn('Logo yüklenemedi:', e);
  }

  if (logoLoaded && logoImg) {
    const scale = Math.min((LOGO_S - 8) / logoImg.width, (LOGO_S - 8) / logoImg.height);
    const lw = logoImg.width * scale, lh = logoImg.height * scale;
    ctx.drawImage(logoImg,
      LOGO_X + (LOGO_S - lw) / 2,
      LOGO_Y + (LOGO_S - lh) / 2,
      lw, lh);
    // İnce logo çerçevesi
    strokeRect(LOGO_X, LOGO_Y, LOGO_S, LOGO_S, 1.5);
  }

  // Şirket adı + slogan: logo sağında, dikey olarak ortalanmış, sağa dayalı
  const hdrTextX = logoLoaded ? (LOGO_X + LOGO_S + 14) : PAD;
  const hdrTextMaxW = W - hdrTextX - PAD;
  const companyName = gonderici?.unvan || '';
  const companySlogan = gonderici?.slogan || '';

  const nameFontSize = fitFont(companyName, hdrTextMaxW, 38, 22, 'bold');
  const nameLineH = nameFontSize * 1.25;
  const sloganLineH = 24;
  const totalTextH = nameLineH + (companySlogan ? sloganLineH + 4 : 0);
  const textStartY = LOGO_Y + (LOGO_S - totalTextH) / 2;

  drawText(companyName, W - PAD, textStartY,
    { size: nameFontSize, weight: 'bold', align: 'right' });
  if (companySlogan) {
    drawText(companySlogan, W - PAD, textStartY + nameLineH + 4,
      { size: 21, color: C.GRAY, align: 'right' });
  }

  const HDR_H = 118;
  hline(HDR_H, 3); // Kalın ayırıcı çizgi

  // ══ 2. ALICI BÖLMESİ (118 → 438) — DARALTILDI ════════════════
  // "ALICI / TO" etiketi: siyah arka plan, beyaz metin
  const ALICI_BAR_H = 30;
  fillRect(0, HDR_H, W, ALICI_BAR_H, C.BLACK);
  drawText('  ALICI / TO', 0, HDR_H + (ALICI_BAR_H - 20) / 2,
    { size: 20, weight: 'bold', color: C.WHITE, baseline: 'top' });

  const ALICI_BOTTOM = 438;
  let recY = HDR_H + ALICI_BAR_H + 10;

  // Alıcı adı — en büyük, en kalın
  const recName = alici?.unvan || alici?.ad || '';
  const recNameSize = fitFont(recName, W - PAD * 2, 46, 24, 'bold');
  drawText(recName, PAD, recY, { size: recNameSize, weight: 'bold' });
  recY += recNameSize * 1.3 + 6;

  // Adres (satır kayan)
  recY = drawWrapped(alici?.adres || '', PAD, recY, W - PAD * 2, 25, 'normal', 30);
  recY += 4;

  // Telefon
  if (alici?.tel) {
    drawText(`☎  ${alici.tel}`, PAD, recY, { size: 23 });
  }

  // İl/İlçe — büyük, sağa dayalı, altta (kargo sınıflandırma için kritik)
  const cityStr = [alici?.ilce, alici?.il].filter(Boolean).join(' / ').toLocaleUpperCase('tr-TR');
  const cityFontSize = fitFont(cityStr, W - PAD * 2, 38, 24, 'bold');
  drawText(cityStr, W - PAD, ALICI_BOTTOM - 40,
    { size: cityFontSize, weight: 'bold', align: 'right', baseline: 'top' });

  hline(ALICI_BOTTOM, 3);

  // ══ 3. GÖNDERİCİ BÖLMESİ (438 → 518) ════════════════════════
  const GOND_BAR_W = Math.round(W * 0.38);
  fillRect(0, ALICI_BOTTOM, GOND_BAR_W, 26, C.BLACK);
  drawText('  GÖNDERİCİ / FROM', 0, ALICI_BOTTOM + 4,
    { size: 17, weight: 'bold', color: C.WHITE, baseline: 'top' });

  const senderLine = [gonderici?.unvan, gonderici?.adres, gonderici?.tel]
    .filter(Boolean).join('  ·  ');
  drawWrapped(senderLine, PAD, ALICI_BOTTOM + 32, W - PAD * 2, 21, 'normal', 26);

  const GOND_BOTTOM = 538; // Gönderici kutusu yüksekliği 80 -> 100 dot'a çıkarıldı
  hline(GOND_BOTTOM, 2);

  // ══ 4. BİLGİ BANDI (538 → 612) — EN-BOY-YÜKSEKLİK EKLENDİ
  const INFO_H = 74;
  const INFO_Y = GOND_BOTTOM;

  vline(220, INFO_Y, INFO_Y + INFO_H, 1.5);
  vline(440, INFO_Y, INFO_Y + INFO_H, 1.5);

  const desiVal = desi?.ucret !== null && desi?.ucret !== undefined ? desi.ucret : '—';
  const kiloVal = desi?.kg ? desi.kg : '—';
  const desiUnit = (desi?.kg > 20 && desi?.ucret === desi?.kg) ? 'KG' : 'DESİ';

  function infoCol(label, value, cx) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = C.BLACK;
    ctx.font = '14px sans-serif';
    ctx.fillText(label, cx, INFO_Y + 7);
    ctx.font = `bold 30px sans-serif`;
    ctx.fillText(String(value), cx, INFO_Y + 25);
  }
  infoCol(`AĞIRLIK (${desiUnit})`, desiVal, 110);
  infoCol('KİLO (kg)',             kiloVal,  330);
  infoCol('EBAT (cm)',
    `${desi?.en || '0'}x${desi?.boy || '0'}x${desi?.yuk || '0'}`,
    620);

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';

  const INFO_BOTTOM = INFO_Y + INFO_H;
  hline(INFO_BOTTOM, 2);

  // ══ 5. BARKOD & QR BÖLMESİ (612 → 800) — BARKOD DARALTILDI + QR KOD EKLENDİ
  // Sol tarafta www.tantex.com.tr içeren QR kod (130x130)
  // Sağ tarafta daraltılmış barkod (500x90) + kodu
  const BC_Y = 646; // Bilgi bandı aşağı kaydığı için barkod Y koordinatı da güncellendi
  const BC_W = 500;
  const BC_H = 90;
  const BC_X = 240;

  // QR Code (www.tantex.com.tr)
  try {
    const qrCanvas = document.createElement('canvas');
    await QRCode.toCanvas(qrCanvas, 'www.tantex.com.tr', { margin: 0, width: 130 });
    ctx.drawImage(qrCanvas, 30, 641, 130, 130);
  } catch (e) {
    console.warn('[PrintEngine] QR kod çizilemedi:', e);
  }

  // Barcode
  try {
    const bcBytes = barcodePNG(tkgCode || '', { type: 'code128', height: BC_H, barWidth: 2 });
    const bcBlob  = new Blob([bcBytes], { type: 'image/png' });
    const bcUrl   = URL.createObjectURL(bcBlob);
    const bcImg   = await loadImg(bcUrl);
    URL.revokeObjectURL(bcUrl);
    ctx.drawImage(bcImg, BC_X, BC_Y, BC_W, BC_H);
  } catch (e) {
    console.warn('[PrintEngine] Barkod çizilemedi:', e);
  }

  // TKG kodu metni (barkodun altında)
  const TKG_Y = BC_Y + BC_H + 4;
  drawText(tkgCode || '', BC_X + BC_W / 2, TKG_Y, { size: 22, align: 'center' });

  // ══ Tüm canvas'ı tek monochrome bitmap'e çevir ══════════════
  const masterBitmap = imageToMonochromeBitmap(mc, W, H);

  const lbl = label({ width: 100, height: 100, unit: 'mm', dpi: 203, copies });
  return { lbl, images: [{ bitmap: masterBitmap, x: 0, y: 0 }] };
}


// Resimleri TSPL'e binary olarak yerleştirmek için özel derleyici
function compileToTSPLBase64(lbl, images, copies) {
  const tsplStr = tsc.compile(lbl);
  const lines = tsplStr.split(/\r?\n/);
  
  let printCmd = `PRINT ${copies},1\r\n`;
  let printIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('PRINT ')) {
      printCmd = lines[i] + '\r\n';
      printIndex = i;
      break;
    }
  }
  
  let beforePrint = tsplStr;
  if (printIndex !== -1) {
    beforePrint = lines.slice(0, printIndex).join('\r\n') + '\r\n';
  }
  
  // Artık metinleri TSPL text komutuyla DEĞİL, resim olarak bastığımız için
  // özel codepage (1254) ya da özel encoder'a gerek kalmadı. Standart UTF-8 kullanabiliriz.
  const enc = new TextEncoder();
  const buffers = [enc.encode(beforePrint)];
  
  for (const img of images) {
    const header = `BITMAP ${img.x},${img.y},${img.bitmap.bytesPerRow},${img.bitmap.height},0,`;
    buffers.push(enc.encode(header));
    buffers.push(img.bitmap.data); // HAM BINARY DATA
    buffers.push(enc.encode('\r\n'));
  }
  
  if (printIndex !== -1) {
    buffers.push(enc.encode(printCmd));
  }
  
  const totalLen = buffers.reduce((s, b) => s + b.length, 0);
  const finalBuf = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of buffers) {
    finalBuf.set(b, offset);
    offset += b.length;
  }
  
  let binary = '';
  for (let i = 0; i < finalBuf.length; i++) {
    binary += String.fromCharCode(finalBuf[i]);
  }
  return window.btoa(binary);
}

// ─────────────────────────────────────────────────────────
// DIŞA AÇILAN ANA FONKSİYON
// ─────────────────────────────────────────────────────────
async function printShippingLabel(data, copies = 1) {
  console.log('[PrintEngine] printShippingLabel başladı:', JSON.stringify(data, null, 2));

  const rawPrefs = localStorage.getItem('cb_prefs');
  let customTemplate = null;
  let activeTemplate = 'default';
  if (rawPrefs) {
    try {
      const prefs = JSON.parse(rawPrefs);
      activeTemplate = prefs.activeTemplate || 'default';
      customTemplate = prefs.customTemplate || null;
    } catch {}
  }
  
  const templateToUse = (activeTemplate === 'custom' && customTemplate) ? customTemplate : null;
  const { lbl, images } = await buildLabel(data, templateToUse, copies);
  console.log('[PrintEngine] Etiket oluşturuldu, TSPL derleniyor...');
  
  const base64Data = compileToTSPLBase64(lbl, images, copies);
  console.log('[PrintEngine] Derleme tamam, ajana gönderiliyor...');

  // Ajanın /print endpoint'ine base64 olarak gönder
  await agentFetch('/print', {
    method: 'POST',
    body: JSON.stringify({ data: base64Data, encoding: 'base64' })
  });
  console.log('[PrintEngine] Ajana gönderildi.');
  return true;
}

// ─────────────────────────────────────────────────────────
// ÖNİZLEME (yazıcıya gitmez, sadece SVG üretir — agent gerekmez)
// ─────────────────────────────────────────────────────────
async function previewShippingLabel(data, copies = 1) {
  const rawPrefs = localStorage.getItem('cb_prefs');
  let customTemplate = null;
  let activeTemplate = 'default';
  if (rawPrefs) {
    try {
      const prefs = JSON.parse(rawPrefs);
      activeTemplate = prefs.activeTemplate || 'default';
      customTemplate = prefs.customTemplate || null;
    } catch {}
  }
  
  const templateToUse = (activeTemplate === 'custom' && customTemplate) ? customTemplate : null;
  const { lbl, images } = await buildLabel(data, templateToUse, copies);
  
  // Önizleme (SVG) için resimleri Label nesnesine tekrar ekle
  for (const img of images) {
    lbl.image(img.bitmap, { x: img.x, y: img.y, width: img.bitmap.width, height: img.bitmap.height });
  }
  
  const code = tsc.compile(lbl);
  const svg = tsc.preview(lbl);
  const validation = tsc.validate(code);
  return { svg, code, validation };
}

// ─────────────────────────────────────────────────────────
window.PrintEngine = {
  Settings,
  checkAgentHealth,
  listPrinters,
  sendTest,
  printShippingLabel,
  previewShippingLabel
};
console.log('[PrintEngine] window.PrintEngine başarıyla set edildi ✓');
