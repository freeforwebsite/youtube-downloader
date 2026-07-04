document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('search-form');
  const videoUrlInput = document.getElementById('video-url');
  const errorMsg = document.getElementById('error-message');
  const skeletonLoader = document.getElementById('skeleton-loader');
  const previewSection = document.getElementById('preview-section');
  const fetchBtn = document.getElementById('fetch-btn');
  const engineBadge = document.getElementById('engine-badge');
  const badgeText = document.getElementById('badge-text');

  let apiBase = window.location.origin;

  // Check if local server is running to use as engine
  async function checkConnection() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      apiBase = window.location.origin;
      updateEngineBadge('local', 'Local Engine');
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);

      const res = await fetch('http://localhost:3000/api/ping', {
        method: 'GET',
        mode: 'cors',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') {
          apiBase = 'http://localhost:3000';
          updateEngineBadge('local', 'Local Engine');
          console.log('Local server detected! Routing queries to http://localhost:3000');
          return;
        }
      }
    } catch (e) {
      console.log('Local server is offline or unreachable from this context.');
    }

    apiBase = window.location.origin;
    updateEngineBadge('cloud', 'Cloud Engine');
  }

  function updateEngineBadge(status, text) {
    if (!engineBadge) return;
    engineBadge.className = `engine-badge ${status}`;
    badgeText.textContent = text;
    
    if (status === 'cloud') {
      engineBadge.title = "Local server is offline. Run 'npm start' on your computer to use the Local Engine (recommended to bypass bot checks).";
    } else {
      engineBadge.title = "Connected to local server. Downloads will run on your local network (fast, unblocked, no timeouts!).";
    }
  }

  // Run connection check immediately
  checkConnection();

  // Video Info Elements
  const videoThumbnail = document.getElementById('video-thumbnail');
  const videoDuration = document.getElementById('video-duration');
  const videoTitle = document.getElementById('video-title');
  const videoAuthor = document.getElementById('video-author');
  const videoViews = document.getElementById('video-views');

  // List containers
  const videoAudioList = document.getElementById('video-audio-list');
  const audioOnlyList = document.getElementById('audio-only-list');
  const videoOnlyList = document.getElementById('video-only-list');

  // Download Modal Elements
  const downloadModal = document.getElementById('download-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalDesc = document.getElementById('modal-desc');
  const progressBar = document.getElementById('progress-bar');
  const progressInfo = document.getElementById('progress-info');

  let currentVideoUrl = '';

  // Tab switching logic
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`${targetTab}-tab`).classList.add('active');
    });
  });

  // Extract clean YouTube video ID or full URL
  function cleanYoutubeUrl(url) {
    const trimmed = url.trim();
    if (!trimmed) return '';
    try {
      // Basic check to see if it matches youtube domain or shortener
      if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
        return trimmed;
      }
      // If user pasted just a 11 char ID, convert it
      if (trimmed.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        return `https://www.youtube.com/watch?v=${trimmed}`;
      }
      return trimmed;
    } catch (e) {
      return trimmed;
    }
  }

  // Handle Form Submission
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawUrl = videoUrlInput.value;
    const url = cleanYoutubeUrl(rawUrl);

    if (!url) return;

    currentVideoUrl = url;
    showLoading(true);
    showError('');

    try {
      const response = await fetch(`${apiBase}/api/info?url=${encodeURIComponent(url)}`);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to extract video details');
      }

      const data = await response.json();
      renderVideoInfo(data);
      showLoading(false);
    } catch (error) {
      console.error(error);
      showError(error.message || 'Something went wrong. Please check your link and try again.');
      showLoading(false);
    }
  });

  function showLoading(isLoading) {
    if (isLoading) {
      skeletonLoader.classList.remove('hidden');
      previewSection.classList.add('hidden');
      fetchBtn.disabled = true;
      fetchBtn.querySelector('span').textContent = 'Extracting...';
    } else {
      skeletonLoader.classList.add('hidden');
      fetchBtn.disabled = false;
      fetchBtn.querySelector('span').textContent = 'Extract';
    }
  }

  function showError(msg) {
    if (msg) {
      errorMsg.textContent = msg;
      errorMsg.classList.remove('hidden');
    } else {
      errorMsg.classList.add('hidden');
      errorMsg.textContent = '';
    }
  }

  function renderVideoInfo(data) {
    // Basic Details
    videoThumbnail.src = data.thumbnail;
    videoDuration.textContent = data.durationLabel;
    videoTitle.textContent = data.title;
    videoAuthor.textContent = data.author;
    videoAuthor.href = data.authorUrl;
    videoViews.textContent = `${data.views} views`;

    // Reset list contents
    videoAudioList.innerHTML = '';
    audioOnlyList.innerHTML = '';
    videoOnlyList.innerHTML = '';

    const formats = data.formats;

    // 1. Render Video + Audio Formats
    if (formats.videoWithAudio && formats.videoWithAudio.length > 0) {
      formats.videoWithAudio.forEach(f => {
        const item = document.createElement('div');
        item.className = 'format-item';
        
        const badgeClass = f.needsMerging ? 'badge-merge' : 'badge-hd';
        const badgeText = f.needsMerging ? 'Merged' : 'Direct';
        const sizeText = f.sizeLabel || 'Unknown Size';
        
        item.innerHTML = `
          <div class="format-quality">
            <span>${f.qualityLabel}</span>
            <span class="badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="format-size">${sizeText}</div>
          <div class="format-ext">${f.container}</div>
          <div>
            <button class="download-btn" data-itag="${f.itag}" data-type="video" data-merge="${f.needsMerging}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="download-btn-icon">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>Get</span>
            </button>
          </div>
        `;
        videoAudioList.appendChild(item);
      });
    } else {
      videoAudioList.innerHTML = '<div class="no-formats">No video formats available.</div>';
    }

    // 2. Render Audio Only Formats
    if (formats.audioOnly && formats.audioOnly.length > 0) {
      formats.audioOnly.forEach(f => {
        const item = document.createElement('div');
        item.className = 'format-item';
        
        const sizeText = f.sizeLabel || 'Unknown Size';
        
        item.innerHTML = `
          <div class="format-quality">
            <span>${f.audioBitrate}kbps</span>
            <span class="badge badge-audio">Audio</span>
          </div>
          <div class="format-size">${sizeText}</div>
          <div class="format-ext">${f.container}</div>
          <div>
            <button class="download-btn" data-itag="${f.itag}" data-type="audio" data-merge="false">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="download-btn-icon">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>Get</span>
            </button>
          </div>
        `;
        audioOnlyList.appendChild(item);
      });
    } else {
      audioOnlyList.innerHTML = '<div class="no-formats">No audio formats available.</div>';
    }

    // 3. Render Video Only Formats
    if (formats.videoOnly && formats.videoOnly.length > 0) {
      formats.videoOnly.forEach(f => {
        const item = document.createElement('div');
        item.className = 'format-item';
        
        const sizeText = f.sizeLabel || 'Unknown Size';
        
        item.innerHTML = `
          <div class="format-quality">
            <span>${f.qualityLabel} (${f.fps}fps)</span>
            <span class="badge badge-hd">Video Only</span>
          </div>
          <div class="format-size">${sizeText}</div>
          <div class="format-ext">${f.container}</div>
          <div>
            <button class="download-btn" data-itag="${f.itag}" data-type="videoonly" data-merge="false">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="download-btn-icon">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>Get</span>
            </button>
          </div>
        `;
        videoOnlyList.appendChild(item);
      });
    } else {
      videoOnlyList.innerHTML = '<div class="no-formats">No video-only formats available.</div>';
    }

    // Hook download events
    const downloadBtns = previewSection.querySelectorAll('.download-btn');
    downloadBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const itag = btn.getAttribute('data-itag');
        const type = btn.getAttribute('data-type');
        const merge = btn.getAttribute('data-merge');
        triggerDownload(itag, type, merge);
      });
    });

    previewSection.classList.remove('hidden');
  }
  function triggerDownload(itag, type, merge) {
    const downloadUrl = `${apiBase}/api/download?url=${encodeURIComponent(currentVideoUrl)}&itag=${itag}&type=${type}&needsMerging=${merge}`;

    showDownloadModal(merge === 'true');

    // Trigger native browser download by routing to download URL
    window.location.href = downloadUrl;
  }

  function showDownloadModal(isMerged) {
    downloadModal.classList.remove('hidden');
    
    if (isMerged) {
      modalTitle.textContent = 'Merging Video & Audio...';
      modalDesc.textContent = 'Muxing high-quality streams. This might take up to a minute for HD/4K videos. Please wait...';
      progressBar.style.width = '100%';
      progressBar.style.animation = 'pulse 1.5s infinite';
      progressInfo.innerHTML = 'Download started! You can track the progress in your browser.<br><button id="modal-close-btn" class="download-btn" style="margin: 12px auto 0 auto; padding: 6px 16px;">Close Overlay</button>';
      
      // Auto close after 6 seconds
      const autoCloseTimer = setTimeout(() => {
        downloadModal.classList.add('hidden');
      }, 6000);

      // Register close click immediately
      setTimeout(() => {
        const closeBtn = document.getElementById('modal-close-btn');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            clearTimeout(autoCloseTimer);
            downloadModal.classList.add('hidden');
          });
        }
      }, 50);
    } else {
      modalTitle.textContent = 'Starting Download...';
      modalDesc.textContent = 'Fetching media stream and sending to browser.';
      progressBar.style.width = '100%';
      progressBar.style.animation = 'pulse 1.5s infinite';
      progressInfo.textContent = 'Preparing stream download.';
      
      // Auto close after 3 seconds for direct streams
      setTimeout(() => {
        downloadModal.classList.add('hidden');
      }, 3000);
    }
  }
});
