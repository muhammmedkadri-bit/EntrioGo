// ═══════════════════════════════════════════════
//  Cargobar v2 — Main Application
// ═══════════════════════════════════════════════

/* ────────────────────────────────────────
   SUPABASE CLIENT
──────────────────────────────────────── */
const supabaseUrl = 'https://wtpijizimadhxcwidrqo.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0cGlqaXppbWFkaHhjd2lkcnFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Mjk0MTQsImV4cCI6MjA5OTEwNTQxNH0.SyYjzqdmwyhdGKcaB5KTo_xAjbsrpPeKBXZ5WeKcCGc';
let _db = null;
try {
  _db = window.supabase.createClient(supabaseUrl, supabaseKey);
} catch(e) {
  console.error('Supabase SDK yüklenemedi, localStorage modunda çalışılıyor.', e);
}

/* ────────────────────────────────────────
   TOAST NOTIFICATIONS
──────────────────────────────────────── */
const Toast = {
  show(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    // Icon based on type
    let iconHtml = '';
    if (type === 'success') {
      iconHtml = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`;
    } else if (type === 'error') {
      iconHtml = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`;
    } else if (type === 'warning') {
      iconHtml = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`;
    } else {
      iconHtml = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
    }

    toast.innerHTML = `
      <div class="toast-icon">${iconHtml}</div>
      <div class="toast-msg">${msg}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-hiding');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
};

/* ────────────────────────────────────────
   STATE & STORE
──────────────────────────────────────── */
const State = {
  session: null,
  customers: [],
  prefs: {
    defaultPrefix: 'TKG',
    prefixes: ['TKG'],
    counters: { 'TKG': 1 },
    activeTemplate: 'default'
  },
  print_count: 0,
  isPrinting: false,  // Guard flag to prevent router re-render during window.print()

  // Company profile
  company: {
    unvan: '',
    slogan: '',
    telefon: '',
    adres: '',
    il: '',
    ilce: '',
    logo: '',   // base64 data URL
  },

  // Slip form state
  mode: 'new',             // 'new' | 'saved'
  selectedCustomer: null,  // saved customer object or null
  pendingPrintData: null,  // data waiting after save-prompt
};

/* ────────────────────────────────────────
   STORAGE HELPERS
──────────────────────────────────────── */
const Store = {
  async load() {
    // 1. Local counters and prefs
    try {
      const rawPrefs = localStorage.getItem('cb_prefs');
      if (rawPrefs) {
        State.prefs = { ...State.prefs, ...JSON.parse(rawPrefs) };
        if (!State.prefs.counters) State.prefs.counters = { [State.prefs.defaultPrefix]: 1 };
      } else {
        // Migrate old tkg_counter if exists
        const oldTkg = localStorage.getItem('cb_tkg_counter');
        if (oldTkg) State.prefs.counters['TKG'] = parseInt(oldTkg, 10);
      }
    } catch (e) {
      console.error('cb_prefs parsing failed:', e);
      localStorage.removeItem('cb_prefs'); // Clear corrupted preferences
    }
    
    try {
      State.print_count = parseInt(localStorage.getItem('cb_print_count') || '0', 10);
    } catch(e) {
      State.print_count = 0;
    }

    // 2. Optimistic Load (Offline Mode / Fallback)
    try {
      const rawCust = localStorage.getItem('cb_customers');
      State.customers = rawCust ? JSON.parse(rawCust) : [...window.MOCK_CUSTOMERS];
    } catch (e) {
      console.error('cb_customers parsing failed:', e);
      State.customers = [...window.MOCK_CUSTOMERS];
      localStorage.removeItem('cb_customers');
    }

    try {
      const rawComp = localStorage.getItem('cb_company');
      if (rawComp) State.company = { ...State.company, ...JSON.parse(rawComp) };
    } catch (e) {
      console.error('cb_company parsing failed:', e);
      localStorage.removeItem('cb_company');
    }

    if (!_db || !State.session) {
      return; // Offline mode or not logged in, we use local data.
    }

    // 3. Fetch from Supabase and update local cache
    try {
      // Load Prefs
      const { data: prefData, error: prefErr } = await _db.from('settings').select('*').eq('key', 'app_prefs').single();
      if (!prefErr && prefData) {
        State.prefs = { ...State.prefs, ...JSON.parse(prefData.value) };
        localStorage.setItem('cb_prefs', JSON.stringify(State.prefs));
      } else if (prefErr && prefErr.code === 'PGRST116') {
        Store.savePrefs(); // Initialize
      }

      const { data: custData, error: custErr } = await _db.from('customers').select('*').order('created_at', { ascending: false });
      if (!custErr && custData) {
        State.customers = custData;
        localStorage.setItem('cb_customers', JSON.stringify(State.customers));
      }

      const { data: compData, error: compErr } = await _db.from('company').select('*').eq('id', 1).single();
      if (!compErr && compData) {
        State.company = { ...State.company, ...compData };
        localStorage.setItem('cb_company', JSON.stringify(State.company));
      } else if (compErr && compErr.code !== 'PGRST116') {
        console.error("Supabase company load error:", compErr);
      }
    } catch (err) {
      console.error("Supabase load exception:", err);
      Toast.show('Veriler sunucudan çekilemedi, çevrimdışı moddasınız.', 'warning');
    }
  },
  
  async saveCustomer(customer) {
    // 1. Update State
    const idx = State.customers.findIndex(c => c.id === customer.id);
    if (idx === -1) State.customers.push(customer);
    else State.customers[idx] = customer;
    
    // 2. Save Locally (Offline support)
    localStorage.setItem('cb_customers', JSON.stringify(State.customers));

    // 3. Save to Supabase
    if (!_db || !State.session) {
      Toast.show('Müşteri cihaza kaydedildi (Çevrimdışı)', 'warning');
      return;
    }
    try {
      const { error } = await _db.from('customers').upsert(customer, { onConflict: 'id' });
      if (error) throw error;
      Toast.show('Müşteri başarıyla kaydedildi.', 'success');
    } catch (err) {
      console.error("Error saving customer:", err);
      Toast.show('Sunucuya kaydedilemedi, veriler cihazınızda güvende.', 'warning');
    }
  },

  async deleteCustomer(id) {
    // 1. Update State & Local
    State.customers = State.customers.filter(c => c.id !== id);
    localStorage.setItem('cb_customers', JSON.stringify(State.customers));

    // 2. Supabase Delete
    if (!_db || !State.session) {
      Toast.show('Müşteri cihazdan silindi (Çevrimdışı)', 'warning');
      return;
    }
    try {
      const { error } = await _db.from('customers').delete().eq('id', id);
      if (error) throw error;
      Toast.show('Müşteri başarıyla silindi.', 'success');
    } catch (err) {
      console.error("Error deleting customer:", err);
      Toast.show('Sunucudan silinemedi, ancak cihazınızdan silindi.', 'warning');
    }
  },

  async savePrefs() {
    localStorage.setItem('cb_prefs', JSON.stringify(State.prefs));
    if (!_db || !State.session) return;
    try {
      await _db.from('settings').upsert({ key: 'app_prefs', value: JSON.stringify(State.prefs) });
    } catch (err) {
      console.error("Error saving prefs:", err);
    }
  },
  savePrintCount() {
    localStorage.setItem('cb_print_count', String(State.print_count));
  },
  
  async saveCompany() {
    // 1. Save Locally
    localStorage.setItem('cb_company', JSON.stringify(State.company));

    // 2. Save to Supabase
    if (!_db || !State.session) {
      Toast.show('Şirket bilgileri cihaza kaydedildi (Çevrimdışı)', 'warning');
      return;
    }
    try {
      const { error } = await _db.from('company').upsert({ id: 1, ...State.company });
      if (error) throw error;
      Toast.show('Şirket bilgileri başarıyla güncellendi.', 'success');
    } catch (err) {
      console.error("Error saving company:", err);
      Toast.show('Sunucuya kaydedilemedi, veriler cihazınızda güvende.', 'warning');
    }
  },
};

/* ────────────────────────────────────────
   CARGO CODE GENERATOR (was TKG)
──────────────────────────────────────── */
const TKG = {
  overridePrefix: null,

  get activePrefix() {
    return this.overridePrefix || State.prefs.defaultPrefix;
  },

  current() {
    const pfx = this.activePrefix;
    const cnt = State.prefs.counters[pfx] || 1;
    return pfx + '-' + String(cnt).padStart(6, '0');
  },
  next() {
    const pfx = this.activePrefix;
    if (!State.prefs.counters[pfx]) State.prefs.counters[pfx] = 1;
    State.prefs.counters[pfx]++;
    Store.savePrefs();

    // Fiş yazdırıldıktan sonra varsayılana dön
    this.overridePrefix = null;
    this.syncSelectUI();

    return this.current();
  },
  setInputValue() {
    const el = document.getElementById('tkg-input');
    if (el) el.value = this.current();
    this.syncSelectUI();
  },
  syncSelectUI() {
    const select = document.getElementById('temp-prefix-select');
    if (!select) return;
    select.innerHTML = '';
    const pfxs = State.prefs.prefixes || [];
    pfxs.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p + (p === State.prefs.defaultPrefix ? ' (Varsayılan)' : '');
      if (p === this.activePrefix) opt.selected = true;
      select.appendChild(opt);
    });
  },
  handlePrefixChange(newPrefix) {
    if (newPrefix === State.prefs.defaultPrefix) {
      this.overridePrefix = null;
    } else {
      this.overridePrefix = newPrefix;
    }
    this.setInputValue();
    if (window.Slip) Slip.syncSummary();
  }
};

