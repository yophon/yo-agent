import { z } from 'zod';

/**
 * cursor：单调递增的事件序号，resume 锚点（DESIGN §2.2 / §6.3）。
 * 由 bridge 分配或本地 EventLog 自增。
 */
export const CursorSchema = z.number().int().nonnegative();
export type Cursor = z.infer<typeof CursorSchema>;

/**
 * Id：不透明标识符（约定用 ULID）。压缩时必须逐字保留（DESIGN §5.1 标识符保留）。
 */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;
