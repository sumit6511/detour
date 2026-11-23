import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconCheck, IconShare } from "../icons";
import { useToast } from "./Toasts";

/** Shares a link with the phone's share sheet where there is one; copies it everywhere else. */
export function ShareButton({
  url,
  title,
  label,
  className = "btn",
}: {
  url: string;
  title: string;
  label: string;
  className?: string;
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);
  const canShare =
    typeof navigator.share === "function" &&
    matchMedia("(pointer: coarse)").matches &&
    !!navigator.canShare?.({ url });

  const run = async () => {
    if (canShare) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      notify("Couldn't copy here. Press and hold the link to copy it instead.", "warn");
    }
  };

  return (
    <button type="button" className={className} onClick={() => void run()}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "done" : "share"}
          className="lobby__copy"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
        >
          {copied ? <IconCheck /> : <IconShare />}
          {copied ? "Copied" : canShare ? `Share ${label}` : `Copy ${label}`}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
