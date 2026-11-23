import { randInt } from "./rng.js";
import { WallGrid, UNREACHABLE, type Wall } from "./board.js";
import { goalRow, startPosition } from "./game.js";

/** The same wall turned 180° about the board's centre, which swaps the two racers' views. */
export function rotateWall(wall: Wall, size: number): Wall {
  return { orientation: wall.orientation, row: size - 2 - wall.row, col: size - 2 - wall.col };
}

/**
 * Picks neutral "stone" walls in 180°-symmetric pairs, so whatever the layout, the two racers'
 * journeys are mirror images of each other and no board is lopsided. Stones
 * stay off the two wall rows right in front of the start lines, so neither pawn opens boxed in.
 */
export function generateStones(rng: () => number, size: number, pairs: number): Wall[] {
  const grid = new WallGrid(size);
  const stones: Wall[] = [];
  const southStart = startPosition(size, "south");
  const northStart = startPosition(size, "north");
  const straightRoute = size - 1;

  for (let attempt = 0; attempt < 200 && stones.length < pairs * 2; attempt++) {
    const wall: Wall = {
      orientation: rng() < 0.6 ? "h" : "v",
      row: randInt(rng, 1, size - 3),
      col: randInt(rng, 0, size - 2),
    };
    const mirror = rotateWall(wall, size);
    if (!grid.fitsGeometrically(wall)) continue;
    grid.place(wall);
    if (!grid.fitsGeometrically(mirror)) {
      grid.remove(wall);
      continue;
    }
    grid.place(mirror);

    const southRoute = grid.distanceTo(southStart, goalRow(size, "south"));
    const northRoute = grid.distanceTo(northStart, goalRow(size, "north"));
    // Some detour is the point; a maze is not. Keep the opening race short and readable.
    if (southRoute >= UNREACHABLE || northRoute >= UNREACHABLE || southRoute > straightRoute + 2) {
      grid.remove(mirror);
      grid.remove(wall);
      continue;
    }
    stones.push(wall, mirror);
  }
  return stones;
}
