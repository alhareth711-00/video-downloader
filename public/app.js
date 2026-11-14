// DOM Elements
const urlInput = document.getElementById('urlInput');
const pasteBtn = document.getElementById('pasteBtn');
const checkBtn = document.getElementById('checkBtn');
const statusMessage = document.getElementById('statusMessage');

const resultsSection = document.getElementById('resultsSection');
const videoThumb = document.getElementById('videoThumb');
const videoDuration = document.getElementById('videoDuration');
const videoTitle = document.getElementById('videoTitle');
const videoUploader = document.getElementById('videoUploader');
const videoDurationArabic = document.getElementById('videoDurationArabic');
const videoCategoryBadge = document.getElementById('videoCategoryBadge');

// Trimming Elements
const trimCheckbox = document.getElementById('trimCheckbox');
const trimControls = document.getElementById('trimControls');
const trimStartTime = document.getElementById('trimStartTime');
const trimEndTime = document.getElementById('trimEndTime');

// Audio Option Box
const audioOptionBox = document.getElementById('audioOptionBox');
const audioTitle = document.getElementById('audioTitle');
const audioSize = document.getElementById('audioSize');
const audioTimeEst = document.getElementById('audioTimeEst');
const downloadAudioBtn = document.getElementById('downloadAudioBtn');

const qualitiesTableBody = document.getElementById('qualitiesTableBody');

const progressSection = document.getElementById('progressSection');
const progressTitle = document.getElementById('progressTitle');
const progressSubtitle = document.getElementById('progressSubtitle');
const progressBarFill = document.getElementById('progressBarFill');
const statPercent = document.getElementById('statPercent');
const statSize = document.getElementById('statSize');
const statSpeed = document.getElementById('statSpeed');
const statEta = document.getElementById('statEta');
const downloadSpinner = document.getElementById('downloadSpinner');
const openFolderBtn = document.getElementById('openFolderBtn');
const openFolderDirectBtn = document.getElementById('openFolderDirectBtn');
const filesList = document.getElementById('filesList');

let currentVideoData = null;
let activePollingInterval = null;

// Toggle Trimming Controls
trimCheckbox.addEventListener('change', () => {
  if (trimCheckbox.checked) {
    trimControls.classList.remove('hidden');
  } else {
    trimControls.classList.add('hidden');
  }
});

// Show status notification
function showStatus(msg, type = 'info') {
  statusMessage.textContent = msg;
  statusMessage.className = `status-msg ${type}`;
  statusMessage.classList.remove('hidden');
}

function clearStatus() {
  statusMessage.textContent = '';
  statusMessage.classList.add('hidden');
}

// Paste from Clipboard
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      clearStatus();
    }
  } catch (err) {
    showStatus('تعذر الوصول إلى الحافظة تلقائياً. يمكنك الضغط على Ctrl + V للصق الرابط.', 'info');
  }
});

// Check / Inspect Video Info
checkBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    showStatus('يرجى لصق رابط الفيديو أولاً.', 'error');
    return;
  }

  clearStatus();
  resultsSection.classList.add('hidden');
  checkBtn.disabled = true;
  checkBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block"></span> جاري فحص بيانات الفيديو والجودات...';

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'فشل فحص الرابط.');
    }

    currentVideoData = { ...data, originalUrl: url };
    displayVideoInfo(data);
  } catch (err) {
    showStatus(err.message || 'حدث خطأ أثناء فحص الرابط. تأكد من صحة الرابط واتصالك بالإنترنت.', 'error');
  } finally {
    checkBtn.disabled = false;
    checkBtn.innerHTML = '<span class="btn-icon">🔍</span><span class="btn-text">فحص الفيديو والجودات</span>';
  }
});

