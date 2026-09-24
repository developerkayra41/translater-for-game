import * as path from 'path';
import { app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain, screen } from 'electron';
import { createWorker, PSM } from 'tesseract.js';

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let editMode = false;
let show = false;

let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
async function getOcrWorker() {
  if (!ocrWorker) {
    ocrWorker = await createWorker('eng');
    await ocrWorker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
    });
  }
  return ocrWorker;
}

async function translate(text: string): Promise<string> {
  try {
    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(text)}`
    );
    const data = await res.json();
    let out = '';
    data?.[0]?.forEach((item: any) => { if (item[0]) out += item[0]; });
    return out || 'Çeviri yapılamadı.';
  } catch {
    return 'Çeviri servisine ulaşılamadı.';
  }
}

function updateMouseEvents() {
  if (!mainWindow) return;

  // Sadece görünür + edit modundayken panel mouse almalı.
  const interactive = editMode && show;

  mainWindow.setIgnoreMouseEvents(!interactive);
}
function setEditMode(on: boolean) {
  if (!mainWindow) return;

  editMode = on;

  mainWindow.setFocusable(on);
  updateMouseEvents();

  mainWindow.webContents.send('edit-mode', on);

  if (on && show) {
    mainWindow.focus();
  }
}

function setShowMode(on: boolean) {
  if (!mainWindow) return;

  show = on;

  mainWindow.webContents.send('show-mode', on);

  updateMouseEvents();

  if (on && editMode) {
    mainWindow.focus();
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
let capturing = false;
const panelBounds = { x: 40, y: 40, width: 420, height: 200 };
function createMainWindow() {
  mainWindow = new BrowserWindow({
    ...panelBounds,
    show: false,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,       // false ise setBounds ile boyut değişmeyebiliyor
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, '../src/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.showInactive(); // odağı çalmadan göster
    setEditMode(false);
    setShowMode(true)
  });
}

function openCaptureWindow(imageData: string) {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  if (captureWindow) {
    captureWindow.destroy();
  }

  captureWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  captureWindow.setAlwaysOnTop(true, 'screen-saver');

  captureWindow.loadFile(
    path.join(__dirname, '../src/capture.html')
  );

  captureWindow.webContents.on('did-finish-load', () => {
    captureWindow?.webContents.send(
      'init-capture',
      imageData
    );

    captureWindow?.focus();
  });
}

// Panel taşıma / boyutlandırma (düzenleme modunda)
ipcMain.on('move-by', (_e, dx: number, dy: number) => {
  if (!mainWindow || !editMode || !show) return;
  panelBounds.x += Math.round(dx);
  panelBounds.y += Math.round(dy);
  mainWindow.setBounds(panelBounds);
});

ipcMain.on('resize-by', (_e, dw: number, dh: number) => {
  if (!mainWindow || !editMode || !show) return;
  panelBounds.width = Math.max(200, panelBounds.width + Math.round(dw));
  panelBounds.height = Math.max(100, panelBounds.height + Math.round(dh));
  mainWindow.setBounds(panelBounds);
});

ipcMain.on('crop-completed', async (_event, croppedImageData: string) => {
  capturing = false;
  if (captureWindow) {
    captureWindow.destroy();
    captureWindow = null;
  }

  if (!mainWindow) return;

  // Kullanıcı iptal ettiyse paneli tekrar göster
  if (!croppedImageData) {
    setShowMode(true);
    return;
  }

  mainWindow.webContents.send(
    'translation-status',
    'Metin okunuyor...'
  );

  try {
    const worker = await getOcrWorker();

    const buf = Buffer.from(
      croppedImageData.split(',')[1],
      'base64'
    );

    const { data } = await worker.recognize(buf);

    const text = data.text
      .replace(/\s*\n\s*/g, ' ')
      .trim();

    if (!text) {
      mainWindow.webContents.send(
        'translation-status',
        'Metin bulunamadı.'
      );

      setShowMode(true);
      return;
    }

    mainWindow.webContents.send(
      'translation-status',
      'Çevriliyor...'
    );

    const translated = await translate(text);

    mainWindow.webContents.send(
      'translation-result',
      translated
    );

    // Çeviri bittikten sonra paneli tekrar göster
    setShowMode(true);

  } catch (err) {
    console.error(err);

    mainWindow.webContents.send(
      'translation-status',
      'Hata oluştu.'
    );

    setShowMode(true);
  }
});

app.whenReady().then(() => {
  createMainWindow();
  getOcrWorker().catch(console.error);

  // Alan seç ve çevir
  globalShortcut.register('Alt+T', async () => {
    if (!mainWindow || capturing) return;
    capturing = true;

    const wasVisible = show;
    if (wasVisible) {
      setShowMode(false);
      await wait(150);
    }

    try {
      const d = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(d.size.width * d.scaleFactor),
          height: Math.round(d.size.height * d.scaleFactor),
        },
        fetchWindowIcons: false,
      });

      const source = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
      if (source) {
        openCaptureWindow(source.thumbnail.toDataURL());
      } else {
        capturing = false;
        if (wasVisible) setShowMode(true);
      }
    } catch (err) {
      console.error('Ekran görüntüsü alınamadı:', err);
      capturing = false;
      if (wasVisible) setShowMode(true);
    }
  });

  globalShortcut.register('Alt+Q', () => app.quit()); // çıkış

  // Düzenleme modunu aç/kapat
  globalShortcut.register('Alt+E', () => setEditMode(!editMode));

  // göster-gizle
  globalShortcut.register('Alt+Y', () => setShowMode(!show))
});

app.on('will-quit', () => globalShortcut.unregisterAll());