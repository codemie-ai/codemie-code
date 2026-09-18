import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { claudeBlocks, claudeResponseKey, type ClaudeNativeRow } from './claude-native.js';

/** One physical owner transcript in the captured family. */
export interface ClaudeTraceOwner {
  id: string;
  messages: unknown[];
  transcript?: NonNullable<ParsedSession['subagents']>[number];
}

/** Family-wide canonical identity indexes; undefined owners remain unresolved. */
export interface ClaudeOwnership {
  rootOwnerId: string;
  owners: Map<string, ClaudeTraceOwner>;
  parents: Map<string, string>;
  toolOwners: Map<string, string>;
  unresolvedTools: Set<string>;
  responseOwners: Map<string, string | undefined>;
  messageOwners: Map<string, string | undefined>;
  responseCandidates: Map<string, Set<string>>;
}

interface IdentityClaims {
  tools: Map<string, Set<string>>;
  responses: Map<string, Set<string>>;
  messages: Map<string, Set<string>>;
  toolResponses: Map<string, Set<string>>;
}

/** Normalize the root alias used by Claude sidecar metadata. */
export function canonicalClaudeParent(parent: string | undefined, root: string): string | undefined {
  return parent === 'root' || parent === root ? root : parent;
}

function addClaim(claims: Map<string, Set<string>>, key: string, owner: string): void {
  const values = claims.get(key) ?? new Set<string>();
  values.add(owner);
  claims.set(key, values);
}

function collectClaims(owners: Map<string, ClaudeTraceOwner>): IdentityClaims {
  const claims: IdentityClaims = { tools: new Map(), responses: new Map(), messages: new Map(), toolResponses: new Map() };
  for (const owner of owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      if (!row || typeof row !== 'object') continue;
      const response = claudeResponseKey(row);
      if (response) addClaim(claims.responses, response, owner.id);
      if (row.uuid) addClaim(claims.messages, row.uuid, owner.id);
      for (const block of claudeBlocks(row)) {
        if (block.type !== 'tool_use' || !block.id) continue;
        addClaim(claims.tools, block.id, owner.id);
        if (response) addClaim(claims.toolResponses, block.id, response);
      }
    }
  }
  return claims;
}

function isAncestor(ancestor: string, descendant: string, parents: Map<string, string>): boolean {
  const seen = new Set<string>();
  let current: string | undefined = descendant;
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

function resolveOwner(candidates: Set<string>, parents: Map<string, string>, root: string): string | undefined {
  // Root rows are the family's original history even when sidecar metadata is absent.
  if (candidates.has(root)) return root;
  const originals = [...candidates].filter((candidate) => [...candidates].every((other) => isAncestor(candidate, other, parents)));
  return originals.length === 1 ? originals[0] : undefined;
}

function ownershipParents(owners: Map<string, ClaudeTraceOwner>, claims: IdentityClaims, root: string): Map<string, string> {
  const parents = new Map<string, string>();
  for (const owner of owners.values()) {
    const parent = canonicalClaudeParent(owner.transcript?.parentAgentId, root);
    if (parent) parents.set(owner.id, parent);
  }
  // A unique native tool occurrence supplies exact evidence when the sidecar omits parentAgentId.
  for (const owner of owners.values()) {
    const tool = owner.transcript?.toolUseId;
    const candidates = tool ? claims.tools.get(tool) : undefined;
    if (!parents.has(owner.id) && candidates?.size === 1) parents.set(owner.id, [...candidates][0]);
  }
  return parents;
}

function resolveTools(claims: IdentityClaims, ownership: ClaudeOwnership): void {
  for (const [tool, candidates] of claims.tools) {
    const responses = claims.toolResponses.get(tool);
    const responseOwners = new Set([...responses ?? []].map((key) => ownership.responseOwners.get(key)));
    const owner = responses?.size
      ? (responseOwners.size === 1 ? [...responseOwners][0] : undefined)
      : resolveOwner(candidates, ownership.parents, ownership.rootOwnerId);
    if (owner) ownership.toolOwners.set(tool, owner);
    else ownership.unresolvedTools.add(tool);
  }
}

/** Resolve original response/message/tool ownership before reading usage or emitting invocations. */
export function buildClaudeOwnership(parsed: ParsedSession): ClaudeOwnership {
  const rootOwnerId = parsed.sessionId;
  const owners = new Map<string, ClaudeTraceOwner>([[rootOwnerId, { id: rootOwnerId, messages: Array.isArray(parsed.messages) ? parsed.messages : [] }]]);
  for (const transcript of parsed.subagents ?? []) {
    owners.set(transcript.agentId, { id: transcript.agentId, messages: Array.isArray(transcript.messages) ? transcript.messages : [], transcript });
  }
  const claims = collectClaims(owners);
  const parents = ownershipParents(owners, claims, rootOwnerId);
  const ownership: ClaudeOwnership = { rootOwnerId, owners, parents, toolOwners: new Map(), unresolvedTools: new Set(), responseOwners: new Map(), messageOwners: new Map(), responseCandidates: claims.responses };
  for (const [key, candidates] of claims.responses) {
    const owner = resolveOwner(candidates, parents, rootOwnerId);
    ownership.responseOwners.set(key, owner);
  }
  for (const [key, candidates] of claims.messages) ownership.messageOwners.set(key, resolveOwner(candidates, parents, rootOwnerId));
  resolveTools(claims, ownership);
  return ownership;
}
