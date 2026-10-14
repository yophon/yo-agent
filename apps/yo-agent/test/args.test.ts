import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, parseArgs, resolvePermissionMode } from '../src/args';

describe('parseArgs(CLI 入口参数解析,4.8c)', () => {
  it('无参数 → headless 空 prompt(main 会给用法提示)', () => {
    expect(parseArgs([])).toEqual({ prompt: '', mode: 'headless', listenPort: undefined, resume: undefined });
  });

  it('-p 取值;裸词兜底拼 prompt;-p 优先于裸词', () => {
    expect(parseArgs(['-p', '你好']).prompt).toBe('你好');
    expect(parseArgs(['写', '快排'])).toMatchObject({ prompt: '写 快排', mode: 'headless' });
    expect(parseArgs(['-p', '主问', '裸词']).prompt).toBe('主问');
  });

  it('-p 后紧跟 flag/缺值 → 视为缺 prompt', () => {
    expect(parseArgs(['-p', '--tui'])).toMatchObject({ prompt: '', mode: 'tui' });
    expect(parseArgs(['-p']).prompt).toBe('');
  });

  it('模式旗标:--tui / --mode jsonl / rpc / mcp-server / acp 双形态', () => {
    expect(parseArgs(['--tui']).mode).toBe('tui');
    expect(parseArgs(['--mode', 'jsonl']).mode).toBe('jsonl');
    expect(parseArgs(['rpc']).mode).toBe('rpc');
    expect(parseArgs(['--rpc']).mode).toBe('rpc');
    expect(parseArgs(['mcp-server']).mode).toBe('mcp-server');
    expect(parseArgs(['--mcp-server']).mode).toBe('mcp-server');
    expect(parseArgs(['acp']).mode).toBe('acp');
    expect(parseArgs(['--acp']).mode).toBe('acp');
  });

  it('模式优先级:acp > mcp-server > rpc > jsonl > tui', () => {
    expect(parseArgs(['--tui', '--mode', 'jsonl']).mode).toBe('jsonl');
    expect(parseArgs(['rpc', '--mode', 'jsonl']).mode).toBe('rpc');
    expect(parseArgs(['rpc', 'mcp-server']).mode).toBe('mcp-server');
    expect(parseArgs(['mcp-server', 'acp']).mode).toBe('acp');
  });

  it('--mode 消费其值,不泄漏进 positional prompt', () => {
    expect(parseArgs(['--mode', 'jsonl', '提问']).prompt).toBe('提问');
    expect(parseArgs(['--mode', 'tui']).mode).toBe('tui');
  });

  it('rpc --listen <port> 解析端口;缺值/后跟 flag 不消费', () => {
    expect(parseArgs(['rpc', '--listen', '8799'])).toMatchObject({ mode: 'rpc', listenPort: 8799 });
    expect(parseArgs(['rpc', '--listen']).listenPort).toBeUndefined();
    expect(parseArgs(['rpc', '--listen', '--tui']).listenPort).toBeUndefined();
  });

  it('--continue/-c → resume=last 并强制 tui', () => {
    expect(parseArgs(['--continue'])).toMatchObject({ resume: 'last', mode: 'tui' });
    expect(parseArgs(['-c'])).toMatchObject({ resume: 'last', mode: 'tui' });
  });

  it('--resume 带 id 取 id;不带 id → picker;均强制 tui', () => {
    expect(parseArgs(['--resume', 'abc123'])).toMatchObject({ resume: 'abc123', mode: 'tui' });
    expect(parseArgs(['--resume'])).toMatchObject({ resume: 'picker', mode: 'tui' });
    expect(parseArgs(['-r', '--tui'])).toMatchObject({ resume: 'picker', mode: 'tui' });
  });

  it('`--` 分隔符与未知 flag 跳过,不进 prompt', () => {
    expect(parseArgs(['--', '-p', '提问', '--unknown']).prompt).toBe('提问');
    expect(parseArgs(['--verbose', '提问']).prompt).toBe('提问');
  });

  it('--permission-mode <档位> 取原始值(空格/= 两形态);缺值/后跟 flag → 空串;不进 prompt', () => {
    expect(parseArgs(['--permission-mode', 'ci', '-p', '问'])).toMatchObject({ permissionMode: 'ci', prompt: '问', mode: 'headless' });
    expect(parseArgs(['--permission-mode=accept-edits', '提问'])).toMatchObject({ permissionMode: 'accept-edits', prompt: '提问' });
    expect(parseArgs(['--permission-mode']).permissionMode).toBe('');
    expect(parseArgs(['--permission-mode', '--tui'])).toMatchObject({ permissionMode: '', mode: 'tui' });
    expect(parseArgs(['--permission-mode', 'bogus']).permissionMode).toBe('bogus'); // 校验在 resolve 层
    expect(parseArgs(['提问']).permissionMode).toBeUndefined();
  });
});

describe('resolvePermissionMode(--permission-mode > YO_PERMISSION_MODE > 不指定)', () => {
  it('档位清单与 protocol sealed enum 同源', () => {
    expect([...PERMISSION_MODES]).toEqual(['read-only', 'supervised', 'accept-edits', 'autonomous', 'ci', 'bypass']);
  });

  it('flag 合法直接生效且压过 env;两者皆无 → 不指定(内核默认 supervised)', () => {
    expect(resolvePermissionMode('ci', 'bypass')).toEqual({ mode: 'ci' });
    expect(resolvePermissionMode(' read-only ', undefined)).toEqual({ mode: 'read-only' });
    expect(resolvePermissionMode(undefined, 'accept-edits')).toEqual({ mode: 'accept-edits' });
    expect(resolvePermissionMode(undefined, undefined)).toEqual({});
    expect(resolvePermissionMode(undefined, '  ')).toEqual({});
  });

  it('flag 非法/缺值 → error(进程退出 2);env 非法 → warning 忽略(与 YO_LOOP_BREAKER 同策略)', () => {
    expect(resolvePermissionMode('bogus', undefined).error).toMatch(/bogus 不是有效档位.*read-only|supervised/);
    expect(resolvePermissionMode('', 'ci')).toMatchObject({ error: expect.stringMatching(/缺值/) });
    expect(resolvePermissionMode('', 'ci').mode).toBeUndefined(); // 缺值不回退到 env：用户显式写了 flag 就按 flag 报错
    const r = resolvePermissionMode(undefined, 'nope');
    expect(r.mode).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.warning).toMatch(/YO_PERMISSION_MODE=nope/);
  });
});
