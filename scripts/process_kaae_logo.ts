import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const sourceImgPath = '/Users/hawzhin/.gemini/antigravity-ide/brain/f738476c-113b-44dd-963c-7ffa81ef121f/.user_uploaded/media_1788725563686.png';
const base64Data = fs.readFileSync(sourceImgPath).toString('base64');

// HTML that loads the image into canvas, extracts transparent logo, and renders it cleanly
const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    canvas { display: block; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <script>
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('c');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      
      // Flood/Color threshold to make white/near-white transparent
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        // If near white/cream background (r > 240 && g > 235 && b > 230)
        // Check difference from pure white
        const dist = Math.sqrt((255 - r)**2 + (255 - g)**2 + (255 - b)**2);
        if (dist < 30) {
          data[i + 3] = 0; // Fully transparent
        } else if (dist < 60) {
          // Smooth alpha edge transition
          const alphaFactor = (dist - 30) / 30;
          data[i + 3] = Math.round(data[i + 3] * alphaFactor);
        }
      }
      ctx.putImageData(imgData, 0, 0);
      document.title = 'READY';
    };
    img.src = 'data:image/png;base64,${base64Data}';
  </script>
</body>
</html>`;

const tmpHtml = '/tmp/process_kaae_logo.html';
fs.writeFileSync(tmpHtml, html, 'utf-8');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outPng = '/Users/hawzhin/Hawdesign/apps/desk/public/assets/logos/kaae-official-logo.png';
const outDir = path.dirname(outPng);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// Render with headless chrome
execSync(`"${chromePath}" --headless=new --screenshot="${outPng}" --window-size=1024,835 --default-background-color=00000000 --hide-scrollbars "file://${tmpHtml}"`);

console.log('Saved transparent official logo to:', outPng);

// Copy to canonical locations
const dests = [
  '/Users/hawzhin/Hawdesign/exports/KAAE_2026_PRODUCTION/02_Official_Verified_Logos/kaae-official-logo.png',
  '/Users/hawzhin/.gemini/antigravity-ide/brain/f738476c-113b-44dd-963c-7ffa81ef121f/kaae_official_logo.png'
];

for (const dest of dests) {
  const dDir = path.dirname(dest);
  if (!fs.existsSync(dDir)) fs.mkdirSync(dDir, { recursive: true });
  fs.copyFileSync(outPng, dest);
  console.log('Copied to:', dest);
}
