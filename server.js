const express = require('express');
const { spawn, execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Output directory for downloaded videos and audio
const DOWNLOADS_DIR = path.join(__dirname, 'تحميلات');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Find yt-dlp executable
const YTDLP_PATH = fs.existsSync(path.join(__dirname, 'yt-dlp.exe'))
  ? path.join(__dirname, 'yt-dlp.exe')
  : 'yt-dlp';

// Download jobs tracking
const activeJobs = new Map();
// Cache for local media durations to keep list fast
const durationCache = new Map();

// Helper: Calculate stream size in bytes from filesize, clen, or bitrate
function getStreamSize(stream, duration) {
  if (!stream) return 0;
  if (stream.filesize && stream.filesize > 0) return stream.filesize;
  if (stream.filesize_approx && stream.filesize_approx > 0) return stream.filesize_approx;
  if (stream.clen && stream.clen > 0) return stream.clen;

  // Calculate from bitrate (kbps * 1000 * seconds / 8 bytes)
  const bitrate = stream.vbr || stream.tbr || stream.abr || 0;
  if (bitrate > 0 && duration > 0) {
    return Math.round((bitrate * 1000 * duration) / 8);
  }
  return 0;
}

// Helper: Format bytes to human readable format (MB, GB)
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return 'حجم غير محدد تقريباً';
  const sizes = ['بايت (B)', 'كيلوبايت (KB)', 'ميجابايت (MB)', 'جيجابايت (GB)'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i] || 'MB'}`;
}

// Helper: Format seconds to (mm:ss or hh:mm:ss)
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  seconds = Math.round(seconds);
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Helper: Format duration into friendly Arabic text (e.g. 5 دقائق و 12 ثانية)
function formatDurationArabic(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return 'غير محدد';
  seconds = Math.round(seconds);
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hrs > 0) {
    if (hrs === 1) parts.push('ساعة واحدة');
    else if (hrs === 2) parts.push('ساعتان');
    else if (hrs >= 3 && hrs <= 10) parts.push(`${hrs} ساعات`);
    else parts.push(`${hrs} ساعة`);
  }
  if (mins > 0) {
    if (mins === 1) parts.push('دقيقة واحدة');
    else if (mins === 2) parts.push('دقيقتان');
    else if (mins >= 3 && mins <= 10) parts.push(`${mins} دقائق`);
    else parts.push(`${mins} دقيقة`);
  }
  if (secs > 0 || parts.length === 0) {
    if (secs === 1) parts.push('ثانية واحدة');
    else if (secs === 2) parts.push('ثانيتان');
    else if (secs >= 3 && secs <= 10) parts.push(`${secs} ثوانٍ`);
    else parts.push(`${secs} ثانية`);
  }
  return parts.join(' و ');
}

// Helper: Get category tag based on video duration
function getDurationCategory(seconds) {
  if (!seconds || seconds <= 0) return { tag: '🎬 فيديو', type: 'regular' };
  if (seconds <= 60) return { tag: '⚡ فيديو قصير (Short)', type: 'short' };
  if (seconds <= 1200) return { tag: '📹 فيديو عادي', type: 'regular' };
  return { tag: '🎬 حلقة / فيديو طويل', type: 'long' };
}

// Helper: Estimate download time based on typical average speed (~3.5 MB/s)
function estimateDownloadTime(bytes) {
  if (!bytes || bytes <= 0) return '~ثوانٍ معدودة';
  const avgSpeedBytesPerSec = 3.5 * 1024 * 1024; // 3.5 MB/s
  const secs = Math.max(1, Math.round(bytes / avgSpeedBytesPerSec));
  if (secs < 60) {
    return `~${secs} ثانية تقريباً`;
  }
  const mins = Math.round(secs / 60);
  return `~${mins} ${mins === 1 ? 'دقيقة' : 'دقائق'} تقريباً`;
}

// API: Get Video Info, Qualities, and Estimated Sizes
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'الرجاء إدخال رابط الفيديو' });
  }

  // Run yt-dlp to get video metadata in JSON format
  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', 'node',
    url
  ];

  execFile(YTDLP_PATH, args, { maxBuffer: 1024 * 1024 * 30 }, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp info error:', stderr || error.message);
      return res.status(500).json({
        error: 'فشل فحص الرابط. تأكد من صحة الرابط أو أن الفيديو غير محمي/خاص.'
      });
    }

    try {
      const data = JSON.parse(stdout);
      const duration = data.duration || 0;
      const formats = data.formats || [];

      // Find the best audio stream
      let bestAudio = null;
      let maxAudioBitrate = 0;
      for (const f of formats) {
        if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
          const abr = f.abr || f.tbr || 0;
          if (abr > maxAudioBitrate) {
            maxAudioBitrate = abr;
            bestAudio = f;
          }
        }
      }

      // Calculate audio size accurately
      let audioSize = getStreamSize(bestAudio, duration);
      if (!audioSize && duration > 0) {
        audioSize = Math.round((128 * 1000 * duration) / 8);
      }

      // Group video formats by standard resolution heights
      const resolutions = [
        { label: '4K فائقة الوضوح (2160p)', height: 2160 },
        { label: '2K فائقة الدقة (1440p)', height: 1440 },
        { label: 'Full HD كاملة الوضوح (1080p)', height: 1080 },
        { label: 'HD عالية الوضوح (720p)', height: 720 },
        { label: 'دقة متوسطة (480p)', height: 480 },
        { label: 'دقة خفيفة (360p)', height: 360 }
      ];

      const availableQualities = [];

      resolutions.forEach(resItem => {
        const matchingFormats = formats.filter(
          f => f.height === resItem.height && f.vcodec && f.vcodec !== 'none'
        );

        if (matchingFormats.length > 0) {
          matchingFormats.sort((a, b) => {
            const sizeA = getStreamSize(a, duration);
            const sizeB = getStreamSize(b, duration);
            return sizeB - sizeA;
          });

          const chosen = matchingFormats[0];
          let videoBytes = getStreamSize(chosen, duration);
          let totalBytes = videoBytes;

          if (!chosen.acodec || chosen.acodec === 'none') {
            totalBytes += audioSize;
          }

          availableQualities.push({
            formatId: chosen.format_id,
            height: chosen.height,
            label: resItem.label,
            ext: 'mp4',
            isAudio: false,
            estimatedBytes: totalBytes,
            estimatedSizeText: formatBytes(totalBytes),
            estimatedTimeText: estimateDownloadTime(totalBytes),
            fps: chosen.fps || 30
          });
        }
      });

      // If no standard resolution matched (e.g. TikTok, Shorts, vertical videos)
      if (availableQualities.length === 0) {
        const seenHeights = new Set();
        const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
        videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

        videoFormats.forEach(f => {
          if (!seenHeights.has(f.height)) {
            seenHeights.add(f.height);
            let videoBytes = getStreamSize(f, duration);
            let totalBytes = videoBytes;

            if (!f.acodec || f.acodec === 'none') {
              totalBytes += audioSize;
            }

            let labelText = `دقة ${f.height}p`;
            if (f.width && f.height) {
              labelText = `دقة ${f.height}p (${f.width}×${f.height})`;
            }

            availableQualities.push({
              formatId: f.format_id,
              height: f.height,
              label: labelText,
              ext: 'mp4',
              isAudio: false,
              estimatedBytes: totalBytes,
              estimatedSizeText: formatBytes(totalBytes),
              estimatedTimeText: estimateDownloadTime(totalBytes),
              fps: f.fps || 30
            });
          }
        });
      }

      // Audio-only (MP3) option
      const audioOption = {
        formatId: bestAudio ? bestAudio.format_id : 'bestaudio',
        label: 'صوت فقط (MP3 عالي الجودة)',
        ext: 'mp3',
        isAudio: true,
        estimatedBytes: audioSize,
        estimatedSizeText: formatBytes(audioSize),
        estimatedTimeText: estimateDownloadTime(audioSize)
      };

      res.json({
        title: data.title || 'فيديو بدون عنوان',
        uploader: data.uploader || data.channel || 'غير معروف',
        thumbnail: data.thumbnail || '',
        durationSeconds: duration,
        durationFormatted: formatDuration(duration),
        durationArabic: formatDurationArabic(duration),
        durationCategory: getDurationCategory(duration),
        webpageUrl: data.webpage_url || url,
        qualities: availableQualities,
        audioOption
      });
    } catch (parseErr) {
      console.error('Parse error:', parseErr);
      res.status(500).json({ error: 'حدث خطأ أثناء معالجة بيانات الفيديو' });
    }
  });
});

// API: Start Download Job (supports optional trimming: startTime, endTime)
app.post('/api/download', (req, res) => {
  const { url, formatId, isAudio, title, startTime, endTime } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'الرابط مطلوب' });
  }

  const jobId = Date.now().toString() + '-' + Math.random().toString(36).substring(2, 7);

  const job = {
    id: jobId,
    url,
    title: title || 'video',
    status: 'downloading',
    percent: 0,
    speed: '',
    eta: '',
    totalSize: '',
    filename: '',
    error: null,
    isTrimmed: false
  };

  activeJobs.set(jobId, job);

  // Limit filename length to 100 characters to prevent MAX_PATH issues
  const outputTemplate = path.join(DOWNLOADS_DIR, '%(title).100s.%(ext)s');
  const args = [
    '--newline',
    '--no-playlist',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--postprocessor-args', 'Merger:-strict -2',
    '-o', outputTemplate
  ];

  // Optional Video Trimming / Cutting
  const timeRegex = /^(?:(?:\d+:)?\d+:)?\d+(?:\.\d+)?$/;
  if (startTime && endTime && timeRegex.test(startTime.trim()) && timeRegex.test(endTime.trim())) {
    const s = startTime.trim();
    const e = endTime.trim();
    args.push('--download-sections', `*${s}-${e}`);
    args.push('--force-keyframes-at-cuts');
    job.isTrimmed = true;
    job.title = `${job.title} (مقتطع: من ${s} إلى ${e})`;
  }

  if (isAudio) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', url);
  } else {
    // If formatId specified, prefer m4a audio or best audio, and merge into mp4
    const formatSpec = formatId ? `${formatId}+bestaudio[ext=m4a]/bestaudio/best` : 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
    args.push('-f', formatSpec, '--merge-output-format', 'mp4', url);
  }

  const child = spawn(YTDLP_PATH, args);

  // Regex to parse yt-dlp progress output
  const progressRegex = /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/;
  const mergerRegex = /\[Merger\]\s+Merging formats into "(.+)"/;
  const destRegex = /\[(?:download|ExtractAudio|ffmpeg)\]\s+Destination:\s+(.+)/;

  let lastStderr = '';

  child.stdout.on('data', data => {
    const text = data.toString();
    const match = text.match(progressRegex);
    if (match) {
      job.percent = parseFloat(match[1]);
      job.totalSize = match[2];
      job.speed = match[3];
      job.eta = match[4];
      job.status = 'downloading';
    }

    if (text.includes('[Merger]') || text.includes('[ExtractAudio]')) {
      job.status = 'processing';
    }

    const destMatch = text.match(destRegex) || text.match(mergerRegex);
    if (destMatch && destMatch[1]) {
      job.filename = path.basename(destMatch[1].trim());
    }
  });

  child.stderr.on('data', data => {
    const errText = data.toString();
    lastStderr = errText;
    console.warn(`yt-dlp stderr [${jobId}]:`, errText);
  });

  child.on('close', code => {
    if (code === 0) {
      job.status = 'completed';
      job.percent = 100;
    } else {
      job.status = 'error';
      job.error = lastStderr.trim() || 'حدث خطأ أثناء تنزيل أو معالجة الفيديو.';
    }
  });

  res.json({ jobId });
});

// API: Get Download Progress
app.get('/api/progress/:id', (req, res) => {
  const job = activeJobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'المهمة غير موجودة' });
  }
  res.json(job);
});

// API: Open Downloads Folder in Windows Explorer
app.post('/api/open-folder', (req, res) => {
  exec(`explorer.exe "${DOWNLOADS_DIR}"`, err => {
    if (err) {
      return res.status(500).json({ error: 'تعذر فتح المجلد' });
    }
    res.json({ success: true, folder: DOWNLOADS_DIR });
  });
});

// Helper: Get duration of local media file via ffprobe
function getMediaDuration(filePath) {
  return new Promise(resolve => {
    if (durationCache.has(filePath)) {
      return resolve(durationCache.get(filePath));
    }
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (err, stdout) => {
        if (!err && stdout) {
          const sec = parseFloat(stdout.trim());
          if (!isNaN(sec) && sec > 0) {
            const formatted = formatDuration(sec);
            durationCache.set(filePath, formatted);
            return resolve(formatted);
          }
        }
        resolve(null);
      }
    );
  });
}

// API: List Downloaded Files with Size & Duration
app.get('/api/files', async (req, res) => {
  fs.readdir(DOWNLOADS_DIR, async (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'تعذر قراءة المجلد' });
    }

    const validFiles = files.filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));

    const fileDetails = await Promise.all(
      validFiles.map(async name => {
        const fullPath = path.join(DOWNLOADS_DIR, name);
        try {
          const stats = fs.statSync(fullPath);
          const duration = await getMediaDuration(fullPath);
          return {
            name,
            size: formatBytes(stats.size),
            duration: duration || 'غير محدد',
            time: stats.mtime
          };
        } catch {
          return null;
        }
      })
    );

    const result = fileDetails.filter(Boolean).sort((a, b) => b.time - a.time);
    res.json(result);
  });
});

// Start server and open browser
app.listen(PORT, () => {
  console.log(`Video Downloader Server running on http://localhost:${PORT}`);
  exec(`start http://localhost:${PORT}`);
});
