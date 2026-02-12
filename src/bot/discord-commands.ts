import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits, type Guild, type TextChannel, type Client, type Message } from 'discord.js';
import type { TeamConfig, TeamsConfig, EnvConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Strip memory/persona blocks — extracts content, saves to file, then strips
// ---------------------------------------------------------------------------

const MEMORY_PATTERN = /(?:```\s*\n?)?(?:\[discord:edit-memory\]\s*\n)?---MEMORY---\n([\s\S]*?)\n---END-MEMORY---(?:\s*\n?```)?/g;
const LONG_MEMORY_PATTERN = /(?:```\s*\n?)?(?:\[discord:edit-long-memory\]\s*\n)?---LONG-MEMORY---\n([\s\S]*?)\n---END-LONG-MEMORY---(?:\s*\n?```)?/g;
const PERSONA_PATTERN = /(?:```\s*\n?)?(?:\[discord:edit-persona\]\s*\n)?---PERSONA---\n([\s\S]*?)\n---END-PERSONA---(?:\s*\n?```)?/g;

export function stripMemoryBlocks(
  output: string,
  teamId?: string,
  workspacePath?: string,
): string {
  // Extract and save memory content before stripping
  if (teamId && workspacePath) {
    const memDir = path.resolve(workspacePath, '.mococo/memory', teamId);

    // Short-term memory → {teamId}/short-term.md
    for (const match of output.matchAll(MEMORY_PATTERN)) {
      if (match[1]) {
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.resolve(memDir, 'short-term.md'), match[1]);
        console.log(`[strip] Updated short-term memory for ${teamId}`);
      }
    }

    // Long-term memory → {teamId}/long-term.md
    for (const match of output.matchAll(LONG_MEMORY_PATTERN)) {
      if (match[1]) {
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.resolve(memDir, 'long-term.md'), match[1]);
        console.log(`[strip] Updated long-term memory for ${teamId}`);
      }
    }

    // Persona updates are handled by processDiscordCommands, not here
  }

  return output
    .replace(MEMORY_PATTERN, '')
    .replace(LONG_MEMORY_PATTERN, '')
    .replace(PERSONA_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// A. Resource Registry — in-memory name→id maps per resource type
// ---------------------------------------------------------------------------

export class ResourceRegistry {
  private channels = new Map<string, string>();
  private threads = new Map<string, string>();
  private categories = new Map<string, string>();
  private messages = new Map<string, string>(); // label→messageId
  private roles = new Map<string, string>();    // name→roleId

  setChannel(name: string, id: string) { this.channels.set(name, id); }
  getChannel(name: string) { return this.channels.get(name); }
  deleteChannel(name: string) { this.channels.delete(name); }

  setThread(name: string, id: string) { this.threads.set(name, id); }
  getThread(name: string) { return this.threads.get(name); }
  deleteThread(name: string) { this.threads.delete(name); }

  setCategory(name: string, id: string) { this.categories.set(name, id); }
  getCategory(name: string) { return this.categories.get(name); }
  deleteCategory(name: string) { this.categories.delete(name); }

  setMessage(label: string, id: string) { this.messages.set(label, id); }
  getMessage(label: string) { return this.messages.get(label); }

  setRole(name: string, id: string) { this.roles.set(name, id); }
  getRole(name: string) { return this.roles.get(name); }
  deleteRole(name: string) { this.roles.delete(name); }
}

// ---------------------------------------------------------------------------
// B. Command Parser — extracts [discord:action ...] from bot output
// ---------------------------------------------------------------------------

interface ParsedCommand {
  raw: string;           // full matched string including brackets
  action: string;        // e.g. "create-channel"
  params: Record<string, string>;
}

/**
 * 코드 블록 내 명령어 매칭 방지를 위해 트리플 백틱 펜스 내용을 마스킹.
 * non-greedy 매칭([\s\S]*?)으로 중첩/연속 코드 블록도 올바르게 처리됨.
 * Discord markdown에서 ``` 는 중첩 불가 — 첫 번째 닫는 ``` 가 항상 블록 종료.
 * 인라인 코드(`...`)도 마스킹하여 코드 내 명령어 실행 방지.
 */
function maskCodeFences(text: string): string {
  // 1. Mask paired triple backtick fences (우선순위 높음)
  let masked = text.replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length));
  // 2. Mask unclosed triple backtick fence (opening ``` without closing)
  masked = masked.replace(/```[\s\S]*$/g, m => ' '.repeat(m.length));
  // 3. Mask inline code (단일 백틱) — skip regions already masked (all-spaces) by steps 1-2
  masked = masked.replace(/`[^`]+`/g, (m, offset) => {
    // Check if this region was already masked (all spaces = inside a code block that was masked)
    const region = masked.slice(offset, offset + m.length);
    if (/^ +$/.test(region)) return region; // already masked, leave as-is
    return ' '.repeat(m.length);
  });
  return masked;
}

