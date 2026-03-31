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
 * 分析音频文件，提取基础特征
 * @param {string} filePath - 音频文件路径
 * @returns {object} 特征 JSON
 */
function analyzeAudio(filePath) {
  const stats = fs.statSync(filePath);
  const now = new Date();

  // 从小时数推算时间段
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // 粗略估计时长：WebM/OGG 大约 16-32kbps，取中间值 ~24kbps
  const fileSizeBytes = stats.size;
  const estimatedDurationSec = Math.round(fileSizeBytes / (24 * 1024 / 8));
  const durationEstimateMs = estimatedDurationSec * 1000;

  return {
    duration_estimate: durationEstimateMs,
    file_size: fileSizeBytes,
    time_of_day: timeStr,
    day_period: getDayPeriod(hour)
  };
}

module.exports = { analyzeAudio, getDayPeriod };
