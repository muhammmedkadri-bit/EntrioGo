/**
 * Cargobar Yerel Yazdırma Ajanı (Print Agent)
 * ---------------------------------------------
 * Bu küçük servis, yazıcının fiziksel olarak bağlı olduğu bilgisayarda
 * arka planda çalışır. Cargobar web sayfası (tarayıcıdan) bu servise
 * HTTP ile "şu ham komutları yazdır" der; servis de bunları doğrudan
 * işletim sisteminin RAW yazdırma yoluyla yazıcıya iletir.
 *
 * Neden böyle? Tarayıcılar güvenlik nedeniyle web sayfasının doğrudan
 * bir USB/ağ yazıcısına ham veri yollamasına izin vermez. Bu servis o
 * köprüyü kurar; kullanıcı hiçbir zaman bunu elle açıp kapatmaz
 * (bkz. install-service.js / run-hidden.vbs - otomatik başlatma).
 *
 * Desteklenen işletim sistemleri:
 *   - Windows  -> paylaşılan yazıcıya "copy /b" ile RAW veri (spooler RAW datatype)
 *   - macOS/Linux -> CUPS "lp -o raw" ile RAW veri
 */

const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  const defaults = {
    port: 9198,
    // Windows: Denetim Masası > Aygıtlar ve Yazıcılar altındaki PAYLAŞIM ADI
    // (yazıcı adı değil, paylaşım adı). Örn: "ZjiangEtiket"
    windowsShareName: 'ZjiangEtiket',
    // macOS/Linux: `lpstat -p` ile görünen CUPS yazıcı adı
    cupsPrinterName: 'Zjiang',
    // Bu siteler dışından gelen istekler reddedilir (güvenlik).
    allowedOrigins: [
      'https://cargobar.vercel.app',
      'https://entrigo.vercel.app',
      'https://entriogo.vercel.app',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
      'http://localhost:8080',
      'http://127.0.0.1:8080'
    ],
    // Her zaman koddaki sabit token'ı kullan
    apiToken: '007419f30b350f3bb329c9ba48bb30e93ae50981744c4737'
  };
  if (fs.existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaults, ...saved };
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  console.log('[config] Yeni config.json oluşturuldu. API token:', defaults.apiToken);
  return defaults;
}

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '5mb' }));

// Chrome Private Network Access (PNA) + CORS preflight
// OPTIONS isteği geldiğinde token kontrolü olmadan direkt izin ver.
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/Postman
  if (config.allowedOrigins.includes(origin)) return true;
  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return true;
  // Vercel preview deploy'ları için esneklik (örn: entrigo-xyz-abc.vercel.app)
  if (origin.endsWith('.vercel.app')) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Print-Token, Access-Control-Request-Private-Network');
  res.setHeader('Access-Control-Max-Age', '86400');
  // OPTIONS preflight — token kontrolü YOK, anında 204 dön
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  // Origin kontrolü (GET/POST için)
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ ok: false, error: 'İzinsiz origin: ' + origin });
  }
  next();
});

function requireToken(req, res, next) {
  const token = (req.header('X-Print-Token') || '').trim();
  const validToken = (config.apiToken || '').trim();
  if (!validToken || token !== validToken) {
    console.log(`[AUTH HATA] Gelen Token: "${token}", Beklenen Token: "${validToken}"`);
    return res.status(401).json({ ok: false, error: `Geçersiz veya eksik X-Print-Token (Gelen: ${token.substring(0,6)}...)` });
  }
  next();
}

// --- Sağlık kontrolü: frontend bunu periyodik yoklayıp ajan var mı bakar ---
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', platform: process.platform });
});

// --- Kurulu/paylaşılan yazıcıları listele (Ayarlar ekranında seçim için) ---
app.get('/printers', requireToken, (req, res) => {
  if (process.platform === 'win32') {
    const psCmd = "Get-Printer | Select-Object Name,ShareName,Shared,DriverName | ConvertTo-Json";
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], (err, stdout) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      let list;
      try { list = JSON.parse(stdout); } catch { list = []; }
      if (!Array.isArray(list)) list = [list];
      res.json({ ok: true, printers: list });
    });
  } else {
    execFile('lpstat', ['-p'], (err, stdout) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      const printers = (stdout.match(/printer (\S+)/g) || []).map(l => l.replace('printer ', ''));
      res.json({ ok: true, printers });
    });
  }
});

