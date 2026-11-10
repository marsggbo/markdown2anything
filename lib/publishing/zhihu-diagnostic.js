'use strict';

const { performance } = require('perf_hooks');
const { safeUrl, failure } = require('./http');

// The diagnostic contains no document text, local paths or personal data. It
// follows the same media client as article preparation, without a publish call.
function testImage() {
  const { PNG } = require('pngjs');
  const image = new PNG({ width: 320, height: 180 });
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const swatch = x >= 32 && x < 288 && y >= 40 && y < 140;
      const stripe = swatch && Math.floor((x - 32) / 64) % 2 === 0;
      image.data[i] = swatch ? (stripe ? 49 : 137) : 246;
      image.data[i + 1] = swatch ? (stripe ? 92 : 118) : 248;
      image.data[i + 2] = swatch ? (stripe ? 173 : 177) : 252;
      image.data[i + 3] = 255;
    }
  }
  return { buffer: PNG.sync.write(image), name: 'markdown2anything-upload-test.png', mimeType: 'image/png' };
}

async function runZhihuUploadTest({ credentials, request, uploadImage } = {}) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  if (!credentials || !['appKey', 'appSecret'].every(field =>
    typeof credentials[field] === 'string' && credentials[field].trim())) {
    throw failure('请先配置知乎 AppKey 与 AppSecret，再测试图片上传');
  }
  const upload = uploadImage || require('./zhihu-media').uploadImage;
  const warnings = new Set();
  const result = await upload({ credentials, ...(request ? { request } : {}) }, testImage(), { warnings });
  if (!result || !safeUrl(result.url)) throw failure('知乎测试图上传未返回有效的 HTTPS 地址');
  return {
    platform: 'zhihu', status: 'passed',
    message: '测试图上传成功；本次未发布文章，文章发布权限尚未验证',
    checks: [
      { label: 'image-upload', status: 'passed', message: '知乎已接收插件测试图并返回真实图片地址' },
      ...[...warnings].map(message => ({ label: 'watermark', status: 'warning', message })),
      { label: 'publishing', status: 'warning', message: '未调用文章发布接口；实际发布仍需最终确认' },
    ],
    durationMs: Math.max(0, Math.round(performance.now() - started)), checkedAt,
  };
}

module.exports = { runZhihuUploadTest };
