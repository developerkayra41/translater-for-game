import { app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain, screen, Menu } from 'electron';
import * as path from 'path';
import { createWorker } from 'tesseract.js';

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let editMode = false;
let show = false;

let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await createWorker('eng');
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

  const interactive = editMode && show;

  mainWindow.setIgnoreMouseEvents(!interactive);
}

function setEditMode(on: boolean) {
  if (!mainWindow) return;
  editMode = on;
  mainWindow.setFocusable(on);
  // mainWindow.setIgnoreMouseEvents(!on); // false: tıklanabilir, true: tıklama geçirgen
  mainWindow.webContents.send('edit-mode', on);
  updateMouseEvents();
  if (on) mainWindow.focus();
}

function setShowMode(on: boolean) {
  if (!mainWindow) return;
  show = on;
  // mainWindow.setIgnoreMouseEvents(!on); // false: tıklanabilir, true: tıklama geçirgen
  mainWindow.webContents.send('show-mode', on);
  updateMouseEvents();
  if (on) mainWindow.focus();

}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 200,
    x: 40,
    y: 40,
    show: false,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: false,
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
  const { width, height } = screen.getPrimaryDisplay().bounds;

  if (captureWindow) captureWindow.destroy();

  captureWindow = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  captureWindow.setAlwaysOnTop(true, 'screen-saver');
  captureWindow.loadFile(path.join(__dirname, '../src/capture.html'));
  captureWindow.webContents.on('did-finish-load', () => {
    captureWindow?.webContents.send('init-capture', imageData);
  });
}

// Panel taşıma / boyutlandırma (düzenleme modunda)
ipcMain.on('move-by', (_e, dx: number, dy: number) => {
  if (!mainWindow || !editMode) return;
  const b = mainWindow.getBounds();
  mainWindow.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
});

ipcMain.on('resize-by', (_e, dw: number, dh: number) => {
  if (!mainWindow || !editMode) return;
  const b = mainWindow.getBounds();
  mainWindow.setBounds({
    ...b,
    width: Math.max(200, b.width + dw),
    height: Math.max(100, b.height + dh),
  });
});

ipcMain.on('crop-completed', async (_event, croppedImageData: string) => {
  if (captureWindow) {
    captureWindow.destroy();
    captureWindow = null;
  }
  if (!croppedImageData || !mainWindow) return;

  mainWindow.webContents.send('translation-status', 'Metin okunuyor...');
  try {
    const worker = await getOcrWorker();
    const buf = Buffer.from(croppedImageData.split(',')[1], 'base64');
    const { data } = await worker.recognize(buf);
    const text = data.text.replace(/\s*\n\s*/g, ' ').trim();

    if (!text) {
      mainWindow.webContents.send('translation-status', 'Metin bulunamadı.');
      return;
    }
    mainWindow.webContents.send('translation-status', 'Çevriliyor...');
    const translated = await translate(text);
    mainWindow.webContents.send('translation-result', translated);
  } catch (err) {
    console.error(err);
    mainWindow.webContents.send('translation-status', 'Hata oluştu.');
  }
});

app.whenReady().then(() => {
  createMainWindow();
   const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Göster / Gizle',
            click: () => {
                setShowMode(!show);
            }
        },
        {
            label: 'Düzenleme Modu',
            click: () => {
                setEditMode(!editMode);
            }
        },
        {
            type: 'separator'
        },
        {
            label: 'Çıkış',
            click: () => {
                app.quit();
            }
        }
    ]);

  // Alan seç ve çevir
  globalShortcut.register('Alt+T', async () => {
    const d = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: d.size.width * d.scaleFactor,
        height: d.size.height * d.scaleFactor,
      },
    });
    if (sources.length > 0) openCaptureWindow(sources[0].thumbnail.toDataURL());
  });

  // Düzenleme modunu aç/kapat
  globalShortcut.register('Alt+E', () => setEditMode(!editMode));

  // göster-gizle
  globalShortcut.register('Alt+Y', () => setShowMode(!show))
});

app.on('will-quit', () => globalShortcut.unregisterAll());