import type { Tool } from '../Tool';

import { readTool } from './read';
import { writeTool } from './write';
import { editTool } from './edit';
import { bashTool } from './bash';

export { readTool, writeTool, editTool, bashTool };

/** The full Tier 1 tool set, in canonical order. */
export const DEFAULT_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];
