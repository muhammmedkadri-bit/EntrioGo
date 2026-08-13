/**
 * Bu dosyayı BİR KEZ, "Yönetici olarak çalıştır" ile açılmış bir
 * cmd/PowerShell içinde şu şekilde çalıştırın:
 *
 *     npm install
 *     node install-service.js
 *
 * Bu, ajanı Windows'ta görünmez, arka planda otomatik başlayan bir
 * SERVİS olarak kurar. Bilgisayar yeniden başlasa bile siz hiçbir şey
 * yapmadan çalışmaya devam eder. Kaldırmak için: node uninstall-service.js
 */
const path = require('path');
let Service;
try {
  Service = require('node-windows').Service;
} catch (e) {
  console.error('node-windows bulunamadı. Önce şunu çalıştırın: npm install node-windows');
  process.exit(1);
}

const svc = new Service({
  name: 'CargobarPrintAgent',
  description: 'Cargobar için yerel termal yazıcı köprüsü (100x100mm etiket).',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: []
});

svc.on('install', () => {
  console.log('Servis kuruldu, başlatılıyor...');
  svc.start();
});
svc.on('start', () => {
  console.log('CargobarPrintAgent servisi çalışıyor. https://localhost:9198/health adresinden kontrol edebilirsiniz.');
});
svc.on('alreadyinstalled', () => console.log('Servis zaten kurulu.'));

svc.install();
