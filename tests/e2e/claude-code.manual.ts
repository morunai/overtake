// Manual integration check: a real Claude Code session (claude -p) drives Overtake
// through MCP against a throwaway Chrome. Run: node tests/e2e/claude-code.manual.ts
// (uses your Claude Code login and a small amount of tokens).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, SITE, sleep } from './harness.ts';

const h = new Harness();
await h.start();
try {
  const cfg = join(h.home, 'mcp.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { 'overtake': { command: process.execPath, args: [join(import.meta.dirname, '..', '..', 'mcp', 'server.ts')], env: { OVERTAKE_HOME: h.home, OVERTAKE_AGENT_NAME: 'claude-code' } } } }));
  const prompt = `Using only the Overtake MCP tools: create a Space named "cc-demo" at ${SITE}/ , take a browser_snapshot, click the "Click me" button twice using its @ref, read the clicks counter with browser_evaluate, take a viewport screenshot, then close the Space. Reply with one line: COUNT=<number>.`;
  // Async spawn: the test site is served from this process, so its event loop must keep running.
  const child = spawn('claude', ['-p', prompt, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__overtake__*', '--output-format', 'json', '--max-turns', '20'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  await new Promise((r) => child.on('exit', r));
  const out = JSON.parse(stdout || '{}');
  console.log('result:', out.result, '| turns:', out.num_turns, '| error:', out.is_error);
  await sleep(300);
  const { readdirSync, readFileSync } = await import('node:fs');
  for (const f of readdirSync(join(h.home, 'logs')).filter((x) => x.startsWith('mcp-'))) console.log(readFileSync(join(h.home, 'logs', f), 'utf8'));
  if (!/COUNT=2\b/.test(out.result || '')) process.exitCode = 1;
} finally {
  await h.stop();
}