/* ────────────────────────────────────────
   ROUTING
──────────────────────────────────────── */
/* ────────────────────────────────────────
   PAGE TRANSITION
──────────────────────────────────────── */
const PageTransition = {
  _timer: null,
  _el() { return document.getElementById('page-transition'); },

  show(msg = '') {
    const el = this._el();
    if (!el) return;
    const logo = el.querySelector('.pt-logo');
    if (logo) { logo.style.animation = 'none'; logo.offsetHeight; logo.style.animation = ''; }
    
    const textEl = document.getElementById('pt-text');
    if (textEl) {
      if (msg) {
        textEl.textContent = msg;
        textEl.classList.add('active');
      } else {
        textEl.classList.remove('active');
      }
    }

    el.classList.remove('pt-hiding');
    el.classList.add('pt-active');
    clearTimeout(this._timer);
  },

  hide() {
    const el = this._el();
    if (!el) return;
    el.classList.add('pt-hiding');
    this._timer = setTimeout(() => {
      el.classList.remove('pt-active', 'pt-hiding');
    }, 220);
  },
};

const Router = {
  authLoaded: false,
  _prevHash: null,

  init() {
    window.addEventListener('beforeprint', () => { State.isPrinting = true; });
    window.addEventListener('afterprint',  () => {
      setTimeout(() => { State.isPrinting = false; }, 300);
    });

    window.addEventListener('hashchange', () => {
      if (State.isPrinting) return;
      this.route();
    });
    this.route();
  },

  navigate(hash) {
    // Sadece giriş yapmış kullanıcı sayfalar arasında geçiş yaparken göster
    const fromProtected = this._prevHash && this._prevHash !== '#/login';
    const toProtected   = hash !== '#/login';
    if (State.session && fromProtected && toProtected && this._prevHash !== hash) {
      PageTransition.show();
      // Geçiş süresi dolunca kapat
      setTimeout(() => PageTransition.hide(), 480);
    }
    window.location.hash = hash;
  },

  route() {
    let hash = window.location.hash || '#/login';

    // Auth guard
    if (this.authLoaded) {
      if (!State.session && hash !== '#/login') {
        this._prevHash = hash;
        this.navigate('#/login');
        return;
      }
      if (State.session && hash === '#/login') {
        this._prevHash = hash;
        this.navigate('#/slip');
        return;
      }
    }

    const views = { '#/login': 'view-login', '#/slip': 'view-slip', '#/customers': 'view-customers', '#/company': 'view-company', '#/settings': 'view-settings' };
    const menus = { '#/slip': 'menu-slip', '#/customers': 'menu-customers', '#/company': 'menu-company' };

    document.querySelectorAll('.view-pane').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));

    const viewKey = Object.keys(views).find(k => hash.startsWith(k)) || '#/login';
    document.getElementById(views[viewKey])?.classList.add('active');
    document.getElementById(menus[viewKey])?.classList.add('active');

    const titles = {
      '#/login': 'EntrioGo | Giriş',
      '#/slip': 'EntrioGo | Kargo Fişi Oluştur',
      '#/customers': 'EntrioGo | Müşteriler',
      '#/company': 'EntrioGo | Şirket',
      '#/settings': 'EntrioGo | Ayarlar'
    };
    document.title = titles[viewKey] || 'EntrioGo';

    this._prevHash = hash;

    if (viewKey === '#/customers') App.renderCustomersTable();
    if (viewKey === '#/company') App.renderCompanyForm();
    if (viewKey === '#/settings') {
      Settings.renderPrefixList();
      Settings.renderCustomTemplate();
      if (window.PrinterSettings) window.PrinterSettings.load();
    }

    // Sync dock visibility and selection
    if (window.Dock) Dock.syncUI(hash);
  },
};

