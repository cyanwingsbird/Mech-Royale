# kestrel — Mech Royale bot

Entry for the Builders Buildathon "Mech Royale" track. Speaks `mechfight/1` on stdin/stdout.

- `main.mjs` — protocol loop (answers only the newest observation)
- `map.mjs` — campus nav grid, A* pathfinding, line of sight
- `bot.mjs` — decision logic
- `sim/` — rough local test simulator (not the real game; not used at runtime)

No runtime dependencies beyond Node 22. Built during the event with AI assistance (Claude). MIT licensed.
