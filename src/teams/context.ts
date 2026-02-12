import type { ConversationMessage } from '../types.js';

// In-memory conversation history (per channel)
const conversations = new Map<string, ConversationMessage[]>();
const MAX_CHANNELS = 100;

export function addMessage(channelId: string, msg: ConversationMessage) {
  // LRU: delete-and-re-set to move channel to end of Map insertion order
  const existing = conversations.get(channelId);
  if (existing) conversations.delete(channelId);

  const history = existing ?? [];
  history.push(msg);
  // Keep last 100 messages in memory
  if (history.length > 100) history.splice(0, history.length - 100);

  conversations.set(channelId, history);

  // Evict oldest channel entry when exceeding limit
  if (conversations.size > MAX_CHANNELS) {
    const oldestKey = conversations.keys().next().value;
    if (oldestKey) conversations.delete(oldestKey);
  }
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
