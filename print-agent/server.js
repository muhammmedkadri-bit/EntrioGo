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
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
      'http://localhost:8080',
      'http://127.0.0.1:8080'
    ],
    // İlk çalıştırmada otomatik üretilir, frontend'de de aynısı saklanmalı.
    apiToken: null
  };
  if (fs.existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaults, ...saved };
  }
  defaults.apiToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  console.log('[config] Yeni config.json oluşturuldu. API token:', defaults.apiToken);
  console.log('[config] Bu token\'ı Cargobar > Ayarlar > Yazıcı Ajanı bölümüne girin.');
  return defaults;
}

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '5mb' }));

// ────────────────────────────────────────────────────────────────
// CORS + Chrome Private Network Access (PNA) middleware
// Chrome, public HTTPS sitesinden yerel IP'ye istek atarken
// iki aşamalı preflight gönderir:
//   1. OPTIONS isteği → Access-Control-Allow-Private-Network: true içermeli
//   2. Asıl istek
// Bu yüzden OPTIONS isteği cors() middleware'den ÖNCE yakalanmalı.
// ────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Print-Token, Access-Control-Request-Private-Network',
  'Access-Control-Allow-Credentials': 'true',
};

function getAllowedOrigin(origin) {
  if (!origin) return '*';
  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('https://localhost') || origin.startsWith('https://127.0.0.1')) return origin;
  if (config.allowedOrigins.includes(origin)) return origin;
  if (origin.startsWith('https://')) return origin; // Güvenlik API token ile sağlanıyor
  return null; // HTTP yabancı origin → reddet
}

// Tüm isteklere origin header'ı ekle
app.use((req, res, next) => {
  const origin = req.headers['origin'];
  const allowed = getAllowedOrigin(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    if (allowed !== '*') res.setHeader('Vary', 'Origin');
  }

  // PNA header'ı her zaman ekle (OPTIONS için zorunlu)
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  // OPTIONS preflight → diğer header'ları ekle ve hemen bitir
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', CORS_HEADERS['Access-Control-Allow-Methods']);
    res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS['Access-Control-Allow-Headers']);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  next();
});

function requireToken(req, res, next) {
  const token = req.header('X-Print-Token');
  if (!config.apiToken || token !== config.apiToken) {
    return res.status(401).json({ ok: false, error: 'Geçersiz veya eksik X-Print-Token' });
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
    // Yazıcı adını config'den al (paylaşım adı değil, kurulu yazıcı adı)
    const printerName = config.windowsPrinterName || config.windowsShareName || 'Etiket Yazıcı';
    
    // PowerShell ile doğrudan RAW yazdırma — Print Spooler paylaşım yoluna gerek yok
    const psScript = `
$printerName = '${printerName.replace(/'/g, "''")}';
$tmpFile = '${tmpFile.replace(/\\/g, '\\\\')}';
Add-Type -AssemblyName System.Drawing;
$pd = New-Object System.Drawing.Printing.PrintDocument;
$pd.PrinterSettings.PrinterName = $printerName;
$pd.PrinterSettings.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('Custom', 394, 394);
$rawData = [System.IO.File]::ReadAllBytes($tmpFile);
$sent = $false;
$pd.add_PrintPage({
  param($sender, $e)
  if (-not $sent) {
    $sent = $true;
    $e.Cancel = $true;
  }
});
# RAW yazdırma için doğrudan spooler API kullan
$pinvoke = @'
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA { public string pDocName; public string pOutputFile; public string pDataType; }
  public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
    IntPtr hPrinter; int written;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
    var di = new DOCINFOA { pDocName="CargobarLabel", pOutputFile=null, pDataType="RAW" };
    if (StartDocPrinter(hPrinter, 1, di) == 0) { ClosePrinter(hPrinter); return false; }
    StartPagePrinter(hPrinter);
    IntPtr ptr = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, ptr, bytes.Length);
    WritePrinter(hPrinter, ptr, bytes.Length, out written);
    Marshal.FreeCoTaskMem(ptr);
    EndPagePrinter(hPrinter);
    EndDocPrinter(hPrinter);
    ClosePrinter(hPrinter);
    return true;
  }
}
'@
Add-Type -TypeDefinition $pinvoke -Language CSharp;
$bytes = [System.IO.File]::ReadAllBytes($tmpFile);
$ok = [RawPrinter]::SendBytesToPrinter($printerName, $bytes);
Remove-Item $tmpFile -ErrorAction SilentlyContinue;
if ($ok) { Write-Output 'OK' } else { Write-Error ('RAW print failed for printer: ' + $printerName); exit 1 }
`.trim();

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 15000 }, (err, stdout, stderr) => {
      fs.unlink(tmpFile, () => {});
      if (err || (stderr && stderr.trim())) {
        const msg = stderr?.trim() || err?.message || 'Bilinmeyen yazdırma hatası';
        console.error('[print] Windows RAW hata:', msg);
        return cb(msg);
      }
      console.log('[print] Başarılı:', stdout.trim());
      cb(null);
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

const https = require('https');
const options = {
  key: fs.readFileSync(path.join(__dirname, '192.168.1.156+2-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '192.168.1.156+2.pem'))
};

https.createServer(options, app).listen(config.port, '0.0.0.0', () => {
  console.log(`Cargobar Print Agent (HTTPS) çalışıyor: https://192.168.1.156:${config.port}`);
  console.log(`API Token: ${config.apiToken}`);
});
