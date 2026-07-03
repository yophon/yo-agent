/** CLI 参数解析(纯函数,从 main.ts 抽出可测,4.8c)。 */

export type Mode = 'tui' | 'jsonl' | 'headless' | 'rpc' | 'mcp-server' | 'acp';

export interface Args {
  /** 4.6e：'last'（--continue）| 'picker'（--resume 不带 id）| 具体会话 id。 */
  resume?: string;
  prompt: string;
  mode: Mode;
  /** rpc --listen <port>：WS server 模式（带设备鉴权），否则 stdio。 */
  listenPort?: number;
}

export function parseArgs(argv: string[]): Args {
  let prompt = '';
  let wantJsonl = false;
  let wantTui = false;
  let wantRpc = false;
  let wantMcp = false;
  let wantAcp = false;
  let listenPort: number | undefined;
  /** 4.6e:'last'(--continue)| 'picker'(--resume 不带 id)| 具体会话 id。 */
  let resume: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue; // pnpm 注入的分隔符
    if (a === '--listen') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        listenPort = Number.parseInt(v, 10);
        i++;
      }
      continue;
    }
    if (a === '-p') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        prompt = v;
        i++;
      } // -p 后紧跟 flag/缺值 → 视为缺 prompt，触发用法提示
      continue;
    }
    if (a === '--mode') {
      const v = argv[i + 1];
      if (v === 'jsonl') wantJsonl = true;
      if (v === 'rpc') wantRpc = true;
      if (v === 'mcp-server') wantMcp = true;
      if (v === 'acp') wantAcp = true;
      if (v === 'tui') wantTui = true;
      if (v !== undefined && !v.startsWith('-')) i++; // 消费其 value，勿泄漏进 positional
      continue;
    }
    if (a === '--tui') {
      wantTui = true;
      continue;
    }
    if (a === '--continue' || a === '-c') {
      resume = 'last';
      wantTui = true;
      continue;
    }
    if (a === '--resume' || a === '-r') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        resume = v;
        i++;
      } else {
        resume = 'picker';
      }
      wantTui = true;
      continue;
    }
    if (a === 'rpc' || a === '--rpc') {
      wantRpc = true;
      continue;
    }
    if (a === 'mcp-server' || a === '--mcp-server') {
      wantMcp = true;
      continue;
    }
    if (a === 'acp' || a === '--acp') {
      wantAcp = true;
      continue;
    }
    if (a.startsWith('-')) continue; // 未知 flag 跳过
    positional.push(a);
  }
  if (!prompt) prompt = positional.join(' ');
  const mode: Mode = wantAcp
    ? 'acp'
    : wantMcp
      ? 'mcp-server'
      : wantRpc
        ? 'rpc'
        : wantJsonl
          ? 'jsonl'
          : wantTui
            ? 'tui'
            : 'headless';
  return { prompt, mode, listenPort, resume };
}
