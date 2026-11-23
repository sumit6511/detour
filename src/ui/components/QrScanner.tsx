import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type Decode = (frame: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

/** The browser's own QR reader where there is one (fast, native), else jsQR, loaded on demand. */
async function makeDecoder(): Promise<Decode> {
  const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector })
    .BarcodeDetector;
  if (Native) {
    try {
      const formats = await (
        Native as unknown as { getSupportedFormats?: () => Promise<string[]> }
      ).getSupportedFormats?.();
      if (!formats || formats.includes("qr_code")) {
        const detector = new Native({ formats: ["qr_code"] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch {
      // Fall through to jsQR.
    }
  }
  const { default: jsQR } = await import("jsqr");
  return async (video, canvas) => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    // Scan a centred square at modest resolution: plenty for a code held up to the camera.
    const side = Math.min(width, height);
    const scale = Math.min(1, 640 / side);
    canvas.width = canvas.height = Math.round(side * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(
      video,
      (width - side) / 2,
      (height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
}

function cameraProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access was blocked. Allow it in your browser, or paste the code instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera found on this device. Paste the code instead.";
  if (name === "NotReadableError") return "The camera is busy in another app. Close it and try again.";
  return "Couldn't start the camera. Paste the code instead.";
}

interface QrScannerProps {
  /** Called with each code read. Return true to stop; false keeps scanning (and says so). */
  onCode: (text: string) => boolean | Promise<boolean>;
  onClose: () => void;
}

/** A live camera view that reads QR codes. */
export function QrScanner({ onCode, onClose }: QrScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const handler = useRef(onCode);
  handler.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement("canvas");
    let lastWrong = "";

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem(
          window.isSecureContext
            ? "This browser can't use the camera here. Paste the code instead."
            : "The camera only works on a secure (https) page. Paste the code instead.",
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (error) {
        if (!stopped) setProblem(cameraProblem(error));
        return;
      }
      if (stopped || !video.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      const decode = await makeDecoder();
      const scan = async () => {
        if (stopped || !video.current) return;
        const text = await decode(video.current, canvas).catch(() => null);
        if (text && text !== lastWrong) {
          if (await handler.current(text)) return;
          lastWrong = text;
          setWrong(true);
        }
        timer = setTimeout(() => void scan(), 160);
      };
      void scan();
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <motion.div
      className="scanner"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
    >
      {problem ? (
        <p className="scanner__problem" role="alert">
          {problem}
        </p>
      ) : (
        <div className="scanner__view">
          <video ref={video} muted playsInline aria-label="Camera view" />
          <span className="scanner__frame" aria-hidden="true" />
        </div>
      )}
      <p className="hint" aria-live="polite">
        {problem
          ? null
          : wrong
            ? "That code isn't a Detour reply. Point at the one on the other device."
            : "Point the camera at the code on the other device."}
      </p>
      <button type="button" className="btn btn--quiet" onClick={onClose}>
        Close camera
      </button>
    </motion.div>
  );
}
