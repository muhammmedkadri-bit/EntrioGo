/**
 * EntrioGo Print Agent — Sertifika Üretici
 * 100 yıl geçerli self-signed sertifika üretir.
 * Kullanım: node gen-cert.js
 */
const selfsigned = require('selfsigned');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const DAYS = 365 * 100; // 100 yıl

const attrs = [
  { name: 'organizationName', value: 'EntrioGo' },
  { name: 'commonName',       value: '192.168.1.156' },
];

const extensions = [
  { name: 'basicConstraints', cA: true },
  {
    name: 'keyUsage',
    digitalSignature: true,
    keyCertSign: true,
    keyEncipherment: true,
    dataEncipherment: true,
  },
  { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
  {
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      { type: 7, ip: '192.168.1.156' },
      { type: 7, ip: '192.168.1.1' },
      { type: 7, ip: '192.168.1.100' },
      { type: 7, ip: '192.168.1.200' },
      { type: 7, ip: '192.168.0.1' },
      { type: 7, ip: '192.168.0.100' },
      { type: 7, ip: '10.0.0.1' },
      { type: 7, ip: '10.0.0.100' },
    ],
  },
];

console.log(`Sertifikalar üretiliyor (${DAYS} gün = 100 yıl)...`);

const pems = selfsigned.generate(attrs, {
  keySize:    2048,
  days:       DAYS,
  algorithm:  'sha256',
  extensions,
});

const outDir = __dirname;

fs.writeFileSync(path.join(outDir, 'server.key'), pems.private,  'utf8');
fs.writeFileSync(path.join(outDir, 'server.crt'), pems.cert,     'utf8');
fs.writeFileSync(path.join(outDir, 'ca.crt'),     pems.cert,     'utf8'); // self-signed → CA kendisi

console.log('\n✅ Dosyalar yazıldı: server.key  server.crt  ca.crt\n');

// Doğrulama
const x509 = new crypto.X509Certificate(pems.cert);
console.log('Konu      :', x509.subject.replace(/\n/g, ', '));
console.log('SAN       :', x509.subjectAltName);
console.log('Başlangıç :', x509.validFrom);
console.log('Bitiş     :', x509.validTo);
