const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const net = require('net');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', sendProc);

  // F12 ile konsolu / devtools açıp kapama
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

// --- GOOGLE İLE GİRİŞ (loopback) ---
// Sistem tarayıcısında siteye gidilir; site Google girişini yapıp kimlik bilgisini
// yalnızca bu bilgisayardaki geçici (tek kullanımlık) yerel adrese iletir.
const SITE_LOGIN_URL = process.env.COMPANION_LOGIN_URL
  || (isDev ? 'http://localhost:5173/companion-login' : 'https://rocket.loopesports.com/companion-login');
let googleLoginServer = null;

function stopGoogleLoginServer() {
  if (googleLoginServer) {
    try { googleLoginServer.close(); } catch (e) { /* yoksay */ }
    googleLoginServer = null;
  }
}

function sendGoogleResult(res) {
  if (mainWindow) {
    mainWindow.webContents.send('google-login-result', res);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

const CALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Rocket Clash Companion</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style></head>
<body><div id="m">Giriş tamamlanıyor...</div><script>
(function(){
  var h = new URLSearchParams(location.hash.slice(1));
  var body = JSON.stringify({ state: h.get('state'), idToken: h.get('idToken'), accessToken: h.get('accessToken') });
  history.replaceState(null, '', '/callback');
  fetch('/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
    .then(function(r){ document.getElementById('m').textContent = r.ok ? 'Giriş tamamlandı. Bu sekmeyi kapatıp Companion uygulamasına dönebilirsin.' : 'Giriş başarısız. Uygulamadan tekrar dene.'; })
    .catch(function(){ document.getElementById('m').textContent = 'Giriş başarısız. Uygulamadan tekrar dene.'; });
})();
</script></body></html>`;

ipcMain.handle('start-google-login', async () => {
  stopGoogleLoginServer();
  const state = crypto.randomBytes(24).toString('hex');
  let finished = false;
  const finish = (res) => {
    if (finished) return;
    finished = true;
    stopGoogleLoginServer();
    sendGoogleResult(res);
  };

  const server = http.createServer((req, resp) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/callback') {
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      resp.end(CALLBACK_HTML);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.state !== state || (!data.idToken && !data.accessToken)) {
            resp.writeHead(400); resp.end();
            return;
          }
          resp.writeHead(200); resp.end('ok');
          finish({ ok: true, idToken: data.idToken || null, accessToken: data.accessToken || null });
        } catch (e) {
          resp.writeHead(400); resp.end();
        }
      });
      return;
    }
    resp.writeHead(404); resp.end();
  });
  googleLoginServer = server;

  try {
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    // 3 dakika içinde dönülmezse vazgeç
    setTimeout(() => finish({ ok: false, error: 'Google girişi zaman aşımına uğradı. Tekrar dene.' }), 180000);
    await shell.openExternal(`${SITE_LOGIN_URL}?port=${port}&state=${state}`);
    return { ok: true };
  } catch (err) {
    stopGoogleLoginServer();
    return { ok: false, error: 'Tarayıcı açılamadı: ' + (err.message || err) };
  }
});

const fs = require('fs');

let statsIniChanged = false; // bu açılışta ayar dosyası oluşturuldu/değiştirildi mi (oyun yeniden açılmalı mı?)

async function enableOfficialStatsAPI() {
  try {
    const documentsPath = app.getPath('documents');
    if (!documentsPath) return;

    const rlConfigDir = path.join(documentsPath, 'My Games', 'Rocket League', 'TAGame', 'Config');
    if (!fs.existsSync(rlConfigDir)) {
      // Rocket League yüklü değil veya hiç açılmamış olabilir
      return;
    }

    const statsApiIni = path.join(rlConfigDir, 'TAStatsAPI.ini');

    // 1. Dosya hiç yoksa tam şablonu oluştur
    if (!fs.existsSync(statsApiIni)) {
      const initialContent = `[TAGame.MatchStatsExporter_TA]
Port=49123
WebPort=49124
PacketSendRate=10
`;
      fs.writeFileSync(statsApiIni, initialContent, 'utf8');
      statsIniChanged = true;
      console.log('Official Stats API created with default configuration.');
      return;
    }

    // 2. Dosya zaten varsa: Orijinal yapıyı (WebPort, IniVersion vs.) KESİNLİKLE bozmadan güncelle
    let content = fs.readFileSync(statsApiIni, 'utf8');
    let modified = false;

    // PacketSendRate=0 ise veya tanımsızsa 10 yap (aktif et)
    if (/PacketSendRate\s*=\s*0/i.test(content)) {
      content = content.replace(/PacketSendRate\s*=\s*0/i, 'PacketSendRate=10');
      modified = true;
    } else if (!/PacketSendRate\s*=/i.test(content)) {
      content = content.replace(/(\[TAGame\.MatchStatsExporter_TA\][\r\n]+)/i, '$1PacketSendRate=10\r\n');
      modified = true;
    }

    // WebPort eksikse ekle
    if (!/WebPort\s*=/i.test(content)) {
      content = content.replace(/(\[TAGame\.MatchStatsExporter_TA\][\r\n]+)/i, '$1WebPort=49124\r\n');
      modified = true;
    }

    // Port eksikse ekle
    if (!/Port\s*=/i.test(content)) {
      content = content.replace(/(\[TAGame\.MatchStatsExporter_TA\][\r\n]+)/i, '$1Port=49123\r\n');
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(statsApiIni, content, 'utf8');
      statsIniChanged = true;
      console.log('Official Stats API updated safely without breaking original structure.');
    }
  } catch (err) {
    console.error('Failed to enable Stats API automatically:', err);
  }
}

app.whenReady().then(async () => {
  await enableOfficialStatsAPI();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});


// --- ROCKET LEAGUE SÜRECİ (oyun açık mı?) ---
// Yalnızca bilgi amaçlı: arayüzde "oyun kapalı / açık, maç bekleniyor" ayrımı için. Veri akışını etkilemez.
const { execFile } = require('child_process');
let lastProc = { running: false, needsRestart: false };
let rlConnected = false;
let sawGameClosed = false;

function sendProc() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rl-process', lastProc);
}

function pollRocketLeagueProcess() {
  if (process.platform !== 'win32') return;
  execFile('tasklist', ['/FI', 'IMAGENAME eq RocketLeague.exe', '/NH', '/FO', 'CSV'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
    if (err) return; // okuyamadıysak durumu değiştirme
    const running = /RocketLeague\.exe/i.test(String(stdout));
    if (!running) sawGameClosed = true;
    // Ayar dosyasını biz bu açılışta değiştirdiysek ve oyun ondan ÖNCE açıksa, oyun ayarı okumamıştır → yeniden açılmalı.
    // Oyun kapanırsa (ya da veri akmaya başlarsa) bu uyarı kalkar.
    const needsRestart = running && statsIniChanged && !sawGameClosed && !rlConnected;
    if (!running) statsIniChanged = false;
    if (running !== lastProc.running || needsRestart !== lastProc.needsRestart) {
      lastProc = { running, needsRestart };
    }
    sendProc();
  });
}

// --- ROCKET LEAGUE STATS API (TCP LISTENER) ---
let rlSocket = null;

function connectToRocketLeague() {
  if (rlSocket) return;

  rlSocket = new net.Socket();

  rlSocket.connect(49123, '127.0.0.1', () => {
    console.log('Connected to Rocket League Stats API');
    rlConnected = true;
    if (mainWindow) mainWindow.webContents.send('rl-status', 'connected');
  });

  let buffer = '';

  rlSocket.on('data', (data) => {
    buffer += data.toString();

    // Rocket League genelde verileri "\n" veya "\0" (null byte) ile ayırır.
    // Ancak garantili olması için regex ile birbirine yapışık JSON'ları ayıralım.
    // Performans için karakter karakter dönmek yerine, RegExp kullanarak ayıklayabiliriz.
    // Veya sadece baştan aramak: 

    let boundaryIndex = 0;
    while (true) {
      let openBraces = 0;
      let inString = false;
      let escape = false;
      let foundCompleteJson = false;
      let i = boundaryIndex;

      // Tam bir JSON objesini bulmaya çalış
      for (; i < buffer.length; i++) {
        let char = buffer[i];
        if (escape) { escape = false; continue; }
        if (char === '\\') { escape = true; continue; }
        if (char === '"') { inString = !inString; continue; }

        if (!inString) {
          if (char === '{') openBraces++;
          else if (char === '}') {
            openBraces--;
            if (openBraces === 0) {
              // Tamamlanmış JSON bulduk!
              foundCompleteJson = true;
              break;
            }
          }
        }
      }

      if (foundCompleteJson) {
        let jsonString = buffer.substring(boundaryIndex, i + 1);
        try {
          const payload = JSON.parse(jsonString);
          handleRlEvent(payload);
        } catch (err) {
          // Parse hatası olsa bile geç
        }
        boundaryIndex = i + 1;
      } else {
        // Tamamlanmış JSON yoksa döngüden çık, sonraki chunk'ı bekle
        break;
      }
    }

    // İşlenmiş kısımları buffer'dan at (O(N) performans sorunu yaratmamak için)
    if (boundaryIndex > 0) {
      buffer = buffer.substring(boundaryIndex);
    }

    // Güvenlik: Buffer çok şişerse çöpe at (memory leak ve donmayı engeller)
    if (buffer.length > 5000000) {
      buffer = '';
    }
  });

  rlSocket.on('close', () => {
    console.log('Disconnected from Rocket League');
    rlConnected = false;
    if (mainWindow) mainWindow.webContents.send('rl-status', 'disconnected');
    rlSocket = null;
    // Try reconnecting every 5 seconds
    setTimeout(connectToRocketLeague, 5000);
  });

  rlSocket.on('error', (err) => {
    // Expected if RL is not running
    // console.log('RL socket error', err.message);
  });
}

function handleRlEvent(payload) {
  // Pass the event directly to the frontend for processing/display
  if (mainWindow) {
    mainWindow.webContents.send('rl-event', payload);
  }
}

// Start attempting to connect
connectToRocketLeague();

pollRocketLeagueProcess();
setInterval(pollRocketLeagueProcess, 10000);
