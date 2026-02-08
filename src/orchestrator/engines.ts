import type { Engine } from '../types.js';
import type { EngineOptions } from './engine-base.js';
import { BaseEngine } from './engine-base.js';
import { ClaudeEngine } from './claude-engine.js';
import { CodexEngine } from './codex-engine.js';
import { GeminiEngine } from './gemini-engine.js';

export function createEngine(engine: Engine, opts: EngineOptions): BaseEngine {
  switch (engine) {
    case 'claude':
      return new ClaudeEngine(opts);
    case 'codex':
      return new CodexEngine(opts);
    case 'gemini':
      return new GeminiEngine(opts);
    default:
      throw new Error(`Unknown engine: ${engine}`);
  }
}
