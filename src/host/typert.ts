// dsh-diff-review typert descriptors: wire contract shared by the host
// registry and the client remote surface (v0.4 transport migration).
// 纯 JS 等价于官方 @Remote() 装饰器：显式 invocation 描述符 + ctx.typert.register。
// agent 参数由运行时注入（scope.context='agent', wire='agentId', lookup='agent'）——
// 调用者身份不可伪造，天然会话绑定。
import { z } from 'zod'

const PACKAGE = 'dsh-diff-review'
const SERVICE = 'diffReview'

const agentCodec = {
  mode: 'strict',
  typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  schema: z.intersection(z.string(), z.unknown()),
}

// request/result 走 src-json（边界 JSON 透传；内部业务已做校验），
// 避免为每个动作维护完整 zod schema——wire 契约仍由 method 名 + JSON 结构约束。
const srcJson = { mode: 'src-json' }

/** Build one direct invocation descriptor for a service method. */
function descriptor(method) {
  return {
    id: `${PACKAGE}#${SERVICE}/${method}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
      { name: 'request', wire: 'request', source: 'json', codec: srcJson },
    ],
    result: srcJson,
  }
}

/** Host invocations registered via ctx.typert.register(...); also $mount()ed client-side. */
export const DIFF_REVIEW_INVOCATIONS = [
  descriptor('getState'),
  descriptor('getItem'),
  descriptor('review'),
  descriptor('reviewGroup'),
  descriptor('reviewSession'),
  descriptor('reviewAll'),
  descriptor('clearReviewed'),
  descriptor('openExternal'),
  descriptor('getEditorConfig'),
  descriptor('saveEditorConfig'),
]

/** The register contribution for the host face. */
export function hostContribution() {
  return {
    package: PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: DIFF_REVIEW_INVOCATIONS,
  }
}
