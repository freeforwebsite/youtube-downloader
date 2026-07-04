const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const binDir = path.join(__dirname, 'bin');
const ytdlpPath = path.join(binDir, 'yt-dlp.exe');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

console.log('Downloading yt-dlp.exe...');
const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

function downloadFile(fileUrl, outputPath) {
  return new Promise((resolve, reject) => {
    https.get(fileUrl, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        downloadFile(response.headers.location, outputPath).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log('Download complete.');
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

downloadFile(url, ytdlpPath)
  .then(() => {
    console.log('yt-dlp downloaded. Testing version...');
    const child = spawn(ytdlpPath, ['--version']);
    child.stdout.on('data', (data) => {
      console.log('yt-dlp version:', data.toString().trim());
    });
    child.stderr.on('data', (data) => {
      console.error('stderr:', data.toString());
    });
    child.on('close', (code) => {
      console.log('test finished with exit code:', code);
    });
  })
  .catch((err) => {
    console.error('Download failed:', err);
  });
