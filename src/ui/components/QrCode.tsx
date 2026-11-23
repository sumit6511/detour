import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code as crisp SVG. Always dark on white with a quiet zone, whatever the theme, because
 * that's what phone cameras read best.
 */
export function QrCode({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 4;
    let d = "";
    for (let row = 0; row < count; row++) {
      // One path segment per run of dark modules keeps the SVG small.
      for (let col = 0; col < count;) {
        if (!qr.isDark(row, col)) {
          col++;
          continue;
        }
        let run = 1;
        while (col + run < count && qr.isDark(row, col + run)) run++;
        d += `M${col + quiet} ${row + quiet}h${run}v1h-${run}z`;
        col += run;
      }
    }
    return { size: count + quiet * 2, path: d };
  }, [text]);

  return (
    <svg
      className={`qr ${className}`}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-qr={text}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#0d1117" />
    </svg>
  );
}