function parseCommands(output: string): ParsedCommand[] {
  const masked = maskCodeFences(output);
  const commands: ParsedCommand[] = [];

  // New format: [discord:action key=value key="quoted value"]
  const discordRe = /\[discord:(\S+)((?:\s+\S+=(?:"[^"]*"|\S+))*)\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = discordRe.exec(masked)) !== null) {
    const raw = output.slice(match.index, match.index + match[0].length);
    const action = match[1];
    const params = parseParams(match[2]);
    commands.push({ raw, action, params });
  }

  // Decision log tags: [decision:level reason="..." action="..."]
  const decisionRe = /\[decision:(\S+)((?:\s+\S+=(?:"[^"]*"|\S+))*)\s*\]/g;
  while ((match = decisionRe.exec(masked)) !== null) {
    const raw = output.slice(match.index, match.index + match[0].length);
    const level = match[1];
    const params = parseParams(match[2]);
    params._level = level;
    commands.push({ raw, action: 'decision-log', params });
  }

  // Block syntax: run against original text (not masked) since bots wrap these in code fences
  // Also strip surrounding code fences if present
  const blockSource = output.replace(/```\s*\n(\[discord:edit-(?:persona|long-memory|memory)\])/g, '$1')
    .replace(/(---END-(?:PERSONA|LONG-MEMORY|MEMORY)---)\s*\n```/g, '$1');

  // Block syntax: [discord:edit-persona] + ---PERSONA---\n...\n---END-PERSONA---
  const personaRe = /\[discord:edit-persona\]\s*\n---PERSONA---\n([\s\S]*?)\n---END-PERSONA---/g;
  while ((match = personaRe.exec(blockSource)) !== null) {
    commands.push({ raw: match[0], action: 'edit-persona', params: { _content: match[1] } });
  }

  // Block syntax: [discord:edit-memory] + ---MEMORY---\n...\n---END-MEMORY---
  // Also match bare ---MEMORY--- blocks without the [discord:edit-memory] prefix
  const memoryRe = /(?:\[discord:edit-memory\]\s*\n)?---MEMORY---\n([\s\S]*?)\n---END-MEMORY---/g;
  while ((match = memoryRe.exec(blockSource)) !== null) {
    commands.push({ raw: match[0], action: 'edit-memory', params: { _content: match[1] } });
  }

  // Block syntax: [discord:edit-long-memory] + ---LONG-MEMORY---\n...\n---END-LONG-MEMORY---
  const longMemoryRe = /(?:\[discord:edit-long-memory\]\s*\n)?---LONG-MEMORY---\n([\s\S]*?)\n---END-LONG-MEMORY---/g;
  while ((match = longMemoryRe.exec(blockSource)) !== null) {
    commands.push({ raw: match[0], action: 'edit-long-memory', params: { _content: match[1] } });
  }

  return commands;
}

// Max length for any single parameter value to prevent abuse
const MAX_PARAM_VALUE_LENGTH = 2000;

function parseParams(paramStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  // key: 영문자/언더스코어 시작, 이후 영문자/숫자/언더스코어/하이픈만 허용
  // value(따옴표 있음): 이스케이프 시퀀스(\\, \")를 포함한 문자열 매칭
  // value(따옴표 없음): 안전한 문자만 허용 (영숫자, 점, 슬래시, 콜론, @, #, 콤마, +, -)
  const re = /([a-zA-Z_][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paramStr)) !== null) {
    let value = m[2] ?? m[3];
    if (m[2] !== undefined) {
      // 큰따옴표 내 이스케이프: \" → ", \\ → \ 만 허용. 기타 \x 시퀀스는 리터럴 유지
      value = value.replace(/\\(["\\])|\\(.)/g, (_, allowed, literal) => allowed ?? `\\${literal}`);
      // Path traversal 방지 (quoted 값): 파일 경로 관련 키에만 적용, _content 등 본문 키 제외
      const key = m[1];
      if (!key.endsWith('_content') && (/\.\.[\\/]/.test(value) || value.includes('..'))) {
        console.warn(`[discord-cmd] Param "${key}" (quoted) contains path traversal sequence, skipping`);
        continue;
      }
    } else {
      // 따옴표 없는 값: 안전한 문자 화이트리스트 검증
      if (!/^[\w./:@#,+-]+$/.test(value)) {
        console.warn(`[discord-cmd] Param "${m[1]}" contains unsafe characters, skipping`);
        continue;
      }
      // Path traversal 방지: .. 시퀀스 차단
      if (/\.\.[\\/]/.test(value) || value.includes('..')) {
        console.warn(`[discord-cmd] Param "${m[1]}" contains path traversal sequence, skipping`);
        continue;
      }
    }
    // Truncate overly long values
    if (value.length > MAX_PARAM_VALUE_LENGTH) {
      value = value.slice(0, MAX_PARAM_VALUE_LENGTH);
      console.warn(`[discord-cmd] Param "${m[1]}" truncated to ${MAX_PARAM_VALUE_LENGTH} chars`);
    }
    params[m[1]] = value;
  }
  return params;
}

// ---------------------------------------------------------------------------
// C. Command Context — everything handlers need
// ---------------------------------------------------------------------------

export interface CommandContext {
  guild: Guild;
  team: TeamConfig;
  config: TeamsConfig;
  env: EnvConfig;
  registry: ResourceRegistry;
  channelId: string;
  teamClients: Map<string, Client>;
  sendAsTeam: (channelId: string, team: TeamConfig, content: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// D. Command Executor — public entry point
// ---------------------------------------------------------------------------

export async function processDiscordCommands(
  output: string,
  ctx: CommandContext,
): Promise<string> {
  const commands = parseCommands(output);
  if (commands.length === 0) return output;

  let cleaned = output;
  for (const cmd of commands) {
    await executeCommand(cmd, ctx);
    // Try stripping the raw match; also strip code-fenced version for block commands
    if (cleaned.includes(cmd.raw)) {
      cleaned = cleaned.replace(cmd.raw, '');
    } else {
      // Block command was inside code fences — build a pattern to match the fenced version
      const escaped = cmd.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fencedRe = new RegExp('```\\s*\\n?' + escaped + '\\s*\\n?```', 's');
      cleaned = cleaned.replace(fencedRe, '');
    }
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// E. Command Handler Type & Registry
// ---------------------------------------------------------------------------

type CommandHandler = (params: Record<string, string>, ctx: CommandContext) => Promise<void>;

const commandRegistry: Record<string, CommandHandler> = {
  // Channels
  'create-channel':    handleCreateChannel,
  'delete-channel':    handleDeleteChannel,
  'rename-channel':    handleRenameChannel,
  'set-topic':         handleSetTopic,
  'move-channel':      handleMoveChannel,
  // Threads
  'create-thread':     handleCreateThread,
  'send-thread':       handleSendThread,
  'archive-thread':    handleArchiveThread,
  'lock-thread':       handleLockThread,
  // Categories
  'create-category':   handleCreateCategory,
  'delete-category':   handleDeleteCategory,
  // Messages
  'pin-message':       handlePinMessage,
  'react':             handleReact,
  'edit-message':      handleEditMessage,
  'delete-message':    handleDeleteMessage,
  // Permissions
  'set-permission':    handleSetPermission,
  'remove-permission': handleRemovePermission,
  // Roles
  'create-role':       handleCreateRole,
  'delete-role':       handleDeleteRole,
  'assign-role':       handleAssignRole,
  'remove-role':       handleRemoveRole,
  // Persona & Memory
  'edit-persona':      handleEditPersona,
  'edit-memory':       handleEditMemory,
  'edit-long-memory':  handleEditLongMemory,
  // Decision log
  'decision-log':      handleDecisionLog,
  // Query
  'list-roles':        handleListRoles,
  'list-channels':     handleListChannels,
};

// ---------------------------------------------------------------------------
// F. Command Executor
// ---------------------------------------------------------------------------

async function executeCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  try {
    const handler = commandRegistry[cmd.action];
    if (handler) {
      await handler(cmd.params, ctx);
    } else {
      console.warn(`[discord-cmd] Unknown command: ${cmd.action}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[discord-cmd] ${cmd.action} failed: ${msg}`);
    await ctx.sendAsTeam(ctx.channelId, ctx.team, `Command \`${cmd.action}\` failed: ${msg}`).catch(() => {});
  }
}

// --- Resolve helpers ---

function resolveChannel(name: string, ctx: CommandContext): TextChannel | undefined {
  // Check registry first
  const id = ctx.registry.getChannel(name);
  if (id) {
    return ctx.guild.channels.cache.get(id) as TextChannel | undefined;
  }
  // Fallback: search guild cache by name
  return ctx.guild.channels.cache.find(
    c => c.name === name && c.type === ChannelType.GuildText,
  ) as TextChannel | undefined;
}

function resolveCategory(name: string, ctx: CommandContext): string | undefined {
  const id = ctx.registry.getCategory(name);
  if (id) return id;
  const cat = ctx.guild.channels.cache.find(
    c => c.name === name && c.type === ChannelType.GuildCategory,
  );
  return cat?.id;
}

function resolveThread(name: string, ctx: CommandContext) {
  const id = ctx.registry.getThread(name);
  if (id) return ctx.guild.channels.cache.get(id);
  return ctx.guild.channels.cache.find(
    c => c.name === name && c.isThread(),
  );
}

function resolveMessageId(idOrLabel: string, ctx: CommandContext): string {
  // If it looks like a snowflake, use as-is
  if (/^\d{17,20}$/.test(idOrLabel)) return idOrLabel;
  // Otherwise resolve label from registry
  return ctx.registry.getMessage(idOrLabel) ?? idOrLabel;
}

function resolveRole(name: string, ctx: CommandContext) {
  const id = ctx.registry.getRole(name);
  if (id) return ctx.guild.roles.cache.get(id);
  return ctx.guild.roles.cache.find(r => r.name === name);
}

// --- Channel Handlers ---

async function handleCreateChannel(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;

  let parentId: string | undefined;
  if (params.category) {
    parentId = resolveCategory(params.category, ctx);
  }

  const channel = await ctx.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
  });

  ctx.registry.setChannel(name, channel.id);
  console.log(`[discord-cmd] Created #${name} (${channel.id})`);
}

async function handleDeleteChannel(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;
  const channel = resolveChannel(name, ctx);
  if (!channel) return;
  await channel.delete();
  ctx.registry.deleteChannel(name);
  console.log(`[discord-cmd] Deleted #${name}`);
}

async function handleRenameChannel(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  const to = params.to;
  if (!name || !to) return;
  const channel = resolveChannel(name, ctx);
  if (!channel) return;
  await channel.setName(to);
  // Update registry: remove old, add new
  const id = ctx.registry.getChannel(name);
  if (id) {
    ctx.registry.deleteChannel(name);
    ctx.registry.setChannel(to, id);
  }
  console.log(`[discord-cmd] Renamed #${name} → #${to}`);
}

async function handleSetTopic(params: Record<string, string>, ctx: CommandContext) {
  const channel = resolveChannel(params.channel, ctx);
  if (!channel || !params.topic) return;
  await channel.setTopic(params.topic);
  console.log(`[discord-cmd] Set topic on #${params.channel}`);
}

// --- Thread Handlers ---

async function handleCreateThread(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;
  const parentChannel = params.channel
    ? resolveChannel(params.channel, ctx)
    : ctx.guild.channels.cache.get(ctx.channelId) as TextChannel | undefined;
  if (!parentChannel) return;

  const thread = await parentChannel.threads.create({
    name,
    autoArchiveDuration: 1440, // 24h
  });
  ctx.registry.setThread(name, thread.id);
  console.log(`[discord-cmd] Created thread "${name}" in #${parentChannel.name}`);
}

async function handleSendThread(params: Record<string, string>, ctx: CommandContext) {
  const threadName = params.thread;
  const message = params.message;
  if (!threadName || !message) return;

  const thread = resolveThread(threadName, ctx);
  if (!thread || !thread.isTextBased()) return;

  // Send using the invoking bot's client
  const client = ctx.teamClients.get(ctx.team.id);
  if (!client) return;
  const ch = client.channels.cache.get(thread.id);
  if (!ch || !ch.isTextBased()) return;

  const sent = await (ch as TextChannel).send(message);

  // Register label if provided
  if (params.label) {
    ctx.registry.setMessage(params.label, sent.id);
  }
  console.log(`[discord-cmd] Sent to thread "${threadName}"${params.label ? ` (label: ${params.label})` : ''}`);
}

async function handleArchiveThread(params: Record<string, string>, ctx: CommandContext) {
  const thread = resolveThread(params.thread, ctx);
  if (!thread || !thread.isThread()) return;
  await thread.setArchived(true);
  ctx.registry.deleteThread(params.thread);
  console.log(`[discord-cmd] Archived thread "${params.thread}"`);
}

async function handleLockThread(params: Record<string, string>, ctx: CommandContext) {
  const thread = resolveThread(params.thread, ctx);
  if (!thread || !thread.isThread()) return;
  await thread.setLocked(true);
  console.log(`[discord-cmd] Locked thread "${params.thread}"`);
}

// --- Category Handlers ---

async function handleCreateCategory(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;
  const category = await ctx.guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
  });
  ctx.registry.setCategory(name, category.id);
  console.log(`[discord-cmd] Created category "${name}" (${category.id})`);
}

async function handleDeleteCategory(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;
  const id = resolveCategory(name, ctx);
  if (!id) return;
  const channel = ctx.guild.channels.cache.get(id);
  if (channel) {
    await channel.delete();
    ctx.registry.deleteCategory(name);
    console.log(`[discord-cmd] Deleted category "${name}"`);
  }
}

async function handleMoveChannel(params: Record<string, string>, ctx: CommandContext) {
  const channelName = params.channel;
  const categoryName = params.category;
  if (!channelName || !categoryName) return;

  const channel = resolveChannel(channelName, ctx);
  if (!channel) return;

  const categoryId = resolveCategory(categoryName, ctx);
  if (!categoryId) return;

  await channel.setParent(categoryId);
  console.log(`[discord-cmd] Moved #${channelName} → category "${categoryName}"`);
}

// --- Message Handlers ---

async function handlePinMessage(params: Record<string, string>, ctx: CommandContext) {
  const idOrLabel = params.id ?? params.label;
  if (!idOrLabel) return;
  const msgId = resolveMessageId(idOrLabel, ctx);

  const channel = ctx.guild.channels.cache.get(ctx.channelId) as TextChannel | undefined;
  if (!channel) return;

  const msg = await channel.messages.fetch(msgId).catch(() => null);
  if (!msg) {
    console.warn(`[discord-cmd] Message ${msgId} not found or inaccessible`);
    return;
  }
  await msg.pin();
  console.log(`[discord-cmd] Pinned message ${msgId}`);
}

async function handleReact(params: Record<string, string>, ctx: CommandContext) {
  const idOrLabel = params.id ?? params.label;
  const emoji = params.emoji;
  if (!idOrLabel || !emoji) return;
  const msgId = resolveMessageId(idOrLabel, ctx);

  const channel = ctx.guild.channels.cache.get(ctx.channelId) as TextChannel | undefined;
  if (!channel) return;

  const msg = await channel.messages.fetch(msgId).catch(() => null);
  if (!msg) {
    console.warn(`[discord-cmd] Message ${msgId} not found or inaccessible`);
    return;
  }
  await msg.react(emoji);
  console.log(`[discord-cmd] Reacted ${emoji} to message ${msgId}`);
}

async function handleEditMessage(params: Record<string, string>, ctx: CommandContext) {
  const idOrLabel = params.id ?? params.label;
  const content = params.content;
  if (!idOrLabel || !content) return;
  const msgId = resolveMessageId(idOrLabel, ctx);

  // Use the invoking bot's client to ensure we only edit our own messages
  const client = ctx.teamClients.get(ctx.team.id);
  if (!client) return;
  const channel = client.channels.cache.get(ctx.channelId) as TextChannel | undefined;
  if (!channel) return;

  const msg = await channel.messages.fetch(msgId).catch(() => null);
  if (!msg) {
    console.warn(`[discord-cmd] Message ${msgId} not found or inaccessible`);
    return;
  }
  if (msg.author.id !== client.user?.id) {
    console.warn(`[discord-cmd] Cannot edit message ${msgId} — not authored by this bot`);
    return;
  }
  await msg.edit(content);
  console.log(`[discord-cmd] Edited message ${msgId}`);
}

async function handleDeleteMessage(params: Record<string, string>, ctx: CommandContext) {
  const idOrLabel = params.id ?? params.label;
  if (!idOrLabel) return;
  const msgId = resolveMessageId(idOrLabel, ctx);

  const client = ctx.teamClients.get(ctx.team.id);
  if (!client) return;
  const channel = client.channels.cache.get(ctx.channelId) as TextChannel | undefined;
  if (!channel) return;

  const msg = await channel.messages.fetch(msgId).catch(() => null);
  if (!msg) {
    console.warn(`[discord-cmd] Message ${msgId} not found or inaccessible`);
    return;
  }
  if (msg.author.id !== client.user?.id) {
    console.warn(`[discord-cmd] Cannot delete message ${msgId} — not authored by this bot`);
    return;
  }
  await msg.delete();
  console.log(`[discord-cmd] Deleted message ${msgId}`);
}

// --- Permission name mapping ---

const PERMISSION_MAP: Record<string, bigint> = {
  'ViewChannel':        PermissionFlagsBits.ViewChannel,
  'SendMessages':       PermissionFlagsBits.SendMessages,
  'ReadMessageHistory': PermissionFlagsBits.ReadMessageHistory,
  'ManageMessages':     PermissionFlagsBits.ManageMessages,
  'ManageChannels':     PermissionFlagsBits.ManageChannels,
  'ManageRoles':        PermissionFlagsBits.ManageRoles,
  'EmbedLinks':         PermissionFlagsBits.EmbedLinks,
  'AttachFiles':        PermissionFlagsBits.AttachFiles,
  'AddReactions':       PermissionFlagsBits.AddReactions,
  'Connect':            PermissionFlagsBits.Connect,
  'Speak':              PermissionFlagsBits.Speak,
  'MentionEveryone':    PermissionFlagsBits.MentionEveryone,
  'CreatePublicThreads':  PermissionFlagsBits.CreatePublicThreads,
  'CreatePrivateThreads': PermissionFlagsBits.CreatePrivateThreads,
  'UseExternalEmojis':  PermissionFlagsBits.UseExternalEmojis,
};

function parsePermissionNames(str: string): string[] {
  const result: string[] = [];
  for (const name of str.split(',').map(s => s.trim()).filter(Boolean)) {
    if (PERMISSION_MAP[name] !== undefined) {
      result.push(name);
    } else {
      console.warn(`[discord-cmd] Unknown permission: ${name}`);
    }
  }
  return result;
}

// --- Permission Handlers ---

function resolveChannelOrCategory(name: string, ctx: CommandContext) {
  // Check channel registry
  const chId = ctx.registry.getChannel(name);
  if (chId) return ctx.guild.channels.cache.get(chId);
  // Check category registry
  const catId = ctx.registry.getCategory(name);
  if (catId) return ctx.guild.channels.cache.get(catId);
  // Fallback: search by name (channels and categories)
  return ctx.guild.channels.cache.find(c => c.name === name);
}

async function handleSetPermission(params: Record<string, string>, ctx: CommandContext) {
  const channelName = params.channel ?? params.category;
  if (!channelName) return;

  const channel = resolveChannelOrCategory(channelName, ctx);
  if (!channel || !('permissionOverwrites' in channel)) {
    console.warn(`[discord-cmd] Channel/category "${channelName}" not found or has no permissions`);
    return;
  }

  // Resolve target: role or user
  let targetId: string | undefined;
  if (params.role) {
    const role = resolveRole(params.role, ctx);
    targetId = role?.id;
    if (!targetId) {
      console.warn(`[discord-cmd] Role "${params.role}" not found`);
      return;
    }
  } else if (params.user) {
    targetId = params.user.replace(/[<@!>]/g, '');
  }
  if (!targetId) return;

  const allowNames = params.allow ? parsePermissionNames(params.allow) : [];
  const denyNames = params.deny ? parsePermissionNames(params.deny) : [];

  const overwrite: Record<string, boolean | null> = {};
  for (const name of allowNames) overwrite[name] = true;
  for (const name of denyNames) overwrite[name] = false;

  await channel.permissionOverwrites.edit(targetId, overwrite, {
    reason: `Set by ${ctx.team.name}`,
  });

  const targetLabel = params.role ?? params.user;
  console.log(`[discord-cmd] Set permissions on "${channelName}" for ${targetLabel}`);
}

async function handleRemovePermission(params: Record<string, string>, ctx: CommandContext) {
  const channelName = params.channel ?? params.category;
  if (!channelName) return;

  const channel = resolveChannelOrCategory(channelName, ctx);
  if (!channel || !('permissionOverwrites' in channel)) return;

  let targetId: string | undefined;
  if (params.role) {
    const role = resolveRole(params.role, ctx);
    targetId = role?.id;
  } else if (params.user) {
    targetId = params.user.replace(/[<@!>]/g, '');
  }
  if (!targetId) return;

  await channel.permissionOverwrites.delete(targetId, `Removed by ${ctx.team.name}`);

  const targetLabel = params.role ?? params.user;
  console.log(`[discord-cmd] Removed permission overwrite on "${channelName}" for ${targetLabel}`);
}

// --- Role Handlers ---

async function handleCreateRole(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;

  const color = params.color ? (parseInt(params.color.replace('#', ''), 16) || undefined) : undefined;

  const role = await ctx.guild.roles.create({
    name,
    color,
    reason: `Created by ${ctx.team.name}`,
  });
  ctx.registry.setRole(name, role.id);
  console.log(`[discord-cmd] Created role "${name}" (${role.id})`);
}

async function handleDeleteRole(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;
  const role = resolveRole(name, ctx);
  if (!role) return;
  await role.delete(`Deleted by ${ctx.team.name}`);
  ctx.registry.deleteRole(name);
  console.log(`[discord-cmd] Deleted role "${name}"`);
}

async function handleAssignRole(params: Record<string, string>, ctx: CommandContext) {
  const roleName = params.role;
  const userId = params.user;
  if (!roleName || !userId) return;

  const role = resolveRole(roleName, ctx);
  if (!role) {
    console.warn(`[discord-cmd] Role "${roleName}" not found`);
    return;
  }

  // Accept raw ID or <@ID> mention format
  const cleanId = userId.replace(/[<@!>]/g, '');
  const member = await ctx.guild.members.fetch(cleanId).catch(() => null);
  if (!member) {
    console.warn(`[discord-cmd] Member "${userId}" not found`);
    return;
  }

  await member.roles.add(role, `Assigned by ${ctx.team.name}`);
  console.log(`[discord-cmd] Assigned role "${roleName}" to ${member.user.tag}`);
}

async function handleRemoveRole(params: Record<string, string>, ctx: CommandContext) {
  const roleName = params.role;
  const userId = params.user;
  if (!roleName || !userId) return;

  const role = resolveRole(roleName, ctx);
  if (!role) {
    console.warn(`[discord-cmd] Role "${roleName}" not found`);
    return;
  }

  const cleanId = userId.replace(/[<@!>]/g, '');
  const member = await ctx.guild.members.fetch(cleanId).catch(() => null);
  if (!member) {
    console.warn(`[discord-cmd] Member "${userId}" not found`);
    return;
  }

  await member.roles.remove(role, `Removed by ${ctx.team.name}`);
  console.log(`[discord-cmd] Removed role "${roleName}" from ${member.user.tag}`);
}

// --- Role Query Handler ---

async function handleListRoles(_params: Record<string, string>, ctx: CommandContext): Promise<void> {
  const roles = ctx.guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .map(r => `- ${r.name} (${r.members.size}명)`)
    .join('\n');
  const output = roles || '(역할 없음)';
  await ctx.sendAsTeam(ctx.channelId, ctx.team, `**서버 역할 목록:**\n${output}`);
  console.log(`[discord-cmd] Listed ${ctx.guild.roles.cache.size - 1} roles`);
}

// --- Channel Query Handler ---

async function handleListChannels(_params: Record<string, string>, ctx: CommandContext): Promise<void> {
  const { guild } = ctx;

  // Non-category, non-thread channels only
  const isNonCategory = (c: { type: ChannelType }) =>
    c.type !== ChannelType.GuildCategory &&
    c.type !== ChannelType.PublicThread &&
    c.type !== ChannelType.PrivateThread &&
    c.type !== ChannelType.AnnouncementThread;

  const categories = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  const uncategorized = guild.channels.cache
    .filter(c => isNonCategory(c) && !c.parentId)
    .sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0));

  const lines: string[] = [];

  // Uncategorized channels first
  if (uncategorized.size > 0) {
    for (const [, ch] of uncategorized) {
      const prefix = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice ? '🔊' : '#';
      lines.push(`${prefix} ${ch.name}`);
    }
  }

  // Categorized channels
  for (const [, cat] of categories) {
    lines.push(`\n📁 **${cat.name}**`);
    const children = guild.channels.cache
      .filter(c => c.parentId === cat.id && isNonCategory(c))
      .sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0));
    if (children.size === 0) {
      lines.push('  (비어 있음)');
    } else {
      for (const [, ch] of children) {
        const prefix = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice ? '🔊' : '#';
        lines.push(`  ${prefix} ${ch.name}`);
      }
    }
  }

  const output = lines.join('\n') || '(채널 없음)';
  await ctx.sendAsTeam(ctx.channelId, ctx.team, `**서버 채널 목록:**\n${output}`);
  const totalChannels = guild.channels.cache.filter(c => isNonCategory(c)).size;
  console.log(`[discord-cmd] Listed ${totalChannels} channels`);
}

// --- Decision Log Handler ---

async function handleDecisionLog(params: Record<string, string>, ctx: CommandContext): Promise<void> {
  const level = params._level ?? 'autonomous';
  const reason = params.reason ?? '';
  const action = params.action ?? '';
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');

  console.log(`[decision] [${level}] ${ctx.team.name}: ${reason} → ${action}`);

  // Append to decision log file
  const logDir = path.resolve(ctx.config.workspacePath, '.mococo');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.resolve(logDir, 'decision-log.jsonl');
  const entry = JSON.stringify({
    timestamp: ts,
    team: ctx.team.name,
    level,
    reason,
    action,
  });
  fs.appendFileSync(logPath, entry + '\n');

  // For propose/escalate: also post to decision log channel if configured
  if ((level === 'propose' || level === 'escalate') && ctx.env.decisionLogChannelId) {
    const emoji = level === 'escalate' ? '🚨' : '📋';
    const msg = `${emoji} **[${level.toUpperCase()}]** ${ctx.team.name}\n> ${reason}\n> 조치: ${action}`;
    ctx.sendAsTeam(ctx.env.decisionLogChannelId, ctx.team, msg).catch(() => {});
  }
}

// --- Persona Handler ---

async function handleEditPersona(params: Record<string, string>, ctx: CommandContext) {
  const content = params._content;
  if (!content) return;

  const promptPath = path.resolve(ctx.config.workspacePath, ctx.team.prompt);
  fs.writeFileSync(promptPath, content);
  console.log(`[discord-cmd] Updated persona for ${ctx.team.name} at ${ctx.team.prompt}`);
  await ctx.sendAsTeam(ctx.channelId, ctx.team, `Persona updated.`);
}

async function handleEditMemory(params: Record<string, string>, ctx: CommandContext) {
  const content = params._content;
  if (!content) return;

  const memoryDir = path.resolve(ctx.config.workspacePath, '.mococo/memory', ctx.team.id);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.resolve(memoryDir, 'short-term.md'), content);
  console.log(`[discord-cmd] Updated short-term memory for ${ctx.team.name}`);
}

async function handleEditLongMemory(params: Record<string, string>, ctx: CommandContext) {
  const content = params._content;
  if (!content) return;

  const memoryDir = path.resolve(ctx.config.workspacePath, '.mococo/memory', ctx.team.id);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.resolve(memoryDir, 'long-term.md'), content);
  console.log(`[discord-cmd] Updated long-term memory for ${ctx.team.name}`);
}
