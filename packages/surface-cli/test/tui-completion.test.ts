import { describe, it, expect } from 'vitest';
import {
  acceptCompletion,
  buildCommands,
  computeCompletion,
  findCommand,
  fuzzyFilter,
  helpText,
  parseCommandLine,
} from '@yo-agent/surface-cli';

const SOURCES = {
  commands: [
    { name: '/help', desc: '帮助' },
    { name: '/model', desc: '模型' },
    { name: '/mcp', desc: 'MCP' },
    { name: '/clear', desc: '清屏' },
  ],
  files: ['src/app.ts', 'src/kernel.ts', 'docs/DESIGN.md'] as string[] | null,
};

describe('fuzzy 匹配', () => {
  it('前缀 > 路径段前缀 > 子串 > 子序列;不匹配剔除', () => {
    const got = fuzzyFilter(['kernel.ts', 'src/kernel.ts', 'ker-helper.md', 'zzz.txt'], 'ker');
    expect(got[0]).toBe('kernel.ts'); // 前缀且最短
    expect(got).not.toContain('zzz.txt');
    expect(fuzzyFilter(['abc'], '')).toEqual(['abc']); // 空查询全保留
    expect(fuzzyFilter(['design'], 'dgn')).toEqual(['design']); // 子序列
  });
});

describe('computeCompletion:触发与 token 解析', () => {
  it('行首 / 触发 slash 补全;非行首不触发', () => {
    const c = computeCompletion('/m', 2, SOURCES)!;
    expect(c.kind).toBe('slash');
    expect(c.token).toBe('/m');
    expect(c.items.map((i) => i.value)).toEqual(['/mcp', '/model']); // 同为前缀命中,短者优先
    expect(computeCompletion('说 /m', 4, SOURCES)).toBeNull();
    expect(computeCompletion('/model x', 8, SOURCES)).toBeNull(); // 进入 args 阶段不再补命令名
  });

  it('@ 触发文件补全;files 未加载返回空 items(菜单显示加载中)', () => {
    const c = computeCompletion('看下 @ker', 9, SOURCES)!;
    expect(c.kind).toBe('file');
    expect(c.token).toBe('@ker');
    expect(c.items[0]).toMatchObject({ value: '@src/kernel.ts', label: 'src/kernel.ts' });
    const loading = computeCompletion('@x', 2, { ...SOURCES, files: null })!;
    expect(loading.items).toEqual([]);
  });

  it('acceptCompletion:替换 token,文件补全带尾空格,光标落插入末尾', () => {
    const c = computeCompletion('看下 @ker 然后', 7, SOURCES)!; // 光标在 @ker 末尾(CJK 为单 code unit)
    const r = acceptCompletion('看下 @ker 然后', c, c.items[0]!);
    expect(r.text).toBe('看下 @src/kernel.ts  然后');
    expect(r.cursor).toBe('看下 @src/kernel.ts '.length);
    const s = computeCompletion('/m', 2, SOURCES)!;
    const modelItem = s.items.find((i) => i.value === '/model')!;
    expect(acceptCompletion('/m', s, modelItem)).toEqual({ text: '/model', cursor: 6 });
  });
});

describe('命令注册表', () => {
  it('parseCommandLine 拆命令与参数;findCommand 支持别名', () => {
    expect(parseCommandLine('/model gpt-5.5')).toEqual({ name: '/model', args: 'gpt-5.5' });
    expect(parseCommandLine('/help')).toEqual({ name: '/help', args: '' });
    expect(parseCommandLine('普通输入')).toBeNull();
    const cmds = buildCommands();
    expect(findCommand(cmds, '/quit')?.name).toBe('/exit');
    expect(findCommand(cmds, '/nope')).toBeUndefined();
  });

  it('注册表含 4.6d 全部命令;helpText 由注册表生成', () => {
    const names = buildCommands().map((c) => c.name);
    for (const n of ['/help', '/clear', '/new', '/model', '/cost', '/mcp', '/reasoning', '/cwd', '/exit']) {
      expect(names).toContain(n);
    }
    const help = helpText(buildCommands());
    expect(help).toContain('可用命令');
    expect(help).toContain('/cost');
    expect(help).toContain('@ 文件补全');
  });

  it('5.2b extraCommands:扩展命令并入注册表(/help 同源);与内置撞名(含别名)内置优先 + onClash 告警', async () => {
    const run = async (): Promise<void> => {};
    const clashes: string[] = [];
    const cmds = buildCommands(
      [
        { name: '/exthello', desc: '扩展命令', run },
        { name: '/help', desc: '妄图覆盖内置', run },
        { name: '/mine', aliases: ['/quit'], desc: '别名撞内置', run },
      ],
      (n) => clashes.push(n),
    );
    const names = cmds.map((c) => c.name);
    expect(names).toContain('/exthello');
    expect(names).not.toContain('/mine'); // 别名撞 /quit 也被拒
    expect(clashes).toEqual(['/help', '/mine']);
    expect(findCommand(cmds, '/help')?.desc).toBe('显示命令与快捷键'); // 内置未被覆盖
    // /help 输出与注册表同源:扩展命令自动进帮助。
    const notices: string[] = [];
    await findCommand(cmds, '/help')!.run({ notice: (_t: unknown, text: string) => notices.push(text) } as never, '');
    expect(notices.join('')).toContain('/exthello');
  });
});
