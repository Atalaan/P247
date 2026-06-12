# P247 Repository Layout

This repository carries two Cline-derived stacks side by side:

- `vscode/` is the reconstructed VS Code + LM Studio golden stack. It is the
  frozen reference route for Part 16 style reproduction and benchmark runs.
- `p2ai/` is the active P2AI/Cline route imported from
  `C:\PAI_Platform\third_party\SAM\Cline_Agent\Cline`.

The golden harness lives under `vscode/scripts/p2ai_stack/` and the convenience
entrypoints are:

```bat
vscode\run_gold_autostart_clean.bat
vscode\run_gold_toolmatrix_clean.bat
```

Those scripts force the golden LM Studio runtime settings used for the
reconstruction checks:

```text
model = gemma-4-E4B-it-GGUF
context = 32768
gpu offload = max
expected GPU layers = 43/43
compact prompt = on
AGENTS.md project rules = off by default
```
