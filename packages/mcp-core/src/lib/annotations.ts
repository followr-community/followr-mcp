// Tool annotations per MCP spec.
//
// Per the protocol (see @modelcontextprotocol/sdk types), each tool can carry
// hints that help the consuming client decide whether to auto-approve a tool
// call or require explicit user confirmation. The hints are NON-NORMATIVE:
// clients can choose to respect them or not, and clients should never trust
// hints from untrusted servers blindly. For Followr MCP (a first-party server)
// the hints are accurate; clients like Claude Desktop and Claude Code use them
// to reduce permission prompt fatigue for read-only operations while still
// requiring confirmation for destructive ones.
//
// Categories:
//   READ_ONLY              - no mutation, no external system contact
//   READ_ONLY_EXTERNAL     - read-only but contacts an external service
//                            (Canva, ElevenLabs, Meta Graph)
//   MUTATION               - writes Followr state, not destructive, not
//                            idempotent (create, update with no-op semantics
//                            unclear)
//   MUTATION_IDEMPOTENT    - writes Followr state but repeated calls produce
//                            the same observable effect (mark_as_read,
//                            find_or_create_tag)
//   MUTATION_OPEN_WORLD    - writes Followr state AND contacts external
//                            systems or consumes credits (AI generation,
//                            Canva imports, uploads from URL)
//   DESTRUCTIVE            - irreversible side effect on Followr or in the
//                            public internet (delete_*, publish_post_group_now)

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const READ_ONLY_EXTERNAL: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const MUTATION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const MUTATION_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MUTATION_OPEN_WORLD: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
