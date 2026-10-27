import type { Refusal } from '../editor-binding/index.ts';
import type { DiaryState } from './session.ts';

export type StatusLine = { text: string; tone: 'calm' | 'busy' | 'warn' };

/**
 * The one line the screen shows about saving (kernel "失败与恢复"): what is stored where,
 * most urgent first, so "已保存到服务器" appears only when nothing waits anywhere.
 */
export function statusLine(state: DiaryState): StatusLine {
  const { save, sync } = state;
  if (state.storeFailed)
    return { text: '本机保存失败，正文仍在页面上，请复制或下载', tone: 'warn' };
  if (save === 'readonly')
    return { text: '只读：这个浏览器无法安全保存，请升级浏览器', tone: 'warn' };
  if (save === 'upgrade' || sync === 'upgrade')
    return { text: '有新版本，请刷新页面；未保存的内容会保留', tone: 'warn' };
  if (save === 'reauth' || sync === 'reauth')
    return { text: '登录已过期，请重新登录同一账号', tone: 'warn' };
  if (sync === 'refused') return { text: '无法同步这篇日记', tone: 'warn' };
  if (state.unstored > 0) return { text: '正在保存到本机', tone: 'busy' };
  if (save === 'confirming') return { text: '正在确认保存结果', tone: 'busy' };
  if (save === 'offline') return { text: '暂时无法同步，已保存在本机', tone: 'warn' };
  if (save === 'syncing') return { text: '正在同步', tone: 'busy' };
  if (save === 'attention') return { text: '需要处理', tone: 'warn' };
  if (save === 'saved') return { text: '已保存到服务器', tone: 'calm' };
  return { text: '正在连接', tone: 'busy' };
}

export const refusalText: Record<Refusal, string> = {
  FOREIGN_TEXT: '不能修改或删除对方写的字',
  PASTE_TOO_LARGE: '粘贴内容超过约 30 万字，请分段粘贴',
  CONTROL_CHARACTER: '内容包含无法保存的控制字符',
};

export function failureText(failure: DiaryState['failure']): string {
  if (failure === 'offline') return '离线，且这台设备上没有这篇日记；联网后再打开';
  if (failure === 'NOT_FOUND') return '找不到这篇日记';
  return '打开失败，请稍后再试';
}
