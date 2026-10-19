# Horde Tower Defence v2 — Change log

Requested changes, newest first.

## 2026-10-19

- Game was too hard, so:
  - Rolled back the "click a tower to sell it, only at ≥ 80% health" change. Right-click sells
    a tower again, at any health, for half price ($25).
  - Tower price is fixed at $50 on every level. It used to rise by $20 per level.
    Starting money (level + 1 towers) is now $100 on level 1, $150 on level 2, and so on.
- Waves follow a fixed order: Tiny, Small, Medium, Large, Huge, Gunner, then repeat. Each level
  starts at Tiny. This replaces the random wave type and the "no two waves in a row" rule.
- Added `docs/horde/` with a feature list and this change log.
- Mobile layout: responsive HUD, viewport-sized grid and touch input. Breakpoint widened to
  500px, and a screen-size footer added.

## 2026-10-18

- Favicons added to the home page and the game. Fixed paths and name in `site.webmanifest`.
- Home page `index.html` added, linking to the game. Site published to GitHub
  (`awhillas/asher.whillas.com`).
- Clicking a tower sold it, but only at ≥ 80% health. *(Rolled back 2026-10-19.)*
- Emergency funds: with no towers and not enough money for one, the player gets a random amount
  that buys 2–10 towers. Limited to once per level.
- Gunners fire at half the tower rate. They are rare at the start and more common at higher levels.
- Consecutive waves can't be the same enemy type. *(Superseded 2026-10-19 by the fixed order.)*
- Enemy HP grows exponentially with size (×2.2 per size). Gunner HP +10% per level.
  The +$1 was removed from starting money. Waves every 20s (previously 30s, originally 15s).
- Starting money buys level + 1 towers.
- Kill reward by size: $5, $10, $15, $20, $25. Gunners are worth $50.
- New red **gunner** enemy that shoots towers. Waves of a single enemy type added.
- Enemies get 5% stronger and 1% faster each level.
- Starting money changed to tower cost × level + $1. *(Superseded.)*
- Tower price +$20 per level. *(Reverted 2026-10-19.)*
- Level-start banner moved to the centre of the screen.
- HUD made compact and kept on one line, so the play area no longer jumps.
- Game fits the browser window without scrolling. Money resets each level.
  Five enemy size tiers added.
- v2 created from scratch: random snake-like corridor of varying width on a grid, colliding
  horde, towers buildable anywhere. Towers in the corridor are attacked by the horde.
  Original game renamed to v1 (now in `prototypes/`).
