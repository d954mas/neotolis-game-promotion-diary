import sharp from "sharp";
import { resolve } from "node:path";

const OUT = ".planning/phases/03.4-design-v2-ux/comparison";

// 1440x900 viewport, deviceScaleFactor 2 → 2880 wide image.
// Crop top 800 px of the IMAGE (= 400 device px).
for (const name of ["feed-live", "feed-prototype"]) {
  await sharp(resolve(OUT, `${name}.png`))
    .extract({ left: 0, top: 0, width: 2880, height: 800 })
    .toFile(resolve(OUT, `${name}-top.png`));
  console.log(`✓ ${name}-top.png`);
}
