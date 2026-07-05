const express = require('express');
const cors = require('cors');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const dns = require('dns');

// Prefer IPv4 for DNS resolution to prevent timeout issues in sandboxed/restricted environments
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from public directory if we're running locally
app.use(express.static(path.join(__dirname, '../public')));

const isWindows = process.platform === 'win32';
// Vercel filesystem is read-only except for os.tmpdir()
const binDir = process.env.VERCEL ? os.tmpdir() : path.join(__dirname, '../bin');
const ytdlpPath = path.join(binDir, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
const ffmpegExePath = require('ffmpeg-static');
const ffmpegDir = path.dirname(ffmpegExePath);

// Helper to follow redirects and download a file
function downloadFile(fileUrl, outputPath) {
  return new Promise((resolve, reject) => {
    https.get(fileUrl, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
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
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

// Ensure yt-dlp binary is present
async function ensureYtdlp() {
  if (fs.existsSync(ytdlpPath)) {
    return ytdlpPath;
  }
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  console.log(`yt-dlp not found. Downloading latest build from GitHub for ${process.platform}...`);
  const url = isWindows
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  
  await downloadFile(url, ytdlpPath);
  
  // Grant execute permissions on Unix-like environments (e.g. Vercel Linux)
  if (!isWindows) {
    fs.chmodSync(ytdlpPath, 0o755);
  }
  
  console.log('yt-dlp downloaded successfully.');
  return ytdlpPath;
}

// Helper: Format bytes to human-readable size
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return 'Unknown size';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Byte';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// API: Ping endpoint to check status
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', platform: process.platform });
});

// API: Fetch Video Info using yt-dlp
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  try {
    const activeYtdlpPath = await ensureYtdlp();

    // Run yt-dlp to dump metadata in JSON format
    const args = [
      '--js-runtimes', 'node',
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate'
    ];
    const cookiesPath = path.join(__dirname, '../cookies.txt');
    console.log('API Info: Cookies file found:', fs.existsSync(cookiesPath));
    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }
    if (process.env.PROXY_URL) {
      args.push('--proxy', process.env.PROXY_URL);
    }
    args.push(videoUrl);

    const child = cp.spawn(activeYtdlpPath, args, { windowsHide: true });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        console.error('yt-dlp info failed with code:', code, 'stderr:', stderrData);
        
        // Cloud Fallback: Try YouTube OEmbed to get basic metadata if yt-dlp is blocked
        try {
          const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
          const oembedRes = await new Promise((resolve, reject) => {
            https.get(oembedUrl, (response) => {
              let body = '';
              response.on('data', chunk => body += chunk);
              response.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch (e) {
                  reject(e);
                }
              });
            }).on('error', reject);
          });

          const match = videoUrl.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          const videoId = match ? match[1] : '';

          return res.json({
            isFallback: true,
            title: oembedRes.title || 'YouTube Video',
            author: oembedRes.author_name || 'Unknown Channel',
            thumbnail: oembedRes.thumbnail_url || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : ''),
            formats: []
          });
        } catch (oembedError) {
          console.error('OEmbed fallback failed:', oembedError.message);
        }

        const cookiesExist = fs.existsSync(path.join(__dirname, '../cookies.txt'));
        return res.status(400).json({ 
          error: `Failed to extract video details: ${stderrData.trim() || 'Process exited with code ' + code}`,
          cookiesExist: cookiesExist 
        });
      }

      try {
        const info = JSON.parse(stdoutData);
        const duration = parseInt(info.duration || 0);

        // Filter and process formats
        const formatsList = info.formats || [];

        // 1. Audio-only formats (has audio, no video)
        const audioOnly = formatsList
          .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
          .map(f => {
            const size = f.filesize || f.filesize_approx || null;
            return {
              itag: f.format_id,
              container: f.ext || 'm4a',
              audioBitrate: Math.round(f.abr || f.tbr || 128),
              size: size,
              sizeLabel: size ? formatBytes(size) : 'Unknown size'
            };
          })
          .sort((a, b) => b.audioBitrate - a.audioBitrate);

        const bestAudio = audioOnly[0];

        // 2. Video-only formats (has video, no audio)
        const videoOnly = formatsList
          .filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'))
          .map(f => {
            const size = f.filesize || f.filesize_approx || null;
            return {
              itag: f.format_id,
              qualityLabel: f.format_note || `${f.height}p`,
              container: f.ext || 'mp4',
              fps: f.fps || 30,
              size: size,
              sizeLabel: size ? formatBytes(size) : 'Unknown size',
              resolution: f.height || 0
            };
          })
          .sort((a, b) => b.resolution - a.resolution);

        // 3. Combined Video + Audio
        // - Native combined formats (usually max 720p)
        const nativeCombined = formatsList
          .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
          .map(f => {
            const size = f.filesize || f.filesize_approx || null;
            return {
              itag: f.format_id,
              qualityLabel: f.format_note || `${f.height}p`,
              container: f.ext || 'mp4',
              fps: f.fps || 30,
              size: size,
              sizeLabel: size ? formatBytes(size) : 'Unknown size',
              needsMerging: false,
              resolution: f.height || 0
            };
          });

        // - Merged options created from video-only formats (for resolutions 1080p, 1440p, 4K)
        const mergedFromVideoOnly = videoOnly.map(f => {
          // Estimate total size = video size + best audio size (approx 128kbps = ~1MB/min)
          const audioSizeEstimate = bestAudio && bestAudio.size ? bestAudio.size : (128 * 1024 * duration) / 8;
          const totalSize = f.size ? f.size + audioSizeEstimate : null;
          
          return {
            itag: f.itag, // this format ID will tell the downloader to merge this video stream with best audio
            qualityLabel: f.qualityLabel,
            container: 'mp4', // we force output container to mp4 when merging
            fps: f.fps,
            size: totalSize,
            sizeLabel: totalSize ? formatBytes(totalSize) : 'Estimating...',
            needsMerging: true,
            resolution: f.resolution
          };
        });

        // Combine native combined formats with merged high-res options
        // Sort by resolution descending, then by fps descending
        const videoWithAudio = [...mergedFromVideoOnly, ...nativeCombined]
          .sort((a, b) => {
            if (b.resolution !== a.resolution) {
              return b.resolution - a.resolution;
            }
            return b.fps - a.fps;
          });

        // Deduplicate videoWithAudio by resolution + fps to clean up the output
        const uniqueVideoWithAudio = [];
        const seenKeys = new Set();
        for (const f of videoWithAudio) {
          const key = `${f.resolution}p${f.fps}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueVideoWithAudio.push(f);
          }
        }

        res.json({
          title: info.title || 'YouTube Video',
          description: info.description ? info.description.substring(0, 200) + '...' : '',
          duration: duration,
          durationLabel: new Date(duration * 1000).toISOString().substr(11, 8).replace(/^00:/, ''),
          author: info.uploader || 'Unknown Channel',
          authorUrl: info.channel_url || '#',
          thumbnail: info.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800',
          views: parseInt(info.view_count || 0).toLocaleString(),
          formats: {
            videoWithAudio: uniqueVideoWithAudio,
            audioOnly: audioOnly,
            videoOnly: videoOnly
          }
        });

      } catch (err) {
        console.error('Failed to parse yt-dlp JSON output:', err);
        res.status(500).json({ error: 'Failed to process video metadata from YouTube' });
      }
    });

  } catch (error) {
    console.error('Error in /api/info:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API: Download endpoint - STREAMS directly to browser (no temp files, instant start!)
app.get('/api/download', async (req, res) => {
  const { url, itag, type, needsMerging, title } = req.query;
  const cookiesPath = path.join(__dirname, '../cookies.txt');

  if (!url || !itag) {
    return res.status(400).send('YouTube URL and format itag are required');
  }

  // Cloud/Fallback mode: route through public Cobalt API instances
  if (needsMerging === 'cobalt') {
    try {
      const isAudioOnly = (type === 'audio');
      console.log(`Cloud Fallback requested. Querying Cobalt API for url: ${url}, audio: ${isAudioOnly}`);
      const cobaltUrl = await getCobaltDownloadUrl(url, isAudioOnly);
      if (cobaltUrl) {
        console.log(`Cloud Fallback Success! Redirecting to: ${cobaltUrl}`);
        return res.redirect(cobaltUrl);
      } else {
        return res.status(500).send('Failed to generate download link via cloud fallback. Please run the local engine.');
      }
    } catch (err) {
      console.error('Cobalt fallback error:', err);
      return res.status(500).send('Internal Server Error during cloud fallback');
    }
  }

  try {
    const activeYtdlpPath = await ensureYtdlp();

    // Use client-provided title or fallback to avoid a slow blocking yt-dlp execution
    const rawTitle = title || 'video';
    const safeTitle = rawTitle.replace(/[^\w\s-]/gi, '').trim() || 'video';

    // Determine output file container/name
    let ext = 'mp4';
    let contentType = 'video/mp4';
    let formatSpec = itag;

    if (type === 'audio') {
      ext = 'mp3';
      contentType = 'audio/mpeg';
      formatSpec = `${itag}/bestaudio`;
    } else if (needsMerging === 'true' || type === 'merged') {
      ext = 'mp4';
      contentType = 'video/mp4';
      formatSpec = `${itag}+bestaudio/best`;
    }

    // Set streaming headers for inline attachment download
    res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.${ext}"`);
    res.header('Content-Type', contentType);

    // Prepare yt-dlp arguments to stream straight to stdout (-o -)
    const args = [
      '--js-runtimes', 'node',
      '-f', formatSpec,
      '--ffmpeg-location', ffmpegDir,
      '-o', '-',
      '-N', '8',
      '--no-check-certificate'
    ];
    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }
    if (process.env.PROXY_URL) {
      args.push('--proxy', process.env.PROXY_URL);
    }

    if (type === 'audio') {
      args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (needsMerging === 'true' || type === 'merged') {
      args.push(
        '--merge-output-format', 'mp4',
        '--postprocessor-args', 'Merger:-f mp4 -movflags frag_keyframe+empty_moov'
      );
    }

    args.push(url);

    console.log(`Starting real-time stream piping: yt-dlp ${args.join(' ')}`);

    const downloadProcess = cp.spawn(activeYtdlpPath, args, { windowsHide: true });

    // Pipe the standard output stream of yt-dlp directly into the HTTP response stream!
    downloadProcess.stdout.pipe(res);

    // Capture error output to help log errors
    let errorLog = '';
    downloadProcess.stderr.on('data', (data) => {
      const errStr = data.toString();
      if (errStr.toLowerCase().includes('error')) {
        errorLog += errStr;
        console.error('yt-dlp stderr error:', errStr);
      }
    });

    downloadProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`yt-dlp stream process exited with code ${code}. Stderr: ${errorLog}`);
        if (!res.headersSent) {
          res.status(500).send('Streaming download failed');
        }
      }
      res.end();
    });

    res.on('close', () => {
      // If user cancels the download in the browser, terminate the process immediately to release resources
      if (downloadProcess) {
        downloadProcess.kill();
      }
    });

  } catch (error) {
    console.error('Download route handler failed:', error);
    if (!res.headersSent) {
      res.status(500).send('Server Error: ' + error.message);
    }
  }
});

// Helper to retrieve download URL from public Cobalt instances
async function getCobaltDownloadUrl(videoUrl, isAudioOnly) {
  const instances = [
    'https://api.cobalt.liubquanti.click/',
    'https://cobalt.k6.cz/',
    'https://api.cobalt.tools/'
  ];

  for (const instance of instances) {
    try {
      const parsed = new URL(instance);
      const payload = JSON.stringify({
        url: videoUrl,
        downloadMode: isAudioOnly ? 'audio' : 'auto',
        videoQuality: '1080',
        audioFormat: 'mp3',
        audioBitrate: '128'
      });

      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname || '/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (response.statusCode === 200 || response.statusCode === 201) {
        const data = JSON.parse(response.body);
        if (data.url) return data.url;
      }
    } catch (e) {
      console.error(`Cobalt instance ${instance} failed:`, e.message);
    }
  }
  return null;
}

// For local running
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on http://localhost:${PORT}`);
  });
}

module.exports = app;