/* ────────────────────────────────────────
   SLIP — Kargo Fişi Logic
──────────────────────────────────────── */
const Slip = {
  setMode(mode) {
    State.mode = mode;
    State.selectedCustomer = null;

    const newCard   = document.getElementById('mode-new-card');
    const savedCard = document.getElementById('mode-saved-card');
    const savedArea = document.getElementById('saved-customer-select-area');
    const badge     = document.getElementById('selected-customer-badge');
    const pickerBtn = document.getElementById('open-customer-picker-btn');

    newCard.classList.toggle('selected', mode === 'new');
    savedCard.classList.toggle('selected', mode === 'saved');
    savedArea.style.display = mode === 'saved' ? 'block' : 'none';

    // Critical fix: always reset picker/badge visibility on any mode switch
    if (pickerBtn) pickerBtn.style.display = 'flex';
    if (badge)     badge.style.display     = 'none';

    Slip.clearForm();
    TKG.setInputValue();
    this.syncSummary();
  },

  clearForm() {
    ['f-unvan','f-ad','f-tel','f-adres','f-ilce','f-il'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  },

  fillFromCustomer(cust) {
    document.getElementById('f-unvan').value = cust.unvan || '';
    document.getElementById('f-ad').value    = cust.ad    || '';
    document.getElementById('f-tel').value   = cust.telefon || '';
    document.getElementById('f-adres').value = cust.adres || '';
    
    const ilSelect = document.getElementById('f-il');
    ilSelect.value = cust.il || '';
    App.handleCityChange('f-il', 'f-ilce');
    
    document.getElementById('f-ilce').value  = cust.ilce  || '';
    this.syncSummary();
  },

  clearSelectedCustomer() {
    State.selectedCustomer = null;
    document.getElementById('selected-customer-badge').style.display = 'none';
    document.getElementById('open-customer-picker-btn').style.display = 'flex';
    Slip.clearForm();
    TKG.setInputValue();
    this.syncSummary();
  },

  calcDesi() {
    const en  = parseFloat(document.getElementById('d-en').value) || 0;
    const boy = parseFloat(document.getElementById('d-boy').value) || 0;
    const yuk = parseFloat(document.getElementById('d-yukseklik').value) || 0;
    const kg  = parseFloat(document.getElementById('d-kilo').value) || 0;

    const resHacimsel = document.getElementById('res-hacimsel');
    const resKilo     = document.getElementById('res-kilo');
    const resUcret    = document.getElementById('res-ucret');
    const resultCard  = document.getElementById('desi-result-card');

    if (!en || !boy || !yuk) {
      resHacimsel.textContent = '—';
      resKilo.textContent     = kg ? `${kg} kg` : '—';
      resUcret.textContent    = '—';
      resultCard.classList.remove('dhl-active');
      this.syncSummary();
      return;
    }

    // Formül: En × Boy × Yükseklik / 3000
    // Enterprise kargo kuralı: küsüratlı desi değerleri bir üst tam sayıya yuvarlanır
    const hacimselDesi = (en * boy * yuk) / 3000;
    const roundedHacimsel = Math.ceil(hacimselDesi);

    // DHL kuralı: ağırlık > 20kg ise ücretlendirme = max(hacimsel, kg)
    let ucretDesi = roundedHacimsel;
    let dhlActive = false;
    if (kg > 20) {
      ucretDesi = Math.max(roundedHacimsel, kg);
      dhlActive = true;
    }

    resHacimsel.textContent = roundedHacimsel + ' desi';
    resKilo.textContent     = kg ? `${kg} kg` : '—';
    resUcret.textContent    = ucretDesi + (kg > 20 && ucretDesi === kg ? ' kg' : ' desi');
    resUcret.style.color    = dhlActive ? 'var(--amber)' : 'var(--accent-light)';

    resultCard.classList.toggle('dhl-active', dhlActive);

    this.syncSummary();
  },

  getDesiData() {
    const en  = parseFloat(document.getElementById('d-en').value) || 0;
    const boy = parseFloat(document.getElementById('d-boy').value) || 0;
    const yuk = parseFloat(document.getElementById('d-yukseklik').value) || 0;
    const kg  = parseFloat(document.getElementById('d-kilo').value) || 0;
    // Enterprise kargo kuralı: küsüratlı desi değerleri bir üst tam sayıya yuvarlanır
    const hacimsel = en && boy && yuk ? Math.ceil((en * boy * yuk) / 3000) : null;
    let ucret = hacimsel;
    if (kg > 20 && hacimsel !== null) ucret = Math.max(hacimsel, kg);
    return { en, boy, yuk, kg, hacimsel, ucret };
  },

  adjustCopies(delta) {
    const inp = document.getElementById('copy-count');
    let val = parseInt(inp.value, 10) || 1;
    val = Math.max(1, Math.min(100, val + delta));
    inp.value = val;
    this.syncSummary();
  },

  regenerateTKG() {
    TKG.next();
    TKG.setInputValue();
    this.syncSummary();
  },

  syncSummary() {
    const unvan = document.getElementById('f-unvan')?.value?.trim();
    const il    = document.getElementById('f-il')?.value?.trim();
    const ilce  = document.getElementById('f-ilce')?.value?.trim();
    const copies = parseInt(document.getElementById('copy-count')?.value, 10) || 1;
    const tkg   = document.getElementById('tkg-input')?.value?.trim();
    const desi  = this.getDesiData();

    let html = '';
    if (unvan) html += `<strong>${unvan}</strong><br>`;
    if (ilce && il) html += `${ilce} / ${il}<br>`;
    if (desi.ucret !== null) {
      html += `Desi: <strong>${desi.ucret}</strong>`;
      if (desi.kg) html += ` | Ağırlık: <strong>${desi.kg} kg</strong>`;
      html += '<br>';
    }
    if (tkg) html += `Kargo Kodu: <strong class="font-mono">${tkg}</strong><br>`;
    html += `Etiket Adeti: <strong>${copies} kopya</strong>`;

    const box = document.getElementById('print-summary');
    if (box) box.innerHTML = html || '<span style="color:var(--text-muted);">Form dolduruldukça özet burada görünür.</span>';
  },

  getFormData() {
    return {
      unvan:  document.getElementById('f-unvan')?.value?.trim()  || '',
      ad:     document.getElementById('f-ad')?.value?.trim()     || '',
      telefon:document.getElementById('f-tel')?.value?.trim()    || '',
      adres:  document.getElementById('f-adres')?.value?.trim()  || '',
      ilce:   document.getElementById('f-ilce')?.value?.trim()   || '',
      il:     document.getElementById('f-il')?.value?.trim()     || '',
    };
  },

  validateForm() {
    const d = this.getFormData();
    const missing = [];
    if (!d.unvan)   missing.push('Firma Ünvanı');
    // Yetkili adı opsiyonel — zorunlu değil
    if (!d.telefon) missing.push('Telefon');
    if (!d.adres)   missing.push('Adres');
    if (!d.ilce)    missing.push('İlçe');
    if (!d.il)      missing.push('İl');
    return missing;
  },

  handlePrint() {
    const missing = this.validateForm();
    if (missing.length > 0) {
      App.showAlert('Eksik Alanlar', `Lütfen şu zorunlu alanları doldurunuz:<br><br><b style="color:var(--amber);">• ${missing.join('<br>• ')}</b>`);
      return;
    }

    const formData = this.getFormData();
    const desiData = this.getDesiData();
    const copies   = Math.max(1, parseInt(document.getElementById('copy-count').value, 10) || 1);
    const tkg      = document.getElementById('tkg-input').value.trim() || TKG.current();

    const printData = { formData, desiData, copies, tkg };

    // New customer → ask to save
    if (State.mode === 'new') {
      State.pendingPrintData = printData;
      document.getElementById('save-prompt-name').textContent = formData.unvan;
      App.openModal('modal-save-prompt');
    } else {
      // Saved customer → print directly
      Slip.executePrint(printData);
    }
  },

  async executePrint(data) {
    const { formData, desiData, copies, tkg } = data;
    
    const labelData = {
      tkgCode: tkg,
      alici: {
        unvan: formData.unvan,
        ad: formData.ad,
        tel: formData.telefon,
        adres: formData.adres,
        il: formData.il,
        ilce: formData.ilce
      },
      gonderici: {
        unvan: State.company.unvan,
        slogan: State.company.slogan,
        tel: State.company.telefon,
        adres: [State.company.adres, State.company.ilce, State.company.il].filter(Boolean).join(', ')
      },
      desi: desiData
    };

    try {
      if (!window.PrintEngine) {
        throw new Error('Yazıcı motoru (PrintEngine) tarayıcıda bulunamadı.');
      }
      
      // UI loader göster
      PageTransition.show('Etiket yazdırılıyor...');
      
      await window.PrintEngine.printShippingLabel(labelData, copies);
      Toast.show('Etiket başarıyla yazıcıya gönderildi.', 'success');
      
      // Sayaç ve istatistikleri güncelle
      State.print_count += copies;
      Store.savePrintCount();
      
      if (tkg === TKG.current()) {
        TKG.next();
      }
      Slip.syncSummary();
    } catch (err) {
      console.error(err);
      App.showAlert('Yazdırma Hatası', `Yazıcı ajanı ile etiket yazdırılamadı:<br><br><b style="color:#ef4444;">${err.message}</b>`);
    } finally {
      PageTransition.hide();
    }
  }
};

/* ────────────────────────────────────────
   LABEL BUILDER — (Silindi, yeni motor bekleniyor)
──────────────────────────────────────── */
const LabelBuilder = {};

/* ────────────────────────────────────────
   APP — Customers & Modals
──────────────────────────────────────── */
const App = {
  openModal(id) {
    document.getElementById(id)?.classList.add('open');
  },
  closeModal(id) {
    document.getElementById(id)?.classList.remove('open');
  },
  async logout() {
    PageTransition.show('Çıkış Yapılıyor...');

    // 1. Supabase sunucu taraflı token geçersizleştirme
    if (window._db) {
      try {
        await _db.auth.signOut({ scope: 'global' });
      } catch(e) {
        console.warn('signOut error (ignored):', e);
      }
    }

    // 2. State temizle
    State.session = null;

    // 3. Supabase'in localStorage'a kaydettiği TÜM token'ları manuel sil
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sb-') || key.includes('supabase'))) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(k => localStorage.removeItem(k));

    // 4. Formu temizle
    const emailEl = document.getElementById('login-email');
    const passEl = document.getElementById('login-password');
    if (emailEl) {
      emailEl.value = '';
      emailEl.classList.remove('error');
    }
    if (passEl) {
      passEl.value = '';
      passEl.classList.remove('error');
    }
    const errEmail = document.getElementById('email-error');
    const errPass = document.getElementById('password-error');
    const errLogin = document.getElementById('login-error');
    if (errEmail) errEmail.style.display = 'none';
    if (errPass) errPass.style.display = 'none';
    if (errLogin) errLogin.style.display = 'none';

    // 5. Login sayfasına yönlendir (hash üzerinden)
    window.location.hash = '#/login';

    // 6. Biraz bekleyip geçiş ekranını kaldır
    setTimeout(() => {
      PageTransition.hide();
    }, 800);
  },

  initCities() {
    if (typeof TurkeyCities === 'undefined') return;
    const cities = Object.keys(TurkeyCities).sort((a, b) => a.localeCompare(b, 'tr'));
    
    const fillSelect = (id) => {
      const select = document.getElementById(id);
      if (!select) return;
      select.innerHTML = '<option value="">İl Seçiniz</option>';
      cities.forEach(city => {
        const opt = document.createElement('option');
        opt.value = city;
        opt.textContent = city;
        select.appendChild(opt);
      });
    };
    
    fillSelect('f-il');
    fillSelect('cf-il');
    fillSelect('cp-il');
  },

  handleCityChange(cityId, distId) {
    const citySelect = document.getElementById(cityId);
    const distSelect = document.getElementById(distId);
    if (!citySelect || !distSelect) return;
    
    const city = citySelect.value;
    distSelect.innerHTML = '<option value="">Önce İl Seçiniz</option>';
    
    if (!city || typeof TurkeyCities === 'undefined' || !TurkeyCities[city]) {
      distSelect.disabled = true;
      if (cityId === 'f-il') Slip.syncSummary();
      return;
    }
    
    distSelect.disabled = false;
    distSelect.innerHTML = '<option value="">İlçe Seçiniz</option>';
    
    let districts = [...TurkeyCities[city]];
    // Remove existing 'Merkez' if any, ignoring case
    districts = districts.filter(d => d.toLowerCase() !== 'merkez');
    // Sort alphabetically for Turkish locale
    districts.sort((a, b) => a.localeCompare(b, 'tr'));
    // Always add Merkez at the top
    districts.unshift('Merkez');
    
    districts.forEach(dist => {
      const opt = document.createElement('option');
      opt.value = dist;
      opt.textContent = dist;
      distSelect.appendChild(opt);
    });
    
    if (cityId === 'f-il') Slip.syncSummary();
  },

  showAlert(title, messageHtml) {
    let modal = document.getElementById('modal-alert');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.id = 'modal-alert';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:380px;">
          <div class="modal-body" style="padding: 2rem 1.75rem; text-align:center;">
            <div style="width: 48px; height: 48px; background: var(--amber-bg); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem auto; color: var(--amber);">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:24px;">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 style="font-weight:700; font-size:1.15rem; margin-bottom:0.75rem; color: var(--text-main);" id="modal-alert-title"></h3>
            <p style="font-size: 0.95rem; color: var(--text-muted); line-height: 1.6;" id="modal-alert-message"></p>
          </div>
          <div class="modal-foot" style="justify-content:center; padding: 1.25rem;">
            <button class="btn btn-primary" style="min-width:120px;" onclick="App.closeModal('modal-alert')">Anladım</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    
    document.getElementById('modal-alert-title').textContent = title;
    document.getElementById('modal-alert-message').innerHTML = messageHtml;
    this.openModal('modal-alert');
  },

  showConfirm(title, messageHtml, onConfirmCallback) {
    let modal = document.getElementById('modal-confirm');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.id = 'modal-confirm';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:400px;">
          <div class="modal-body" style="padding: 2rem 1.75rem; text-align:center;">
            <div style="width: 48px; height: 48px; background: var(--red-bg); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem auto; color: var(--red);">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:24px;">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 style="font-weight:700; font-size:1.15rem; margin-bottom:0.75rem; color: var(--text-main);" id="modal-confirm-title"></h3>
            <p style="font-size: 0.95rem; color: var(--text-muted); line-height: 1.6;" id="modal-confirm-message"></p>
          </div>
          <div class="modal-foot" style="justify-content:center; gap: 0.75rem; padding: 1.25rem;">
            <button class="btn btn-secondary" style="min-width:110px;" onclick="App.closeModal('modal-confirm')">İptal</button>
            <button class="btn btn-danger" style="min-width:110px;" id="modal-confirm-yes-btn">Evet, Sil</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    
    document.getElementById('modal-confirm-title').textContent = title;
    document.getElementById('modal-confirm-message').innerHTML = messageHtml;
    
    const yesBtn = document.getElementById('modal-confirm-yes-btn');
    yesBtn.onclick = () => {
      this.closeModal('modal-confirm');
      if (onConfirmCallback) onConfirmCallback();
    };
    
    this.openModal('modal-confirm');
  },

  /* ── Customer Picker Modal ── */
  openCustomerPicker() {
    document.getElementById('picker-search').value = '';
    this.renderPickerList(State.customers);
    this.openModal('modal-customer-picker');
  },

  filterPickerList() {
    const q = document.getElementById('picker-search').value.toLowerCase();
    const filtered = State.customers.filter(c =>
      c.unvan.toLowerCase().includes(q) ||
      c.ad.toLowerCase().includes(q) ||
      c.telefon.includes(q)
    );
    this.renderPickerList(filtered);
  },

  renderPickerList(list) {
    const ul = document.getElementById('picker-list');
    ul.innerHTML = '';
    if (list.length === 0) {
      ul.innerHTML = '<li style="padding:1.5rem; text-align:center; color:var(--text-muted);">Sonuç bulunamadı.</li>';
      return;
    }
    list.forEach(cust => {
      const li = document.createElement('li');
      li.className = 'cust-list-item';
      li.innerHTML = `
        <div>
          <div class="item-name">${cust.unvan}</div>
          <div class="item-sub">${cust.ad} · ${cust.telefon} · ${cust.ilce || ''}/${cust.il || ''}</div>
        </div>
        <span class="item-code">${cust.kod || ''}</span>
      `;
      li.onclick = () => this.selectCustomer(cust);
      ul.appendChild(li);
    });
  },

  selectCustomer(cust) {
    State.selectedCustomer = cust;
    Slip.fillFromCustomer(cust);

    // Update badge
    document.getElementById('badge-name-text').textContent = cust.unvan;
    document.getElementById('badge-code-text').textContent = `${cust.kod || ''}  ${cust.ilce || ''} / ${cust.il || ''}`;
    document.getElementById('selected-customer-badge').style.display = 'flex';
    document.getElementById('open-customer-picker-btn').style.display = 'none';

    this.closeModal('modal-customer-picker');
  },

  /* ── Save Prompt (yeni müşteri) ── */
  async handleSavePrompt(shouldSave) {
    this.closeModal('modal-save-prompt');
    const data = State.pendingPrintData;
    if (!data) return;

    let savedCust = null;
    if (shouldSave) {
      // Save customer to list
      const c = data.formData;
      savedCust = {
        id: 'cust-' + Date.now(),
        unvan: c.unvan, ad: c.ad, telefon: c.telefon,
        adres: c.adres, ilce: c.ilce, il: c.il,
        kod: 'M-' + Date.now() + Math.floor(Math.random() * 1000),
      };
      // State.customers.push is done inside Store.saveCustomer
      await Store.saveCustomer(savedCust);
    }

    Slip.executePrint(data);
    State.pendingPrintData = null;

    // After printing, if saved → silently switch to saved mode without clearing the form.
    // This prevents the save prompt from appearing again on subsequent prints.
    if (savedCust) {
      State.mode = 'saved';
      State.selectedCustomer = savedCust;

      // Update UI cards
      const newCard   = document.getElementById('mode-new-card');
      const savedCard = document.getElementById('mode-saved-card');
      const savedArea = document.getElementById('saved-customer-select-area');
      if (newCard)   newCard.classList.remove('selected');
      if (savedCard) savedCard.classList.add('selected');
      if (savedArea) savedArea.style.display = 'block';

      // Show the customer badge
      const badge     = document.getElementById('selected-customer-badge');
      const pickerBtn = document.getElementById('open-customer-picker-btn');
      if (badge) {
        document.getElementById('badge-name-text').textContent = savedCust.unvan;
        document.getElementById('badge-code-text').textContent = `${savedCust.kod || ''}  ${savedCust.ilce || ''} / ${savedCust.il || ''}`;
        badge.style.display = 'flex';
      }
      if (pickerBtn) pickerBtn.style.display = 'none';
      // Form inputs are left untouched — user can print again immediately
    }
  },

  /* ── Customer CRUD Table ── */
  renderCustomersTable(list) {
    const tbody = document.getElementById('customers-tbody');
    if (!tbody) return;
    const data = list || State.customers;
    tbody.innerHTML = '';

    if (data.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Kayıtlı müşteri bulunamadı.</td></tr>`;
      return;
    }

    data.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Müşteri Kodu"><span class="code-badge">${c.kod || '—'}</span></td>
        <td data-label="Firma Ünvanı">
          <div class="cell-stack">
            <span class="cell-main">${c.unvan}</span>
          </div>
        </td>
        <td data-label="Yetkili">${c.ad}</td>
        <td data-label="Telefon">${c.telefon}</td>
        <td data-label="Şehir/İlçe">
          <div class="cell-stack">
            <span class="cell-main">${c.il || '—'}</span>
            <span class="cell-sub">${c.ilce || ''}</span>
          </div>
        </td>
        <td>
          <div class="action-group">
            <button class="action-btn btn-use" title="Fişte Kullan" onclick="App.useInSlip('${c.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/></svg>
            </button>
            <button class="action-btn btn-edit" title="Düzenle" onclick="App.openCustomerModal('${c.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125"/></svg>
            </button>
            <button class="action-btn btn-del" title="Sil" onclick="App.deleteCustomer('${c.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.24 2.156H8.584a2.25 2.25 0 01-2.24-2.156L5.61 5.757m12.73 0c.34-.059.68-.114 1.022-.165M18.004 4.087a48.86 48.86 0 00-12.01 0m11.958 0c.515.057.994.254 1.37.591m-1.553-.591a48.908 48.908 0 00-9.334 0M4.505 4.087c-.376.337-.655.735-.785 1.19m11.1-1.19c-.48-.052-.962-.087-1.446-.105m-8.2.137c-.482-.018-.965-.053-1.446-.105M8.5 2.25h7a1.125 1.125 0 011.125 1.125v1.25H7.375V3.375A1.125 1.125 0 018.5 2.25z"/></svg>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  },

  filterCustomers() {
    const q = document.getElementById('customer-search').value.toLowerCase();
    const filtered = State.customers.filter(c =>
      c.unvan.toLowerCase().includes(q) ||
      c.ad.toLowerCase().includes(q) ||
      c.telefon.includes(q) ||
      (c.il || '').toLowerCase().includes(q) ||
      (c.ilce || '').toLowerCase().includes(q)
    );
    this.renderCustomersTable(filtered);
  },

  useInSlip(id) {
    const cust = State.customers.find(c => c.id === id);
    if (!cust) return;
    window.location.hash = '#/slip';
    setTimeout(() => {
      Slip.setMode('saved');
      App.selectCustomer(cust);
    }, 80);
  },

  /* ── Customer Form Modal ── */
  openCustomerModal(id) {
    const form = document.getElementById('cust-form');
    form.reset();
    document.getElementById('cust-form-id').value = '';
    document.getElementById('cust-modal-title').textContent = 'Yeni Müşteri Ekle';
    document.getElementById('cust-form-submit').textContent = 'Kaydet';

    if (id) {
      const c = State.customers.find(x => x.id === id);
      if (!c) return;
      document.getElementById('cust-form-id').value = c.id;
      document.getElementById('cf-unvan').value = c.unvan || '';
      document.getElementById('cf-ad').value    = c.ad    || '';
      document.getElementById('cf-tel').value   = c.telefon || '';
      document.getElementById('cf-adres').value = c.adres || '';
      document.getElementById('cf-kod').value   = c.kod   || '';
      
      const ilSelect = document.getElementById('cf-il');
      ilSelect.value = c.il || '';
      this.handleCityChange('cf-il', 'cf-ilce');
      document.getElementById('cf-ilce').value  = c.ilce  || '';
      
      document.getElementById('cust-modal-title').textContent = 'Müşteriyi Düzenle';
      document.getElementById('cust-form-submit').textContent = 'Güncelle';
    } else {
      // Clear city and reset district for new customer
      document.getElementById('cf-il').value = '';
      this.handleCityChange('cf-il', 'cf-ilce');
    }

    this.openModal('modal-customer-form');
  },

  async handleCustomerSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('cust-form-id').value;
    const data = {
      unvan:   document.getElementById('cf-unvan').value.trim(),
      ad:      document.getElementById('cf-ad').value.trim(),
      telefon: document.getElementById('cf-tel').value.trim(),
      adres:   document.getElementById('cf-adres').value.trim(),
      ilce:    document.getElementById('cf-ilce').value.trim(),
      il:      document.getElementById('cf-il').value.trim(),
      kod:     document.getElementById('cf-kod').value.trim(),
    };

    if (id) {
      data.id = id;
      const idx = State.customers.findIndex(c => c.id === id);
      if (idx !== -1) State.customers[idx] = { ...State.customers[idx], ...data };
    } else {
      data.id  = 'cust-' + Date.now();
      data.kod = data.kod || ('M-' + Date.now() + Math.floor(Math.random() * 1000));
      State.customers.unshift(data); // Add to top locally
    }

    // Use specific Store method instead of saveCustomers
    await Store.saveCustomer(data);
    
    this.closeModal('modal-customer-form');
    this.renderCustomersTable();
  },

  deleteCustomer(id) {
    const c = State.customers.find(x => x.id === id);
    if (!c) return;
    
    this.showConfirm(
      'Müşteriyi Sil',
      `<b style="color:var(--text-main);">${c.unvan}</b> müşterisini kalıcı olarak silmek istediğinizden emin misiniz?`,
      async () => {
        State.customers = State.customers.filter(x => x.id !== id);
        await Store.deleteCustomer(id);
        this.renderCustomersTable();
      }
    );
  },

  /* ── Company Profile ── */
  renderCompanyForm() {
    const co = State.company;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };
    setVal('cp-unvan',   co.unvan);
    setVal('cp-slogan',  co.slogan);
    setVal('cp-tel',     co.telefon);
    setVal('cp-adres',   co.adres);
    
    setVal('cp-il',      co.il);
    this.handleCityChange('cp-il', 'cp-ilce');
    setVal('cp-ilce',    co.ilce);

    // Show logo preview
    const preview = document.getElementById('cp-logo-preview');
    if (preview) {
      preview.src = co.logo || '';
      preview.style.display = co.logo ? 'block' : 'none';
    }
  },

  /* ── Auth ── */
  async handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.querySelector('.login-btn');
    
    errorEl.style.display = 'none';
    const oldText = btn.innerHTML;
    btn.innerHTML = 'Giriş Yapılıyor...';
    btn.disabled = true;

    try {
      if (!_db) throw new Error('Sunucu bağlantısı yok (localStorage modunda auth kullanılamaz).');
      const { data, error } = await _db.auth.signInWithPassword({ email, password });
      
      if (error) {
        throw error;
      }
      
      State.session = data.session;
      // Navigate to app
      Router.navigate('#/slip');
      
    } catch (err) {
      console.error(err);
      errorEl.textContent = err.message || 'Giriş başarısız. Lütfen bilgilerinizi kontrol edin.';
      errorEl.style.display = 'block';
    } finally {
      btn.innerHTML = oldText;
      btn.disabled = false;
    }
  },

  handleLogoUpload(input) {
    const file = input.files[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        App.showAlert('Hata', 'Logo dosyası 2 MB\'dan büyük olamaz.');
        input.value = '';
        return;
      }
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      State.company.logo = e.target.result;
      const preview = document.getElementById('cp-logo-preview');
      if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
    };
    reader.readAsDataURL(file);
  },

  removeCompanyLogo() {
    State.company.logo = '';
    const preview = document.getElementById('cp-logo-preview');
    if (preview) { preview.src = ''; preview.style.display = 'none'; }
    const inp = document.getElementById('cp-logo-input');
    if (inp) inp.value = '';
  },

  async saveCompanySettings() {
    const getVal = (id) => (document.getElementById(id)?.value?.trim() || '');
    State.company.unvan   = getVal('cp-unvan');
    State.company.slogan  = getVal('cp-slogan');
    State.company.telefon = getVal('cp-tel');
    State.company.adres   = getVal('cp-adres');
    State.company.ilce    = getVal('cp-ilce');
    State.company.il      = getVal('cp-il');
    // logo already updated via handleLogoUpload
    await Store.saveCompany();

    // Visual feedback
    const btn = document.getElementById('cp-save-btn');
    if (btn) {
      btn.textContent = '✓ Kaydedildi!';
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:17px"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.046 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.14.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"/></svg> Bilgileri Kaydet'; btn.disabled = false; }, 2000);
    }
  },
};

/* ────────────────────────────────────────
   FLOATING MENU LOGIC
──────────────────────────────────────── */
const Dock = {
  NORMAL:  48,   // px – base icon size
  MAX:     72,   // px – max icon size on hover
  DIST:   140,   // px – influence radius

  init() {
    this.panel = document.getElementById('dock-panel');
    if (!this.panel) return;
    this.items = Array.from(this.panel.querySelectorAll('.dock-item'));

    this.panel.addEventListener('mousemove', (e) => this._onMove(e));
    this.panel.addEventListener('mouseleave', () => this._onLeave());

    this.syncUI(window.location.hash);
  },

  _onMove(e) {
    const mouseX = e.clientX;
    this.items.forEach(item => {
      const rect = item.querySelector('.dock-icon').getBoundingClientRect();
      const iconCenterX = rect.left + rect.width / 2;
      const dist = Math.abs(mouseX - iconCenterX);
      // Gaussian-like falloff
      const ratio = Math.max(0, 1 - dist / this.DIST);
      const size = Math.round(this.NORMAL + (this.MAX - this.NORMAL) * ratio);
      this._setSize(item, size);
    });
  },

  _onLeave() {
    this.items.forEach(item => this._setSize(item, this.NORMAL));
  },

  _setSize(item, size) {
    const icon = item.querySelector('.dock-icon');
    const svg  = item.querySelector('svg');
    if (!icon) return;

    // Scale the icon square
    icon.style.width        = size + 'px';
    icon.style.height       = size + 'px';
    icon.style.borderRadius = Math.round(size * 0.26) + 'px';

    // Also widen the button wrapper so icons never overflow and overlap
    // Add 8px horizontal breathing room on each side
    item.style.width = (size + 8) + 'px';

    // Scale SVG proportionally
    if (svg) {
      const svgSize = Math.round(size * 0.48);
      svg.style.width  = svgSize + 'px';
      svg.style.height = svgSize + 'px';
    }
  },

  syncUI(hash) {
    // Set dock active class
    this.items.forEach(item => item.classList.remove('active'));
    const dockMap = {
      '#/slip':      'dock-slip',
      '#/customers': 'dock-customers',
      '#/company':   'dock-company',
      '#/settings':  'dock-settings',
    };
    const activeDockId = Object.keys(dockMap).find(k => hash.startsWith(k));
    if (activeDockId) {
      const el = document.getElementById(dockMap[activeDockId]);
      if (el) el.classList.add('active');
    }

    // Hide/show dock based on login
    const dockWrapper = document.getElementById('dock-wrapper');
    if (dockWrapper) {
      if (hash.startsWith('#/login')) {
        dockWrapper.style.display = 'none';
        document.body.style.paddingBottom = '0'; // Remove dock padding
      } else {
        dockWrapper.style.display = '';
        document.body.style.paddingBottom = '';
      }
    }
  },

  navigate(hash) {
    // Router üzerinden yönlendir — sayfa geçiş animasyonu tetiklenir
    Router.navigate(hash);
  }
};

/* ────────────────────────────────────────
   BOOTSTRAP
──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // ── 0. Login sayfasında auth-veil'i anında gizle (hassas içerik yok) ──
  const startHash = window.location.hash || '#/login';
  if (startHash === '#/login' || startHash === '' || startHash === '#') {
    document.getElementById('auth-veil')?.classList.add('av-skip');
  }

  // ── 1. UI'yı ANINDA başlat (Supabase'i bekleme) ──
  App.initCities();
  Router.init();
  TKG.setInputValue();
  Slip.syncSummary();
  Dock.init();

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Expose to window for inline handlers
  window.App  = App;
  window.Slip = Slip;
  window.Dock = Dock;

  // ── 2. Auth Control & Verileri ARKA PLANDA yükle (UI'yı bloke etme) ──

  // Auth Veil — perdeyi kaldır (auth kontrol bittikten sonra)
  const hideAuthVeil = () => {
    const veil = document.getElementById('auth-veil');
    if (veil) veil.classList.add('av-hidden');
  };

  const checkAuthAndLoad = async () => {
    if (_db) {
      const { data: { session } } = await _db.auth.getSession();
      State.session = session;
    }

    Router.authLoaded = true;

    if (_db && !State.session) {
      Router.route(); // Auth guard yönlendirmeyi uygular
      hideAuthVeil(); // Perde kaldırılır — artık doğru view görünür
      return;
    }
    
    // Giriş yapılmış veya local mod → veri yükle
    try {
      await Store.load();
      TKG.setInputValue();
      Slip.syncSummary();
    } catch(err) {
      console.error('Veri yüklenemedi:', err);
    } finally {
      Router.route();
      hideAuthVeil();
      
      const hash = window.location.hash;
      if (hash.includes('/customers')) App.renderCustomersTable();
      if (hash.includes('/company'))   App.renderCompanyForm();
    }
  };
  
  // Expose Router to window so LoginPage can use it
  window.Router = Router;

  // ── 3. Supabase Auth State Listener ──
  // Supabase session'ları dışarıdan değişirse (başka sekme, token sönmesi) yakalamak için.
  // NOT: Navigation buradan yapilmaz — sadece State güncellenir.
  //      Navigation’u checkAuthAndLoad ve logout() yönetiyor.
  if (_db) {
    _db.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        State.session = null;
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        State.session = session;
      }
    });
  }

  checkAuthAndLoad();
  LoginPage.init();
});

/* ────────────────────────────────────────
   LOGIN PAGE — Vanilla JS Module
   (Full faithful recreation of Login.jsx)
──────────────────────────────────────── */
const LoginPage = {
  state: {
    pwVisible: false,
  },

  init() {
    // No initialization needed for minimal login
  },

  togglePassword() {
    const inp = document.getElementById('login-password');
    const showIcon = document.getElementById('eye-icon-show');
    const hideIcon = document.getElementById('eye-icon-hide');
    if (!inp) return;
    const visible = inp.type === 'text';
    inp.type = visible ? 'password' : 'text';
    showIcon.style.display = visible ? '' : 'none';
    hideIcon.style.display = visible ? 'none' : '';
    this.state.pwVisible = !visible;
    this.updateEyes();
  },

  /* Forgot Password */
  showForgot() {
    const m = document.getElementById('forgot-modal');
    if (m) { m.style.display = 'flex'; document.getElementById('forgot-email').value = ''; this._resetForgotStatus(); }
  },

  hideForgot() {
    const m = document.getElementById('forgot-modal');
    if (m) m.style.display = 'none';
  },

  closeForgotOnOverlay(e) {
    if (e.target === document.getElementById('forgot-modal')) this.hideForgot();
  },

  _resetForgotStatus() {
    document.getElementById('forgot-success').style.display = 'none';
    document.getElementById('forgot-notfound').style.display = 'none';
  },

  searchForgot() {
    const email = document.getElementById('forgot-email')?.value?.trim();
    if (!email) return;
    const btn = document.getElementById('forgot-search-btn');
    btn.disabled = true;
    btn.textContent = 'Sorgulanıyor...';
    this._resetForgotStatus();

    // Always show "request received" for security (never reveal if email exists)
    setTimeout(() => {
      document.getElementById('forgot-success').style.display = 'flex';
      btn.disabled = false;
      btn.textContent = 'Sorgula';
    }, 800);
  },

  /* Form Submit */
  async handleSubmit(e) {
    e.preventDefault();
    const email    = document.getElementById('login-email')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    const errorEl  = document.getElementById('login-error');
    const btn      = document.getElementById('login-submit-btn');

    // Validate
    let valid = true;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      document.getElementById('email-error').textContent = 'Geçerli bir e-posta giriniz.';
      document.getElementById('email-error').style.display = 'block';
      document.getElementById('login-email').classList.add('error');
      valid = false;
    } else {
      document.getElementById('email-error').style.display = 'none';
      document.getElementById('login-email').classList.remove('error');
    }
    if (!password) {
      document.getElementById('password-error').textContent = 'Şifre zorunludur.';
      document.getElementById('password-error').style.display = 'block';
      document.getElementById('login-password').classList.add('error');
      valid = false;
    } else {
      document.getElementById('password-error').style.display = 'none';
      document.getElementById('login-password').classList.remove('error');
    }
    if (!valid) return;

    errorEl.style.display = 'none';
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<svg class="lp-spin" style="width:18px;height:18px;margin-right:6px" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity:.25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" style="opacity:.75"/></svg>Giriş yapılıyor...';
    btn.disabled = true;

    try {
      if (!_db) throw new Error('Sunucu bağlantısı kurulamadı.');
      const { data, error } = await _db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      State.session = data.session;
      Router.authLoaded = true; // mark auth as resolved
      
      // Hoşgeldiniz & Loader göster
      PageTransition.show('Hoşgeldiniz, verileriniz yükleniyor...');
      
      // Verileri taze çek
      await Store.load();
      TKG.setInputValue();
      Slip.syncSummary();
      
      Router.route(); // Yönlendirme yap
      setTimeout(() => PageTransition.hide(), 800); // Loader'ı kaldır
      
    } catch (err) {
      errorEl.textContent = err.message === 'Invalid login credentials'
        ? 'E-posta veya şifre hatalı. Lütfen tekrar deneyiniz.'
        : (err.message || 'Giriş başarısız.');
      errorEl.style.display = 'block';
    } finally {
      btn.innerHTML = origHTML;
      btn.disabled = false;
    }
  }
};

window.LoginPage = LoginPage;


/* ────────────────────────────────────────
   SETTINGS PAGE LOGIC
──────────────────────────────────────── */
const Settings = {
  switchTab(tabId) {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
    
    // Find clicked tab and pane
    const clickedTab = Array.from(document.querySelectorAll('.settings-tab')).find(t => t.getAttribute('onclick')?.includes(`'${tabId}'`));
    if (clickedTab) clickedTab.classList.add('active');
    
    const pane = document.getElementById(`settings-tab-${tabId}`);
    if (pane) pane.classList.add('active');
  },

  renderPrefixList() {
    const list = document.getElementById('prefix-list');
    if (!list) return;
    
    list.innerHTML = '';
    const prefs = State.prefs;
    
    prefs.prefixes.forEach(pfx => {
      const isDefault = prefs.defaultPrefix === pfx;
      const count = prefs.counters[pfx] || 1;
      
      const item = document.createElement('div');
      item.className = `prefix-item ${isDefault ? 'active' : ''}`;
      
      item.innerHTML = `
        <div class="prefix-item-left">
          <div class="prefix-tag">${pfx}</div>
          <span style="color:var(--text-muted); font-size:0.9rem;">Sıradaki: ${count}</span>
        </div>
        <div style="display:flex; gap:0.5rem;">
          ${!isDefault ? `<button class="btn btn-primary" style="padding: 0.3rem 0.6rem; font-size:0.85rem;" onclick="Settings.setDefaultPrefix('${pfx}')">Varsayılan Yap</button>` : `<span style="color:var(--primary); font-weight:600; font-size:0.9rem; padding:0.3rem 0.6rem;">Varsayılan</span>`}
          <button class="btn text-danger" style="padding: 0.3rem 0.6rem; font-size:0.85rem; border:1px solid #fecaca; background:white;" onclick="Settings.deletePrefix('${pfx}')">
            Sil
          </button>
        </div>
      `;
      list.appendChild(item);
    });
  },

  addPrefix() {
    const input = document.getElementById('new-prefix-input');
    const val = input.value.trim().toUpperCase();
    if (!val) return;
    
    if (State.prefs.prefixes.includes(val)) {
      Toast.show('Bu önek zaten mevcut.', 'warning');
      return;
    }
    
    State.prefs.prefixes.push(val);
    if (!State.prefs.counters[val]) State.prefs.counters[val] = 1;
    Store.savePrefs();
    input.value = '';
    this.renderPrefixList();
    Toast.show('Kargo öneki eklendi.', 'success');
  },

  deletePrefix(pfx) {
    if (State.prefs.prefixes.length <= 1) {
      Toast.show('En az bir önek bulunmalıdır.', 'error');
      return;
    }
    if (confirm(`'${pfx}' önekini silmek istediğinize emin misiniz?`)) {
      State.prefs.prefixes = State.prefs.prefixes.filter(p => p !== pfx);
      if (State.prefs.defaultPrefix === pfx) {
        State.prefs.defaultPrefix = State.prefs.prefixes[0];
      }
      Store.savePrefs();
      this.renderPrefixList();
      Toast.show('Kargo öneki silindi.', 'success');
    }
  },

  setDefaultPrefix(pfx) {
    State.prefs.defaultPrefix = pfx;
    Store.savePrefs();
    this.renderPrefixList();
    Toast.show(`${pfx} varsayılan kargo kodu yapıldı.`, 'success');
  },

  setTemplate(tpl) {
    State.prefs.activeTemplate = tpl;
    Store.savePrefs();
    document.querySelectorAll('.template-card').forEach(c => {
      c.classList.toggle('active', c.getAttribute('onclick')?.includes(`'${tpl}'`));
    });
    Toast.show('Şablon güncellendi.', 'success');
  },

  handleCustomTemplateUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.match('image.*')) {
      Toast.show('Sadece resim (PNG/JPG) yükleyebilirsiniz.', 'error');
      return;
    }

    // Convert file to base64 and store in State
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Img = e.target.result;
      State.prefs.customTemplate = base64Img;
      State.prefs.activeTemplate = 'custom'; // Automatically set active template to custom on upload!
      Store.savePrefs();
      Settings.renderCustomTemplate();
      Toast.show('Özel şablon başarıyla yüklendi ve aktif edildi.', 'success');
    };
    reader.readAsDataURL(file);
    event.target.value = ''; // reset input
  },

  clearCustomTemplate() {
    if (confirm('Özel şablonu kaldırmak istediğinize emin misiniz?')) {
      State.prefs.customTemplate = null;
      // If it was selected as custom, revert to default
      if (State.prefs.activeTemplate === 'custom') {
        State.prefs.activeTemplate = 'default';
      }
      Store.savePrefs();
      Settings.renderCustomTemplate();
      Toast.show('Şablon kaldırıldı.', 'success');
    }
  },

  renderCustomTemplate() {
    const imgElement = document.getElementById('custom-template-img');
    const emptyElement = document.getElementById('custom-template-empty');
    const clearBtn = document.getElementById('clear-template-btn');

    if (imgElement && emptyElement) {
      if (State.prefs.customTemplate) {
        imgElement.src = State.prefs.customTemplate;
        imgElement.style.display = 'block';
        emptyElement.style.display = 'none';
        if (clearBtn) clearBtn.style.display = 'inline-block';
      } else {
        imgElement.src = '';
        imgElement.style.display = 'none';
        emptyElement.style.display = 'flex';
        if (clearBtn) clearBtn.style.display = 'none';
      }
    }

    // Sync active classes across cards
    const activeTpl = State.prefs.activeTemplate || 'default';
    document.querySelectorAll('.template-card').forEach(c => {
      c.classList.toggle('active', c.getAttribute('onclick')?.includes(`'${activeTpl}'`));
    });
  },

  checkResetInput() {
    const input = document.getElementById('reset-confirm-input');
    const btn = document.getElementById('reset-btn');
    if (input.value === 'Tüm verileri sıfırla') {
      btn.disabled = false;
    } else {
      btn.disabled = true;
    }
  },

  async executeReset() {
    if (!_db || !State.session) return;
    
    const btn = document.getElementById('reset-btn');
    btn.innerHTML = 'Sıfırlanıyor...';
    btn.disabled = true;

    try {
      // Sadece verileri sil
      await _db.from('customers').delete().neq('id', '00000000-0000-0000-0000-000000000000'); 
      await _db.from('company').update({
        unvan: '', slogan: '', telefon: '', adres: '', il: '', ilce: '', logo: ''
      }).eq('id', 1);
      await _db.from('settings').delete().neq('key', 'xyz');
      
      // Clear local storage EXCEPT session
      const keys = Object.keys(localStorage);
      keys.forEach(k => {
        if (k.startsWith('cb_')) localStorage.removeItem(k);
      });
      
      window.location.reload();
    } catch (err) {
      console.error(err);
      Toast.show('Sıfırlama sırasında hata oluştu.', 'error');
      btn.innerHTML = 'Sistemi Sıfırla';
      btn.disabled = false;
    }
  }
};
window.Settings = Settings;

/* ────────────────────────────────────────
   PRINTER AGENT SETTINGS
──────────────────────────────────────── */
const PrinterSettings = {
  load() {
    if (!window.PrintEngine) return;
    const urlInput = document.getElementById('agent-url');
    const tokenInput = document.getElementById('agent-token');
    const langSelect = document.getElementById('agent-lang');
    
    if (urlInput) urlInput.value = window.PrintEngine.Settings.agentUrl;
    if (tokenInput) tokenInput.value = window.PrintEngine.Settings.agentToken;
    if (langSelect) langSelect.value = window.PrintEngine.Settings.labelLang;
  },
  save() {
    if (!window.PrintEngine) return;
    const urlInput = document.getElementById('agent-url');
    const tokenInput = document.getElementById('agent-token');
    const langSelect = document.getElementById('agent-lang');
    
    if (urlInput) window.PrintEngine.Settings.agentUrl = urlInput.value.trim();
    if (tokenInput) window.PrintEngine.Settings.agentToken = tokenInput.value.trim();
    if (langSelect) window.PrintEngine.Settings.labelLang = langSelect.value;
  },
  async testConnection() {
    this.save();
    const statusEl = document.getElementById('agent-status');
    if (!statusEl) return;
    
    statusEl.textContent = 'Bağlantı test ediliyor...';
    statusEl.style.color = 'var(--text-muted)';
    
    const ok = await window.PrintEngine.checkAgentHealth();
    if (ok) {
      statusEl.textContent = '✅ Yazıcı ajanına başarıyla bağlanıldı!';
      statusEl.style.color = 'var(--primary)';
      Toast.show('Yazıcı ajanı bağlantısı başarılı.', 'success');
    } else {
      statusEl.textContent = '❌ Yazıcı ajanı bulunamadı! Servisin çalışıp çalışmadığını kontrol edin.';
      statusEl.style.color = '#ef4444';
      Toast.show('Yazıcı ajanı bağlantısı başarısız.', 'error');
    }
  },
  async testPrint() {
    this.save();
    const statusEl = document.getElementById('agent-status');
    if (!statusEl) return;
    
    statusEl.textContent = 'Test etiketi gönderiliyor...';
    statusEl.style.color = 'var(--text-muted)';
    
    try {
      const lang = window.PrintEngine.Settings.labelLang;
      await window.PrintEngine.sendTest(lang);
      statusEl.textContent = `✅ Test etiketi (${lang.toUpperCase()}) başarıyla gönderildi.`;
      statusEl.style.color = 'var(--primary)';
      Toast.show('Test etiketi yazıcıya gönderildi.', 'success');
    } catch (err) {
      console.error(err);
      statusEl.textContent = `❌ Test yazdırma hatası: ${err.message}`;
      statusEl.style.color = '#ef4444';
      Toast.show('Test etiketi yazılamadı.', 'error');
    }
  },
  async previewLabel() {
    this.save();
    const previewEl = document.getElementById('label-preview');
    if (!previewEl) return;
    
    try {
      const sample = {
        tkgCode: typeof TKG !== 'undefined' && TKG.current ? TKG.current() : 'TKG-000001',
        alici: { unvan: 'Örnek Alıcı A.Ş.', ad: 'Ahmet Yılmaz', tel: '05321234567', adres: 'Örnek Mahallesi, Test Caddesi No:12', il: 'İstanbul', ilce: 'Kadıköy' },
        gonderici: {
          unvan: State.company?.unvan || 'Şirket Ünvanı',
          slogan: State.company?.slogan || '',
          tel: State.company?.telefon || '',
          adres: [State.company?.adres, State.company?.ilce, State.company?.il].filter(Boolean).join(', ')
        },
        desi: { en: 30, boy: 20, yukseklik: 15, kg: 4, desi: 3, ucret: 4 }
      };
      
      if (!window.PrintEngine || !window.PrintEngine.previewShippingLabel) {
        throw new Error('Yazdırma motoru önizleme işlevi yüklenemedi.');
      }
      
      const { svg, validation } = await window.PrintEngine.previewShippingLabel(sample, 1);
      previewEl.innerHTML = svg;
      previewEl.style.display = 'block';
      
      if (validation && validation.errors > 0) {
        Toast.show(`Doğrulama hatası: ${validation.issues.map(i=>i.message).join(', ')}`, 'error');
      } else {
        Toast.show('Önizleme başarıyla oluşturuldu.', 'success');
      }
    } catch (err) {
      console.error(err);
      Toast.show('Önizleme başarısız: ' + err.message, 'error');
    }
  }
};
window.PrinterSettings = PrinterSettings;

