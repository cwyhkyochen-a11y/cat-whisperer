const fs = require('fs');
const path = require('path');

const FFT = require('fft.js');

// Canvas 尝试加载，失败则用 SVG fallback
let Canvas;
try {
  Canvas = require('canvas');
  // 测试 native binding 是否可用
  Canvas.createCanvas(1, 1);
} catch {
  Canvas = null;
}

/**
 * 生成频谱图 + 数值特征
 * @param {string} audioPath - 音频文件路径
 * @returns {{ spectrogramBuffer: Buffer|string|null, features: object, spectrogramFilename: string|null }}
 */
async function generateSpectrogram(audioPath) {
  // 1. 读取 PCM 数据
  const pcmData = await decodeAudioToPcm(audioPath);
  if (!pcmData) {
    return { spectrogramBuffer: null, features: extractBasicFeatures(audioPath), spectrogramFilename: null };
  }

  // 2. FFT 分析
  const analysis = performFFT(pcmData.samples, pcmData.sampleRate);

  // 3. 渲染频谱图（PNG 或 SVG）
  const spectrogramBuffer = await renderSpectrogram(analysis, pcmData.duration);

  // 4. 提取数值特征
  const features = extractFeatures(pcmData, analysis);

  return {
    spectrogramBuffer,
    features,
    format: spectrogramBuffer ? (Canvas ? 'png' : 'svg') : null
  };
}

/**
 * 解码音频为 PCM
 * 优先用 ffmpeg，fallback 解析 WAV
 */
async function decodeAudioToPcm(audioPath) {
  const ext = path.extname(audioPath).toLowerCase();

  // WAV 文件直接解析
  if (ext === '.wav') {
    return parseWavFile(audioPath);
  }

  // 其他格式用 ffmpeg 转换
  try {
    const { execSync } = require('child_process');
    const tmpPcm = audioPath + '.pcm';
    execSync(`ffmpeg -y -i "${audioPath}" -f s16le -ar 16000 -ac 1 "${tmpPcm}"`, {
      timeout: 10000,
      stdio: 'pipe'
    });
    const samples = new Int16Array(fs.readFileSync(tmpPcm).buffer);
    fs.unlinkSync(tmpPcm);

    return {
      samples,
      sampleRate: 16000,
      duration: samples.length / 16000
    };
  } catch {
    return null;
  }
}

/**
 * 解析 WAV 文件头部提取 PCM
 */
function parseWavFile(filePath) {
  const buf = fs.readFileSync(filePath);

  // 验证 RIFF 头
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  // 查找 fmt 和 data chunk
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let channels = 1;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    }

    if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset < 0) return null;

  // 读取 PCM 样本（转为 mono float）
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = dataSize / (bytesPerSample * channels);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const byteOffset = dataOffset + (i * channels + ch) * bytesPerSample;
      if (bitsPerSample === 16) {
        sum += buf.readInt16LE(byteOffset) / 32768;
      } else if (bitsPerSample === 8) {
        sum += (buf.readUInt8(byteOffset) - 128) / 128;
      }
    }
    samples[i] = sum / channels;
  }

  return {
    samples,
    sampleRate,
    duration: numSamples / sampleRate
  };
}

/**
 * FFT 分析
 */
function performFFT(samples, sampleRate) {
  const fftSize = 1024;
  const hopSize = fftSize / 2;
  const numFrames = Math.floor((samples.length - fftSize) / hopSize);
  const fft = new FFT(fftSize);

  const spectrogram = [];
  const energyOverTime = [];

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    const window = new Float64Array(fftSize);

    // 汉明窗
    for (let i = 0; i < fftSize; i++) {
      window[i] = samples[start + i] * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }

    const out = fft.createComplexArray();
    fft.realTransform(out, window);

    // 计算功率谱
    const power = new Float64Array(fftSize / 2);
    let frameEnergy = 0;
    for (let i = 0; i < fftSize / 2; i++) {
      const re = out[i * 2];
      const im = out[i * 2 + 1];
      power[i] = Math.sqrt(re * re + im * im);
      frameEnergy += power[i] * power[i];
    }

    spectrogram.push(power);
    energyOverTime.push(10 * Math.log10(frameEnergy + 1e-10));
  }

  // 频率轴
  const freqs = [];
  for (let i = 0; i < fftSize / 2; i++) {
    freqs.push(i * sampleRate / fftSize);
  }

  return { spectrogram, freqs, numFrames, fftSize, sampleRate, hopSize, energyOverTime };
}

