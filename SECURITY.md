# Security policy

Report vulnerabilities privately through the repository security advisory flow.
Do not place credentials or private session logs in a public issue.

ARC stores no sidecar copy of conversation content. Reversible blocks and their
originals live in the DeepSeek Harness append-only session log. Operators remain
responsible for the host's storage, access-control, retention, and deletion
policy.

The plugin does not send telemetry. The optional `research/` bundle is static,
synthetic repository data and is excluded from the npm package.
