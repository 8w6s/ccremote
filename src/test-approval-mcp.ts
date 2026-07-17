import 'dotenv/config';
import { spawn } from 'node:child_process';
import { approvalMcpServer } from './lib/approvalMcpServer';

async function main(): Promise<void> {
  await approvalMcpServer.start(async (_channelId, args) => ({
    behavior: 'allow',
    updatedInput: args.input,
  }));
  const configPath = await approvalMcpServer.registerChannel('integration-test');
  if (!configPath) throw new Error('MCP config path unavailable');

  const child = spawn(
    process.env.CLAUDE_BIN ?? 'claude',
    [
      '-p',
      'Use Bash exactly once to run: printf approval-ok',
      '--output-format',
      'json',
      '--debug',
      'mcp',
      '--debug-file',
      '/tmp/clauderemote-approval-debug.log',
      '--permission-mode',
      'manual',
      '--strict-mcp-config',
      '--mcp-config',
      configPath,
      '--permission-prompt-tool',
      'mcp__cr__approve',
      '--tools',
      'Bash',
      '--max-turns',
      '2',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );

  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk: string) => process.stderr.write(chunk));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  await approvalMcpServer.stop();
  if (code !== 0) throw new Error(`Claude integration test exited ${code}`);
}

void main().catch(async (err) => {
  await approvalMcpServer.stop().catch(() => {});
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