// Display Video Info & Qualities Table
function displayVideoInfo(data) {
  videoThumb.src = data.thumbnail || 'https://via.placeholder.com/300x180?text=No+Thumbnail';
  videoDuration.textContent = data.durationFormatted || '00:00';
  videoTitle.textContent = data.title;
  videoUploader.textContent = data.uploader;

  // Set Arabic Duration Text and Category
  videoDurationArabic.textContent = data.durationArabic || '--';
  if (data.durationCategory) {
    videoCategoryBadge.textContent = data.durationCategory.tag;
  }

  // Pre-fill Trimming times
  trimStartTime.value = '00:00';
  trimEndTime.value = data.durationFormatted || '01:00';

  // Set Audio Option
  if (data.audioOption) {
    audioSize.textContent = data.audioOption.estimatedSizeText;
    audioTimeEst.textContent = `⏱️ ${data.audioOption.estimatedTimeText}`;
    downloadAudioBtn.onclick = () => {
      startDownload({
        url: data.webpageUrl || urlInput.value.trim(),
        formatId: data.audioOption.formatId,
        isAudio: true,
        title: data.title
      });
    };
  }

  // Populate Video Qualities
  qualitiesTableBody.innerHTML = '';
  if (data.qualities && data.qualities.length > 0) {
    data.qualities.forEach(q => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span class="quality-badge">${q.label}</span>
        </td>
        <td>${q.ext.toUpperCase()}</td>
        <td>
          <span class="size-highlight">${q.estimatedSizeText}</span>
        </td>
        <td>
          <span class="time-table-cell">⏱️ ${q.estimatedTimeText}</span>
        </td>
        <td>
          <button class="btn btn-sm btn-success">
            تحميل الآن ⬇
          </button>
        </td>
      `;

      const downloadBtn = tr.querySelector('button');
      downloadBtn.onclick = () => {
        startDownload({
          url: data.webpageUrl || urlInput.value.trim(),
          formatId: q.formatId,
          isAudio: false,
          title: data.title
        });
      };

      qualitiesTableBody.appendChild(tr);
    });
  } else {
    qualitiesTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">
          لم نتمكن من حصر دقات متعددة منفصلة، ولكن يمكنك تنزيل المقطع بأعلى دقة متوفرة.
        </td>
      </tr>
    `;
  }

  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Start Download
async function startDownload({ url, formatId, isAudio, title }) {
  if (activePollingInterval) {
    clearInterval(activePollingInterval);
  }

  const payload = { url, formatId, isAudio, title };

  // Check if Trimming is enabled
  if (trimCheckbox.checked && trimStartTime.value.trim() && trimEndTime.value.trim()) {
    payload.startTime = trimStartTime.value.trim();
    payload.endTime = trimEndTime.value.trim();
  }

  progressSection.classList.remove('hidden');
  if (payload.startTime && payload.endTime) {
    progressTitle.textContent = `جاري اقتطاع وتنزيل: ${title} (من ${payload.startTime} إلى ${payload.endTime})`;
  } else {
    progressTitle.textContent = `جاري بدء تنزيل: ${title}`;
  }

  progressSubtitle.textContent = isAudio ? 'جاري استخراج وتحويل الصوت إلى MP3...' : 'جاري تنزيل ملفات الفيديو والصوت...';
  progressBarFill.style.width = '0%';
  statPercent.textContent = '0%';
  statSize.textContent = '--';
  statSpeed.textContent = '--';
  statEta.textContent = '--';
  downloadSpinner.style.display = 'block';

  progressSection.scrollIntoView({ behavior: 'smooth' });

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل بدء التنزيل.');
    }

    trackProgress(data.jobId);
  } catch (err) {
    progressTitle.textContent = 'حدث خطأ!';
    progressSubtitle.textContent = err.message;
    downloadSpinner.style.display = 'none';
  }
}

// Track Download Progress via Polling
function trackProgress(jobId) {
  activePollingInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress/${jobId}`);
      if (!res.ok) return;

      const job = await res.json();

      if (job.status === 'downloading') {
        progressBarFill.style.width = `${job.percent}%`;
        statPercent.textContent = `${job.percent}%`;
        if (job.totalSize) statSize.textContent = job.totalSize;
        if (job.speed) statSpeed.textContent = job.speed;
        if (job.eta) statEta.textContent = job.eta;
        progressSubtitle.textContent = job.isTrimmed ? 'جاري اقتطاع وتنزيل المقطع المحدد...' : 'جاري التنزيل بأقصى سرعة...';
      } else if (job.status === 'processing') {
        progressBarFill.style.width = '95%';
        statPercent.textContent = '95%';
        progressSubtitle.textContent = 'جاري دمج ومعالجة المقطع بأعلى نقاء عبر FFmpeg...';
      } else if (job.status === 'completed') {
        clearInterval(activePollingInterval);
        progressBarFill.style.width = '100%';
        statPercent.textContent = '100%';
        downloadSpinner.style.display = 'none';
        progressTitle.textContent = 'تم التنزيل بنجاح! 🎉';
        progressSubtitle.textContent = `تم حفظ الملف: ${job.filename || ''} داخل مجلد التنزيلات`;
        loadRecentFiles();
      } else if (job.status === 'error') {
        clearInterval(activePollingInterval);
        downloadSpinner.style.display = 'none';
        progressTitle.textContent = 'تعذر إكمال التنزيل';
        progressSubtitle.textContent = job.error || 'حدث خطأ غير متوقع';
      }
    } catch (e) {
      console.warn('Progress poll error:', e);
    }
  }, 700);
}

// Open Downloads Folder in Windows Explorer
async function openFolder() {
  try {
    await fetch('/api/open-folder', { method: 'POST' });
  } catch (err) {
    alert('تعذر فتح المجلد تلقائياً.');
  }
}

openFolderBtn.addEventListener('click', openFolder);
openFolderDirectBtn.addEventListener('click', openFolder);

// Load Recent Files with Duration & Size
async function loadRecentFiles() {
  try {
    const res = await fetch('/api/files');
    const files = await res.json();

    if (!files || files.length === 0) {
      filesList.innerHTML = '<div class="empty-state">لا توجد ملفات محملة بعد، الصق رابطاً وابدأ التنزيل!</div>';
      return;
    }

    filesList.innerHTML = files.map(file => `
      <div class="file-item">
        <div class="file-name" title="${file.name}">📄 ${file.name}</div>
        <div class="file-meta-badges">
          <span class="file-duration" title="مدة المقطع">⏱️ ${file.duration}</span>
          <span class="file-size">${file.size}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.warn('Load files error:', err);
  }
}

// Initial load
loadRecentFiles();
