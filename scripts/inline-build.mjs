// Folds the `vite build --mode single` output (one IIFE script + one stylesheet) into
// self-contained HTML, so the game can be shared as a single file or hosted anywhere static.
//   dist-single/detour.html          a complete page: open it straight from disk
//   dist-single/detour.fragment.html the same page without <html>/<head>/<body>, for hosts that
//                                    wrap the page in their own document skeleton
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../dist-single/", import.meta.url);
const js = readFileSync(new URL("app.js", dir), "utf8").replaceAll("</script", "<\\/script");
const css = readFileSync(new URL("app.css", dir), "utf8");

const head = `<title>Detour</title>
<meta name="description" content="A wall-placing race game. Beat the bot, or a friend, to the far side of the board.">
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Overpass:wght@600;800;900&family=Overpass+Mono:wght@500;700&family=Public+Sans:wght@400;500;600;700&display=swap">
<style>${css}</style>`;
const body = `<div id="root"></div>\n<script>${js}</script>`;

writeFileSync(new URL("detour.fragment.html", dir), `${head}\n${body}\n`);
writeFileSync(
  new URL("detour.html", dir),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
);
console.log("wrote dist-single/detour.html and dist-single/detour.fragment.html");
