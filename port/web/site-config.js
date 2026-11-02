// Air Attack - ad setup file (SETUP MODE).
// Fill in the Adsterra ad units, upload this file, open the game and check that the ads show on both sides.
// For every unit paste EITHER the whole "invoke.js" link from the Adsterra code (https://.../xxxxxxxx.../invoke.js) OR just the 32-character key.
// Leave a line as "" if you do not have that unit (an empty right side uses the left unit). While the 160x600 AND the 160x300 lines are all empty, the game runs WITHOUT ads.
window.AA_CFG = {
  left600: "",        // Banner 160x600  - left side   (tall windows)
  right600: "",       // Banner 160x600  - right side  (you may use the same unit as the left side)
  left300: "",        // Banner 160x300  - left side   (low windows: laptops with a browser toolbar)
  right300: "",       // Banner 160x300  - right side
  refresh: 30,        // seconds between two ad changes (30 or more)
  enforce: false      // false = only shows warnings in the console; the locked build always enforces the AdBlock message
};
