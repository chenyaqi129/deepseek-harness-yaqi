# Lifebase tools (local plugin)

Read-only DeepSeek Harness tools over the Lifebase HumanOS JSON CLI
(api_version 1): `lifebase_topics`, `lifebase_search`, `lifebase_timeline`, `lifebase_evidence`,
`lifebase_context`. Lifebase owns the contract and egress policy; this directory only adapts it.

- The executable, data directory, and destination come from plugin config; the model supplies
  query text and filters only. Option values are bound as `--opt=value` and positionals follow `--`.
- Destination is re-resolved on every call from the agent's provider: only providers mapped to
  `local` in `routes` get `local`; everything else is `cloud`.
- `exclusive: true` (default) registers a `tools.guard()` that denies every non-`lifebase_*`
  tool. Shell, filesystem, web, subagent, or workflow tools could otherwise read the data
  directory directly. Keep it on for any profile that points at Lifebase data.

Load it from a profile patch (see the Lifebase `docs/harness-interface.md` for a full example):

```yaml
- insert:
    - id: lifebase-tools
      name: '/abs/path/lifebase-plugin/src/index.ts'
      config:
        executable: /abs/path/envs/lifebase/bin/lifebase
        dataDir: /abs/path/Lifebase-data/libraries/demo
        routes:
          deepseek-official: cloud
```

Tests use Node's built-in runner and need no workspace build. Set the variables to also run the
end-to-end checks against a real CLI:

```sh
LIFEBASE_EXECUTABLE=... LIFEBASE_DEMO_DATA_DIR=... LIFEBASE_PERSONAL_DATA_DIR=... node --test lifebase-plugin/tests/
```
