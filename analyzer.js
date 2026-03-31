const fs = require('fs');
const path = require('path');

/**
 * 音频特征提取（v1.0 简化版）
 * 不做 FFT/DSP，只提取基础元数据
 */

// 根据时间段判断 day_period
function getDayPeriod(hour) {
  if (hour >= 6 && hour < 8) return '清晨';
  if (hour >= 8 && hour < 12) return '上午';
  if (hour >= 12 && hour < 17) return '下午';
  if (hour >= 17 && hour < 20) return '傍晚';
  return '深夜'; // 20-6
}

/**
 * 按格式估算比特率 (kbps)
 */
function getEstimatedBitrate(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') return 1411;
  if (ext === '.mp3' || ext === '.m4a') return 128;
  // webm, ogg 等
  return 32;
}

/**
 * 分析音频文件，提取基础特征
 * @param {string} filePath - 音频文件路径
 * @param {number|null} actualDurationMs - 前端传来的实际时长（毫秒），可选
 * @returns {object} 特征 JSON
 */
function analyzeAudio(filePath, actualDurationMs) {
  const stats = fs.statSync(filePath);
  const now = new Date();

  // 从小时数推算时间段
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const fileSizeBytes = stats.size;

  // 优先使用前端传来的实际时长
  let durationEstimateMs;
  if (actualDurationMs && actualDurationMs > 0) {
    durationEstimateMs = actualDurationMs;
  } else {
    const bitrate = getEstimatedBitrate(filePath);
    const estimatedDurationSec = Math.round(fileSizeBytes / (bitrate * 1024 / 8));
    durationEstimateMs = estimatedDurationSec * 1000;
  }

  return {
    duration_estimate: durationEstimateMs,
    file_size: fileSizeBytes,
    time_of_day: timeStr,
    day_period: getDayPeriod(hour)
  };
}

module.exports = { analyzeAudio, getDayPeriod };
