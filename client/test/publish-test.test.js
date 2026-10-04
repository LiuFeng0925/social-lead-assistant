'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const publish = require('../src/publish-test');

test('发布测试素材固定为一张本地图片和 1 / #1 文案', () => {
  assert.equal(publish.TEST_TITLE, '1');
  assert.equal(publish.TEST_BODY, '1\n#1');
  assert.equal(path.basename(publish.TEST_IMAGE_PATH), 'current-xhs-screen.png');
  assert.match(publish.CREATOR_PUBLISH_URL, /creator\.xiaohongshu\.com\/publish/);
});

test('发布编辑器字段优先按标题和正文语义定位', () => {
  const fields = [
    { tag: 'INPUT', visible: true, placeholder: '填写标题会有更多赞哦～', h: 32 },
    { tag: 'DIV', visible: true, placeholder: '', cls: 'content-editor', h: 200 }
  ];
  assert.equal(publish.selectField(fields, 'title'), fields[0]);
  assert.equal(publish.selectField(fields, 'body'), fields[1]);
});

test('发布测试可识别创作后台的上传图文入口', () => {
  assert.match(publish.imageModeProbeScript(), /上传图文/);
  assert.match(publish.imageModeProbeScript(), /innerHeight/);
});
