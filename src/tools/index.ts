import type { Tool } from '../Tool';

import { readTool } from './read';
import { writeTool } from './write';
import { editTool } from './edit';
import { bashTool } from './bash';
import { globTool } from './glob';
import { grepTool } from './grep';

export { readTool, writeTool, editTool, bashTool, globTool, grepTool };

/** The mini-claw tool set, in canonical order. */
export const DEFAULT_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];
