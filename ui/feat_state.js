// 主窗口与 Agent 窗口共用的 Feat 状态识别。
'use strict';

/** 只按档案状态的开头归纳，避免正文中的「待验收」「已完成」被误判为当前阶段。 */
window.FeatState = function (status) {
  const value = String(status || '').trim().replace(/^\*+/, '').trim();
  const rules = [
    [/^(已废弃|放弃需求)/, '已废弃', 'dropped'],
    [/^(已关闭|已正式收口)/, '已关闭', 'done'],
    [/^(已暂停|暂停|暂缓)/, '已暂停', 'paused'],
    [/^(待验收|待人工确认|待用户确认)/, '待验收', 'accept'],
    [/^(测试完成|已测试)/, '待验收', 'accept'],
    [/^(待测试|开发完成)/, '待测试', 'ready'],
    [/^(正在测试|测试)/, '测试中', 'test'],
    [/^(正在开发|部分接入|开发)/, '开发中', 'dev'],
    [/^(UI|界面设计|设计界面)/i, 'UI设计', 'design'],
    [/^(整理需求|需求)/, '需求中', 'req'],
    [/^(讨论方案|探讨)/, '探讨中', 'talk'],
  ];
  const match = rules.find(([pattern]) => pattern.test(value));
  return match ? { label: match[1], tone: match[2] } : { label: '待明确', tone: 'muted' };
};
