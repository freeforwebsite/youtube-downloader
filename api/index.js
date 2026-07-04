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

const binDir = path.join(__dirname, '../bin');
const ytdlpPath = path.join(binDir, 'yt-dlp.exe');
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
  console.log('yt-dlp.exe not found. Downloading latest build from GitHub...');
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  await downloadFile(url, ytdlpPath);
  console.log('yt-dlp.exe downloaded successfully.');
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

// API: Fetch Video Info using yt-dlp
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  try {
    const activeYtdlpPath = await ensureYtdlp();

    // Run yt-dlp to dump metadata in JSON format
    const child = cp.spawn(activeYtdlpPath, [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      videoUrl
    ], { windowsHide: true });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('yt-dlp info failed with code:', code, 'stderr:', stderrData);
        return res.status(400).json({ error: 'Failed to extract video details. Verify the URL is correct.' });
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

// API: Download endpoint using yt-dlp and local ffmpeg muxer
app.get('/api/download', async (req, res) => {
  const { url, itag, type, needsMerging } = req.query;

  if (!url || !itag) {
    return res.status(400).send('YouTube URL and format itag are required');
  }

  try {
    const activeYtdlpPath = await ensureYtdlp();

    // 1. Get safe title for filename
    const infoChild = cp.spawnSync(activeYtdlpPath, ['--dump-json', '--no-playlist', url], { windowsHide: true });
    let safeTitle = 'video';
    if (infoChild.status === 0) {
      try {
        const info = JSON.parse(infoChild.stdout.toString());
        safeTitle = (info.title || 'video').replace(/[^\w\s-]/gi, '').trim();
      } catch (e) {
        console.error('Failed to parse title for download:', e);
      }
    }

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
      // Format spec: download this video format ID, and merge with best audio
      formatSpec = `${itag}+bestaudio/best`;
    }

    const tempFileName = `ytdl-${Date.now()}-${itag}.${ext}`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    // Prepare yt-dlp arguments
    const args = [
      '-f', formatSpec,
      '--ffmpeg-location', ffmpegDir,
      '-o', tempFilePath
    ];

    if (type === 'audio') {
      args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (needsMerging === 'true') {
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    console.log(`Starting download command: yt-dlp ${args.join(' ')}`);

    const downloadProcess = cp.spawn(activeYtdlpPath, args, { windowsHide: true });

    downloadProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`yt-dlp download process exited with code ${code}`);
        if (!res.headersSent) {
          res.status(500).send('Failed to process and download video from YouTube');
        }
        // Cleanup file if created
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        return;
      }

      // Check if temp file exists
      if (!fs.existsSync(tempFilePath)) {
        console.error('Downloaded file not found at:', tempFilePath);
        if (!res.headersSent) {
          res.status(500).send('File processing completed, but output file was not found.');
        }
        return;
      }

      // Send file to browser using native download mechanism
      res.download(tempFilePath, `${safeTitle}.${ext}`, (err) => {
        if (err) {
          console.error('Error sending file to browser:', err);
        }
        // Delete temp file from server once download finishes or errors out
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
            console.log('Cleaned up temp file:', tempFilePath);
          }
        } catch (cleanupErr) {
          console.error('Failed to cleanup temp file:', cleanupErr);
        }
      });
    });

    res.on('close', () => {
      // If client aborts request, terminate yt-dlp download process and delete temp file
      if (downloadProcess) {
        downloadProcess.kill();
      }
      setTimeout(() => {
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (e) {}
      }, 2000);
    });

  } catch (error) {
    console.error('Download route handler failed:', error);
    if (!res.headersSent) {
      res.status(500).send('Server Error: ' + error.message);
    }
  }
});

// For local running
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on http://localhost:${PORT}`);
  });
}

module.exports = app;
