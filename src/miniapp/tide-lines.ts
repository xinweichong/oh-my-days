/**
 * The tide contour lines (ADR 0007), shared by the launch screen (rendered by
 * the Worker) and the All clear screen (drawn by the client). Wider than a phone
 * so they can drift sideways; always decorative.
 */
export const TIDE_LINES_VIEWBOX = "0 160 520 420";

export const TIDE_LINES = [
  "M-20 300 C 80 260, 180 340, 280 300 S 460 260, 540 300",
  "M-20 330 C 90 292, 190 368, 290 330 S 466 292, 540 330",
  "M-20 362 C 100 326, 200 398, 300 362 S 470 326, 540 362",
  "M-20 396 C 110 362, 210 430, 310 396 S 476 362, 540 396",
  "M-20 432 C 118 400, 218 464, 318 432 S 480 400, 540 432",
  "M-20 470 C 126 440, 226 500, 326 470 S 486 440, 540 470",
  "M-20 510 C 134 482, 234 538, 334 510 S 490 482, 540 510",
] as const;
