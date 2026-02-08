import type { ConversationMessage } from '../types.js';

// In-memory conversation history (per channel)
const conversations = new Map<string, ConversationMessage[]>();

export function addMessage(channelId: string, msg: ConversationMessage) {
  if (!conversations.has(channelId)) conversations.set(channelId, []);
  const history = conversations.get(channelId)!;
  history.push(msg);
  // Keep last 100 messages in memory
  if (history.length > 100) history.splice(0, history.length - 100);
}

export function getRecentConversation(
  channelId: string,
  windowSize: number,
): ConversationMessage[] {
  const history = conversations.get(channelId) ?? [];
  return history.slice(-windowSize);
}

export function formatConversation(messages: ConversationMessage[]): string {
  return messages.map(m => {
    const sender = m.teamId === 'human' ? 'Human' : m.teamName;
    const time = m.timestamp.toISOString().slice(11, 19);
    return `[${time}] ${sender}: ${m.content}`;
  }).join('\n');
}
