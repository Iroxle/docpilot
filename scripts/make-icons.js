'use strict';
// Creates the app icons (icon.ico, icon.png) from assets/emblem.svg. Usage: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function bmpEntry(rgba, s) {
  // DIB entry: BITMAPINFOHEADER + BGRA from bottom to top + 1-bit mask
  const maskRow = Math.ceil(s / 32) * 4;
  const buf = Buffer.alloc(40 + s * s * 4 + maskRow * s);
  buf.writeUInt32LE(40, 0); buf.writeInt32LE(s, 4); buf.writeInt32LE(s * 2, 8);
  buf.writeUInt16LE(1, 12); buf.writeUInt16LE(32, 14);
  let o = 40;
  for (let y = s - 1; y >= 0; y--) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      buf[o++] = rgba[i + 2]; buf[o++] = rgba[i + 1]; buf[o++] = rgba[i]; buf[o++] = rgba[i + 3];
    }
  }
  return buf;
}
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((m) => m.data)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(assets, { recursive: true });
  const emblem = fs.readFileSync(path.join(assets, 'emblem.svg'), 'utf8');

  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<canvas></canvas>');
  const url = `data:image/svg+xml;base64,${Buffer.from(emblem).toString('base64')}`;
  const result = await w.webContents.executeJavaScript(`(async()=>{
    const img=new Image(); img.src=${JSON.stringify(url)}; await img.decode();
    const out={};
    for(const s of ${JSON.stringify([...SIZES, 512])}){
      const c=document.createElement('canvas'); c.width=c.height=s; const x=c.getContext('2d');
      x.imageSmoothingQuality='high'; x.drawImage(img,0,0,s,s);
      out[s]={png:c.toDataURL('image/png').split(',')[1], rgba:Array.from(x.getImageData(0,0,s,s).data)};
    }
    return out;})()`);
  const images = SIZES.map((size) => {
    const png = Buffer.from(result[size].png, 'base64');
    return { size, data: size >= 256 ? png : bmpEntry(result[size].rgba, size) };
  });
  fs.writeFileSync(path.join(assets, 'icon.ico'), ico(images));
  fs.writeFileSync(path.join(assets, 'icon.png'), Buffer.from(result[512].png, 'base64'));
  console.log('Icons created');
  app.quit();
});
