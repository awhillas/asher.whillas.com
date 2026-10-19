# Horde Tower Defence v2 — Features

Current behaviour of the game in `horde-v2.html` / `horde-v2.js`.
Most numbers are constants near the top of `horde-v2.js`.

## Map

- Grid-based. Desktop is a fixed 40 × 28 grid. On screens 500px wide or less, the grid is
  sized to fill the screen, with larger cells.
- A new corridor is randomly generated each level. It winds like a snake across 3 or 4
  horizontal lanes joined by U-turns.
- Corridor width varies along its length (roughly 2–5 cells).
- The entrance is on the left. The exit is on the left or right, depending on the number of lanes.
- Every generated corridor is checked to connect the entrance to the exit.

## Enemies

- Enemies are solid circles. They push each other apart, can't overlap, and can't leave the corridor.
- They follow a flow field towards the exit and route around towers when there is room.
- If towers block the corridor, enemies push into them and damage them until they are destroyed.

| Type | HP (level 1) | Speed | Tower damage / s | Reward |
|---|---|---|---|---|
| Tiny (yellow) | 15 | 3.0 | 4 | $5 |
| Small (orange) | 33 | 2.3 | 8 | $10 |
| Medium (green) | 73 | 1.7 | 14 | $15 |
| Large (purple) | 160 | 1.25 | 24 | $20 |
| Huge (blue) | 351 | 0.95 | 40 | $25 |
| Gunner (red) | 80 | 1.4 | 10 | $50 |

- Size HP grows exponentially: 15 × 2.2^size.
- Gunners shoot the nearest tower in range. They use the same range, damage and bullet speed
  as towers, at half the fire rate.
- Gunners are rare on level 1 and become more common each level.
- Per level, all enemies get 5% more tower damage and 1% more speed. HP grows 5% per level,
  or 10% per level for gunners.
- Larger enemy types become more common at higher levels.

## Spawning and waves

- A mixed stream of enemies arrives all the time. The rate rises with the level and the
  time spent in the level.
- Every 20 seconds a wave of a single enemy type arrives on top of that stream.
  - Wave size is 10 + 4 × level enemies, arriving at 6 per second.
  - Waves go in a fixed order: Tiny, Small, Medium, Large, Huge, Gunner, then repeat from Tiny.
    Each level starts again at Tiny.
- A banner announces each wave. The HUD shows a countdown to the next wave.

## Towers

- Cost **$50** on every level.
- Can be built on any grid cell except the corridor entrance and exit cells, or on top of an enemy.
- Towers inside the corridor block enemies and take damage from them (150 HP).
- Range 3.6 cells, 10 damage per shot, 2.2 shots per second. Towers target the enemy
  furthest along the corridor.
- **Selling:** right-click a tower to sell it for $25, at any health.

## Economy and levels

- At the start of each level money resets to enough for **level + 1 towers** (level × $50 + $50).
- Clear a level by reaching **level × $1000**.
- 20 lives per level. Each enemy that reaches the exit costs one life. At 0 lives the game is over.
- **Emergency funds:** if you have no towers and can't afford one, you receive a random amount
  that buys 2–10 towers. This happens at most once per level.
- Towers do not carry over to the next level.

## Controls and UI

- Left-click / tap: build a tower. Right-click a tower: sell it.
- Space: start or pause. F or the Speed button: switch between x1, x2 and x3 speed.
- Hovering a cell shows the tower range and whether it can be built on.
- Each level starts paused with a centred banner so towers can be placed before starting.
- The game scales to fit the browser window without scrolling.
- Mobile layout for screens 500px wide or less: responsive HUD, full-screen grid, touch input.

## Site

- `index.html` is the home page and links to the game.
- Favicons are in `favicon/`.
