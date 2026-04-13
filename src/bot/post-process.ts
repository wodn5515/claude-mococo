// ---------------------------------------------------------------------------
// Extract memory update from claude output
// ---------------------------------------------------------------------------

const MEMORY_REGEX = /---MEMORY---([\s\S]*?)---END-MEMORY---/;

/**
 * Extract memory update block from claude's output.
 * Returns the memory content if found, null otherwise.
 */
export function extractMemoryUpdate(output: string): string | null {
  const match = output.match(MEMORY_REGEX);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Strip memory blocks from output before posting to Discord.
 */
export function stripMemoryBlocks(output: string): string {
  return output.replace(/---MEMORY---[\s\S]*?---END-MEMORY---/g, '').trim();
}

// ---------------------------------------------------------------------------
// Truncate output for Discord
// ---------------------------------------------------------------------------

const MAX_DISCORD_OUTPUT = 4000; // Leave room for chunking

/**
 * Prepare claude output for Discord:
 * - Strip memory blocks
 * - Truncate if too long
 */
export function truncateForDiscord(output: string): string {
  let cleaned = stripMemoryBlocks(output);

  if (cleaned.length > MAX_DISCORD_OUTPUT) {
    cleaned = cleaned.slice(0, MAX_DISCORD_OUTPUT) + '\n\n... (truncated)';
  }

  return cleaned;
}