// --- Ortak yazdırma işlevi: bir byte buffer'ı işletim sisteminin RAW yoluna yollar ---
function printBuffer(buffer, cb) {
  const tmpFile = path.join(os.tmpdir(), `cargobar-${Date.now()}-${Math.random().toString(36).slice(2)}.prn`);
  fs.writeFileSync(tmpFile, buffer);

  if (process.platform === 'win32') {
    const target = `\\\\localhost\\${config.windowsShareName}`;
    execFile('cmd.exe', ['/c', 'copy', '/b', tmpFile, target], (err, stdout, stderr) => {
      fs.unlink(tmpFile, () => {});
      cb(err ? (stderr || err.message) : null);
    });
  } else {
    execFile('lp', ['-d', config.cupsPrinterName, '-o', 'raw', tmpFile], (err, stdout, stderr) => {
      fs.unlink(tmpFile, () => {});
      cb(err ? (stderr || err.message) : null);
    });
  }
}

// --- Asıl yazdırma uç noktası ---
// body: { data: "<ham TSPL/ESC-POS komutları>", encoding: "utf8" | "base64" }
app.post('/print', requireToken, (req, res) => {
  const { data, encoding = 'utf8' } = req.body || {};
  if (!data) return res.status(400).json({ ok: false, error: 'data alanı zorunlu' });
  const buffer = Buffer.from(data, encoding === 'base64' ? 'base64' : 'utf8');
  printBuffer(buffer, (error) => {
    if (error) {
      console.error('[print] hata:', error);
      return res.status(500).json({ ok: false, error });
    }
    res.json({ ok: true });
  });
});

// --- Tanı/test: TSPL mi ESC/POS mu olduğunu anlamak için iki dilde de mini test etiketi yollar ---
// Kullanım: POST /test/:lang  veya  POST /test/escpos  (body gerekmez)
app.post('/test/:lang', requireToken, (req, res) => {
  const lang = req.params.lang;
  let cmd;
  if (lang === 'tspl') {
    // 100x100mm, 203dpi varsayımıyla basit test etiketi
    cmd = [
      'SIZE 100 mm,100 mm',
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
      'TEXT 50,50,"3",0,1,1,"TSPL TEST OK"',
      'TEXT 50,120,"3",0,1,1,"100x100mm"',
      'PRINT 1,1',
      ''
    ].join('\r\n');
  } else if (lang === 'escpos') {
    const ESC = '\x1b';
    cmd = ESC + '@' + 'ESC/POS TEST OK\n100x100mm alan varsayimiyla\n\n\n\n';
  } else {
    return res.status(400).json({ ok: false, error: 'lang tspl veya escpos olmalı' });
  }
  printBuffer(Buffer.from(cmd, 'utf8'), (error) => {
    if (error) return res.status(500).json({ ok: false, error });
    res.json({ ok: true, sent: lang });
  });
});

// HTTPS: 30 yıl geçerli sertifika ile güvenli bağlantı
const certPath = path.join(__dirname, 'server.crt');
const keyPath  = path.join(__dirname, 'server.key');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('[HATA] server.crt veya server.key bulunamadı!');
  console.error('Lütfen proje kökündeki sertifika üretme adımını tekrar çalıştırın.');
  process.exit(1);
}

const httpsOptions = {
  cert: fs.readFileSync(certPath),
  key:  fs.readFileSync(keyPath),
};

https.createServer(httpsOptions, app).listen(config.port, () => {
  console.log(`EntrioGo Print Agent çalışıyor: https://localhost:${config.port}`);
  console.log(`API Token: ${config.apiToken}`);
  console.log(`Mobil cihaz için CA sertifikasını yükleyin: ca.crt (veya mobil-sertifika.pem)`);
});
