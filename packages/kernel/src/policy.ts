import type { PermissionMode, RiskLevel, ToolKind } from '@yo-agent/protocol';
import type { ToolApproval } from '@yo-agent/tools';

/** 权限闸门裁决：allow=直接放行；ask=走 ApprovalGate；deny=拒绝执行（不弹审批）。 */
export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface PolicyInput {
  permissionMode: PermissionMode;
  kind: ToolKind;
  risk: RiskLevel;
  approval: ToolApproval;
  toolName: string;
}

/**
 * 权限闸门（DESIGN §9.2 / ADR-4 / ADR-16）：在 assessRisk 之后、requestApproval 之前按 permissionMode 决策。
 * 与 SecurityAnalyzer(assessRisk) × ApprovalGate(approvalCache) 正交叠加——本闸门只决定「直接放行/需审批/直接拒」。
 */
export interface PolicyEngine {
  decide(input: PolicyInput): PolicyDecision;
}

/** 读类：非变更、非执行、非网络——只读类工具。 */
const READ_CLASS: ReadonlySet<ToolKind> = new Set<ToolKind>(['read', 'search', 'think']);
/** 编辑类：文件变更但非删除/执行。 */
const EDIT_CLASS: ReadonlySet<ToolKind> = new Set<ToolKind>(['edit', 'move']);
/** 危险类：执行命令 / 删除——破坏性最强。 */
const DANGEROUS_CLASS: ReadonlySet<ToolKind> = new Set<ToolKind>(['execute', 'delete']);

/**
 * 默认权限闸门。
 *
 * 关键不变量（4A「不改运行时行为」的基石）：
 *   - `supervised`（默认档）对所有非 never 工具返回 `ask` → 逐字等价 Phase 3 既有审批行为。
 *   - `approval:'never'` 工具恒 `allow`（与既有「never 放行」一致；外部 MCP 工具被禁用 never，§3.3）。
 * 其余档位仅在显式切换时引入新行为（现有测试不设这些档 → 307 测试不变）。
 */
export class DefaultPolicyEngine implements PolicyEngine {
  decide(i: PolicyInput): PolicyDecision {
    // never 工具恒放行（不可被权限模式升级为审批/拒，保持与既有 kernel 行为一致）。
    if (i.approval === 'never') return 'allow';

    // read-only 优先：只读档对非读类恒拒，先于 always 升级（拒 > 审批，最严档不被 always 软化）。
    if (i.permissionMode === 'read-only') return READ_CLASS.has(i.kind) ? 'allow' : 'deny';

    // approval:'always'（必经审批契约，审查 4A-MED）：除 bypass（明示 opt-out）外恒走审批，
    // 不被 accept-edits/autonomous/ci 的自动放行软化。否则声明 always 的（插件/外部）工具在非 supervised 档形同 risk-based。
    if (i.approval === 'always' && i.permissionMode !== 'bypass') return 'ask';

    switch (i.permissionMode) {
      case 'supervised':
        // 默认档：全部非 never 工具走审批 —— 等价既有行为。
        return 'ask';
      case 'bypass':
        // 明示危险：全放行（CI 信任环境 / 显式 opt-out）。
        return 'allow';
      // read-only 已在上方「read-only 优先」分支返回，不再入 switch。
      case 'accept-edits':
        // 自动接受编辑：读类直接放行；编辑类**仅低/中风险**放行，high/unknown（如写 Protected Path/.git/hooks）仍走审批
        //（审查 4A-H：accept-edits 不应无视风险放行 Protected Path 写入）；危险类与网络/其它仍走审批。
        if (READ_CLASS.has(i.kind)) return 'allow';
        if (EDIT_CLASS.has(i.kind)) return i.risk === 'high' || i.risk === 'unknown' ? 'ask' : 'allow';
        return 'ask';
      case 'autonomous':
        // 自主：按风险——高/未知风险走审批，其余放行。
        return i.risk === 'high' || i.risk === 'unknown' ? 'ask' : 'allow';
      case 'ci':
        // 非交互 CI：无人应答，「需审批」即等价拒。危险类恒拒；高/未知风险拒；低/中风险且非危险类放行。
        if (DANGEROUS_CLASS.has(i.kind)) return 'deny';
        return i.risk === 'high' || i.risk === 'unknown' ? 'deny' : 'allow';
      default:
        // 未知档位保守走审批（不应发生：PermissionMode 是 sealed enum）。
        return 'ask';
    }
  }
}
