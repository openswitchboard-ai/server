/**
 * Patch, the switchboard's octopus, as bytes the pages can serve.
 *
 * The artwork is `.github/profile/assets/patch.png` in the OpenSwitchboard
 * monorepo, scaled down and re-encoded as an indexed PNG so the header image
 * costs a few kilobytes rather than a hundred and fifty. Two sizes: 126x96 for
 * the page header (a 63x48 box at 2x, which is what a phone with a retina
 * screen asks for) and a square 64x64 for the browser tab.
 *
 * They live here as base64 rather than as files because the build is `tsc`
 * and the image ships in the container as compiled JavaScript. Both are
 * immutable for the life of a deploy, so the routes that serve them say so.
 */

/** 126x96 — the header mark, a 63x48 box at 2x. */
export const PATCH_HEADER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAH4AAABgCAMAAADsITZRAAABgFBMVEUAAAAAAAACAxcjEhguLT2KcoZIOkRfQkBdSGAuHDYV" +
  "EDC1x8CzpI3r39N6V1AGAxqLeWMXDCBBIR6NcYA4MUlfRTZdSGcZEjIsGz8fFTtZSTuHaFo2IEFCLUlVQ2qcio6BYIvd1te8" +
  "oYofFztZRjw2H0dCLkeKZFNTPWmBW2OETD2Se2FkT0rNrY/e1+IeGTl/W5EwI1NnSH1JJUFcOEa+kGk/PFlBKWNSPXSad6u7" +
  "nLqIWoy5lXihbkx3U4+HX6KWbazf1M56KzFSHS1XL1daO3NaQoJ2X3EWFjkqHVM4Ilg+JWc2K10wP1RFLXBPL3FQL3VbOVVd" +
  "Xk1ZM4BQPHteO4JiO4VpPY5pQoduQpJrSIhHX41Cgr52RXlzRpZ3SJ55T52HKCqEPk9/T4+ATqOEWpGIcoCGYp+FU6mPWrSv" +
  "OzPCV1WmYZ6XYbmZYr3Qej27kGenfabRtJ+cZ7qca7mjfrfDubWeaMCga8CndMCmb8eyec27gtLEjNjEotLf3OQmnTRdAAAA" +
  "SHRSTlMABQ8RFBUWFxwdHiInKCsuLzM6PkFDQ0ZIb29yc3V1jJKVmZyfoKCho9HU1tfX2NnZ29vc3d3e3+Dj9/j5+vz8/Pz9" +
  "/v7+/v7OoB4uAAAQ8UlEQVR42u1a+1va2hIVfHN7am2RhwLa8hBfB0NtQRGw0FiSSBKNCY8egUIoSW24Wmx5Wf3X7+wdbLXV" +
  "Uwvn++4vZ/q1BU1Ye2avmVmzw9DQv/av3W7/+X+CGx49+2PA5c8/6P/m4ZnoM8Mg6CPPVh4OcPtjz9LoIPAPVzyTA9w+PLs4" +
  "yOqHLEuzY0MDuT8/gPuj8xuPB9m88dno2lz/t8+tRQfyfmwmuj3ff+I8247ODA/EneWTF1P93jy5drI8M1DePl6ObnvuiJ/B" +
  "OGl2Oh1W4x3b+9CzHfUMxLwxZzJRLi/ekjwG88L65tYF2Nbmust8ywoer5QTyY2Z8UGc33iX+HC87PgJ3LKwdfH16zmyr2Bb" +
  "Szbjj9fMvjiJRqOLA8E/f/fhw/EHzw/OAfjX824XI6MVwKvPS7abFxkX/wv2wTMI9YYdyXcfjo9vfoZxbhOwdXCE32l20Nt1" +
  "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",
  'base64',
);

/** 64x64 — the browser tab. */
export const PATCH_FAVICON_PNG = Buffer.from(
  "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",
  'base64',
);

/** What the header `<img>` is: the box it occupies, and its natural size. */
export const PATCH_HEADER_SIZE = { width: 126, height: 96, displayWidth: 63, displayHeight: 48 };
