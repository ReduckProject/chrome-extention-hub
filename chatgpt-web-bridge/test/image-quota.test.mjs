import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageGenerationQuota, parseImageGenerationQuota } from '../src/image-quota.mjs';

test('image quota parses an absolute Chinese reset time before a relative fallback', () => {
  const observed = new Date(2026, 8, 14, 22, 23, 10, 0);
  const quota = parseImageGenerationQuota('图像额度已用完。请在明天 02:04后重试。上限将在 4小时 后重置。', observed);
  const reset = new Date(quota.resetAt);

  assert.equal(quota.type, 'image_generation');
  assert.equal(quota.exhausted, true);
  assert.equal(quota.source, 'absolute_text');
  assert.equal(quota.precision, 'minute');
  assert.equal(quota.resetAtLocal, '2026-09-15 02:04');
  assert.equal(reset.getFullYear(), 2026);
  assert.equal(reset.getMonth(), 8);
  assert.equal(reset.getDate(), 15);
  assert.equal(reset.getHours(), 2);
  assert.equal(reset.getMinutes(), 4);
  assert.equal(quota.resetAfterMs, reset.getTime() - observed.getTime());
});

test('image quota converts the observed relative reset duration to an absolute timestamp', () => {
  const observed = new Date(2026, 8, 14, 22, 23, 10, 0).getTime();
  const quota = parseImageGenerationQuota('你已达到 Plus 套餐的图像生成请求上限。上限将在 4小时 后重置，届时可创建更多图像。', observed);

  assert.equal(isImageGenerationQuota('You have run out of image generations.'), true);
  assert.equal(quota.source, 'relative_text');
  assert.equal(quota.precision, 'relative');
  assert.equal(quota.resetAt, new Date(observed + 4 * 60 * 60 * 1000).toISOString());
  assert.equal(quota.resetAfterMs, 4 * 60 * 60 * 1000);
});

test('quota parsing recognizes English exhaustion and does not classify ordinary image text', () => {
  const observed = Date.UTC(2026, 8, 14, 14, 23, 10);
  const quota = parseImageGenerationQuota('You have run out of image generations. Try again tomorrow at 2:04 AM.', observed);

  assert.equal(quota.source, 'absolute_text');
  assert.equal(new Date(quota.resetAt).getHours(), 2);
  assert.equal(new Date(quota.resetAt).getMinutes(), 4);
  assert.equal(parseImageGenerationQuota('Here is an image generation prompt.', observed), null);
});

test('quota exhaustion is reported even when the page gives no reset time', () => {
  const quota = parseImageGenerationQuota('图片生成次数已用完，请稍后再试。', 100000);

  assert.equal(quota.exhausted, true);
  assert.equal(quota.resetAt, null);
  assert.equal(quota.resetAtLocal, null);
  assert.equal(quota.source, 'unavailable');
  assert.equal(quota.precision, 'unknown');
});