/**
 * 渲染频谱图（PNG 或 SVG fallback）
 */
async function renderSpectrogram(analysis, duration) {
  if (Canvas) {
    return renderPngSpectrogram(analysis, duration);
  }
  return renderSvgSpectrogram(analysis, duration);
}

/**
 * 渲染频谱图为 PNG（canvas）
 */
function renderPngSpectrogram(analysis, duration) {
  const { spectrogram, freqs, numFrames } = analysis;
  const width = Math.min(numFrames, 600);
  const height = 300;

  const { createCanvas } = Canvas;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#fafbfc';
  ctx.fillRect(0, 0, width, height);

  // 找全局最大值用于归一化
  let globalMax = findGlobalMax(spectrogram);

  // 绘制频谱
  const maxFreqBin = Math.min(freqs.length, Math.floor(freqs.length * 8000 / (analysis.sampleRate / 2)));
  const binPerPixel = maxFreqBin / height;

  for (let x = 0; x < width; x++) {
    const frameIdx = Math.floor(x * numFrames / width);
    if (frameIdx >= spectrogram.length) continue;

    for (let y = 0; y < height; y++) {
      const bin = Math.floor((height - 1 - y) * binPerPixel);
      const val = spectrogram[frameIdx][bin] / globalMax;
      const color = heatmapColor(val);
      ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // 绘制坐标轴
  ctx.fillStyle = '#a1a1aa';
  ctx.font = '10px sans-serif';
  ctx.fillText('8kHz', 4, 12);
  ctx.fillText('4kHz', 4, height / 2);
  ctx.fillText('0Hz', 4, height - 4);
  ctx.fillText(`${duration.toFixed(1)}s`, width - 36, height - 4);

  return canvas.toBuffer('image/png');
}

/**
 * 渲染频谱图为 SVG（fallback，简化版避免巨大 DOM）
 */
function renderSvgSpectrogram(analysis, duration) {
  const { spectrogram, freqs, numFrames } = analysis;
  const width = Math.min(numFrames, 300); // 降分辨率
  const height = 150;

  // 生成像素数据数组（RGBA）
  let globalMax = findGlobalMax(spectrogram);

  const maxFreqBin = Math.min(freqs.length, Math.floor(freqs.length * 8000 / (analysis.sampleRate / 2)));
  const binPerPixel = maxFreqBin / height;
  const pixels = new Uint8Array(width * height * 4);

  for (let x = 0; x < width; x++) {
    const frameIdx = Math.floor(x * spectrogram.length / width);
    for (let y = 0; y < height; y++) {
      const bin = Math.floor((height - 1 - y) * binPerPixel);
      const val = spectrogram[frameIdx]?.[bin] / globalMax || 0;
      const offset = (y * width + x) * 4;
      const c = heatmapColor(val);
      pixels[offset] = c[0];
      pixels[offset + 1] = c[1];
      pixels[offset + 2] = c[2];
      pixels[offset + 3] = 255;
    }
  }

  // 如果有 Canvas，用 Canvas 生成 PNG 再嵌入 SVG
  if (Canvas) {
    const { createCanvas } = Canvas;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    const pngBase64 = canvas.toBuffer('image/png').toString('base64');
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<image href="data:image/png;base64,${pngBase64}" width="${width}" height="${height}"/>` +
      `<text x="4" y="12" fill="#a1a1aa" font-size="10" font-family="sans-serif">8kHz</text>` +
      `<text x="4" y="${height / 2}" fill="#a1a1aa" font-size="10" font-family="sans-serif">4kHz</text>` +
      `<text x="4" y="${height - 4}" fill="#a1a1aa" font-size="10" font-family="sans-serif">0Hz</text>` +
      `<text x="${width - 36}" y="${height - 4}" fill="#a1a1aa" font-size="10" font-family="sans-serif">${duration.toFixed(1)}s</text>` +
      `</svg>`,
      'utf-8'
    );
  }

  // 无 Canvas：返回简单说明 SVG
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#fafbfc"/>` +
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#a1a1aa" font-size="14">频谱图（需要安装 Canvas 依赖）</text>` +
    `</svg>`,
    'utf-8'
  );
}

/**
 * 找全局最大值
 */
function findGlobalMax(spectrogram) {
  let globalMax = 0;
  for (const frame of spectrogram) {
    for (const val of frame) {
      if (val > globalMax) globalMax = val;
    }
  }
  return globalMax || 1;
}

/**
 * 热力图颜色：蓝→紫→红→黄
 */
function heatmapColor(val) {
  const r = Math.floor(Math.min(255, val * 510));
  const g = Math.floor(Math.max(0, val < 0.5 ? 0 : (val - 0.5) * 510));
  const b = Math.floor(Math.min(255, Math.max(0, (1 - val * 2)) * 255));
  return [r, g, b];
}

/**
 * 提取数值特征
 */
function extractFeatures(pcmData, analysis) {
  const { samples, sampleRate, duration } = pcmData;
  const { spectrogram, freqs, energyOverTime } = analysis;

  // 1. 主频率（能量最高的频率）
  let maxEnergy = 0;
  let dominantFreqBin = 0;
  const avgPower = new Float64Array(spectrogram[0].length);
  for (const frame of spectrogram) {
    for (let i = 0; i < frame.length; i++) {
      avgPower[i] += frame[i];
    }
  }
  for (let i = 0; i < avgPower.length; i++) {
    if (avgPower[i] > maxEnergy) {
      maxEnergy = avgPower[i];
      dominantFreqBin = i;
    }
  }
  const dominantFreq = freqs[dominantFreqBin];

  // 2. 频率范围（有能量的最低到最高频率）
  const threshold = maxEnergy * 0.05;
  let lowBin = 0, highBin = avgPower.length - 1;
  for (let i = 0; i < avgPower.length; i++) {
    if (avgPower[i] > threshold) { lowBin = i; break; }
  }
  for (let i = avgPower.length - 1; i >= 0; i--) {
    if (avgPower[i] > threshold) { highBin = i; break; }
  }
  const freqRange = [freqs[lowBin], freqs[highBin]];

  // 3. 平均能量 dB
  let totalEnergy = 0;
  for (const e of energyOverTime) totalEnergy += e;
  const energyDb = totalEnergy / energyOverTime.length;

  // 4. 波峰数（能量曲线的峰值数）
  let peakCount = 0;
  for (let i = 1; i < energyOverTime.length - 1; i++) {
    if (energyOverTime[i] > energyOverTime[i-1] && energyOverTime[i] > energyOverTime[i+1]) {
      peakCount++;
    }
  }

  // 5. 频谱重心
  let spectralCentroid = 0;
  let totalPower = 0;
  for (let i = 0; i < avgPower.length; i++) {
    spectralCentroid += freqs[i] * avgPower[i];
    totalPower += avgPower[i];
  }
  spectralCentroid = totalPower > 0 ? spectralCentroid / totalPower : 0;

  // 6. 过零率
  let zeroCrossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0 && samples[i-1] < 0) || (samples[i] < 0 && samples[i-1] >= 0)) {
      zeroCrossings++;
    }
  }
  const zeroCrossingRate = zeroCrossings / samples.length;

  // 7. 节奏（波峰间隔的标准差，越小越规律）
  const peakTimes = [];
  for (let i = 1; i < energyOverTime.length - 1; i++) {
    if (energyOverTime[i] > energyOverTime[i-1] && energyOverTime[i] > energyOverTime[i+1]) {
      peakTimes.push(i * analysis.hopSize / sampleRate);
    }
  }
  let tempo = 0;
  if (peakTimes.length > 1) {
    const intervals = [];
    for (let i = 1; i < peakTimes.length; i++) {
      intervals.push(peakTimes[i] - peakTimes[i-1]);
    }
    const avgInterval = intervals.reduce((a,b) => a+b, 0) / intervals.length;
    tempo = avgInterval > 0 ? 1 / avgInterval : 0;
  }

  return {
    duration_ms: Math.round(duration * 1000),
    dominant_freq: Math.round(dominantFreq),
    freq_range: [Math.round(freqRange[0]), Math.round(freqRange[1])],
    energy_db: Math.round(energyDb * 10) / 10,
    peak_count: peakCount,
    tempo: Math.round(tempo * 10) / 10,
    spectral_centroid: Math.round(spectralCentroid),
    zero_crossing_rate: Math.round(zeroCrossingRate * 10000) / 10000,
    sample_rate: sampleRate
  };
}

/**
 * 提取基本特征（无法 FFT 时的 fallback）
 */
function extractBasicFeatures(audioPath) {
  const stat = fs.statSync(audioPath);
  return {
    duration_ms: null,
    file_size: stat.size,
    dominant_freq: null,
    freq_range: null,
    energy_db: null,
    peak_count: null,
    tempo: null,
    spectral_centroid: null,
    zero_crossing_rate: null,
    sample_rate: null,
    _fallback: true
  };
}

module.exports = { generateSpectrogram };
