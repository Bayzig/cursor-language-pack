import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { rewrite } from './translate-install.mjs';

test('the commerce card title is translated without changing its locale, import, variables or returned data', () => {
  const before = 'var header="Credits",locale="en";function load(){return import("./workbench.xai-commerce-prepaid.js")}function render(){return {title:header,locale:locale,component:"plan-usage-credits-card",amount:12345}};render();';
  const after = rewrite(before, { Credits: '用量额度' });
  assert.equal(after.count, 1);
  const result = vm.runInNewContext(after.text);
  assert.equal(result.title, '用量额度');
  assert.equal(result.locale, 'en');
  assert.equal(result.amount, 12345);
  assert.ok(after.text.includes('import("./workbench.xai-commerce-prepaid.js")'));
});

test('the commerce header matcher supports minifier aliases but refuses unrelated strings and incomplete context', () => {
  const alias = 'let $h="Credits",$l="en";import("./workbench.xai-commerce-prepaid.js");const props={title:$h,locale:$l,component:"plan-usage-credits-card"};';
  assert.equal(rewrite(alias, { Credits: '用量額度' }).count, 1);
  const glass = 'function load(){return import("./workbench.xai-commerce-prepaid.js")}function render(){return {title:h$,locale:l$,component:"plan-usage-credits-card"}}var h$,l$,init=(()=>{h$="Credits",l$="en"})();render();';
  assert.equal(vm.runInNewContext(rewrite(glass, { Credits: '用量額度' }).text).title, '用量額度');
  for (const source of [
    'var header="Credits",locale="en";console.log(header);',
    'var header="Credits",locale="en";import("./workbench.xai-commerce-prepaid.js");const props={title:other};',
    'var header="Credits",locale="en";const props={title:header};',
    'const message="Credits";const id="Credits";'
  ]) assert.equal(rewrite(source, { Credits: '用量额度' }).text, source);
});

test('queue editing labels and screen recording status keep dispatch and protocol identifiers', () => {
  const source = 'const views={queueItem:()=>({bannerLabel:"Editing queued message",placeholder:"Editing queued message...",cancelLabel:"Cancel",pillLabel:"Editing",pillTitle:"Editing queued message"})};const statuses={recordScreenToolCall:{loading:"Recording screen",completed:"Recorded screen",error:"Record screen"}};const other={loading:"Recording screen",id:"queue-item"};[views.queueItem(),statuses,other];';
  const dict = { 'Editing queued message': '正在编辑排队消息', 'Editing queued message...': '正在编辑排队消息…', Cancel: '取消', Editing: '正在编辑', 'Recording screen': '正在录制屏幕', 'Recorded screen': '已录制屏幕', 'Record screen': '录制屏幕' };
  const [view, statuses, other] = vm.runInNewContext(rewrite(source, dict).text);
  assert.equal(view.bannerLabel, '正在编辑排队消息');
  assert.equal(view.pillLabel, '正在编辑');
  assert.equal(view.cancelLabel, '取消');
  assert.equal(statuses.recordScreenToolCall.loading, '正在录制屏幕');
  assert.equal(other.loading, 'Recording screen');
  assert.equal(other.id, 'queue-item');
});

test('computer permission constants change only beside the complete component signature', () => {
  const block = 'a="Enable Computer Use",b="Allow Cursor to use your computer.",c="Cursor Computer Use is not available in this build",d="Back to Cursor",e="Computer Use is ready",f="Allow",g="Allowing\\u2026",h="Ready",items=[{kind:"accessibility",label:"Access app interfaces"}]';
  const dict = { 'Enable Computer Use': '启用计算机操作', 'Allow Cursor to use your computer.': '允许 Cursor 操作你的计算机。', 'Cursor Computer Use is not available in this build': '此版本不支持 Cursor 计算机操作', 'Back to Cursor': '返回 Cursor', 'Computer Use is ready': '计算机操作已就绪', Allow: '允许', 'Allowing…': '正在允许…', Ready: '就绪' };
  const source = 'var ' + block + ';[a,f,g,h,items[0].kind];';
  const result = vm.runInNewContext(rewrite(source, dict).text);
  assert.equal(result[0], '启用计算机操作');
  assert.equal(result[1], '允许');
  assert.equal(result[2], '正在允许…');
  assert.equal(result[3], '就绪');
  assert.equal(result[4], 'accessibility');
  assert.equal(rewrite('const label="Allow",state="Ready";', dict).count, 0);
});
