# Contributing

Start with a [good first issue](https://github.com/VictorPimentaDev/orca-agent-runner/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
or describe a concrete bug: the command, expected result and observed result.
Remove secrets, personal paths and worker output that is not safe to share.

## Development

Use Node.js 24, npm and Git. From the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run demo
npm pack --dry-run
```

`npm run demo` uses a disposable local repository and your configured Git identity.
It never calls an external LLM. Tests use temporary repositories and subprocess
fixtures; no API keys or running Orca instance are needed.

Keep changes small. If you change parsing, ownership, cleanup or filesystem
handling, include a failing case that proves the behavior. Do not weaken validation
to make a test pass. A worktree is not a sandbox; cleanup must never target a handle
that the adapter cannot prove it created.

## Pull requests

Explain the concrete problem, resulting behavior and checks you ran. Note limitations
or platform assumptions. Use current timestamps and your own Git identity. Do not add
secrets, generated instruction files or unrelated refactoring. Documentation examples
must distinguish a fixture from a real coding agent.

The package is MIT licensed. Submitting a contribution means you are comfortable
with its inclusion under that license. There is no CLA or external service signup.

## Em português

Pode abrir issue ou PR em pt-BR. Traga um caso reproduzível e o resultado esperado.
As prioridades são clareza do protocolo, isolamento de arquivos e cleanup que respeite
ownership. Ideias maiores devem começar com uma issue para discutir o comportamento.
