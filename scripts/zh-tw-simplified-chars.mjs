// Shared by scripts/check-zh-tw-coverage.mjs (web/src) and scripts/check-zh-tw-native-coverage.mjs (launcher, injector, server).
// Conservative set of common Simplified-only characters (their Traditional forms differ).
export const SIMPLIFIED_ONLY = new Set([...(
  "个们这时间项编辑删确认领处状态显导选择发对话记录执运错误标签优级创归档复进详评论联碍筛视图没请输网络链页题说传载预览帮账户设语应会线额动开关负责与为无数据库续务读写启远锁钮键换块条专业类从询验证过滤区组织员单双资讯讨节点击缓储构样种异响实现两边层该隐扩缩调试势损坏丢断观测报汇总统计历备还销毁释权审许诺议钟闹码栏滚于后里着么吗并将当旧离满队结际经仅办继场义广产严众体气电脑机让给问门闭闪书画马车转轮软较头顶顺须频颜风飞长阅阶陆难灵静齐龙见规觉订训讲访识诉译谁谈谢贝贡财败货质购贴费资赏赖赛赞趋跃轨辅辞达迁违连迟适递逻遗邮钥银铺锚闲闻阔阵陈险随隶韩顾饰馈骤黄乐习乱争亏亚亲亿仓仪价伟伤伪佣侧债倾偿儿兑党兰兴养内册军农冲决况冻净减几凭刚删别剂剧劝励劲劳匀医华协卖卫却厂厅压厌厕县参变叙叠号叹吓启员听响团园围国圆圣坚坛执扫扬扰抚抛抢护报担拟拥拦拨挂挡挤挥据摄摆摇撑数断晓晕暂术杀杂来极枪栈树桥检楼横欢残毕汇汉沟泽洁浅济浏浓涂润涨渐温湾滞灭灯灾炉炼烦热爱牵犹独猎环画畅疗盖盘矿础礼积称稳穷竞笔简粮紧纠红约纪纯纲纳纵纸练细终绍绕绘绝绩维综绿缀缘罗罚职肤胁胜胶脚脱腾艺范荐药获虑虚补袭装触誉计赖闸惯态辆输递阈误绑谱译应适务储"
)]);
// Mainland-only terms, and wrong character-by-character conversions, that contain no Simplified-only character.
export const MAINLAND_TERMS = ["信息", "標簽", "重復"];

export function simplifiedIn(value) {
  const chars = [...new Set([...value].filter((c) => SIMPLIFIED_ONLY.has(c)))];
  for (const term of MAINLAND_TERMS) if (value.includes(term)) chars.push(term);
  return chars;
}
