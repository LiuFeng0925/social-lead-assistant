'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../src/inbox-utils');

const NOW = new Date('2026-07-01T12:00:00+08:00');

test('relative notification times are within recent days', () => {
  for (const raw of ['刚刚', '1分钟前', '59分钟前', '1小时前', '23小时前', '今天']) {
    const parsed = inbox.parseNotificationTime(raw, NOW);
    assert.ok(parsed.daysAgo === 0 || parsed.daysAgo === 1, raw);
    assert.equal(inbox.isWithinRecentDays(raw, 7, NOW), true, raw);
  }
});

test('date strings and day-relative strings compare against recent window', () => {
  assert.equal(inbox.parseNotificationTime('昨天', NOW).daysAgo, 1);
  assert.equal(inbox.parseNotificationTime('2天前', NOW).daysAgo, 2);
  assert.equal(inbox.isWithinRecentDays('8天前', 7, NOW), false);
  assert.equal(inbox.isWithinRecentDays('06-30', 7, NOW), true);
});

test('exact ISO and timestamp values are parsed when the page exposes them', () => {
  assert.equal(inbox.parseNotificationTime('2026-07-01T03:01:02.000Z', NOW).confidence, 'exact');
  assert.equal(inbox.parseNotificationTime('2026-07-01 11:01:02', NOW).confidence, 'exact');
  assert.equal(inbox.parseNotificationTime('1782874862000', NOW).confidence, 'exact');
});

test('unknown notification time does not force scanner to stop early', () => {
  assert.equal(inbox.parseNotificationTime('', NOW).confidence, 'unknown');
  assert.equal(inbox.shouldStopForRecentWindow('', 7, NOW), false);
  assert.equal(inbox.shouldStopForRecentWindow('8天前', 7, NOW), true);
});

test('stable event key ignores relative display time', () => {
  const a = inbox.prepareInboxItem({ type: 'comment', nick: '流风流', link: '/user/profile/abc', content: '我想租朝阳', date: '33分钟前' }, NOW);
  const b = inbox.prepareInboxItem({ type: 'comment', nick: '流风流', link: '/user/profile/abc', content: ' 我想租朝阳 ', date: '41分钟前' }, NOW);
  assert.equal(a.event_key, b.event_key);
  assert.equal(a.dedup_key, a.event_key);
});

test('non-comment labels are not auto-replyable incoming content', () => {
  for (const text of ['你的关注', '你的粉丝', '作者', '回复', '原评论已删除', '']) {
    const item = inbox.prepareInboxItem({ type: 'comment', nick: '流风流', content: text, date: '刚刚' }, NOW);
    assert.equal(item.can_auto_reply, false, text);
    assert.equal(item.skip_reason, text === '原评论已删除' ? '原评论已删/无内容' : '未识别到评论正文');
  }
});

test('basis text is preserved separately from incoming text', () => {
  const item = inbox.prepareInboxItem({
    type: 'reply',
    nick: '流风流',
    content: '还在吗？',
    basis_text: '我之前评论的朝阳一居房源',
    date: '刚刚'
  }, NOW);
  assert.equal(item.content, '还在吗？');
  assert.equal(item.basis_text, '我之前评论的朝阳一居房源');
});

test('post-inbox return url restores main page and never notification page', () => {
  assert.equal(
    inbox.resolvePostInboxReturnUrl('https://www.xiaohongshu.com/search_result?keyword=%E6%9C%9D%E9%98%B3'),
    'https://www.xiaohongshu.com/search_result?keyword=%E6%9C%9D%E9%98%B3'
  );
  assert.equal(inbox.resolvePostInboxReturnUrl('https://www.xiaohongshu.com/notification'), '');
  assert.equal(inbox.resolvePostInboxReturnUrl('about:blank'), '');
});

test('saved interaction time is frozen unless a later scan has exact time', () => {
  const existing = {
    event_at_est: '2026-07-01T14:30:00.000Z',
    time_confidence: 'estimated'
  };
  const laterRelative = {
    event_at_est: '2026-07-01T14:55:00.000Z',
    time_confidence: 'estimated'
  };
  const laterExact = {
    event_at_est: '2026-07-01T14:20:11.000Z',
    time_confidence: 'exact'
  };

  assert.deepEqual(inbox.mergeEventTime(existing, laterRelative), existing);
  assert.deepEqual(inbox.mergeEventTime(existing, laterExact), laterExact);
});
