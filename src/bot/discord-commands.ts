import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, type Guild, type TextChannel, type Client, type Message } from 'discord.js';
import type { TeamConfig, TeamsConfig, EnvConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Strip memory/persona blocks — can be called without guild context
// ---------------------------------------------------------------------------

export function stripMemoryBlocks(output: string): string {
  return output
    .replace(/```\s*\n?(?:\[discord:edit-memory\]\s*\n)?---MEMORY---\n[\s\S]*?\n---END-MEMORY---\s*\n?```/g, '')
    .replace(/(?:\[discord:edit-memory\]\s*\n)?---MEMORY---\n[\s\S]*?\n---END-MEMORY---/g, '')
    .replace(/```\s*\n?(?:\[discord:edit-persona\]\s*\n)?---PERSONA---\n[\s\S]*?\n---END-PERSONA---\s*\n?```/g, '')
    .replace(/(?:\[discord:edit-persona\]\s*\n)?---PERSONA---\n[\s\S]*?\n---END-PERSONA---/g, '')
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
}

// ---------------------------------------------------------------------------
// B. Command Parser — extracts [discord:action ...] from bot output
// ---------------------------------------------------------------------------

interface ParsedCommand {
  raw: string;           // full matched string including brackets
  action: string;        // e.g. "create-channel"
  params: Record<string, string>;
}

/** Mask content inside triple-backtick fences so we don't match commands in code blocks */
function maskCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length));
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

  // Block syntax: run against original text (not masked) since bots wrap these in code fences
  // Also strip surrounding code fences if present
  const blockSource = output.replace(/```\s*\n(\[discord:edit-(?:persona|memory)\])/g, '$1')
    .replace(/(---END-(?:PERSONA|MEMORY)---)\s*\n```/g, '$1');

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

  // Legacy: [task:create name @bots...]
  const legacyCreateRe = /\[task:create\s+(\S+)([^\]]*)\]/gi;
  while ((match = legacyCreateRe.exec(masked)) !== null) {
    const raw = output.slice(match.index, match.index + match[0].length);
    commands.push({
      raw,
      action: 'create-channel',
      params: { name: `task-${match[1]}`, _taskName: match[1], _assigned: match[2]?.trim() || '' },
    });
  }

  // Legacy: [task:done name]
  const legacyDoneRe = /\[task:done\s+(\S+)\]/gi;
  while ((match = legacyDoneRe.exec(masked)) !== null) {
    const raw = output.slice(match.index, match.index + match[0].length);
    commands.push({
      raw,
      action: '_task-done',
      params: { name: match[1] },
    });
  }

  return commands;
}

function parseParams(paramStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\S+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paramStr)) !== null) {
    params[m[1]] = m[2] ?? m[3];
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
  sendAsTeam: (channelId: string, team: TeamConfig, content: string) => Promise<void>;
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
// E. Command Handlers
// ---------------------------------------------------------------------------

async function executeCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  try {
    switch (cmd.action) {
      case 'create-channel':  return await handleCreateChannel(cmd.params, ctx);
      case 'delete-channel':  return await handleDeleteChannel(cmd.params, ctx);
      case 'rename-channel':  return await handleRenameChannel(cmd.params, ctx);
      case 'set-topic':       return await handleSetTopic(cmd.params, ctx);
      case 'create-thread':   return await handleCreateThread(cmd.params, ctx);
      case 'send-thread':     return await handleSendThread(cmd.params, ctx);
      case 'archive-thread':  return await handleArchiveThread(cmd.params, ctx);
      case 'lock-thread':     return await handleLockThread(cmd.params, ctx);
      case 'create-category': return await handleCreateCategory(cmd.params, ctx);
      case 'delete-category': return await handleDeleteCategory(cmd.params, ctx);
      case 'move-channel':    return await handleMoveChannel(cmd.params, ctx);
      case 'pin-message':     return await handlePinMessage(cmd.params, ctx);
      case 'react':           return await handleReact(cmd.params, ctx);
      case 'edit-message':    return await handleEditMessage(cmd.params, ctx);
      case 'delete-message':  return await handleDeleteMessage(cmd.params, ctx);
      // Persona & Memory
      case 'edit-persona':    return await handleEditPersona(cmd.params, ctx);
      case 'edit-memory':     return await handleEditMemory(cmd.params, ctx);
      // Legacy alias
      case '_task-done':      return await handleTaskDone(cmd.params, ctx);
      default:
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

// --- Channel Handlers ---

async function handleCreateChannel(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;

  let parentId: string | undefined;
  if (params.category) {
    parentId = resolveCategory(params.category, ctx);
  } else if (params._taskName) {
    // Legacy [task:create] — use tasks category
    parentId = ctx.env.tasksCategoryId;
  }

  const channel = await ctx.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
  });

  const registryName = params._taskName ?? name;
  ctx.registry.setChannel(registryName, channel.id);
  console.log(`[discord-cmd] Created #${name} (${channel.id})`);

  // Legacy task:create behaviour — notify and post context
  if (params._taskName) {
    await ctx.sendAsTeam(ctx.channelId, ctx.team, `Task channel created: <#${channel.id}>`);
    const assigned = params._assigned || 'all';
    await ctx.sendAsTeam(channel.id, ctx.team, `Task **${params._taskName}** started. Assigned: ${assigned}`);
  }
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

  const msg = await channel.messages.fetch(msgId);
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

  const msg = await channel.messages.fetch(msgId);
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

  const msg = await channel.messages.fetch(msgId);
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

  const msg = await channel.messages.fetch(msgId);
  if (msg.author.id !== client.user?.id) {
    console.warn(`[discord-cmd] Cannot delete message ${msgId} — not authored by this bot`);
    return;
  }
  await msg.delete();
  console.log(`[discord-cmd] Deleted message ${msgId}`);
}

// --- Legacy: [task:done] ---

async function handleTaskDone(params: Record<string, string>, ctx: CommandContext) {
  const name = params.name;
  if (!name) return;

  if (!ctx.env.archiveCategoryId) {
    console.warn('[discord-cmd] ARCHIVE_CATEGORY_ID not set — cannot archive channels');
    return;
  }

  const channel = resolveChannel(name, ctx);
  if (!channel) {
    console.warn(`[discord-cmd] No task channel found for "${name}"`);
    return;
  }

  await channel.setParent(ctx.env.archiveCategoryId);
  ctx.registry.deleteChannel(name);
  await ctx.sendAsTeam(ctx.channelId, ctx.team, `Task **${name}** completed and channel archived.`);
  console.log(`[discord-cmd] Archived task channel "${name}"`);
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

  const memoryDir = path.resolve(ctx.config.workspacePath, '.mococo/memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryPath = path.resolve(memoryDir, `${ctx.team.id}.md`);
  fs.writeFileSync(memoryPath, content);
  console.log(`[discord-cmd] Updated memory for ${ctx.team.name}`);
}
