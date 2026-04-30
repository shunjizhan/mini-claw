#!/usr/bin/env bun
import * as readline from 'node:readline';
import { Command } from 'commander';

import { QueryEngine } from './QueryEngine';
import { DEFAULT_TOOLS } from './tools/index';
import { buildSkillTool } from './tools/skill';
import { buildAgentTool } from './tools/agent';
import { resolveBaseURL, selectProvider } from './providers/index';
import { assembleSystemPrompt, loadMemory } from './prompt';
import { createReadlinePermissionPrompter } from './permissions';
import { loadSkills } from './skills/loader';
import { loadAgents } from './agents/loader';
import { ProviderProtocolError } from './types';
import type { Tool } from './Tool';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('mini-cc')
    .description('Mini provider-agnostic Claude Code clone')
    .option(
      '--provider <name>',
      "provider: 'anthropic' (default) or 'openai'; overrides MINI_CC_PROVIDER",
    )
    .option(
      '--model <id>',
      'model ID; overrides MINI_CC_MODEL (provider-specific default otherwise)',
    )
    .option('--cwd <path>', 'working directory (default: current)');
  program.parse();
  const cli = program.opts<{ provider?: string; model?: string; cwd?: string }>();

  if (cli.provider) process.env['MINI_CC_PROVIDER'] = cli.provider;
  if (cli.model) process.env['MINI_CC_MODEL'] = cli.model;
  const cwd = cli.cwd ?? process.cwd();

  const provider = selectProvider();
  const memory = await loadMemory(cwd);
  const [skills, agents] = await Promise.all([
    loadSkills({ cwd }),
    loadAgents({ cwd }),
  ]);
  // Skill / Agent tools are only registered when at least one of each is
  // discoverable — matches real CC's behavior of not exposing the dispatcher
  // when its registry is empty (avoids the model inventing names).
  //
  // The Agent tool reads the parent's tool pool from `ctx.tools` at call
  // time (populated fresh per turn by QueryEngine), so it doesn't need a
  // construction-time reference to the `tools` array. Mirrors real CC's
  // `toolUseContext.options.tools` mechanism — see ToolContext docs.
  const tools: Tool[] = [...DEFAULT_TOOLS];
  if (skills.length > 0) tools.push(buildSkillTool(skills));
  if (agents.length > 0) {
    tools.push(buildAgentTool(agents, { provider, memory }));
  }
  const systemPrompt = assembleSystemPrompt({
    tools,
    cwd,
    memory,
    skills,
    agents,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
    terminal: true,
  });

  const engine = new QueryEngine({
    provider,
    tools,
    systemPrompt,
    cwd,
    permissionPrompter: createReadlinePermissionPrompter(rl),
  });

  let turnActive = false;

  // SIGINT: if mid-turn, abort just the turn (keep the session). If idle,
  // a second Ctrl+C kills the process. EOF (Ctrl+D) always exits cleanly.
  let idleSigintCount = 0;
  const onSigint = (): void => {
    if (turnActive) {
      engine.abort();
      return;
    }
    idleSigintCount++;
    if (idleSigintCount >= 2) {
      rl.close();
      process.exit(0);
    }
    process.stdout.write('\n(Ctrl+C again to exit, or Ctrl+D)\n');
    rl.prompt();
  };
  rl.on('SIGINT', onSigint);

  const provName = process.env['MINI_CC_PROVIDER'] ?? 'anthropic';
  const baseURL = resolveBaseURL() ?? '(SDK default)';
  const skillNote =
    skills.length > 0
      ? ` | skills=${skills.length} (${skills.map((s) => s.name).join(', ')})`
      : '';
  const agentNote =
    agents.length > 0
      ? ` | agents=${agents.length} (${agents.map((a) => a.agentType).join(', ')})`
      : '';
  console.log(
    `mini-claw | provider=${provName} | model=${provider.model} | baseURL=${baseURL} | cwd=${cwd}${skillNote}${agentNote}\n` +
      `Ctrl+C aborts the current turn; Ctrl+D exits.`,
  );
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      continue;
    }

    idleSigintCount = 0;
    turnActive = true;
    let hadNonNewlineOutput = false;
    try {
      for await (const event of engine.submitMessage(text)) {
        if (event.type === 'text_delta') {
          process.stdout.write(event.text);
          hadNonNewlineOutput = true;
        } else {
          for (const block of event.assistantMessage.content) {
            if (block.type === 'tool_use') {
              if (hadNonNewlineOutput) process.stdout.write('\n');
              process.stdout.write(
                `⚙ ${block.name}(${formatToolInput(block.input)})\n`,
              );
              hadNonNewlineOutput = false;
            }
          }
          if (event.stopReason === 'stop' && hadNonNewlineOutput) {
            process.stdout.write('\n');
          }
        }
      }
    } catch (err) {
      if (hadNonNewlineOutput) process.stdout.write('\n');
      if (isAbortError(err)) {
        console.error('[aborted — turn dropped]');
      } else if (err instanceof ProviderProtocolError) {
        console.error(`[provider protocol error — turn dropped: ${err.message}]`);
      } else {
        console.error(
          `[error: ${err instanceof Error ? err.message : String(err)}]`,
        );
      }
    } finally {
      turnActive = false;
    }
    rl.prompt();
  }

  console.log('bye');
}

function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => {
      const str = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
      const truncated = str.length > 80 ? `${str.slice(0, 77)}...` : str;
      return `${k}=${truncated}`;
    })
    .join(', ');
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  // Anthropic SDK throws APIUserAbortError; OpenAI SDK throws APIUserAbortError too.
  // Message text is the reliable cross-provider signal.
  return /abort/i.test(err.message);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
