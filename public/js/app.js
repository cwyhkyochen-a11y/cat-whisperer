/**
 * 猫语翻译器 v1.1 — 前端逻辑
 * 纯 JS，无框架依赖
 * 新增: VAD 自动检测 + 实时波形 + 设置页
 */

(function () {
  'use strict';

  // ===== 常量 =====
  const API_BASE = '';  // 同域，直接用相对路径
  const PAGELIMIT = 20;

  const DEFAULT_SETTINGS = {
    mode: 'manual',       // 'manual' | 'auto'
    vadSensitivity: -35,  // dB
    silenceDuration: 2000, // ms
    maxRecordingDuration: 300000 // ms (5min)
  };

  const STORAGE_KEY = 'cat_whisperer_settings';

  // 情绪标签颜色映射
  const LABEL_COLORS = {
    happy: 'tag-happy',
    seeking: 'tag-seeking',
    anxious: 'tag-anxious',
    warning: 'tag-warning',
    pain: 'tag-pain',
    neutral: 'tag-neutral'
  };

  const LABEL_CN = {
    happy: '开心',
    seeking: '求助',
    anxious: '焦虑',
    warning: '警告',
    pain: '痛苦',
    neutral: '中性'
  };

  // ===== 设置管理 =====
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
      }
    } catch { /* ignore */ }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch { /* ignore */ }
  }

  let settings = loadSettings();

  // ===== VAD 引擎 =====
  class VADEngine {
    constructor(options) {
      this.threshold = options.threshold || -35;
      this.silenceDuration = options.silenceDuration || 2000;
      this.minRecordingDuration = options.minRecordingDuration || 500;
      this.fftSize = options.fftSize || 2048;
      this.onMeowStart = options.onMeowStart || function () {};
      this.onMeowEnd = options.onMeowEnd || function () {};
      this.onLevelUpdate = options.onLevelUpdate || function () {};
      this.onFreqData = options.onFreqData || function () {};

      this.stream = null;
      this.audioContext = null;
      this.source = null;
      this.analyser = null;
      this.monitoring = false;
      this.isSpeaking = false;
      this.silenceStart = 0;
      this.speakStart = 0;
      this._rafId = null;
    }

    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new AudioContext();
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.source.connect(this.analyser);

      this.monitoring = true;
      this.isSpeaking = false;
      this.silenceStart = 0;
      this._monitor();
    }

    _monitor() {
      if (!this.monitoring) return;

      try {
        const bufLen = this.analyser.fftSize;
        const timeBuf = new Float32Array(bufLen);
        this.analyser.getFloatTimeDomainData(timeBuf);

        // 计算 RMS
        let sum = 0;
        for (let i = 0; i < bufLen; i++) {
          sum += timeBuf[i] * timeBuf[i];
        }
        const rms = Math.sqrt(sum / bufLen);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;

        // 频率数据
        const freqBins = this.analyser.frequencyBinCount;
        const freqData = new Uint8Array(freqBins);
        this.analyser.getByteFrequencyData(freqData);

        this.onLevelUpdate(db);
        this.onFreqData(freqData, this.threshold);

        const now = Date.now();

        if (db > this.threshold) {
          // 超过阈值
          if (!this.isSpeaking) {
            this.isSpeaking = true;
            this.speakStart = now;
            this.silenceStart = 0;
            this.onMeowStart();
          }
          this.silenceStart = 0; // 重置安静计时
        } else {
          // 低于阈值
          if (this.isSpeaking) {
            if (!this.silenceStart) {
              this.silenceStart = now;
            } else if (now - this.silenceStart > this.silenceDuration) {
              // 安静足够久
              if (now - this.speakStart >= this.minRecordingDuration) {
                this.isSpeaking = false;
                this.silenceStart = 0;
                this.onMeowEnd();
              } else {
                // 录音太短，忽略
                this.isSpeaking = false;
                this.silenceStart = 0;
              }
            }
          }
        }
      } catch { /* ignore frame errors */ }

      this._rafId = requestAnimationFrame(() => this._monitor());
    }

    stop() {
      this.monitoring = false;
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
      }
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
      this.source = null;
      this.analyser = null;
      this.isSpeaking = false;
    }

    setThreshold(db) {
      this.threshold = db;
    }

    setSilenceDuration(ms) {
      this.silenceDuration = ms;
    }
  }

  // ===== 状态 =====
  let appState = 'idle'; // idle | monitoring | recording | uploading | interpreting
  let mediaRecorder = null;
  let audioChunks = [];
  let timerInterval = null;
  let recordStartTime = null;
  let currentAudio = null;
  let vadEngine = null;
  let vadStream = null; // VAD 自己管理麦克风，录制时直接用
  let recordingTriggerType = 'manual'; // 'manual' | 'auto'

  // ===== Canvas 波形 =====
  let canvasCtx = null;
  let canvasAnimId = null;
  let currentFreqData = null;
  let currentDbLevel = -100;

  // ===== 检查 Web Audio API 支持 =====
  const vadSupported = !!(window.AudioContext || window.webkitAudioContext) &&
                       !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // ===== DOM 元素 =====
  const $ = (sel) => document.querySelector(sel);
  const recordBtn = $('#recordBtn');
  const timerEl = $('#timer');
  const statusEl = $('#recordingStatus');
  const latestResult = $('#latestResult');
  const historyList = $('#historyList');
  const emptyState = $('#emptyState');
  const waveformCanvas = $('#waveformCanvas');
  const settingsBtn = $('#settingsBtn');
  const settingsPanel = $('#settingsPanel');
  const settingsOverlay = $('#settingsOverlay');
  const closeSettingsBtn = $('#closeSettingsBtn');
  const headerStatsEl = $('#headerStats');

  // 设置控件
  const modeGroup = $('#modeGroup');
  const autoModeOption = $('#autoModeOption');
  const vadNotSupported = $('#vadNotSupported');
  const vadSensitivitySlider = $('#vadSensitivity');
  const vadSensitivityLabel = $('#vadSensitivityLabel');
  const silenceDurationSlider = $('#silenceDuration');
  const silenceDurationLabel = $('#silenceDurationLabel');
  const maxDurationSelect = $('#maxDuration');

  const toastContainer = createToastContainer();

  // ===== Toast 系统 =====
  function createToastContainer() {
    const div = document.createElement('div');
    div.id = 'toastContainer';
    document.body.appendChild(div);
    return div;
  }

  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ===== 工具函数 =====

  function formatTime(seconds) {
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function formatDateTime(isoStr) {
    const d = new Date(isoStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `今天 ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  }

  function formatDuration(sec) {
    if (!sec && sec !== 0) return '';
    const s = Math.round(sec);
    if (s < 60) return `${s}秒`;
    return `${Math.floor(s / 60)}分${s % 60}秒`;
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function renderLabels(labels) {
    if (!labels || !labels.length) return '';
    return labels.map(l => {
      const cls = LABEL_COLORS[l] || 'tag-neutral';
      const name = LABEL_CN[l] || l;
      return `<span class="tag ${cls}">${name}</span>`;
    }).join('');
  }

  // ===== API 调用 =====

  async function apiFetch(path, options = {}) {
    const url = API_BASE + path;
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error('网络连接失败，请检查后端服务');
      }
      throw err;
    }
  }

  async function fetchStats() {
    try {
      const data = await apiFetch('/api/stats');
      const today = data.today || 0;
      const total = data.total || 0;
      headerStatsEl.textContent = `今日 ${today} 条 / 总计 ${total} 条`;
    } catch {
      // 静默失败
    }
  }

  async function fetchRecordings() {
    try {
      const data = await apiFetch(`/api/recordings?page=1&limit=${PAGELIMIT}`);
      const items = data.items || data.data || data || [];
      renderHistory(items);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // 上传音频（v1.1: 增加 duration_ms 和 trigger_type）
  async function uploadAudio(blob, durationMs, triggerType) {
    const formData = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
    formData.append('audio', blob, `recording.${ext}`);
    formData.append('duration_ms', String(durationMs));
    formData.append('trigger_type', triggerType || 'manual');
    return apiFetch('/api/recordings/upload', {
      method: 'POST',
      body: formData
    });
  }

  async function interpretRecording(id) {
    return apiFetch(`/api/recordings/${id}/interpret`, { method: 'POST' });
  }

  async function deleteRecording(id) {
    return apiFetch(`/api/recordings/${id}`, { method: 'DELETE' });
  }

  // ===== 状态管理 =====

  function setAppState(newState, statusText) {
    appState = newState;
    recordBtn.className = 'record-btn';
    const icon = recordBtn.querySelector('.icon');
    const text = recordBtn.querySelector('.text');

    if (settings.mode === 'manual') {
      switch (newState) {
        case 'idle':
          icon.textContent = '🎤';
          text.textContent = '开始录音';
          break;
        case 'recording':
          recordBtn.classList.add('recording');
          icon.textContent = '⏹';
          text.textContent = '停止录音';
          break;
        case 'uploading':
          recordBtn.classList.add('uploading');
          icon.textContent = '⏳';
          text.textContent = '上传中…';
          break;
        case 'interpreting':
          recordBtn.classList.add('interpreting');
          icon.textContent = '🔮';
          text.textContent = '解读中…';
          break;
      }
    } else {
      // 自动模式
      switch (newState) {
        case 'idle':
        case 'monitoring':
          recordBtn.classList.add('monitoring');
          icon.textContent = '👂';
          text.textContent = '监听中…';
          break;
        case 'recording':
          recordBtn.classList.add('recording');
          icon.textContent = '🎵';
          text.textContent = '检测到猫叫！';
          break;
        case 'uploading':
          recordBtn.classList.add('uploading');
          icon.textContent = '⏳';
          text.textContent = '上传中…';
          break;
        case 'interpreting':
          recordBtn.classList.add('interpreting');
          icon.textContent = '🔮';
          text.textContent = '解读中…';
          break;
      }
    }

    if (statusText !== undefined) {
      statusEl.textContent = statusText;
      statusEl.className = 'status';
    }
  }

  // ===== 录音（手动模式）=====

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      let mimeType = '';
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        mimeType = 'audio/ogg';
      }

      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        audioChunks = [];

        const durationMs = Date.now() - recordStartTime;
        await handleUpload(blob, durationMs, recordingTriggerType);
      };

      mediaRecorder.start(250);
      recordStartTime = Date.now();
      recordingTriggerType = 'manual';
      setAppState('recording');

      // 启动计时器
      timerEl.classList.remove('hidden');
      timerEl.textContent = '00:00';
      startTimerInterval();

      // 显示波形
      showWaveform();

    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('请允许访问麦克风', 'error');
      } else {
        showToast('无法启动录音: ' + err.message, 'error');
      }
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ===== 录音（自动模式：VAD 驱动）=====

  async function startAutoRecording() {
    try {
      // 使用 VAD 已有的 stream 来录制
      if (!vadStream) {
        showToast('VAD 未启动', 'error');
        return;
      }

      let mimeType = '';
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        mimeType = 'audio/ogg';
      }

      // 使用新的 stream 录制（共享 VAD 的麦克风）
      // 我们已经通过 VAD 获取了麦克风，但 MediaRecorder 需要独立操作
      // 最好的做法是 VAD 获取 stream 后，MediaRecorder 也用同一个 stream
      const stream = vadStream;

      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        audioChunks = [];

        const durationMs = Date.now() - recordStartTime;
        await handleUpload(blob, durationMs, recordingTriggerType);
      };

      mediaRecorder.start(250);
      recordStartTime = Date.now();
      recordingTriggerType = 'auto';
      setAppState('recording', '检测到猫叫声，正在录音…');

      // 启动计时器
      timerEl.classList.remove('hidden');
      timerEl.textContent = '00:00';
      startTimerInterval();

    } catch (err) {
      showToast('自动录音失败: ' + err.message, 'error');
    }
  }

  function stopAutoRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      clearInterval(timerInterval);
      timerInterval = null;
    }
    // VAD 不需要停，继续监听
  }

  // ===== 公共计时器 =====

  function startTimerInterval() {
    timerInterval = setInterval(() => {
      if (!recordStartTime) return;
      const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
      timerEl.textContent = formatTime(elapsed);

      // 检查最大录音时长
      if (Date.now() - recordStartTime > settings.maxRecordingDuration) {
        if (settings.mode === 'manual') {
          stopRecording();
        } else {
          stopAutoRecording();
        }
        showToast('已达到最大录音时长', 'info');
      }
    }, 200);
  }

  // ===== 上传处理 =====

  async function handleUpload(blob, durationMs, triggerType) {
    // 如果是自动模式，上传完成后回到 monitoring；手动回到 idle
    const isAuto = settings.mode === 'auto' && appState !== 'idle';

    setAppState('uploading', '正在上传…');
    stopWaveform();

    try {
      const uploadResult = await uploadAudio(blob, durationMs, triggerType);
      const recordingId = uploadResult.id || uploadResult.data?.id || uploadResult.recording?.id;

      if (!recordingId) {
        showToast('上传成功但未获取到录音 ID', 'error');
        setAppState(isAuto ? 'monitoring' : 'idle');
        return;
      }

      setAppState('interpreting', 'AI 正在解读猫叫声…');

      const interpretResult = await interpretRecording(recordingId);

      showLatestResult(interpretResult);

      if (isAuto) {
        setAppState('monitoring', '继续监听…');
      } else {
        setAppState('idle');
        timerEl.classList.add('hidden');
      }

      showToast('解读完成！', 'success');

      fetchStats();
      fetchRecordings();

    } catch (err) {
      showToast(err.message, 'error');
      if (isAuto) {
        setAppState('monitoring', '继续监听…');
      } else {
        setAppState('idle');
        timerEl.classList.add('hidden');
      }
    }
  }

  // ===== VAD 自动模式 =====

  async function startVAD() {
    try {
      if (!vadSupported) {
        showToast('您的浏览器不支持自动模式', 'error');
        return;
      }

      vadEngine = new VADEngine({
        threshold: settings.vadSensitivity,
        silenceDuration: settings.silenceDuration,
        minRecordingDuration: 500,

        onMeowStart: () => {
          try {
            if (appState === 'monitoring') {
              startAutoRecording();
            }
          } catch (err) {
            console.error('VAD onMeowStart error:', err);
          }
        },

        onMeowEnd: () => {
          try {
            if (appState === 'recording' && recordingTriggerType === 'auto') {
              stopAutoRecording();
            }
          } catch (err) {
            console.error('VAD onMeowEnd error:', err);
          }
        },

        onLevelUpdate: (db) => {
          currentDbLevel = db;
        },

        onFreqData: (freqData, threshold) => {
          currentFreqData = freqData;
        }
      });

      await vadEngine.start();
      // 保存 VAD 的 stream 引用（录制用）
      vadStream = vadEngine.stream;

      setAppState('monitoring', '自动监听中，请靠近猫咪…');
      timerEl.classList.add('hidden');
      showWaveform();

    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('请允许访问麦克风', 'error');
      } else {
        showToast('启动自动模式失败: ' + err.message, 'error');
      }
    }
  }

  function stopVAD() {
    if (vadEngine) {
      vadEngine.stop();
      vadEngine = null;
    }
    vadStream = null;
    stopWaveform();
    setAppState('idle');
    timerEl.classList.add('hidden');
    statusEl.textContent = '';
  }

  // ===== Canvas 波形可视化 =====

  function initCanvas() {
    if (!waveformCanvas) return;
    const container = waveformCanvas.parentElement;
    waveformCanvas.width = container.clientWidth - 32; // 考虑 padding
    waveformCanvas.height = 120;
    canvasCtx = waveformCanvas.getContext('2d');
  }

  function showWaveform() {
    if (!canvasCtx) initCanvas();
    waveformCanvas.classList.remove('hidden');
    drawWaveformLoop();
  }

  function stopWaveform() {
    if (canvasAnimId) {
      cancelAnimationFrame(canvasAnimId);
      canvasAnimId = null;
    }
    waveformCanvas.classList.add('hidden');
  }

  function drawWaveformLoop() {
    if (appState !== 'recording' && appState !== 'monitoring') {
      return;
    }

    try {
      const w = waveformCanvas.width;
      const h = waveformCanvas.height;

      // 清空
      canvasCtx.clearRect(0, 0, w, h);

      if (appState === 'recording') {
        // 录音中：绘制时域波形
        drawOscilloscope(w, h);
      } else if (appState === 'monitoring') {
        // 监听中：绘制频谱柱状图
        drawFrequencyBars(w, h);
      }
    } catch { /* ignore draw errors */ }

    canvasAnimId = requestAnimationFrame(() => drawWaveformLoop());
  }

  function drawOscilloscope(w, h) {
    if (!vadEngine && !mediaRecorder) return;

    let analyser = null;
    if (vadEngine && vadEngine.analyser) {
      analyser = vadEngine.analyser;
    }

    if (!analyser) {
      // 手动模式没有 analyser，简单画一条静音线
      canvasCtx.strokeStyle = '#8b5cf6';
      canvasCtx.lineWidth = 2;
      canvasCtx.shadowColor = '#8b5cf6';
      canvasCtx.shadowBlur = 8;
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, h / 2);
      canvasCtx.lineTo(w, h / 2);
      canvasCtx.stroke();
      canvasCtx.shadowBlur = 0;
      return;
    }

    const bufLen = analyser.fftSize;
    const timeData = new Float32Array(bufLen);
    analyser.getFloatTimeDomainData(timeData);

    // 绘制波形
    canvasCtx.strokeStyle = '#8b5cf6';
    canvasCtx.lineWidth = 2;
    canvasCtx.shadowColor = '#8b5cf6';
    canvasCtx.shadowBlur = 10;
    canvasCtx.beginPath();

    const sliceWidth = w / bufLen;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const v = timeData[i];
      const y = (v * h / 2) + h / 2;
      if (i === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    canvasCtx.lineTo(w, h / 2);
    canvasCtx.stroke();
    canvasCtx.shadowBlur = 0;
  }

  function drawFrequencyBars(w, h) {
    if (!currentFreqData) return;

    const data = currentFreqData;
    const barCount = 32;
    const barWidth = (w / barCount) - 2;
    const step = Math.floor(data.length / barCount);

    // 将 threshold 从 dB 转为 0-255 的近似值
    // threshold 大约在 -50 到 -20 dB，映射到柱状图高度比例
    const thresholdRatio = Math.pow(10, settings.vadSensitivity / 20);
    const thresholdHeight = thresholdRatio * h * 8; // 放大系数

    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += data[i * step + j];
      }
      const avg = sum / step;
      const barHeight = (avg / 255) * h * 0.9;

      const x = i * (barWidth + 2) + 1;

      // 超过阈值的变红色
      if (barHeight > thresholdHeight) {
        canvasCtx.fillStyle = 'rgba(239, 68, 68, 0.8)';
        canvasCtx.shadowColor = '#ef4444';
        canvasCtx.shadowBlur = 6;
      } else {
        canvasCtx.fillStyle = 'rgba(139, 92, 246, 0.6)';
        canvasCtx.shadowColor = '#8b5cf6';
        canvasCtx.shadowBlur = 3;
      }

      canvasCtx.fillRect(x, h - barHeight, barWidth, barHeight);
    }
    canvasCtx.shadowBlur = 0;
  }

  // ===== 设置面板 =====

  function openSettings() {
    settingsPanel.classList.add('open');
    settingsOverlay.classList.add('visible');
  }

  function closeSettings() {
    settingsPanel.classList.remove('open');
    settingsOverlay.classList.remove('visible');
  }

  function initSettingsUI() {
    // 浏览器支持检查
    if (!vadSupported) {
      autoModeOption.classList.add('disabled');
      autoModeOption.querySelector('input').disabled = true;
      vadNotSupported.classList.remove('hidden');
    }

    // 恢复设置到 UI
    syncSettingsToUI();

    // 事件绑定
    settingsBtn.addEventListener('click', openSettings);
    closeSettingsBtn.addEventListener('click', closeSettings);
    settingsOverlay.addEventListener('click', closeSettings);

    // 录音模式
    modeGroup.addEventListener('click', (e) => {
      const option = e.target.closest('.radio-option');
      if (!option || option.classList.contains('disabled')) return;
      const val = option.dataset.value;
      settings.mode = val;
      saveSettings(settings);
      syncModeUI();

      // 如果正在录音，不让切换
      if (appState !== 'idle' && appState !== 'monitoring') {
        showToast('请先停止当前录音', 'info');
        return;
      }

      // 如果从自动切到手动，停止 VAD
      if (val === 'manual' && vadEngine) {
        stopVAD();
      }
    });

    // VAD 灵敏度
    vadSensitivitySlider.addEventListener('input', () => {
      const val = parseInt(vadSensitivitySlider.value, 10);
      settings.vadSensitivity = val;
      vadSensitivityLabel.textContent = getSensitivityLabel(val);
      if (vadEngine) vadEngine.setThreshold(val);
      saveSettings(settings);
    });

    // 安静时长
    silenceDurationSlider.addEventListener('input', () => {
      const val = parseFloat(silenceDurationSlider.value) * 1000;
      settings.silenceDuration = val;
      silenceDurationLabel.textContent = `${silenceDurationSlider.value} 秒`;
      if (vadEngine) vadEngine.setSilenceDuration(val);
      saveSettings(settings);
    });

    // 最大录音时长
    maxDurationSelect.addEventListener('change', () => {
      settings.maxRecordingDuration = parseInt(maxDurationSelect.value, 10);
      saveSettings(settings);
    });
  }

  function syncSettingsToUI() {
    // 模式
    syncModeUI();

    // 灵敏度
    vadSensitivitySlider.value = settings.vadSensitivity;
    vadSensitivityLabel.textContent = getSensitivityLabel(settings.vadSensitivity);

    // 安静时长
    silenceDurationSlider.value = settings.silenceDuration / 1000;
    silenceDurationLabel.textContent = `${settings.silenceDuration / 1000} 秒`;

    // 最大录音时长
    maxDurationSelect.value = String(settings.maxRecordingDuration);
  }

  function syncModeUI() {
    const radios = modeGroup.querySelectorAll('.radio-option');
    radios.forEach(opt => {
      const input = opt.querySelector('input');
      if (opt.dataset.value === settings.mode) {
        opt.classList.add('active');
        input.checked = true;
      } else {
        opt.classList.remove('active');
        input.checked = false;
      }
    });
  }

  function getSensitivityLabel(db) {
    if (db <= -42) return '高灵敏';
    if (db <= -30) return '中等';
    return '低灵敏';
  }

  // ===== 最新结果 =====

  function showLatestResult(data) {
    latestResult.classList.remove('hidden');

    const d = data.data || data.recording || data;
    const interpretation = d.interpretation || {};
    const translation = interpretation.translation || interpretation.text || d.translation || '（无翻译结果）';
    const labels = d.labels || [];

    const translationEl = latestResult.querySelector('.translation');
    const metaEl = latestResult.querySelector('.meta');

    translationEl.textContent = translation;
    metaEl.innerHTML = renderLabels(labels);

    latestResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ===== 历史记录 =====

  function renderHistory(items) {
    if (!items || items.length === 0) {
      historyList.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    historyList.innerHTML = items.map(item => renderHistoryItem(item)).join('');
    bindHistoryEvents();
  }

  function renderHistoryItem(item) {
    const id = item.id || item._id;
    const time = formatDateTime(item.createdAt || item.created_at || item.timestamp);
    const duration = formatDuration(item.duration);
    const interpretation = item.interpretation || {};
    const translation = interpretation.translation || interpretation.text || item.translation || '';
    const summary = truncate(translation, 50);
    const labels = item.labels || [];

    return `
      <div class="history-item" data-id="${id}">
        <div class="item-header">
          <div class="item-main">
            <div class="item-time">${time} · ${duration}</div>
            <div class="item-summary">${summary || '未解读'}</div>
            <div class="item-tags">${renderLabels(labels)}</div>
          </div>
          <div class="item-actions">
            <button class="btn-icon play-btn" data-id="${id}" title="播放">▶</button>
            <button class="btn-icon delete-btn" data-id="${id}" title="删除">✕</button>
          </div>
        </div>
      </div>
    `;
  }

  function bindHistoryEvents() {
    historyList.querySelectorAll('.history-item').forEach(el => {
      const mainArea = el.querySelector('.item-main');
      mainArea.addEventListener('click', () => toggleDetail(el));
    });

    historyList.querySelectorAll('.play-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlay(btn);
      });
    });

    historyList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDelete(btn);
      });
    });
  }

  async function toggleDetail(el) {
    const id = el.dataset.id;
    if (el.classList.contains('expanded')) {
      el.classList.remove('expanded');
      const detail = el.querySelector('.detail');
      if (detail) detail.remove();
      return;
    }

    try {
      const data = await apiFetch(`/api/recordings/${id}`);
      const d = data.data || data;
      const interpretation = d.interpretation || {};
      const translation = interpretation.translation || interpretation.text || d.translation || '（无翻译结果）';
      const advice = interpretation.advice || interpretation.suggestion || '';
      const confidence = interpretation.confidence;
      const labels = d.labels || [];

      el.classList.add('expanded');

      const oldDetail = el.querySelector('.detail');
      if (oldDetail) oldDetail.remove();

      const detailDiv = document.createElement('div');
      detailDiv.className = 'detail';
      detailDiv.innerHTML = `
        <div class="interpretation">${translation}</div>
        ${advice ? `<div class="advice">💡 ${advice}</div>` : ''}
        <div class="detail-meta">
          ${confidence !== undefined ? `<span>置信度: <span class="confidence">${Math.round(confidence * 100)}%</span></span>` : ''}
          ${labels.length ? `<span>情绪: ${labels.map(l => LABEL_CN[l] || l).join('、')}</span>` : ''}
        </div>
      `;

      el.appendChild(detailDiv);
    } catch (err) {
      showToast('加载详情失败: ' + err.message, 'error');
    }
  }

  function togglePlay(btn) {
    const id = btn.dataset.id;
    const audioUrl = `${API_BASE}/api/recordings/${id}/audio`;

    if (currentAudio && btn.classList.contains('playing')) {
      currentAudio.pause();
      currentAudio = null;
      btn.classList.remove('playing');
      btn.textContent = '▶';
      return;
    }

    if (currentAudio) {
      currentAudio.pause();
      historyList.querySelectorAll('.play-btn.playing').forEach(b => {
        b.classList.remove('playing');
        b.textContent = '▶';
      });
    }

    const audio = new Audio(audioUrl);
    audio.crossOrigin = 'anonymous';
    currentAudio = audio;
    btn.classList.add('playing');
    btn.textContent = '⏸';

    audio.play().catch(err => {
      showToast('播放失败: ' + err.message, 'error');
      btn.classList.remove('playing');
      btn.textContent = '▶';
      currentAudio = null;
    });

    audio.onended = () => {
      btn.classList.remove('playing');
      btn.textContent = '▶';
      currentAudio = null;
    };
  }

  async function handleDelete(btn) {
    const id = btn.dataset.id;
    if (!confirm('确定删除这条录音吗？')) return;

    try {
      await deleteRecording(id);
      showToast('已删除', 'success');

      const item = btn.closest('.history-item');
      if (item) {
        item.style.opacity = '0';
        item.style.transform = 'translateX(40px)';
        item.style.transition = 'all 0.3s ease';
        setTimeout(() => {
          item.remove();
          if (historyList.children.length === 0) {
            emptyState.classList.remove('hidden');
          }
        }, 300);
      }

      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }

      fetchStats();
    } catch (err) {
      showToast('删除失败: ' + err.message, 'error');
    }
  }

  // ===== 主按钮点击 =====

  function handleRecordBtnClick() {
    try {
      if (settings.mode === 'manual') {
        // 手动模式
        if (appState === 'idle') {
          startRecording();
        } else if (appState === 'recording') {
          stopRecording();
        }
        // uploading / interpreting 状态不可点击
      } else {
        // 自动模式
        if (appState === 'idle') {
          startVAD();
        } else if (appState === 'monitoring') {
          stopVAD();
        }
        // recording / uploading / interpreting 由 VAD 控制
      }
    } catch (err) {
      console.error('handleRecordBtnClick error:', err);
      showToast('操作失败: ' + err.message, 'error');
    }
  }

  // ===== 事件绑定 =====

  recordBtn.addEventListener('click', handleRecordBtnClick);

  // Canvas resize
  window.addEventListener('resize', () => {
    if (waveformCanvas && !waveformCanvas.classList.contains('hidden')) {
      initCanvas();
    }
  });

  // ===== 初始化 =====

  document.addEventListener('DOMContentLoaded', () => {
    initCanvas();
    initSettingsUI();

    // 根据设置更新按钮初始状态
    setAppState('idle');

    fetchStats();
    fetchRecordings();
  });

})();
