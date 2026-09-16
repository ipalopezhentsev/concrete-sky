// Material and window-style ids shared by geometry and shaders.

export const enum Mat {
  Asphalt = 0,
  Paving = 1,
  Board = 2,
  Panel = 3,
  Windows = 4,
  Lamp = 5,
  Metal = 6,
  Beacon = 7,
  Deck = 8, // paving on top, board-formed concrete on the sides
  Glow = 9,
  Paint = 10, // vehicle paint; colour comes from the tint
  VGlass = 11, // vehicle glass
  Tail = 12, // red tail light
  Pad = 13, // landing pad markings
}

export const enum Win {
  Punched = 0,
  Ribbon = 1,
  Slit = 2,
  Grid = 3,
}

export type Tint = [number, number, number];
