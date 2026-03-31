/**
 * 猫语翻译器 v1.0 — 前端逻辑
 * 纯 JS，无框架依赖
 */

(function () {
  'use strict';

  // ===== 常量 =====
  const API_BASE = '';  // 同域，直接用相对路径
  const PAGELIMIT = 20;

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

  // ===== 状态 =====
  let state = 'idle'; // idle | recording | uploading | interpreting
  let mediaRecorder = null;
  let audioChunks = [];
  let timerInterval = null;
  let recordStartTime = null;
  let currentAudio = null; // 当前播放的 audio 元素

  // ===== DOM 元素 =====
  const $ = (sel) => document.querySelector(sel);
  const recordBtn = $('#recordBtn');
  const timerEl = $('#timer');
  const statusEl = $('#recordingStatus');
  const latestResult = $('#latestResult');
  const historyList = $('#historyList');
  const emptyState = $('#emptyState');
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
    // 触发动画
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ===== 工具函数 =====

  // 格式化秒数为 MM:SS
  function formatTime(seconds) {
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // 格式化日期时间
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

  // 格式化时长（秒）
  function formatDuration(sec) {
    if (!sec && sec !== 0) return '';
    const s = Math.round(sec);
    if (s < 60) return `${s}秒`;
    return `${Math.floor(s / 60)}分${s % 60}秒`;
  }

  // 截取文字
  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  // 渲染情绪标签 HTML
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

  // 获取统计数据
  async function fetchStats() {
    try {
      const data = await apiFetch('/api/stats');
      const today = data.today || 0;
      const total = data.total || 0;
      $('#headerStats').textContent = `今日 ${today} 条 / 总计 ${total} 条`;
    } catch {
      // 静默失败
    }
  }

  // 获取录音列表
  async function fetchRecordings() {
    try {
      const data = await apiFetch(`/api/recordings?page=1&limit=${PAGELIMIT}`);
      const items = data.items || data.data || data || [];
      renderHistory(items);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // 上传音频
  async function uploadAudio(blob) {
    const formData = new FormData();
    // 根据 blob 类型确定文件名
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
    formData.append('audio', blob, `recording.${ext}`);
    return apiFetch('/api/recordings/upload', {
      method: 'POST',
      body: formData
    });
  }

  // 触发解读
  async function interpretRecording(id) {
    return apiFetch(`/api/recordings/${id}/interpret`, { method: 'POST' });
  }

  // 删除录音
  async function deleteRecording(id) {
    return apiFetch(`/api/recordings/${id}`, { method: 'DELETE' });
  }

  // ===== 录音模块 =====

  function setState(newState, statusText) {
    state = newState;
    // 更新按钮状态
    recordBtn.className = 'record-btn';
    const icon = recordBtn.querySelector('.icon');
    const text = recordBtn.querySelector('.text');

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

    if (statusText !== undefined) {
      statusEl.textContent = statusText;
      statusEl.className = 'status';
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 选择 mimeType
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
        // 停止所有音轨
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        audioChunks = [];

        await handleUpload(blob);
      };

      mediaRecorder.start(250); // 每250ms收集一次
      recordStartTime = Date.now();
      setState('recording');

      // 启动计时器
      timerEl.classList.remove('hidden');
      timerEl.textContent = '00:00';
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        timerEl.textContent = formatTime(elapsed);
      }, 200);

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

  async function handleUpload(blob) {
    setState('uploading', '正在上传…');

    try {
      const uploadResult = await uploadAudio(blob);
      const recordingId = uploadResult.id || uploadResult.data?.id || uploadResult.recording?.id;

      if (!recordingId) {
        showToast('上传成功但未获取到录音 ID', 'error');
        setState('idle');
        return;
      }

      setState('interpreting', 'AI 正在解读猫叫声…');

      const interpretResult = await interpretRecording(recordingId);

      // 显示结果
      showLatestResult(interpretResult);

      setState('idle');
      showToast('解读完成！', 'success');

      // 刷新列表和统计
      fetchStats();
      fetchRecordings();

    } catch (err) {
      showToast(err.message, 'error');
      setState('idle');
    }
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

    // 滚动到结果区
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

    // 绑定事件
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
    // 点击展开/收起
    historyList.querySelectorAll('.history-item').forEach(el => {
      const mainArea = el.querySelector('.item-main');
      mainArea.addEventListener('click', () => toggleDetail(el));
    });

    // 播放按钮
    historyList.querySelectorAll('.play-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlay(btn);
      });
    });

    // 删除按钮
    historyList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDelete(btn);
      });
    });
  }

  async function toggleDetail(el) {
    const id = el.dataset.id;
    // 如果已展开则收起
    if (el.classList.contains('expanded')) {
      el.classList.remove('expanded');
      const detail = el.querySelector('.detail');
      if (detail) detail.remove();
      return;
    }

    // 加载详情
    try {
      const data = await apiFetch(`/api/recordings/${id}`);
      const d = data.data || data;
      const interpretation = d.interpretation || {};
      const translation = interpretation.translation || interpretation.text || d.translation || '（无翻译结果）';
      const advice = interpretation.advice || interpretation.suggestion || '';
      const confidence = interpretation.confidence;
      const labels = d.labels || [];

      el.classList.add('expanded');

      // 移除旧的 detail（如果有）
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

    // 如果当前正在播放，则暂停
    if (currentAudio && btn.classList.contains('playing')) {
      currentAudio.pause();
      currentAudio = null;
      btn.classList.remove('playing');
      btn.textContent = '▶';
      return;
    }

    // 停止其他正在播放的
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

      // 移除元素
      const item = btn.closest('.history-item');
      if (item) {
        item.style.opacity = '0';
        item.style.transform = 'translateX(40px)';
        item.style.transition = 'all 0.3s ease';
        setTimeout(() => {
          item.remove();
          // 检查是否已空
          if (historyList.children.length === 0) {
            emptyState.classList.remove('hidden');
          }
        }, 300);
      }

      // 如果播放的是被删除的
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }

      fetchStats();
    } catch (err) {
      showToast('删除失败: ' + err.message, 'error');
    }
  }

  // ===== 事件绑定 =====

  recordBtn.addEventListener('click', () => {
    if (state === 'idle') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
    // uploading / interpreting 状态按钮不可点击（pointer-events: none）
  });

  // ===== 初始化 =====

  document.addEventListener('DOMContentLoaded', () => {
    fetchStats();
    fetchRecordings();
  });

})();
