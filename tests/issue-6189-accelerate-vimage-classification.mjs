import test from 'node:test';
import assert from 'node:assert/strict';
import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { apiInfo } from '../js/blocks.js';

test('issue #6189: Accelerate vImage functions are classified as memory convert, not UI', () => {
  const vimageNames = [
    'vImageScale_ARGB8888',
    '_vImageScale_ARGB8888',
    'vImageRotate90_Planar8',
    'vImageConvolve_ARGB8888',
    'vImageHistogramCalculation_ARGB8888',
  ];

  for (const name of vimageNames) {
    const extra = extraApiInfo(name);
    assert.ok(extra, `${name} must be classified`);
    assert.equal(extra.id, 'accelerate_vimage');
    assert.equal(extra.cat, 'memory');
    assert.equal(extra.effect, 'convert');
    assert.notEqual(extra.cat, 'ui');
    assert.notEqual(extra.effect, 'ui');

    const info = apiInfo(name);
    assert.ok(info, `${name} must resolve in apiInfo`);
    assert.equal(info.id, 'accelerate_vimage');
    assert.equal(info.cat, 'memory');
    assert.equal(info.effect, 'convert');
    assert.notEqual(info.cat, 'ui');
    assert.notEqual(info.effect, 'ui');
  }
});

test('issue #6189: apple_ui_media retains genuine UI and media symbols', () => {
  const uiNames = [
    'UIApplicationMain',
    'UIRectFill',
    'UIAccessibilityPostNotification',
    'CAFrameRateRangeMake',
    'CMSampleBufferCreate',
    'CVOpenGLESQueueCreate',
    'UTTypeConformsTo',
  ];

  for (const name of uiNames) {
    const extra = extraApiInfo(name);
    assert.ok(extra, `${name} must remain classified`);
    assert.equal(extra.id, 'apple_ui_media');
    assert.equal(extra.cat, 'ui');
    assert.equal(extra.effect, 'ui');
  }
});

console.log('issue #6189 test file loaded.');
