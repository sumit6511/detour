import { useEffect, useRef } from "react";
import type { Side } from "../../engine/game";

interface ConfettiProps {
  /** Bump to fire a burst. 0 means "not yet". */
  fire: number;
  originLeft: number;
  originTop: number;
  side: Side;
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  w: number;
  h: number;
  color: string;
}

/** A one-shot burst of paper confetti drawn on a canvas over the board. */
export function Confetti({ fire, originLeft, originTop, side }: ConfettiProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!fire || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const styles = getComputedStyle(canvas);
    const colors = [
      styles.getPropertyValue(side === "south" ? "--south" : "--north").trim() || "#ee7a14",
      styles.getPropertyValue("--lane").trim() || "#ffffff",
      styles.getPropertyValue("--confetti-3").trim() || "#ffd166",
    ];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const ox = (originLeft / 100) * width;
    const oy = (originTop / 100) * height;
    const pieces: Piece[] = Array.from({ length: 110 }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 5 + Math.random() * 7;
      return {
        x: ox,
        y: oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        spin: (Math.random() - 0.5) * 0.4,
        angle: Math.random() * Math.PI,
        w: 4 + Math.random() * 5,
        h: 2 + Math.random() * 3,
        color: colors[Math.floor(Math.random() * colors.length)]!,
      };
    });

    let frame = 0;
    let raf = 0;
    const tick = () => {
      frame++;
      ctx.clearRect(0, 0, width, height);
      const fade = Math.max(0, 1 - Math.max(0, frame - 70) / 60);
      for (const p of pieces) {
        p.vy += 0.22;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.scale(1, Math.abs(Math.cos(frame * 0.12 + p.angle)) + 0.2);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (fade > 0) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, width, height);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fire, originLeft, originTop, side]);

  return <canvas ref={canvasRef} className="confetti" aria-hidden="true" />;
}
