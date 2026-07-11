# Security policy

## Supported versions

Security fixes are made on the latest release and on `main`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting flow at
`https://github.com/cochon123/cli2api/security/advisories/new`. Include the
affected version, a minimal reproduction, impact, and any suggested mitigation.
Do not disclose an exploitable issue in a public GitHub issue before a fix is
available.

## Security boundary

cli2api is a single-user, loopback-only process. It is not a multi-tenant
gateway and intentionally refuses non-loopback binds. A client with the bearer
token can send prompts to locally authenticated coding CLIs.

The default empty working directory limits automatically discovered project
context; it is not an operating-system sandbox. CLI subprocesses run as the
current user and can access their own authentication/configuration locations
and anything permitted by the CLI's own sandbox or policy. `--project` and
`--cwd` additionally trust the selected directory and any instructions/config
that the CLI normally discovers there. Cursor's headless adapter passes
`--trust`, so either option also auto-acknowledges that workspace to Cursor.
Managed machine-level CLI policy may
override user-level behavior. Keep the token private, install CLIs from trusted
sources, and do not tunnel or reverse-proxy the service onto a network.
