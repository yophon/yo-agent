/**
 * 从 zod schema 生成 JSON Schema（draft-07），供 Go bridge 端对接 / 跨语言契约测试。
 * 运行：pnpm run gen:schema
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { AgentEventSchema, EventEnvelopeSchema } from '../src/events';
import { RPC_PARAM_SCHEMAS } from '../src/rpc';
import { PROTOCOL_VERSION } from '../src/version';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'schema');
mkdirSync(outDir, { recursive: true });

function emit(name: string, schema: ZodTypeAny): void {
  const json = zodToJsonSchema(schema, { name, target: 'jsonSchema7' });
  const file = `${name}.schema.json`;
  writeFileSync(join(outDir, file), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  wrote schema/${file}`);
}

console.log(`生成 JSON Schema (protocol v${PROTOCOL_VERSION}) →`);
emit('AgentEvent', AgentEventSchema);
emit('EventEnvelope', EventEnvelopeSchema);
for (const [method, schema] of Object.entries(RPC_PARAM_SCHEMAS)) {
  emit(`rpc.${method.replace('/', '_')}`, schema);
}
console.log('完成。');
